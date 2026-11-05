"""Replay a mission from its episode log and check the trajectory hash.

    python -m blackbox_robot.replay --log data/<mission>.jsonl
    python -m blackbox_robot.replay --core http://localhost:8787 --mission 0x...
    python -m blackbox_robot.replay --log ... --force continue   # counterfactual

The replay re-runs the physics from the manifest seed, re-applies logged world
events and logged checkpoint outcomes, and re-renders every camera crop. It
never calls 0G: it only checks that the logged answers explain the motion.
"""
from __future__ import annotations

import argparse
import json
import sys
import urllib.request
from typing import Callable, Dict, List, Optional

from .episode_log import load_jsonl, verify_entries
from .mission import MissionSim


def _events(entries: List[dict]):
    world, outcomes, expected = [], {}, {}
    end = None
    for e in entries:
        b = e.get("body", {})
        kind = e.get("kind")
        if kind == "world":
            world.append((b["step"], e["seq"], "place", b["defect"]))
        elif kind == "decision":
            outcomes[b["checkpoint"]] = b["action_applied"]
            expected[b["checkpoint"]] = b
        elif kind == "human":
            outcomes[b["checkpoint"]] = b["action"]
        elif kind == "hold":
            expected[b["checkpoint"]] = b
        elif kind == "safe_stop":
            if b.get("checkpoint") is None:
                world.append((b["step"], e["seq"], "estop", None))
            else:
                outcomes[b["checkpoint"]] = "safe_stop"
                expected.setdefault(b["checkpoint"], b)
        elif kind == "mission_end":
            end = e
    world.sort(key=lambda t: (t[0], t[1]))
    return world, outcomes, expected, end


def replay(entries: List[dict], override: Optional[Callable[[int, Optional[str]], Optional[str]]] = None,
           texture_dir: Optional[str] = None, collect: bool = False) -> dict:
    if not entries or entries[0].get("kind") != "mission_start":
        raise ValueError("log must start with a mission_start entry")
    g = entries[0]["body"]
    manifest = g["manifest"]
    sim = MissionSim(manifest["mission_id"], manifest["seed"], manifest["sim"], texture_dir)
    try:
        for d in g.get("defects", []):
            sim.place(d["kind"], d["x_mm"], d["y_mm"], d["variant"])
        world, outcomes, expected, end = _events(entries)
        sim.start()
        mismatches: List[str] = []
        wi = 0
        replayed = 0
        while True:
            while wi < len(world) and world[wi][0] <= sim.step_idx:
                _, _, typ, payload = world[wi]
                if typ == "place":
                    sim.place(payload["kind"], payload["x_mm"], payload["y_mm"], payload["variant"])
                else:
                    sim.emergency_stop()
                wi += 1
            ev = sim.step()
            if ev is None:
                if not sim.running and sim.pending is None and sim.final is None:
                    mismatches.append(f"sim stalled in phase {sim.phase}")
                    break
                continue
            if ev["type"] == "done":
                break
            k = ev["k"]
            exp = expected.get(k)
            if exp is not None and override is None:
                if exp.get("pix_hash") != ev["pix_hash"]:
                    mismatches.append(f"checkpoint {k}: camera crop differs from the logged one")
                if exp.get("step") is not None and exp.get("step") != ev["step"]:
                    mismatches.append(f"checkpoint {k}: reached at step {ev['step']}, log says {exp['step']}")
            outcome = outcomes.get(k)
            if override is not None:
                outcome = override(k, outcome)
            if outcome is None:
                mismatches.append(f"checkpoint {k}: log has no outcome (log ends here)")
                break
            sim.resolve(outcome)
            replayed += 1
        traj = sim.trajectory_hash()
        logged = end["body"]["trajectory_hash"] if end else None
        out = {
            "mission_id": manifest["mission_id"],
            "backend": sim.backend,
            "trajectory_hash": traj,
            "logged_trajectory_hash": logged,
            "match": (logged == traj) and not mismatches if override is None else None,
            "checkpoints_replayed": replayed,
            "final": sim.final,
            "steps": sim.step_idx,
            "mismatches": mismatches,
        }
        if collect:
            out["samples"] = sim.samples
            out["inspected"] = sim.inspected
            out["checkpoints"] = sim.checkpoints
        return out
    finally:
        sim.close()


def force_override(action: str):
    def f(_k: int, outcome: Optional[str]) -> Optional[str]:
        if outcome in ("descend", "continue"):
            return action
        return outcome
    return f


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Replay a Blackbox mission and compare trajectory hashes.")
    ap.add_argument("--log", help="episode log (.jsonl, or .json list)")
    ap.add_argument("--core", help="core URL, e.g. http://localhost:8787")
    ap.add_argument("--mission", help="mission id when using --core")
    ap.add_argument("--force", choices=["continue", "descend"], help="counterfactual: override every 0G action")
    ap.add_argument("--textures", help="texture dir used by the live run, if any")
    args = ap.parse_args(argv)

    if args.log:
        if args.log.endswith(".jsonl"):
            entries = load_jsonl(args.log)
        else:
            with open(args.log, encoding="utf-8") as f:
                data = json.load(f)
            entries = data["entries"] if isinstance(data, dict) else data
    elif args.core and args.mission:
        with urllib.request.urlopen(f"{args.core.rstrip('/')}/api/missions/{args.mission}/entries") as r:
            entries = json.loads(r.read())["entries"]
    else:
        ap.error("give --log, or --core and --mission")
        return 2

    problem = verify_entries(entries, entries[0].get("robot") if entries else None)
    if problem:
        print(f"log integrity: FAIL - {problem}")
    else:
        print(f"log integrity: ok ({len(entries)} entries, hashes and robot signatures recomputed)")
    res = replay(entries, override=force_override(args.force) if args.force else None, texture_dir=args.textures)
    print(json.dumps(res, indent=2))
    if args.force:
        return 0
    print("REPLAY MATCH" if res["match"] else "REPLAY MISMATCH")
    return 0 if res["match"] and not problem else 1


if __name__ == "__main__":
    sys.exit(main())
