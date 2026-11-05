/**
 * Byte-exact encodings shared with robot/blackbox_robot/canonical.py.
 * Browser-safe: depends only on ethers.
 */
import { keccak256, sha256, toUtf8Bytes } from "ethers";

/** Episode-log encoding: sorted keys, compact, integers only. */
export function canonicalJson(v: unknown, path = "$"): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isInteger(v)) throw new Error(`non-integer number at ${path}`);
    return JSON.stringify(v);
  }
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x, i) => canonicalJson(x, `${path}[${i}]`)).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(o[k], `${path}.${k}`)).join(",") + "}";
  }
  throw new Error(`unsupported value at ${path}`);
}

const GO_ESC: Record<string, string> = {
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
};

function goString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const e = GO_ESC[ch];
    if (e !== undefined) out += e;
    else if (ch.charCodeAt(0) < 0x20) out += "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
    else out += ch;
  }
  return out + '"';
}

/**
 * Go encoding/json Marshal of a decoded map (sorted keys, HTML-escaped, compact).
 * 0G's serving broker re-marshals responses this way before signing them.
 */
export function goJson(v: unknown): string {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number");
    return String(v);
  }
  if (typeof v === "string") return goString(v);
  if (Array.isArray(v)) return "[" + v.map(goJson).join(",") + "]";
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return "{" + keys.map((k) => goString(k) + ":" + goJson(o[k])).join(",") + "}";
  }
  throw new Error("unsupported value");
}

export const utf8 = (s: string) => toUtf8Bytes(s);
export const keccakHex = (data: Uint8Array | string) => keccak256(typeof data === "string" ? utf8(data) : data);
/** Lowercase hex without 0x, like Go's hex.EncodeToString(sha256.Sum256(b)). */
export const sha256Hex = (data: Uint8Array | string) =>
  sha256(typeof data === "string" ? utf8(data) : data).slice(2);

export interface EntryCore {
  v: number;
  mission_id: string;
  seq: number;
  kind: string;
  prev: string;
  t_ms: number;
  wall_ms: number;
  robot: string;
  body: Record<string, any>;
}
export interface Entry extends EntryCore {
  hash: string;
  robot_sig: string;
}

export const ZERO_HASH = "0x" + "00".repeat(32);

export function entryHash(e: EntryCore | Entry): string {
  const { hash: _h, robot_sig: _s, ...core } = e as Entry;
  return keccakHex(canonicalJson(core));
}
