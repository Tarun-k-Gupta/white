"""Deterministic inspection mission: lawnmower survey, checkpoints, outcomes.

The sim never reads the wall clock. While a checkpoint waits for 0G the
physics is frozen, so the trajectory depends only on (seed, manifest, world
events, checkpoint outcomes) and a replay of the episode log reproduces it.
"""
from __future__ import annotations

import math
from collections import deque
from typing import Deque, Dict, List, Optional, Set, Tuple

from .canonical import canonical_json, keccak_hex
from .crypto import checkpoint_nonce
from .physics import HALF_H, PHYS_HZ, controller, make_body
from .world import World

SAMPLE_EVERY = 24  # 10 Hz trajectory samples
CONTROL_EVERY = 12  # 20 Hz detector
MAX_STEPS = PHYS_HZ * 900  # hard cap: 15 sim-minutes

DEFAULT_SIM = {
    "backend": "pybullet",
    "deck_mm": [24000, 8000],
    "home_mm": [-2000, 4000],
    "cruise_mm": 3000,
    "inspect_mm": 1000,
    "speed_mm_s": 3000,
    "lanes": 3,
    "footprint_mm": 1400,
    "detector_min": 10,
    "inspect_hover_ms": 1000,
    "crop_mm": 1000,
}

OUTCOMES = ("descend", "continue", "safe_stop")


class MissionSim:
    def __init__(self, mission_id: str, seed: int, sim_cfg: Optional[dict] = None, texture_dir: Optional[str] = None):
        self.cfg = dict(DEFAULT_SIM)
        self.cfg.update(sim_cfg or {})
        c = self.cfg
        self.mission_id = mission_id
        self.seed = int(seed)
        self.backend = c["backend"]
        self.world = World(c["deck_mm"][0], c["deck_mm"][1], self.seed, texture_dir)
        hx, hy = c["home_mm"]
        self.body = make_body(self.backend, hx / 1000.0, hy / 1000.0, 0.0)
        self.step_idx = 0
        self.phase = "READY"
        self.targets: Deque[Tuple[float, float, float, int]] = deque()
        self.waypoints = self._lawnmower()
        self.wp_idx = 0
        self.handled: Set[Tuple[int, int]] = set()
        self.checkpoints: List[dict] = []
        self.pending: Optional[dict] = None
        self.inspected: List[dict] = []
        self.samples: List[List[int]] = []
        self.final: Optional[str] = None
        self._hover_left = 0

    # ----------------------------------------------------------------- setup
    def _lawnmower(self) -> List[Tuple[int, int]]:
        w, h = self.cfg["deck_mm"]
        n = self.cfg["lanes"]
        pts = []
        for i in range(n):
            y = h * (2 * i + 1) // (2 * n)
            xs = (0, w) if i % 2 == 0 else (w, 0)
            pts += [(xs[0], y), (xs[1], y)]
        return pts

    def start(self) -> None:
        if self.phase != "READY":
            raise RuntimeError("mission already started")
        hx, hy = self.cfg["home_mm"]
        self.phase = "TAKEOFF"
        self.targets = deque([(hx / 1000.0, hy / 1000.0, self.cfg["cruise_mm"] / 1000.0, 0)])

    def place(self, kind: str, x_mm: int, y_mm: int, variant: int = 0) -> dict:
        return self.world.add_defect(kind, x_mm, y_mm, variant).to_json()

    # ------------------------------------------------------------------ step
    @property
    def running(self) -> bool:
        return self.phase not in ("READY", "HOLD", "LANDED", "STOPPED")

    def step(self) -> Optional[dict]:
        if not self.running:
            return None
        pos, vel = self.body.state()
        target = self._target()
        if target is None:
            force = [0.0, 0.0, 0.0]
        else:
            vmax = self.cfg["speed_mm_s"] / 1000.0 if self.phase == "SURVEY" else 1.5
            force = controller(pos, vel, target, vmax)
        self.body.step(force)
        self.step_idx += 1
        pos, vel = self.body.state()
        if self.step_idx % SAMPLE_EVERY == 0:
            self.samples.append([self.step_idx] + [int(round(v * 1000)) for v in pos])
        self._advance(pos, vel)
        if self.phase in ("LANDED", "STOPPED"):
            self.final = "landed" if self.phase == "LANDED" else "safe_stopped"
            return {"type": "done", "final": self.final, "step": self.step_idx,
                    "trajectory_hash": self.trajectory_hash()}
        if self.phase == "SURVEY" and self.step_idx % CONTROL_EVERY == 0:
            return self._detect(pos)
        if self.step_idx >= MAX_STEPS and self.phase not in ("RTH", "SAFE_RTH"):
            self._go_home("RTH")
        return None

    def _target(self) -> Optional[Tuple[float, float, float]]:
        if self.phase == "SURVEY":
            x, y = self.waypoints[self.wp_idx]
            return (x / 1000.0, y / 1000.0, self.cfg["cruise_mm"] / 1000.0)
        if self.targets:
            t = self.targets[0]
            return (t[0], t[1], t[2])
        return None

    def _advance(self, pos, vel) -> None:
        speed = math.sqrt(sum(v * v for v in vel))
        if self.phase == "SURVEY":
            x, y = self.waypoints[self.wp_idx]
            if math.hypot(pos[0] - x / 1000.0, pos[1] - y / 1000.0) < 0.25:
                self.wp_idx += 1
                if self.wp_idx >= len(self.waypoints):
                    self._go_home("RTH")
            return
        if not self.targets:
            return
        tx, ty, tz, hover = self.targets[0]
        landing = tz <= HALF_H + 1e-9
        if landing:
            reached = pos[2] < HALF_H + 0.03 and speed < 0.15 and math.hypot(pos[0] - tx, pos[1] - ty) < 0.3
        else:
            reached = math.sqrt((pos[0] - tx) ** 2 + (pos[1] - ty) ** 2 + (pos[2] - tz) ** 2) < 0.2
        if not reached:
            return
        if hover > 0:
            if self._hover_left == 0:
                self._hover_left = hover
            self._hover_left -= 1
            if self._hover_left > 0:
                return
        self.targets.popleft()
        if self.targets:
            return
        if self.phase == "TAKEOFF" or self.phase == "INSPECT":
            self.phase = "SURVEY"
        elif self.phase == "RTH":
            self.phase = "LANDED"
        elif self.phase == "SAFE_RTH":
            self.phase = "STOPPED"

    def _go_home(self, phase: str) -> None:
        hx, hy = self.cfg["home_mm"]
        pos, _ = self.body.state()
        cruise = self.cfg["cruise_mm"] / 1000.0
        self.phase = phase
        self.targets = deque([
            (pos[0], pos[1], cruise, 0),
            (hx / 1000.0, hy / 1000.0, cruise, 0),
            (hx / 1000.0, hy / 1000.0, HALF_H, 0),
        ])

    # -------------------------------------------------------------- detection
    def _cluster(self, i0: int, j0: int) -> List[Tuple[int, int]]:
        thr = self.cfg["detector_min"]
        a = self.world.anomaly
        seen = {(i0, j0)}
        q = deque([(i0, j0)])
        out = []
        while q:
            i, j = q.popleft()
            out.append((i, j))
            for dj in (-1, 0, 1):
                for di in (-1, 0, 1):
                    n = (i + di, j + dj)
                    if n in seen or not (0 <= n[0] < self.world.bx and 0 <= n[1] < self.world.by):
                        continue
                    if a[n[1]][n[0]] >= thr and n not in self.handled:
                        seen.add(n)
                        q.append(n)
        return sorted(out)

    def _detect(self, pos) -> Optional[dict]:
        thr = self.cfg["detector_min"]
        r = self.cfg["footprint_mm"]
        fx, fy = int(round(pos[0] * 1000)), int(round(pos[1] * 1000))
        i0, j0 = self.world.block_of(fx - r, fy - r)
        i1, j1 = self.world.block_of(fx + r, fy + r)
        a = self.world.anomaly
        tried: Set[Tuple[int, int]] = set()
        for j in range(max(0, j0), min(self.world.by, j1 + 1)):
            for i in range(max(0, i0), min(self.world.bx, i1 + 1)):
                if a[j][i] < thr or (i, j) in self.handled or (i, j) in tried:
                    continue
                cluster = self._cluster(i, j)
                tried.update(cluster)
                wsum = sum(a[cj][ci] for ci, cj in cluster)
                cx = sum(self.world.block_center_mm(ci, cj)[0] * a[cj][ci] for ci, cj in cluster) // wsum
                cy = sum(self.world.block_center_mm(ci, cj)[1] * a[cj][ci] for ci, cj in cluster) // wsum
                if math.hypot(cx - fx, cy - fy) > r:
                    continue
                return self._checkpoint(cluster, cx, cy, pos, max(a[cj][ci] for ci, cj in cluster))
        return None

    def _checkpoint(self, cluster, cx: int, cy: int, pos, score: int) -> dict:
        k = len(self.checkpoints)
        png, pix_hash = self.world.crop(cx, cy, self.cfg["crop_mm"])
        obs_hash = keccak_hex(png)
        cp = {
            "k": k,
            "step": self.step_idx,
            "t_ms": self.t_ms,
            "target_mm": [cx, cy],
            "pose_mm": [int(round(v * 1000)) for v in pos],
            "detector_score": score,
            "blocks": len(cluster),
            "pix_hash": pix_hash,
            "obs_hash": obs_hash,
            "nonce": checkpoint_nonce(self.mission_id, obs_hash, k),
        }
        self.checkpoints.append(dict(cp, outcome=None))
        self.pending = dict(cp, cluster=cluster)
        self.phase = "HOLD"
        return dict(cp, type="checkpoint", png=png)

    # ------------------------------------------------------------- outcomes
    def resolve(self, outcome: str) -> None:
        """Apply the checkpoint outcome: an interlock-approved 0G action, a
        human's action after a calibrated hold, or the lease's safe stop."""
        if self.pending is None:
            raise RuntimeError("no pending checkpoint")
        if outcome not in OUTCOMES:
            raise ValueError(f"bad outcome {outcome!r}")
        cp = self.pending
        self.pending = None
        self.handled.update(cp["cluster"])
        self.checkpoints[cp["k"]]["outcome"] = outcome
        cruise = self.cfg["cruise_mm"] / 1000.0
        if outcome == "descend":
            tx, ty = cp["target_mm"][0] / 1000.0, cp["target_mm"][1] / 1000.0
            px, py, _ = (v / 1000.0 for v in cp["pose_mm"])
            hover = self.cfg["inspect_hover_ms"] * PHYS_HZ // 1000
            self.targets = deque([
                (tx, ty, cruise, 0),
                (tx, ty, self.cfg["inspect_mm"] / 1000.0, hover),
                (tx, ty, cruise, 0),
                (px, py, cruise, 0),
            ])
            self.inspected.append({"k": cp["k"], "target_mm": cp["target_mm"]})
            self.phase = "INSPECT"
        elif outcome == "continue":
            self.phase = "SURVEY"
        else:
            self._go_home("SAFE_RTH")

    def emergency_stop(self) -> None:
        """Operator E-stop outside a checkpoint (also logged and replayed)."""
        if self.pending is not None:
            self.resolve("safe_stop")
        elif self.phase not in ("SAFE_RTH", "STOPPED", "LANDED", "READY"):
            self._go_home("SAFE_RTH")

    # ---------------------------------------------------------------- output
    @property
    def t_ms(self) -> int:
        return self.step_idx * 1000 // PHYS_HZ

    def trajectory_hash(self) -> str:
        return keccak_hex(canonical_json({"v": 1, "backend": self.backend, "samples": self.samples}).encode())

    def pose_mm(self) -> List[int]:
        pos, _ = self.body.state()
        return [int(round(v * 1000)) for v in pos]

    def state(self) -> dict:
        pending = None
        if self.pending:
            pending = {k: v for k, v in self.pending.items() if k != "cluster"}
        return {
            "phase": self.phase,
            "step": self.step_idx,
            "t_ms": self.t_ms,
            "pose_mm": self.pose_mm(),
            "deck_mm": self.cfg["deck_mm"],
            "home_mm": self.cfg["home_mm"],
            "waypoints_mm": [list(p) for p in self.waypoints],
            "wp_idx": self.wp_idx,
            "defects": [d.to_json() for d in self.world.defects],
            "checkpoints": self.checkpoints,
            "pending": pending,
            "inspected": self.inspected,
            "final": self.final,
            "backend": self.backend,
        }

    def close(self) -> None:
        self.body.close()
