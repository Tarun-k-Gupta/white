"""Verify before actuate.

The adapter acts on a checkpoint decision only if, in this order:
  1. the answer parses (strict JSON: nonce, label, severity, action), read from
     the raw Router response body itself, not from anything the core parsed;
  2. the answer echoes this checkpoint's nonce;
  3. the TEE signature recovers (EIP-191) to an address on the manifest allowlist;
  4. the signed text covers this exact response: 0G's broker signs
     "sha256(request):sha256(response bytes)", so the response hash must match
     the body we were handed.
Any failure is a refusal - never a default action. Mirrors core/src/lib/interlock.ts.
"""
from __future__ import annotations

import json
import re
from typing import Dict, List, Optional

from .canonical import go_json, sha256_hex
from .crypto import expected_echo, recover_text

LABELS = ("crack", "decoy", "unsure")
ACTIONS = ("descend", "continue")
ANSWER_KEYS = {"nonce", "label", "severity", "action"}
BINDINGS = ("raw", "go", "content")
_HEX64 = re.compile(r"^[0-9a-f]{64}$")


class AnswerError(ValueError):
    pass


def extract_content(raw_response: str) -> str:
    try:
        body = json.loads(raw_response)
        content = body["choices"][0]["message"]["content"]
    except Exception as e:  # noqa: BLE001
        raise AnswerError(f"response has no choices[0].message.content ({e.__class__.__name__})")
    if isinstance(content, list):
        content = "".join(p.get("text", "") for p in content if isinstance(p, dict))
    if not isinstance(content, str):
        raise AnswerError("content is not a string")
    return content


def parse_answer(content: str) -> dict:
    s = content.strip()
    s = re.sub(r"^<think>.*?</think>", "", s, flags=re.S).strip()
    if s.startswith("```"):
        s = re.sub(r"^```[a-zA-Z]*\s*", "", s)
        s = re.sub(r"\s*```$", "", s)
    try:
        obj = json.loads(s)
    except Exception:
        raise AnswerError("answer is not JSON")
    if not isinstance(obj, dict):
        raise AnswerError("answer is not a JSON object")
    if set(obj.keys()) != ANSWER_KEYS:
        raise AnswerError(f"answer keys {sorted(obj.keys())} != {sorted(ANSWER_KEYS)}")
    if not isinstance(obj["nonce"], str):
        raise AnswerError("nonce is not a string")
    if obj["label"] not in LABELS:
        raise AnswerError(f"label {obj['label']!r} not in {LABELS}")
    sev = obj["severity"]
    if isinstance(sev, bool) or not isinstance(sev, int) or not 0 <= sev <= 3:
        raise AnswerError("severity must be an integer 0-3")
    if obj["action"] not in ACTIONS:
        raise AnswerError(f"action {obj['action']!r} not in {ACTIONS}")
    return {"nonce": obj["nonce"].lower(), "label": obj["label"], "severity": sev, "action": obj["action"]}


def split_signed_text(text: str):
    """Return (request_sha256, response_sha256) from the broker's signed text, or None."""
    parts = text.split(":")
    for i in range(len(parts) - 1):
        if _HEX64.match(parts[i]) and _HEX64.match(parts[i + 1]):
            return parts[i], parts[i + 1]
    return None


def response_hash_candidates(raw_response: str) -> Dict[str, str]:
    """Ways the bytes the broker signed can be rebuilt from the Router's body.

    raw - the Router passed the broker's bytes through untouched.
    go  - the Router decoded the body, added its x_0g_* fields and re-marshalled
          with Go's encoding/json; removing those fields and re-marshalling the
          same way reproduces the broker's bytes.
    Run core/scripts/probe-0g.ts once against the live Router to see which holds.
    """
    out = {"raw": sha256_hex(raw_response.encode("utf-8"))}
    try:
        body = json.loads(raw_response)
        if isinstance(body, dict):
            stripped = {k: v for k, v in body.items() if not k.startswith("x_0g")}
            out["go"] = sha256_hex(go_json(stripped).encode("utf-8"))
    except Exception:
        pass
    return out


def check_binding(text: str, raw_response: str, content: str, allowed: List[str]) -> Optional[str]:
    hashes = split_signed_text(text)
    if hashes is not None:
        cands = response_hash_candidates(raw_response)
        for name in ("raw", "go"):
            if name in allowed and cands.get(name) == hashes[1]:
                return name
    if "content" in allowed and text == content:
        return "content"
    return None


def allowed_bindings(policy: dict) -> List[str]:
    mode = policy.get("tee_binding", "auto")
    if mode == "auto":
        return list(BINDINGS)
    return [m.strip() for m in mode.split(",") if m.strip() in BINDINGS]


def verify_bundle(bundle: dict, policy: dict, nonce: str) -> dict:
    """Returns {"accepted": bool, "reason": str, "answer": dict|None, "signer": str|None,
    "binding": str|None, "checks": {...}}."""
    checks = {"parsed": False, "nonce_ok": False, "signer_allowlisted": False, "binding": None}
    res = {"accepted": False, "reason": "", "answer": None, "signer": None, "binding": None, "checks": checks}

    raw = bundle.get("raw_response")
    if not isinstance(raw, str):
        res["reason"] = "answer does not parse: no raw response"
        return res
    try:
        content = extract_content(raw)
        answer = parse_answer(content)
    except AnswerError as e:
        res["reason"] = f"answer does not parse: {e}"
        return res
    checks["parsed"] = True
    res["answer"] = answer

    want = expected_echo(nonce, int(policy.get("nonce_hex_len", 64)))
    if answer["nonce"] != want:
        res["reason"] = f"nonce mismatch: answer echoed {answer['nonce'][:18]}... expected {want[:18]}..."
        return res
    checks["nonce_ok"] = True

    tee = bundle.get("tee") or {}
    text, sig = tee.get("text"), tee.get("signature")
    if not isinstance(text, str) or not isinstance(sig, str) or not sig:
        res["reason"] = "unsigned decision rejected: no TEE signature"
        return res
    try:
        signer = recover_text(text, sig)
    except Exception:
        res["reason"] = "unsigned decision rejected: TEE signature is malformed"
        return res
    res["signer"] = signer
    allow = {a.lower() for a in policy.get("tee_signers", [])}
    if signer.lower() not in allow:
        res["reason"] = f"unsigned decision rejected: signer {signer} is not on the manifest allowlist"
        return res
    checks["signer_allowlisted"] = True

    binding = check_binding(text, raw, content, allowed_bindings(policy))
    if binding is None:
        res["reason"] = "unsigned decision rejected: TEE signature does not cover this answer"
        return res
    checks["binding"] = binding
    res["binding"] = binding
    res["accepted"] = True
    res["reason"] = "accepted"
    return res
