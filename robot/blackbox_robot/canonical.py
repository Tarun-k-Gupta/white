"""Byte-exact JSON encodings shared with core/src/lib/canonical.ts.

canonical_json  - the episode-log encoding (sorted keys, compact, integers only).
go_json         - reproduces Go's encoding/json Marshal of a decoded map, which is
                  how 0G's serving broker re-serialises the response it signs.
"""
from __future__ import annotations

import hashlib
import json
import re
from decimal import Decimal
from typing import Any

from eth_utils import keccak as _keccak


def canonical_json(value: Any) -> str:
    _reject_floats(value)
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False)


def _reject_floats(value: Any, path: str = "$") -> None:
    if isinstance(value, bool) or value is None or isinstance(value, (int, str)):
        return
    if isinstance(value, float):
        raise ValueError(f"float at {path}: episode log entries must use integers")
    if isinstance(value, dict):
        for k, v in value.items():
            if not isinstance(k, str):
                raise ValueError(f"non-string key at {path}")
            _reject_floats(v, f"{path}.{k}")
        return
    if isinstance(value, (list, tuple)):
        for i, v in enumerate(value):
            _reject_floats(v, f"{path}[{i}]")
        return
    raise ValueError(f"unsupported type {type(value).__name__} at {path}")


def keccak_hex(data: bytes) -> str:
    return "0x" + _keccak(data).hex()


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def entry_hash(entry_without_hash: dict) -> str:
    return keccak_hex(canonical_json(entry_without_hash).encode("utf-8"))


# ---------------------------------------------------------------------------
# Go encoding/json emulation
# ---------------------------------------------------------------------------

_GO_ESCAPES = {
    '"': '\\"',
    "\\": "\\\\",
    "\n": "\\n",
    "\r": "\\r",
    "\t": "\\t",
    "\b": "\\b",
    "\f": "\\f",
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    " ": "\\u2028",
    " ": "\\u2029",
}


def _go_string(s: str) -> str:
    out = ['"']
    for ch in s:
        esc = _GO_ESCAPES.get(ch)
        if esc is not None:
            out.append(esc)
        elif ord(ch) < 0x20:
            out.append("\\u%04x" % ord(ch))
        else:
            out.append(ch)
    out.append('"')
    return "".join(out)


def _go_float(f: float) -> str:
    if f != f or f in (float("inf"), float("-inf")):
        raise ValueError("non-finite number")
    a = abs(f)
    if a == 0 or (1e-6 <= a < 1e21):
        if f == int(f):
            return str(int(f))
        r = repr(f)
        if "e" in r or "E" in r:
            return format(Decimal(r), "f")
        return r
    r = repr(f)  # e.g. '1e-07', '1.5e+21'
    return re.sub(r"e([+-])0(\d)$", r"e\1\2", r)


def go_json(value: Any) -> str:
    if value is None:
        return "null"
    if value is True:
        return "true"
    if value is False:
        return "false"
    if isinstance(value, int):
        return str(value)
    if isinstance(value, float):
        return _go_float(value)
    if isinstance(value, str):
        return _go_string(value)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(go_json(v) for v in value) + "]"
    if isinstance(value, dict):
        items = sorted(value.items(), key=lambda kv: kv[0])
        return "{" + ",".join(_go_string(k) + ":" + go_json(v) for k, v in items) + "}"
    raise ValueError(f"unsupported type {type(value).__name__}")
