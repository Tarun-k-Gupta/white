"""Robot adapter: the one process that holds the robot key and can move the robot.

    python -m blackbox_robot.adapter --port 8801 --core http://127.0.0.1:8787

It runs the mission sim (or the rover driver), holds at each checkpoint, asks
the core for a 0G decision, and actuates only on an answer that passes the
interlock. A lease watchdog safe-stops the robot when no valid answer arrives
in time; refused answers never extend the lease. Every event is appended to a
robot-signed hash chain and handed to the core's writer queue - motion never
waits for Storage.
"""
from __future__ import annotations

import argparse
import base64
import json
import os
import queue
import re
import threading
import time
import traceback
import urllib.error
import urllib.request
from collections import deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Optional

from .canonical import keccak_hex
from .crypto import RobotKey, anchor_digest, close_digest
from .episode_log import EpisodeLog
from .interlock import ACTIONS, split_signed_text, verify_bundle
from .mission import CONTROL_EVERY, MissionSim
from .physics import PHYS_HZ, available_backends
from .replay import replay

HEX32 = re.compile(r"^0x[0-9a-fA-F]{64}$")


def http_json(method: str, url: str, body: Any = None, timeout: float = 10.0) -> dict:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(url, data=data, method=method, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=max(0.1, timeout)) as r:
            return json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return json.loads(e.read() or b"{}")
        except Exception:
            return {"ok": False, "error": f"HTTP {e.code}"}


def _ints(v: Any) -> Any:
    """Log entries carry integers only (canonical JSON is shared with TypeScript)."""
    if isinstance(v, bool) or v is None or isinstance(v, (int, str)):
        return v
    if isinstance(v, float):
        return int(round(v))
    if isinstance(v, dict):
        return {str(k): _ints(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_ints(x) for x in v]
    return str(v)


class Outbox(threading.Thread):
    """Ordered, retrying hand-off of log entries to the core's writer queue."""

    def __init__(self, core_url: str):
        super().__init__(daemon=True)
        self.core_url = core_url.rstrip("/")
        self.q: "queue.Queue[dict]" = queue.Queue()
        self.pending = 0
        self.last_error: Optional[str] = None

    def push(self, entry: dict) -> None:
        self.pending += 1
        self.q.put(entry)

    def run(self) -> None:
        while True:
            entry = self.q.get()
            delay = 0.5
            while True:
                try:
                    r = http_json("POST", f"{self.core_url}/api/entries", {"entry": entry}, timeout=10)
                    if r.get("ok"):
                        self.last_error = None
                        break
                    self.last_error = str(r.get("error"))
                except Exception as e:  # noqa: BLE001
                    self.last_error = f"core unreachable: {e.__class__.__name__}"
                time.sleep(delay)
                delay = min(5.0, delay * 2)
            self.pending -= 1


class Adapter:
    def __init__(self, key: RobotKey, core_url: str, data_dir: str, speed: float = 1.0,
                 texture_dir: Optional[str] = None, driver: str = "sim"):
        self.key = key
        self.driver = driver
        self.core_url = core_url.rstrip("/")
        self.data_dir = data_dir
        self.speed = speed
        self.texture_dir = texture_dir
        self.lock = threading.RLock()
        self.sim: Optional[MissionSim] = None
        self.log: Optional[EpisodeLog] = None
        self.manifest: Optional[dict] = None
        self.cp: Optional[dict] = None
        self.crops: dict = {}
        self.events: deque = deque(maxlen=200)
        self.outbox = Outbox(core_url)
        self.outbox.start()
        self._preview = (None, b"")
        threading.Thread(target=self._runner, daemon=True).start()
        threading.Thread(target=self._watchdog, daemon=True).start()

    # ----------------------------------------------------------------- helpers
    def _event(self, level: str, text: str) -> None:
        self.events.append({"t": int(time.time() * 1000), "level": level, "text": text})
        print(f"[adapter] {level}: {text}", flush=True)

    def _append(self, kind: str, body: dict) -> dict:
        e = self.log.append(kind, self.sim.t_ms, _ints(body))
        self.outbox.push(e)
        return e

    @property
    def policy(self) -> dict:
        return (self.manifest or {}).get("policy", {})

    # ----------------------------------------------------------------- mission
    def prepare(self, req: dict) -> dict:
        with self.lock:
            if self.sim is not None and self.sim.phase not in ("READY", "LANDED", "STOPPED"):
                raise ValueError("a mission is in progress")
            text = req["manifest_text"]
            m = json.loads(text)
            if m.get("robot", "").lower() != self.key.address.lower():
                raise ValueError(f"manifest is for robot {m.get('robot')}, I am {self.key.address}")
            if not HEX32.match(m.get("mission_id", "")):
                raise ValueError("manifest mission_id must be bytes32 hex")
            p = m.get("policy", {})
            if not p.get("tee_signers"):
                raise ValueError("manifest has an empty TEE signer allowlist")
            if not 500 <= int(p.get("lease_ms", 0)) <= 60000:
                raise ValueError("lease_ms must be within 500..60000")
            if self.sim is not None:
                self.sim.close()
            self.manifest = m
            self.cp = None
            self.crops = {}
            if self.driver == "rover":
                from .rover import RoverMission

                self.sim = RoverMission(m["mission_id"], m["seed"], m["sim"])
            else:
                self.sim = MissionSim(m["mission_id"], m["seed"], m["sim"], self.texture_dir)
            defects = [self.sim.place(d["kind"], int(d["x_mm"]), int(d["y_mm"]), int(d.get("variant", 0)))
                       for d in req.get("defects", [])]
            path = os.path.join(self.data_dir, f"{m['mission_id']}.jsonl")
            if os.path.exists(path):
                os.remove(path)
            self.log = EpisodeLog(m["mission_id"], self.key, path)
            genesis = self._append("mission_start", {
                "manifest": m,
                "manifest_hash": keccak_hex(text.encode("utf-8")),
                "manifest_root": req.get("manifest_root"),
                "seed_hash": keccak_hex(int(m["seed"]).to_bytes(32, "big")),
                "robot_id": m.get("robot_id"),
                "chain_id": m.get("chain_id"),
                "registry": m.get("registry"),
                "backend": self.sim.backend,
                "defects": defects,
            })
            self._event("info", f"mission {m['mission_id'][:10]} prepared, {len(defects)} defects placed")
            return {"genesis": genesis, "robot": self.key.address}

    def go(self) -> dict:
        with self.lock:
            if self.sim is None:
                raise ValueError("no prepared mission")
            self.sim.start()
            self._event("info", "takeoff")
            return {"ok": True}

    def place(self, req: dict) -> dict:
        with self.lock:
            if self.sim is None or self.sim.phase in ("LANDED", "STOPPED"):
                raise ValueError("no active mission")
            d = self.sim.place(req["kind"], int(req["x_mm"]), int(req["y_mm"]), int(req.get("variant", 0)))
            e = self._append("world", {"step": self.sim.step_idx, "defect": d})
            self._event("info", f"{d['kind']} placed at ({d['x_mm']/1000:.1f}, {d['y_mm']/1000:.1f}) m")
            return {"defect": d, "entry": e["seq"]}

    # -------------------------------------------------------------- run loop
    def _runner(self) -> None:
        next_t = time.monotonic()
        while True:
            sim = self.sim
            if sim is None or not sim.running:
                time.sleep(0.02)
                next_t = time.monotonic()
                continue
            steps = getattr(sim, "STEPS_PER_TICK", CONTROL_EVERY)
            tick_hz = getattr(sim, "TICK_HZ", PHYS_HZ / CONTROL_EVERY) * (self.speed if self.driver == "sim" else 1.0)
            with self.lock:
                if self.sim is sim:
                    for _ in range(steps):
                        ev = sim.step()
                        if ev is not None:
                            try:
                                self._on_event(ev)
                            except Exception:
                                traceback.print_exc()
                            break
            next_t += 1.0 / tick_hz
            d = next_t - time.monotonic()
            if d > 0:
                time.sleep(d)
            elif d < -0.5:
                next_t = time.monotonic()

    def _on_event(self, ev: dict) -> None:
        if ev["type"] == "checkpoint":
            lease = int(self.policy.get("lease_ms", 12000))
            k = ev["k"]
            self.crops[k] = ev["png"]
            cp = {k2: ev[k2] for k2 in ("k", "step", "nonce", "obs_hash", "pix_hash", "pose_mm", "target_mm",
                                        "detector_score")}
            cp.update(status="waiting", deadline=time.monotonic() + lease / 1000.0, lease_ms=lease,
                      asks=0, refused=0, last_error=None, started=time.time())
            self.cp = cp
            self._event("info", f"checkpoint {k}: holding, asking 0G (lease {lease} ms)")
            threading.Thread(target=self._ask_core, args=(cp, ev["png"]), daemon=True).start()
        elif ev["type"] == "done":
            n = {}
            for e in self.log.entries:
                n[e["kind"]] = n.get(e["kind"], 0) + 1
            self._append("mission_end", {
                "final": ev["final"],
                "step": ev["step"],
                "trajectory_hash": ev["trajectory_hash"],
                "samples": len(self.sim.samples),
                "checkpoints": len(self.sim.checkpoints),
                "decisions": n.get("decision", 0) + n.get("human", 0),
                "refusals": n.get("rejected", 0),
                "safe_stops": n.get("safe_stop", 0),
                "backend": self.sim.backend,
            })
            self._event("info", f"mission ended: {ev['final']}, trajectory {ev['trajectory_hash'][:12]}")

    def _ask_core(self, cp: dict, png: bytes) -> None:
        payload = {
            "mission_id": self.manifest["mission_id"],
            "checkpoint": cp["k"],
            "step": cp["step"],
            "nonce": cp["nonce"],
            "obs_hash": cp["obs_hash"],
            "pix_hash": cp["pix_hash"],
            "pose_mm": cp["pose_mm"],
            "target_mm": cp["target_mm"],
            "detector_score": cp["detector_score"],
            "crop_png_b64": base64.b64encode(png).decode(),
        }
        max_asks = int(self.policy.get("max_asks", 2))
        while True:
            with self.lock:
                if self.cp is not cp or cp["status"] != "waiting":
                    return
                remaining = cp["deadline"] - time.monotonic()
                if cp["asks"] >= max_asks:
                    return
            if remaining <= 0.05:
                return
            payload["deadline_ms"] = int(remaining * 1000)
            try:
                resp = http_json("POST", f"{self.core_url}/api/checkpoint", payload, timeout=remaining)
            except Exception as e:  # noqa: BLE001
                cp["last_error"] = f"core unreachable: {e.__class__.__name__}"
                time.sleep(min(1.0, max(0.05, remaining)))
                continue
            if not resp.get("ok"):
                cp["last_error"] = str(resp.get("error"))[:300]
                time.sleep(min(1.0, max(0.05, remaining)))
                continue
            with self.lock:
                cp["asks"] += 1
            res = self.submit_decision(resp["bundle"], source="core")
            if res.get("accepted") or res.get("held"):
                return

    def _watchdog(self) -> None:
        while True:
            time.sleep(0.05)
            with self.lock:
                cp = self.cp
                if cp is None:
                    continue
                now = time.monotonic()
                if cp["status"] == "waiting" and now >= cp["deadline"]:
                    if cp["refused"]:
                        reason = (f"no valid 0G-signed decision before the lease expired "
                                  f"({cp['refused']} refused), no decision made")
                    else:
                        reason = "0G unreachable, no decision made"
                    self._safe_stop_cp(cp, reason)
                elif cp["status"] == "await_human" and now >= cp["human_deadline"]:
                    self._safe_stop_cp(cp, "no human decision before the hold timeout, no decision made")

    def _safe_stop_cp(self, cp: dict, reason: str) -> None:
        self._append("safe_stop", {
            "checkpoint": cp["k"], "step": cp["step"], "reason": reason, "lease_ms": cp["lease_ms"],
            "asks": cp["asks"], "refused": cp["refused"], "last_error": cp["last_error"],
            "nonce": cp["nonce"], "obs_hash": cp["obs_hash"], "pix_hash": cp["pix_hash"],
        })
        cp["status"] = "safe_stopped"
        self.sim.resolve("safe_stop")
        self._event("stop", f"SAFE STOP at checkpoint {cp['k']}: {reason}")

    # --------------------------------------------------------------- decisions
    @staticmethod
    def _zg_fields(bundle: dict) -> dict:
        tee = bundle.get("tee") or {}
        z = {k: bundle.get(k) for k in ("endpoint", "router_url", "request_id", "chat_id", "chat_id_source",
                                         "provider", "model", "router_tee_verified", "latency_ms",
                                         "request_sha256", "raw_response", "tee_error")}
        z["tee"] = {k: tee.get(k) for k in ("text", "signature", "signing_address", "service_url")}
        hashes = split_signed_text(tee.get("text") or "")
        z["request_hash_match"] = bool(hashes and bundle.get("request_sha256") == hashes[0])
        return z

    def submit_decision(self, bundle: dict, source: str) -> dict:
        with self.lock:
            if self.log is None or self.sim is None:
                return {"accepted": False, "reason": "no mission"}
            cp = self.cp
            k = bundle.get("checkpoint")
            if cp is None or cp["status"] != "waiting" or k != cp["k"] or \
                    bundle.get("mission_id") != self.manifest["mission_id"]:
                reason = "decision rejected: no pending checkpoint matches it"
                self._append("rejected", {"checkpoint": k if isinstance(k, int) else None, "source": source,
                                          "reason": reason})
                self._event("refuse", f"{source}: {reason}")
                return {"accepted": False, "reason": reason}
            res = verify_bundle(bundle, self.policy, cp["nonce"])
            zg = self._zg_fields(bundle)
            if not res["accepted"]:
                cp["refused"] += 1
                self._append("rejected", {
                    "checkpoint": k, "step": cp["step"], "source": source, "reason": res["reason"],
                    "attempted_answer": res["answer"], "signer": res["signer"], "nonce": cp["nonce"], "zg": zg,
                })
                self._event("refuse", f"checkpoint {k} ({source}): {res['reason']}")
                return res
            body = {
                "checkpoint": k, "step": cp["step"], "pose_mm": cp["pose_mm"], "target_mm": cp["target_mm"],
                "detector_score": cp["detector_score"], "pix_hash": cp["pix_hash"], "obs_hash": cp["obs_hash"],
                "nonce": cp["nonce"], "answer": res["answer"], "source": source, "zg": zg,
                "interlock": {"parsed": True, "nonce_ok": True, "signer": res["signer"],
                              "signer_allowlisted": True, "binding": res["binding"]},
                "decision_model": bundle.get("decision_model"),
                "wait_ms": int((time.time() - cp["started"]) * 1000),
            }
            dm = bundle.get("decision_model") or {}
            if dm.get("hold"):
                cp["status"] = "await_human"
                cp["human_deadline"] = time.monotonic() + int(self.policy.get("human_timeout_ms", 60000)) / 1000.0
                self._append("hold", body)
                self._event("hold", f"checkpoint {k}: calibrated hold ({dm.get('reason')}), asking a human")
                return dict(res, held=True)
            action = res["answer"]["action"]
            body["action_applied"] = action
            self._append("decision", body)
            cp["status"] = "resolved"
            self.sim.resolve(action)
            self._event("accept", f"checkpoint {k}: 0G says {res['answer']['label']} -> {action} "
                                  f"(TEE signer {res['signer'][:10]}, binding {res['binding']})")
            return res

    def human(self, req: dict) -> dict:
        with self.lock:
            cp = self.cp
            action = req.get("action")
            if cp is None or cp["status"] != "await_human" or req.get("checkpoint") != cp["k"]:
                raise ValueError("no checkpoint is waiting for a human")
            if action not in ACTIONS:
                raise ValueError("action must be descend or continue")
            self._append("human", {"checkpoint": cp["k"], "step": cp["step"], "action": action,
                                   "by": str(req.get("by", "operator console"))[:64]})
            cp["status"] = "resolved"
            self.sim.resolve(action)
            self._event("accept", f"checkpoint {cp['k']}: human chose {action}")
            return {"ok": True}

    def estop(self) -> dict:
        with self.lock:
            if self.sim is None:
                raise ValueError("no mission")
            cp = self.cp
            if cp is not None and cp["status"] in ("waiting", "await_human"):
                self._safe_stop_cp(cp, "operator e-stop")
            elif self.sim.phase not in ("READY", "LANDED", "STOPPED", "SAFE_RTH"):
                self.sim.emergency_stop()
                self._append("safe_stop", {"checkpoint": None, "step": self.sim.step_idx, "reason": "operator e-stop"})
                self._event("stop", "SAFE STOP: operator e-stop")
            return {"ok": True}

    # ----------------------------------------------------------------- signing
    def sign(self, req: dict) -> dict:
        """Sign an anchor/close for the core to relay - only for heads in my own log."""
        with self.lock:
            m = self.manifest
            if m is None or self.log is None:
                raise ValueError("no mission")
            if req.get("mission_id") != m["mission_id"]:
                raise ValueError("wrong mission")
            chain_id, registry = int(m["chain_id"]), m["registry"]
            count, head, index_root = int(req["count"]), req["head"], req["index_root"]
            entries = self.log.entries
            if not 1 <= count <= len(entries) or entries[count - 1]["hash"] != head:
                raise ValueError("head does not match my log")
            if req["type"] == "anchor":
                digest = anchor_digest(chain_id, registry, m["mission_id"], count, head, index_root)
            elif req["type"] == "close":
                last = entries[-1]
                if last["kind"] != "mission_end" or count != len(entries):
                    raise ValueError("mission has not ended")
                if req.get("trajectory_hash") != last["body"]["trajectory_hash"]:
                    raise ValueError("trajectory hash does not match my log")
                digest = close_digest(chain_id, registry, m["mission_id"], count, head, index_root,
                                      req["trajectory_hash"])
            else:
                raise ValueError("type must be anchor or close")
            return {"signature": self.key.sign_digest(digest), "robot": self.key.address}

    # ---------------------------------------------------------- replay & views
    def counterfactual(self, req: dict) -> dict:
        force = req.get("force", "continue")
        if self.driver != "sim":
            raise ValueError("rover runs are live; the counterfactual replays the sim")
        with self.lock:
            if self.log is None:
                raise ValueError("no mission")
            entries = list(self.log.entries)
            actual = list(self.sim.samples)

        def override(_k, outcome):
            return force if outcome in ("descend", "continue", None) else outcome

        cf = replay(entries, override=override, texture_dir=self.texture_dir, collect=True)
        return {"force": force, "actual": actual, "counterfactual": cf["samples"],
                "counterfactual_inspected": cf["inspected"], "counterfactual_final": cf["final"]}

    def replay_check(self, req: dict) -> dict:
        if self.driver != "sim":
            return {"match": None, "error": "rover runs are live and not replayable"}
        entries = req.get("entries")
        if entries is None:
            with self.lock:
                entries = list(self.log.entries) if self.log else []
        return replay(entries, texture_dir=self.texture_dir)

    def state(self, since: int = 0) -> dict:
        with self.lock:
            s = self.sim.state() if self.sim else None
            cp = None
            if self.cp:
                cp = {k: self.cp[k] for k in ("k", "status", "asks", "refused", "last_error", "lease_ms", "nonce")}
                cp["remaining_ms"] = max(0, int((self.cp["deadline"] - time.monotonic()) * 1000))
            return {
                "robot": self.key.address,
                "mission_id": self.manifest["mission_id"] if self.manifest else None,
                "sim": s,
                "checkpoint": cp,
                "log_len": len(self.log.entries) if self.log else 0,
                "outbox_pending": self.outbox.pending,
                "outbox_error": self.outbox.last_error,
                "samples": self.sim.samples[since:] if self.sim else [],
                "events": list(self.events)[-40:],
                "backends": available_backends(),
                "speed": self.speed,
            }

    def world_png(self) -> bytes:
        with self.lock:
            if self.sim is None or self.sim.world is None:
                return b""
            key = (id(self.sim), len(self.sim.world.defects))
            if self._preview[0] != key:
                self._preview = (key, self.sim.world.preview_png())
            return self._preview[1]


def make_handler(ad: Adapter):
    class H(BaseHTTPRequestHandler):
        def log_message(self, *a):  # quiet
            pass

        def _send(self, code: int, obj: Any = None, raw: Optional[bytes] = None, ctype: str = "application/json"):
            body = raw if raw is not None else json.dumps(obj).encode()
            self.send_response(code)
            self.send_header("content-type", ctype)
            self.send_header("content-length", str(len(body)))
            self.send_header("access-control-allow-origin", "*")
            self.end_headers()
            self.wfile.write(body)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header("access-control-allow-origin", "*")
            self.send_header("access-control-allow-headers", "content-type")
            self.send_header("access-control-allow-methods", "GET, POST, OPTIONS")
            self.end_headers()

        def do_GET(self):
            path, _, qs = self.path.partition("?")
            try:
                if path == "/health":
                    return self._send(200, {"ok": True, "robot": ad.key.address, "backends": available_backends()})
                if path == "/state":
                    since = int(dict(p.split("=", 1) for p in qs.split("&") if "=" in p).get("since", 0))
                    return self._send(200, ad.state(since))
                if path == "/world.png":
                    return self._send(200, raw=ad.world_png(), ctype="image/png")
                m = re.match(r"^/crop/(\d+)\.png$", path)
                if m:
                    png = ad.crops.get(int(m.group(1)))
                    return self._send(200, raw=png, ctype="image/png") if png else self._send(404, {"error": "no crop"})
                if path == "/entries":
                    return self._send(200, {"entries": ad.log.entries if ad.log else []})
                return self._send(404, {"error": "not found"})
            except Exception as e:  # noqa: BLE001
                return self._send(500, {"ok": False, "error": str(e)})

        def do_POST(self):
            n = int(self.headers.get("content-length") or 0)
            try:
                req = json.loads(self.rfile.read(n) or b"{}")
            except Exception:
                return self._send(400, {"ok": False, "error": "bad json"})
            routes = {
                "/mission/prepare": ad.prepare,
                "/mission/go": lambda r: ad.go(),
                "/world/place": ad.place,
                "/decision": lambda r: ad.submit_decision(r.get("bundle") or r, source=r.get("source", "console")),
                "/human": ad.human,
                "/estop": lambda r: ad.estop(),
                "/sign": ad.sign,
                "/counterfactual": ad.counterfactual,
                "/replay": ad.replay_check,
            }
            fn = routes.get(self.path)
            if fn is None:
                return self._send(404, {"ok": False, "error": "not found"})
            try:
                out = fn(req)
                return self._send(200, dict(out, ok=out.get("ok", True)) if isinstance(out, dict) else out)
            except (ValueError, KeyError) as e:
                return self._send(400, {"ok": False, "error": str(e)})
            except Exception as e:  # noqa: BLE001
                traceback.print_exc()
                return self._send(500, {"ok": False, "error": str(e)})

    return H


def load_dotenv(path: str) -> None:
    if not os.path.exists(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


def main(argv=None) -> None:
    here = os.path.dirname(os.path.abspath(__file__))
    load_dotenv(os.path.join(here, "..", "..", os.environ.get("BLACKBOX_ENV", ".env")))
    ap = argparse.ArgumentParser(description="Blackbox robot adapter")
    ap.add_argument("--port", type=int, default=int(os.environ.get("ROBOT_PORT", 8801)))
    ap.add_argument("--host", default=os.environ.get("ROBOT_HOST", "127.0.0.1"))
    ap.add_argument("--core", default=os.environ.get("CORE_URL", "http://127.0.0.1:8787"))
    ap.add_argument("--data", default=os.environ.get("ROBOT_DATA_DIR", os.path.join(here, "..", "data")))
    ap.add_argument("--speed", type=float, default=float(os.environ.get("SIM_SPEED", 1.0)))
    ap.add_argument("--textures", default=os.environ.get("BLACKBOX_TEXTURE_DIR") or None)
    ap.add_argument("--driver", choices=["sim", "rover"], default=os.environ.get("ROBOT_DRIVER", "sim"))
    args = ap.parse_args(argv)

    pk = os.environ.get("ROBOT_PRIVATE_KEY")
    if pk:
        key = RobotKey(pk)
    else:
        key = RobotKey.generate()
        print("[adapter] WARNING: ROBOT_PRIVATE_KEY not set - using a throwaway key "
              "(it is not a zerobot operator, so on-chain registration will revert)")
    ad = Adapter(key, args.core, os.path.abspath(args.data), args.speed, args.textures, args.driver)
    srv = ThreadingHTTPServer((args.host, args.port), make_handler(ad))
    body = "rover hardware" if args.driver == "rover" else f"sim, physics {available_backends()[0]}, speed x{args.speed}"
    print(f"[adapter] robot {key.address} listening on http://{args.host}:{args.port} (core {args.core}, {body})",
          flush=True)
    srv.serve_forever()


if __name__ == "__main__":
    main()
