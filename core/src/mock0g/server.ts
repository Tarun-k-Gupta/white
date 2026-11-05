/**
 * DEV-ONLY stand-in for the 0G Router + one TeeML provider broker, so the full
 * loop runs offline and in CI. It is never a fallback: the core only talks to it
 * when ZG_MODE=mock, its signer is a local key that is NOT a 0G TEE signer, and
 * the dashboard and manifest label it as mock.
 *
 * Wire-compatible with what the real stack returns (see README "0G facts"):
 *   POST /v1/chat/completions  -> OpenAI body + x_0g_trace, header ZG-Res-Key
 *   GET  /v1/proxy/signature/:chatId -> {text: "sha256(req):sha256(resp)", signature (EIP-191)}
 *   GET  /v1/providers?model=  -> provider list
 *   POST /v1/decisions         -> calibrated probability (schema guessed; real one undocumented)
 *   GET  /mock/services/:addr  -> the on-chain service record shape
 */
import { createServer } from "node:http";
import { Wallet } from "ethers";
import { goJson, sha256Hex } from "../lib/canonical";
import { classify } from "./classify";

const PORT = Number(process.env.MOCK_0G_PORT ?? 8790);
const BASE = process.env.MOCK_0G_URL ?? `http://127.0.0.1:${PORT}`;
const LATENCY = Number(process.env.MOCK_LATENCY_MS ?? 1200);
const TEE = new Wallet(process.env.MOCK_TEE_KEY ?? "0x" + "0e".repeat(32));
const PROVIDER = new Wallet("0x" + "0f".repeat(32)).address;
const MODEL_ID = "0GM-1.0-35B-A3B";
const sigs = new Map<string, { text: string; signature: string }>();

function json(res: any, code: number, obj: unknown, headers: Record<string, string> = {}, raw?: string) {
  res.writeHead(code, { "content-type": "application/json", "access-control-allow-origin": "*", "access-control-expose-headers": "ZG-Res-Key", ...headers });
  res.end(raw ?? JSON.stringify(obj));
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", BASE);
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const rawReq = Buffer.concat(chunks).toString("utf8");
  try {
    if (req.method === "GET" && url.pathname === "/v1/providers") {
      return json(res, 200, { object: "list", data: [{ address: PROVIDER, model_id: MODEL_ID, canonical_id: "0gm-1.0-35b-a3b", verifiability: "TeeML", trust_mode: "private", tee_acknowledged: true, provider_name: "MOCK (dev only)" }] });
    }
    const svc = url.pathname.match(/^\/mock\/services\/(0x[0-9a-fA-F]{40})$/);
    if (req.method === "GET" && svc) {
      if (svc[1].toLowerCase() !== PROVIDER.toLowerCase()) return json(res, 404, { error: "unknown provider" });
      return json(res, 200, {
        provider: PROVIDER, serviceType: "chatbot", url: BASE, model: MODEL_ID, verifiability: "TeeML",
        additionalInfo: JSON.stringify({ TargetSeparated: false, TargetTeeAddress: "", TEEVerifier: "mock" }),
        teeSignerAddress: TEE.address, teeSignerAcknowledged: true,
      });
    }
    const sig = url.pathname.match(/^\/v1\/proxy\/signature\/([^/]+)$/);
    if (req.method === "GET" && sig) {
      const s = sigs.get(decodeURIComponent(sig[1]).toLowerCase());
      if (!s) return json(res, 404, { error: "Chat id not found or expired", code: "chat_id_not_found" });
      return json(res, 200, { ...s, signing_address: TEE.address, signing_algo: "ecdsa" });
    }
    if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
      if (!/^Bearer sk-/.test(String(req.headers.authorization ?? ""))) return json(res, 401, { error: { message: "missing sk- key" } });
      const body = JSON.parse(rawReq);
      const user = body.messages?.find((m: any) => m.role === "user");
      const parts = Array.isArray(user?.content) ? user.content : [{ type: "text", text: String(user?.content ?? "") }];
      const text = parts.filter((p: any) => p.type === "text").map((p: any) => p.text).join("\n");
      const img = parts.find((p: any) => p.type === "image_url")?.image_url?.url ?? "";
      const nonce = (text.match(/nonce:\s*(0x[0-9a-fA-F]+)/) ?? [])[1] ?? "";
      const verdict = img.startsWith("data:image/png;base64,") ? classify(Buffer.from(img.split(",")[1], "base64")) : { label: "unsure", severity: 0, action: "descend" };
      await sleep(LATENCY * (0.75 + Math.random() * 0.5));
      const chatKey = crypto.randomUUID();
      const broker = {
        id: `chatcmpl-${chatKey}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: MODEL_ID,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ nonce, ...verdict }) } }],
        usage: { prompt_tokens: 900 + Math.floor(Math.random() * 50), completion_tokens: 38, total_tokens: 950 },
      };
      const brokerBytes = goJson(broker);
      const signedText = `${sha256Hex(rawReq)}:${sha256Hex(brokerBytes)}`;
      sigs.set(chatKey, { text: signedText, signature: TEE.signMessageSync(signedText) });
      const trace: Record<string, unknown> = { request_id: crypto.randomUUID(), provider: PROVIDER, billing: { input_cost: "19000000000000", output_cost: "1916800000000000", total_cost: "1935800000000000" } };
      if (body.verify_tee) trace.tee_verified = true;
      return json(res, 200, null, { "ZG-Res-Key": chatKey }, goJson({ ...broker, x_0g_trace: trace }));
    }
    if (req.method === "POST" && url.pathname === "/v1/decisions") {
      const body = JSON.parse(rawReq);
      const unsure = /label=unsure/.test(String(body.state));
      await sleep(LATENCY / 3);
      return json(res, 200, { id: crypto.randomUUID(), model: body.model, answers: { confident: { type: "noul", probability: unsure ? 0.41 : 0.93 } }, x_0g_trace: { request_id: crypto.randomUUID(), provider: PROVIDER } });
    }
    if (req.method === "GET" && url.pathname === "/v1/models") return json(res, 200, { data: [{ id: "0gm-1.0-35b-a3b", verifiability: "TeeML" }] });
    json(res, 404, { error: "not found" });
  } catch (e) {
    json(res, 500, { error: (e as Error).message });
  }
}).listen(PORT, "127.0.0.1", () => {
  console.log(`[mock0g] DEV-ONLY 0G mock on ${BASE} - TEE signer ${TEE.address} (NOT a 0G signer), provider ${PROVIDER}, latency ~${LATENCY} ms`);
});
