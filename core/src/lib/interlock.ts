/**
 * TypeScript mirror of robot/blackbox_robot/interlock.py. The robot adapter is
 * the authority that refuses to move; the core uses this to pre-check (and
 * re-ask 0G once on a bad answer) and the verifier re-runs it on every entry.
 */
import { AbiCoder, keccak256, verifyMessage } from "ethers";
import { goJson, sha256Hex } from "./canonical";

export const LABELS = ["crack", "decoy", "unsure"] as const;
export const ACTIONS = ["descend", "continue"] as const;
export type Answer = { nonce: string; label: string; severity: number; action: "descend" | "continue" };

export interface Bundle {
  mission_id: string;
  checkpoint: number;
  endpoint?: string;
  router_url?: string;
  request_id?: string | null;
  chat_id?: string | null;
  chat_id_source?: string | null;
  provider?: string | null;
  model?: string;
  router_tee_verified?: boolean | null;
  latency_ms?: number;
  request_sha256?: string;
  raw_response: string;
  tee: { text?: string; signature?: string; signing_address?: string; service_url?: string };
  decision_model?: Record<string, unknown> | null;
}

export interface Policy {
  tee_signers: string[];
  tee_binding?: string;
  nonce_hex_len?: number;
}

export interface InterlockResult {
  accepted: boolean;
  reason: string;
  answer: Answer | null;
  signer: string | null;
  binding: string | null;
}

export function checkpointNonce(missionId: string, obsHash: string, k: number): string {
  return keccak256(AbiCoder.defaultAbiCoder().encode(["bytes32", "bytes32", "uint256"], [missionId, obsHash, k]));
}

export const expectedEcho = (nonce: string, hexLen = 64) => "0x" + nonce.slice(2, 2 + hexLen);

export function extractContent(raw: string): string {
  let body: any;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error("response has no choices[0].message.content (bad JSON)");
  }
  let c = body?.choices?.[0]?.message?.content;
  if (Array.isArray(c)) c = c.map((p: any) => (p && typeof p === "object" ? p.text ?? "" : "")).join("");
  if (typeof c !== "string") throw new Error("response has no choices[0].message.content");
  return c;
}

export function parseAnswer(content: string): Answer {
  let s = content.trim().replace(/^<think>[\s\S]*?<\/think>/, "").trim();
  if (s.startsWith("```")) s = s.replace(/^```[a-zA-Z]*\s*/, "").replace(/\s*```$/, "");
  let o: any;
  try {
    o = JSON.parse(s);
  } catch {
    throw new Error("answer is not JSON");
  }
  if (!o || typeof o !== "object" || Array.isArray(o)) throw new Error("answer is not a JSON object");
  const keys = Object.keys(o).sort().join(",");
  if (keys !== "action,label,nonce,severity") throw new Error(`answer keys [${keys}] != [action,label,nonce,severity]`);
  if (typeof o.nonce !== "string") throw new Error("nonce is not a string");
  if (!LABELS.includes(o.label)) throw new Error(`label ${JSON.stringify(o.label)} not allowed`);
  if (typeof o.severity !== "number" || !Number.isInteger(o.severity) || o.severity < 0 || o.severity > 3)
    throw new Error("severity must be an integer 0-3");
  if (!ACTIONS.includes(o.action)) throw new Error(`action ${JSON.stringify(o.action)} not allowed`);
  return { nonce: o.nonce.toLowerCase(), label: o.label, severity: o.severity, action: o.action };
}

const HEX64 = /^[0-9a-f]{64}$/;

export function splitSignedText(text: string): [string, string] | null {
  const parts = text.split(":");
  for (let i = 0; i < parts.length - 1; i++) if (HEX64.test(parts[i]) && HEX64.test(parts[i + 1])) return [parts[i], parts[i + 1]];
  return null;
}

export function responseHashCandidates(raw: string): Record<string, string> {
  const out: Record<string, string> = { raw: sha256Hex(raw) };
  try {
    const body = JSON.parse(raw);
    if (body && typeof body === "object" && !Array.isArray(body)) {
      const stripped = Object.fromEntries(Object.entries(body).filter(([k]) => !k.startsWith("x_0g")));
      out.go = sha256Hex(goJson(stripped));
    }
  } catch {
    /* not JSON */
  }
  return out;
}

export function allowedBindings(policy: Policy): string[] {
  const mode = policy.tee_binding ?? "auto";
  if (mode === "auto") return ["raw", "go", "content"];
  return mode
    .split(",")
    .map((s) => s.trim())
    .filter((s) => ["raw", "go", "content"].includes(s));
}

export function checkBinding(text: string, raw: string, content: string, allowed: string[]): string | null {
  const h = splitSignedText(text);
  if (h) {
    const c = responseHashCandidates(raw);
    for (const name of ["raw", "go"]) if (allowed.includes(name) && c[name] === h[1]) return name;
  }
  if (allowed.includes("content") && text === content) return "content";
  return null;
}

export function verifyBundle(b: Pick<Bundle, "raw_response" | "tee">, policy: Policy, nonce: string): InterlockResult {
  const r: InterlockResult = { accepted: false, reason: "", answer: null, signer: null, binding: null };
  if (typeof b.raw_response !== "string") return { ...r, reason: "answer does not parse: no raw response" };
  let content: string;
  try {
    content = extractContent(b.raw_response);
    r.answer = parseAnswer(content);
  } catch (e) {
    return { ...r, reason: `answer does not parse: ${(e as Error).message}` };
  }
  const want = expectedEcho(nonce, policy.nonce_hex_len ?? 64);
  if (r.answer.nonce !== want)
    return { ...r, reason: `nonce mismatch: answer echoed ${r.answer.nonce.slice(0, 18)}... expected ${want.slice(0, 18)}...` };
  const { text, signature } = b.tee ?? {};
  if (typeof text !== "string" || typeof signature !== "string" || !signature)
    return { ...r, reason: "unsigned decision rejected: no TEE signature" };
  try {
    r.signer = verifyMessage(text, signature);
  } catch {
    return { ...r, reason: "unsigned decision rejected: TEE signature is malformed" };
  }
  const allow = new Set(policy.tee_signers.map((a) => a.toLowerCase()));
  if (!allow.has(r.signer.toLowerCase()))
    return { ...r, reason: `unsigned decision rejected: signer ${r.signer} is not on the manifest allowlist` };
  r.binding = checkBinding(text, b.raw_response, content, allowedBindings(policy));
  if (!r.binding) return { ...r, reason: "unsigned decision rejected: TEE signature does not cover this answer" };
  return { ...r, accepted: true, reason: "accepted" };
}
