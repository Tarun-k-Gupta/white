"""Test helpers: build Router-shaped responses signed the way 0G's broker signs them."""
from __future__ import annotations

import json
import uuid

from eth_account import Account
from eth_account.messages import encode_defunct

from blackbox_robot.canonical import go_json, sha256_hex

TEE = Account.from_key("0x" + "11" * 32)  # stand-in TEE signer for tests only


def make_bundle(mission_id: str, k: int, answer: dict, signer=TEE, tamper_action: str = None) -> dict:
    req_body = json.dumps({"model": "0gm-1.0-35b-a3b", "nonce": answer.get("nonce")}).encode()
    chat = str(uuid.uuid4())
    broker = {
        "id": "chatcmpl-" + chat,
        "object": "chat.completion",
        "created": 1730000000,
        "model": "0GM-1.0-35B-A3B",
        "choices": [{"index": 0, "finish_reason": "stop",
                     "message": {"role": "assistant", "content": json.dumps(answer)}}],
        "usage": {"prompt_tokens": 812, "completion_tokens": 40, "total_tokens": 852},
    }
    broker_bytes = go_json(broker).encode()
    text = f"{sha256_hex(req_body)}:{sha256_hex(broker_bytes)}"
    sig = signer.sign_message(encode_defunct(text=text)).signature.hex()
    router = dict(broker, x_0g_trace={"request_id": str(uuid.uuid4()), "provider": "0x" + "22" * 20,
                                      "tee_verified": True, "billing": {"total_cost": "1935800000000000"}})
    if tamper_action:
        a = dict(answer, action=tamper_action)
        router["choices"] = [{"index": 0, "finish_reason": "stop",
                              "message": {"role": "assistant", "content": json.dumps(a)}}]
    return {
        "mission_id": mission_id,
        "checkpoint": k,
        "endpoint": "test",
        "router_url": "http://test",
        "request_id": router["x_0g_trace"]["request_id"],
        "chat_id": chat,
        "chat_id_source": "header",
        "provider": "0x" + "22" * 20,
        "model": "0gm-1.0-35b-a3b",
        "router_tee_verified": True,
        "latency_ms": 900,
        "request_sha256": sha256_hex(req_body),
        "raw_response": go_json(router),
        "tee": {"text": text, "signature": "0x" + sig.removeprefix("0x"),
                "signing_address": signer.address, "service_url": "http://test"},
    }


def manifest(mission_id: str, robot: str, lease_ms: int = 60000, backend: str = "native") -> dict:
    return {
        "v": 1,
        "kind": "blackbox.mission-manifest",
        "mission_id": mission_id,
        "robot_id": "0x" + "33" * 32,
        "robot": robot,
        "chain_id": 31337,
        "registry": "0x" + "44" * 20,
        "seed": 7,
        "sim": {"backend": backend},
        "policy": {"tee_signers": [TEE.address], "tee_binding": "auto", "nonce_hex_len": 64,
                   "lease_ms": lease_ms, "max_asks": 2, "anchor_every": 2, "human_timeout_ms": 60000},
    }
