"""Robot-signed, keccak256-chained episode log (one canonical-JSON entry per event)."""
from __future__ import annotations

import json
import os
import threading
import time
from typing import List, Optional

from .canonical import entry_hash
from .crypto import RobotKey, recover_hash

ZERO_HASH = "0x" + "00" * 32
ENTRY_VERSION = 1


class EpisodeLog:
    def __init__(self, mission_id: str, key: RobotKey, path: Optional[str] = None):
        self.mission_id = mission_id
        self.key = key
        self.path = path
        self.entries: List[dict] = []
        self._lock = threading.Lock()
        if path:
            os.makedirs(os.path.dirname(path), exist_ok=True)

    @property
    def head(self) -> str:
        return self.entries[-1]["hash"] if self.entries else ZERO_HASH

    def append(self, kind: str, t_ms: int, body: dict) -> dict:
        with self._lock:
            e = {
                "v": ENTRY_VERSION,
                "mission_id": self.mission_id,
                "seq": len(self.entries),
                "kind": kind,
                "prev": self.head,
                "t_ms": int(t_ms),
                "wall_ms": int(time.time() * 1000),
                "robot": self.key.address,
                "body": body,
            }
            h = entry_hash(e)
            stored = dict(e, hash=h, robot_sig=self.key.sign_digest(bytes.fromhex(h[2:])))
            self.entries.append(stored)
            if self.path:
                with open(self.path, "a", encoding="utf-8") as f:
                    f.write(json.dumps(stored, ensure_ascii=False) + "\n")
            return stored


def verify_entries(entries: List[dict], robot: Optional[str] = None) -> Optional[str]:
    """Recompute hashes, prev links and robot signatures. Returns the first problem or None."""
    prev = ZERO_HASH
    for i, e in enumerate(entries):
        core = {k: v for k, v in e.items() if k not in ("hash", "robot_sig")}
        if e.get("seq") != i:
            return f"entry {i}: seq is {e.get('seq')}"
        if e.get("prev") != prev:
            return f"entry {i}: prev link broken"
        h = entry_hash(core)
        if h != e.get("hash"):
            return f"entry {i}: hash mismatch (content changed after signing)"
        signer = recover_hash(h, e.get("robot_sig", ""))
        if robot and signer.lower() != robot.lower():
            return f"entry {i}: robot signature by {signer}, expected {robot}"
        prev = h
    return None


def load_jsonl(path: str) -> List[dict]:
    with open(path, encoding="utf-8") as f:
        return [json.loads(line) for line in f if line.strip()]
