"""Real-hardware twin: a line-following camera rover on a printed deck mat (PRD R13).

    python -m blackbox_robot.adapter --driver rover

UNTESTED ON HARDWARE - written against gpiozero + picamera2 on a Raspberry Pi 4/5,
TB6612FNG motor driver, 2 IR line sensors, Pi Camera Module 3. Pin numbers are
the ROVER_* env vars below. Same mission interface as MissionSim, so the adapter's
interlock, lease watchdog and signed log are shared with the sim unchanged.

Safety layers, outermost first:
  1. latching E-stop switch in the motor power line (hardware, always wins)
  2. firmware watchdog thread: motors cut if the control loop misses its tick
  3. adapter lease: no allowlisted 0G answer before the lease -> safe_stop()
Rover runs are live, not replayable: replay and the counterfactual apply to the sim.
"""
from __future__ import annotations

import io
import os
import threading
import time
from typing import List, Optional

from .canonical import canonical_json, keccak_hex
from .crypto import checkpoint_nonce

TICK_HZ = 20


def _pin(name: str, default: int) -> int:
    return int(os.environ.get(name, default))


class _Hardware:
    def __init__(self):
        from gpiozero import DigitalInputDevice, Motor  # type: ignore
        from picamera2 import Picamera2  # type: ignore

        self.left = Motor(forward=_pin("ROVER_AIN1", 5), backward=_pin("ROVER_AIN2", 6), enable=_pin("ROVER_PWMA", 12))
        self.right = Motor(forward=_pin("ROVER_BIN1", 23), backward=_pin("ROVER_BIN2", 24), enable=_pin("ROVER_PWMB", 13))
        self.line_l = DigitalInputDevice(_pin("ROVER_LINE_L", 17))
        self.line_r = DigitalInputDevice(_pin("ROVER_LINE_R", 27))
        self.cam = Picamera2()
        self.cam.configure(self.cam.create_still_configuration(main={"size": (640, 480), "format": "RGB888"}))
        self.cam.start()

    def drive(self, l: float, r: float) -> None:
        for m, v in ((self.left, l), (self.right, r)):
            if v > 0:
                m.forward(min(1.0, v))
            elif v < 0:
                m.backward(min(1.0, -v))
            else:
                m.stop()

    def stop(self) -> None:
        self.left.stop()
        self.right.stop()

    def frame(self):
        from PIL import Image

        return Image.fromarray(self.cam.capture_array())


class RoverMission:
    STEPS_PER_TICK = 1
    TICK_HZ = TICK_HZ
    backend = "rover"

    def __init__(self, mission_id: str, seed: int, sim_cfg: Optional[dict] = None, texture_dir: Optional[str] = None):
        self.cfg = {"speed": 0.45, "dark_frac": 0.04, "inspect_ms": 1500, **(sim_cfg or {})}
        self.mission_id = mission_id
        self.hw = _Hardware()
        self.phase = "READY"
        self.step_idx = 0
        self.checkpoints: List[dict] = []
        self.pending: Optional[dict] = None
        self.samples: List[List[int]] = []
        self.inspected: List[dict] = []
        self.final: Optional[str] = None
        self.world = None
        self._cooldown = 0
        self._resume_at = 0.0
        self._last_tick = time.monotonic()
        self._t0 = time.monotonic()
        self._cmd = (0.0, 0.0)
        threading.Thread(target=self._firmware_watchdog, daemon=True).start()

    def _firmware_watchdog(self) -> None:
        while self.final is None:
            time.sleep(0.05)
            if time.monotonic() - self._last_tick > 0.3:
                self.hw.stop()

    @property
    def running(self) -> bool:
        return self.phase not in ("READY", "HOLD", "LANDED", "STOPPED")

    @property
    def t_ms(self) -> int:
        return int((time.monotonic() - self._t0) * 1000)

    def start(self) -> None:
        self.phase = "SURVEY"

    def place(self, kind, x_mm, y_mm, variant=0) -> dict:
        raise ValueError("on the rover, place a printed crack or decoy card on the mat instead")

    def _drive(self, l: float, r: float) -> None:
        self._cmd = (l, r)
        self.hw.drive(l, r)

    def step(self) -> Optional[dict]:
        self._last_tick = time.monotonic()
        if not self.running:
            self.hw.stop()
            return None
        self.step_idx += 1
        if self.phase == "STOPPING":  # motors are already cut; report the end once
            self.phase, self.final = "STOPPED", "safe_stopped"
            return {"type": "done", "final": self.final, "step": self.step_idx, "trajectory_hash": self.trajectory_hash()}
        if self.phase == "INSPECT":
            if time.monotonic() >= self._resume_at:
                self.phase = "SURVEY"
            return None
        s = self.cfg["speed"]
        on_l, on_r = self.hw.line_l.value, self.hw.line_r.value
        if on_l and on_r:  # end-of-track bar across the mat
            self._drive(0, 0)
            self.phase, self.final = "LANDED", "landed"
            return {"type": "done", "final": "landed", "step": self.step_idx, "trajectory_hash": self.trajectory_hash()}
        self._drive(s * (0.3 if on_l else 1.0), s * (0.3 if on_r else 1.0))
        self.samples.append([self.t_ms, int(self._cmd[0] * 1000), int(self._cmd[1] * 1000), 0])
        if self._cooldown:
            self._cooldown -= 1
            return None
        img = self.hw.frame()
        roi = img.crop((img.width // 4, img.height // 4, 3 * img.width // 4, 3 * img.height // 4)).convert("L")
        dark = sum(1 for v in roi.getdata() if v < 70) / (roi.width * roi.height)
        if dark < self.cfg["dark_frac"]:
            return None
        self._drive(0, 0)
        crop = img.crop((img.width // 2 - 200, img.height // 2 - 200, img.width // 2 + 200, img.height // 2 + 200)).resize((256, 256))
        buf = io.BytesIO()
        crop.save(buf, format="PNG")
        png = buf.getvalue()
        k = len(self.checkpoints)
        obs_hash = keccak_hex(png)
        cp = {"k": k, "step": self.step_idx, "t_ms": self.t_ms, "target_mm": [0, 0], "pose_mm": [0, 0, 0],
              "detector_score": int(dark * 255), "blocks": 0, "pix_hash": keccak_hex(crop.tobytes()),
              "obs_hash": obs_hash, "nonce": checkpoint_nonce(self.mission_id, obs_hash, k)}
        self.checkpoints.append(dict(cp, outcome=None))
        self.pending = cp
        self.phase = "HOLD"
        return dict(cp, type="checkpoint", png=png)

    def resolve(self, outcome: str) -> None:
        cp, self.pending = self.pending, None
        self.checkpoints[cp["k"]]["outcome"] = outcome
        self._cooldown = TICK_HZ * 2  # drive off the card before looking again
        if outcome == "descend":  # "inspect": stop over the card, then carry on
            self.inspected.append({"k": cp["k"], "target_mm": cp["target_mm"]})
            self.phase, self._resume_at = "INSPECT", time.monotonic() + self.cfg["inspect_ms"] / 1000
        elif outcome == "continue":
            self.phase = "SURVEY"
        else:
            self.emergency_stop()

    def emergency_stop(self) -> None:
        self.hw.stop()
        self.pending = None
        self.phase = "STOPPING"

    def trajectory_hash(self) -> str:
        return keccak_hex(canonical_json({"v": 1, "backend": "rover", "samples": self.samples}).encode())

    def pose_mm(self):
        return [0, 0, 0]

    def state(self) -> dict:
        return {"phase": self.phase, "step": self.step_idx, "t_ms": self.t_ms, "pose_mm": [0, 0, 0],
                "deck_mm": [1800, 600], "home_mm": [0, 300], "waypoints_mm": [], "wp_idx": 0, "defects": [],
                "checkpoints": self.checkpoints, "pending": self.pending, "inspected": self.inspected,
                "final": self.final, "backend": "rover"}

    def close(self) -> None:
        self.hw.stop()
