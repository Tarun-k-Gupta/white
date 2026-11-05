import json
import os
import shutil
import sys
import tempfile
import time
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from eth_account import Account  # noqa: E402

from blackbox_robot.adapter import Adapter  # noqa: E402
from blackbox_robot.canonical import canonical_json, go_json  # noqa: E402
from blackbox_robot.crypto import RobotKey, checkpoint_nonce  # noqa: E402
from blackbox_robot.episode_log import verify_entries  # noqa: E402
from blackbox_robot.interlock import verify_bundle  # noqa: E402
from blackbox_robot.replay import force_override, replay  # noqa: E402
from helpers import TEE, make_bundle, manifest  # noqa: E402

MID = "0x" + "ab" * 32
POLICY = manifest(MID, "0x0")["policy"]


def answer(nonce, label="crack", action="descend", severity=2):
    return {"nonce": nonce, "label": label, "severity": severity, "action": action}


class EncodingTest(unittest.TestCase):
    def test_canonical_rejects_floats(self):
        with self.assertRaises(ValueError):
            canonical_json({"a": 1.5})
        self.assertEqual(canonical_json({"b": 1, "a": [True, None, "é"]}), '{"a":[true,null,"é"],"b":1}')

    def test_go_json_matches_go_marshal(self):
        # Expected strings are what Go's encoding/json produces for the decoded map.
        self.assertEqual(go_json({"b": 1, "a": "<&> \n\x01"}), '{"a":"\\u003c\\u0026\\u003e\\u2028\\n\\u0001","b":1}')
        self.assertEqual(go_json([1.0, 0.5, 1.5e16, 1e-7, 1e21, 12345678]),
                         "[1,0.5,15000000000000000,1e-7,1e+21,12345678]")


class InterlockTest(unittest.TestCase):
    nonce = checkpoint_nonce(MID, "0x" + "cd" * 32, 0)

    def test_accepts_signed_answer(self):
        r = verify_bundle(make_bundle(MID, 0, answer(self.nonce)), POLICY, self.nonce)
        self.assertTrue(r["accepted"], r["reason"])
        self.assertEqual(r["binding"], "go")

    def test_refuses_non_allowlisted_signer(self):
        forger = Account.create()
        r = verify_bundle(make_bundle(MID, 0, answer(self.nonce, "decoy", "continue", 0), signer=forger),
                          POLICY, self.nonce)
        self.assertFalse(r["accepted"])
        self.assertIn("not on the manifest allowlist", r["reason"])

    def test_refuses_tampered_answer_with_real_signature(self):
        r = verify_bundle(make_bundle(MID, 0, answer(self.nonce), tamper_action="continue"), POLICY, self.nonce)
        self.assertFalse(r["accepted"])
        self.assertIn("does not cover this answer", r["reason"])

    def test_refuses_wrong_nonce(self):
        r = verify_bundle(make_bundle(MID, 0, answer("0x" + "00" * 32)), POLICY, self.nonce)
        self.assertFalse(r["accepted"])
        self.assertIn("nonce mismatch", r["reason"])

    def test_refuses_unsigned(self):
        b = make_bundle(MID, 0, answer(self.nonce))
        b["tee"] = {}
        self.assertIn("no TEE signature", verify_bundle(b, POLICY, self.nonce)["reason"])

    def test_refuses_extra_keys(self):
        b = make_bundle(MID, 0, dict(answer(self.nonce), why="because"))
        self.assertIn("does not parse", verify_bundle(b, POLICY, self.nonce)["reason"])


class AdapterFlowTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.key = RobotKey.generate()
        self.ad = Adapter(self.key, "http://127.0.0.1:9", self.tmp, speed=60.0)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _start(self, lease_ms=60000, defects=None):
        m = manifest(MID, self.key.address, lease_ms)
        self.ad.prepare({"manifest_text": json.dumps(m), "manifest_root": "0x" + "55" * 32,
                         "defects": defects or []})
        self.ad.go()

    def _wait_cp(self, timeout=20):
        end = time.time() + timeout
        while time.time() < end:
            cp = self.ad.cp
            if cp and cp["status"] == "waiting":
                return cp
            if self.ad.sim.final:
                return None
            time.sleep(0.01)
        self.fail("no checkpoint")

    def _wait_end(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end and not self.ad.sim.final:
            time.sleep(0.02)
        self.assertIsNotNone(self.ad.sim.final)
        time.sleep(0.05)

    def test_full_mission_forgery_refused_and_replay_matches(self):
        self._start(defects=[{"kind": "crack", "x_mm": 6000, "y_mm": 1300, "variant": 0},
                             {"kind": "decoy", "x_mm": 15000, "y_mm": 4000, "variant": 1}])
        # checkpoint 0: a forged "continue" first, then the real answer
        cp = self._wait_cp()
        forged = make_bundle(MID, cp["k"], answer(cp["nonce"], "decoy", "continue", 0), signer=Account.create())
        self.assertFalse(self.ad.submit_decision(forged, "console")["accepted"])
        tampered = make_bundle(MID, cp["k"], answer(cp["nonce"]), tamper_action="continue")
        self.assertFalse(self.ad.submit_decision(tampered, "core")["accepted"])
        self.assertTrue(self.ad.submit_decision(make_bundle(MID, cp["k"], answer(cp["nonce"])), "core")["accepted"])
        # checkpoint 1: the decoy
        cp = self._wait_cp()
        self.assertTrue(self.ad.submit_decision(
            make_bundle(MID, cp["k"], answer(cp["nonce"], "decoy", "continue", 0)), "core")["accepted"])
        self._wait_end()

        entries = self.ad.log.entries
        kinds = [e["kind"] for e in entries]
        self.assertEqual(kinds.count("rejected"), 2)
        self.assertEqual(kinds.count("decision"), 2)
        self.assertEqual(kinds[-1], "mission_end")
        self.assertIsNone(verify_entries(entries, self.key.address))
        res = replay(entries)
        self.assertTrue(res["match"], res)
        cf = replay(entries, override=force_override("continue"))
        self.assertNotEqual(cf["trajectory_hash"], res["trajectory_hash"])

        # editing one field after the fact is caught and names the entry
        bad = json.loads(json.dumps(entries))
        i = kinds.index("decision")
        bad[i]["body"]["answer"]["severity"] = 0
        self.assertIn(f"entry {i}", verify_entries(bad, self.key.address))

    def test_lease_expiry_safe_stops_without_a_decision(self):
        self._start(lease_ms=500, defects=[{"kind": "crack", "x_mm": 6000, "y_mm": 1300, "variant": 0}])
        self._wait_cp()
        self._wait_end()
        stops = [e for e in self.ad.log.entries if e["kind"] == "safe_stop"]
        self.assertEqual(len(stops), 1)
        self.assertEqual(stops[0]["body"]["reason"], "0G unreachable, no decision made")
        self.assertEqual(self.ad.sim.final, "safe_stopped")
        self.assertEqual([e for e in self.ad.log.entries if e["kind"] == "decision"], [])
        self.assertTrue(replay(self.ad.log.entries)["match"])

    def test_sign_refuses_heads_not_in_log(self):
        self._start()
        with self.assertRaises(ValueError):
            self.ad.sign({"type": "anchor", "mission_id": MID, "count": 1, "head": "0x" + "00" * 32,
                          "index_root": "0x" + "00" * 32})
        g = self.ad.log.entries[0]
        out = self.ad.sign({"type": "anchor", "mission_id": MID, "count": 1, "head": g["hash"],
                            "index_root": "0x" + "00" * 32})
        self.assertTrue(out["signature"].startswith("0x"))


if __name__ == "__main__":
    unittest.main()
