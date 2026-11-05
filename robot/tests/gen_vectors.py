"""Emit cross-language test vectors as JSON on stdout (consumed by core/test/crosslang.test.ts)."""
import base64
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from eth_account import Account  # noqa: E402

from blackbox_robot.canonical import canonical_json, entry_hash, go_json  # noqa: E402
from blackbox_robot.crypto import RobotKey, checkpoint_nonce  # noqa: E402
from blackbox_robot.episode_log import EpisodeLog  # noqa: E402
from blackbox_robot.world import World  # noqa: E402
from helpers import TEE, make_bundle  # noqa: E402

MID = "0x" + "ab" * 32
values = [
    {"b": 1, "a": "<&> \n\x01\"\\é😀", "c": [True, False, None, 0, -5, 1730000000123]},
    {"z": {"y": [], "x": {}}, "k": "plain"},
]
go_values = values + [[0.5, 1.5e16, 1e-7, 1e21, 0.1, 123.456, 2.0]]

nonce = checkpoint_nonce(MID, "0x" + "cd" * 32, 3)
ans = {"nonce": nonce, "label": "crack", "severity": 2, "action": "descend"}
bundles = {
    "good": make_bundle(MID, 3, ans),
    "forged": make_bundle(MID, 3, dict(ans, label="decoy", action="continue", severity=0), signer=Account.create()),
    "tampered": make_bundle(MID, 3, ans, tamper_action="continue"),
}

key = RobotKey("0x" + "22" * 32)
log = EpisodeLog(MID, key)
log.append("mission_start", 0, {"manifest": {"seed": 1}, "note": "é<>&"})
log.append("decision", 4170, {"checkpoint": 0, "answer": ans, "pose_mm": [6072, 1375, 3001]})

w = World(24000, 8000, 42)
crops = {}
for i, (kind, variant) in enumerate([("crack", v) for v in range(5)] + [("decoy", 0), ("decoy", 1)]):
    x = 2000 + i * 3000
    w.add_defect(kind, x, 4000, variant)
    png, _ = w.crop(x, 4000)
    crops[f"{kind}-{variant}"] = base64.b64encode(png).decode()

print(json.dumps({
    "canonical": [[v, canonical_json(v)] for v in values],
    "go": [[v, go_json(v)] for v in go_values],
    "nonce": {"mission": MID, "obs": "0x" + "cd" * 32, "k": 3, "nonce": nonce},
    "tee": TEE.address,
    "bundles": bundles,
    "entries": log.entries,
    "entry_hashes": [entry_hash({k: v for k, v in e.items() if k not in ("hash", "robot_sig")}) for e in log.entries],
    "robot": key.address,
    "crops": crops,
}, ensure_ascii=False))
