/**
 * One checkpoint decision on 0G: sealed vision call -> TEE signature -> bundle.
 * The bundle carries the exact Router response bytes so the robot adapter can
 * re-derive the answer and check the TEE signature covers it.
 */
import type { Config } from "../config";
import { sha256Hex } from "../lib/canonical";
import { type Bundle, type InterlockResult, type Policy, expectedEcho, verifyBundle } from "../lib/interlock";
import { RouterClient } from "./router";
import { ServiceDirectory, fetchSignature } from "./services";

export const SYSTEM_PROMPT = `You are the sealed decision model of Blackbox, an autonomous bridge-deck inspection drone.
The image is a top-down camera crop of one grid cell of a concrete deck. The on-board detector flagged it because it contains a dark or high-contrast mark. Decide what the mark is.
- "crack": a structural crack in the concrete: an irregular, jagged or branching thin dark fracture.
- "decoy": a harmless crack-like mark: painted line, cable or wire, tar seam, saw-cut joint, twig, shadow or stain.
- "unsure": you cannot tell.
severity: integer 0-3 (0 none, 1 hairline, 2 moderate, 3 severe). Use 0 for decoys.
action: "descend" to inspect closely (cracks, and unsure), "continue" to skip (decoys).
Reply with exactly one JSON object and nothing else, copying the nonce from the user message exactly:
{"nonce":"<nonce>","label":"crack|decoy|unsure","severity":0,"action":"descend|continue"}`;

export interface CheckpointRequest {
  mission_id: string;
  checkpoint: number;
  step: number;
  nonce: string;
  obs_hash: string;
  pix_hash: string;
  pose_mm: number[];
  target_mm: number[];
  detector_score: number;
  crop_png_b64: string;
  deadline_ms: number;
}

export interface AllowlistEntry {
  provider: string;
  signer: string;
  url: string;
  endpoint: string;
  verifiability: string;
  source: string;
}

export class ZgDecider {
  constructor(
    private cfg: Config,
    public router: RouterClient,
    public services: ServiceDirectory,
  ) {}

  visionBody(req: CheckpointRequest, policy: Policy) {
    const echo = expectedEcho(req.nonce, policy.nonce_hex_len ?? 64);
    const body: Record<string, unknown> = {
      model: this.cfg.zg.visionModel,
      temperature: 0,
      max_tokens: 300,
      response_format: { type: "json_object" },
      verify_tee: true,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            { type: "text", text: `nonce: ${echo}\nMission ${req.mission_id.slice(0, 10)}, checkpoint ${req.checkpoint}. Classify this crop.` },
            { type: "image_url", image_url: { url: `data:image/png;base64,${req.crop_png_b64}` } },
          ],
        },
      ],
    };
    for (const [k, v] of Object.entries(this.cfg.zg.extraBody)) {
      if (v === null) delete body[k];
      else body[k] = v;
    }
    return body;
  }

  /** Ask 0G; re-ask once inside the lease if the model's answer does not parse or echo the nonce. */
  async decide(req: CheckpointRequest, policy: Policy): Promise<{ bundle: Bundle; precheck: InterlockResult }> {
    const deadline = Date.now() + Math.max(500, req.deadline_ms - 250);
    let out: { bundle: Bundle; precheck: InterlockResult } | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const left = deadline - Date.now();
      if (left < 300) break;
      const r = await this.router.post("/chat/completions", this.visionBody(req, policy), left);
      const bundle = await this.toBundle(req, r, deadline);
      const precheck = verifyBundle(bundle, policy, req.nonce);
      out = { bundle, precheck };
      const modelError = precheck.reason.startsWith("answer does not parse") || precheck.reason.startsWith("nonce mismatch");
      if (!modelError) break;
    }
    if (!out) throw new Error("no time left in the lease to ask 0G");
    if (out.precheck.accepted && this.cfg.zg.decisionModel && out.precheck.answer) {
      out.bundle.decision_model = await this.decisionModel(req, out.precheck.answer, deadline);
    }
    return out;
  }

  private async toBundle(req: CheckpointRequest, r: Awaited<ReturnType<RouterClient["post"]>>, deadline: number) {
    let body: any = {};
    try {
      body = JSON.parse(r.rawResponse);
    } catch {
      /* the robot will refuse it as unparseable */
    }
    const trace = body?.x_0g_trace ?? {};
    const header = r.headers["zg-res-key"];
    const ids = [header, typeof body?.id === "string" ? body.id.replace(/^chatcmpl-/, "") : null, body?.id]
      .filter((x): x is string => typeof x === "string" && !!x)
      .filter((x, i, a) => a.indexOf(x) === i);
    const bundle: Bundle & Record<string, unknown> = {
      mission_id: req.mission_id,
      checkpoint: req.checkpoint,
      endpoint: r.endpoint.name,
      router_url: r.endpoint.url,
      request_id: trace.request_id ?? null,
      chat_id: ids[0] ?? null,
      chat_id_source: header ? "header" : ids.length ? "body" : null,
      provider: trace.provider ?? null,
      model: this.cfg.zg.visionModel,
      router_tee_verified: typeof trace.tee_verified === "boolean" ? trace.tee_verified : null,
      latency_ms: r.latencyMs,
      request_sha256: sha256Hex(r.requestBody),
      raw_response: r.rawResponse,
      tee: {},
    };
    if (!trace.provider) {
      bundle.tee_error = "response carries no x_0g_trace.provider";
      return bundle;
    }
    try {
      const svc = await this.services.get(trace.provider);
      const sig = await fetchSignature(svc, ids, Math.max(1000, Math.min(6000, deadline - Date.now())));
      bundle.chat_id = sig.chatId;
      bundle.chat_id_source = sig.chatId === header ? "header" : "body";
      bundle.tee = { text: sig.text, signature: sig.signature, signing_address: sig.signing_address, service_url: svc.url };
    } catch (e) {
      bundle.tee_error = (e as Error).message.slice(0, 300);
    }
    return bundle;
  }

  /** R16: calibrated hold. Text-only decision model over the vision answer; below threshold -> ask a human. */
  private async decisionModel(req: CheckpointRequest, a: { label: string; severity: number; action: string }, deadline: number) {
    const model = this.cfg.zg.decisionModel;
    const threshold = this.cfg.zg.holdBelowPermille;
    const state =
      `Bridge-deck inspection drone, checkpoint ${req.checkpoint}. The on-board detector flagged a mark ` +
      `(score ${req.detector_score}/255). The sealed vision model classified the camera crop as ` +
      `label=${a.label}, severity=${a.severity}, and proposes action=${a.action}.`;
    const body = {
      model,
      state,
      questions: {
        confident: {
          type: "noul",
          instructions: "Is this classification clear-cut enough for the drone to act on it without asking a human?",
        },
      },
      verify_tee: true,
    };
    try {
      const r = await this.router.post("/decisions", body, Math.max(300, deadline - Date.now()));
      const j = JSON.parse(r.rawResponse);
      const p = findProbability(j);
      if (p === null)
        return { model, hold: false, error: "no probability found in /v1/decisions response", raw_response: r.rawResponse.slice(0, 2000) };
      const pm = Math.round(p * 1000);
      return {
        model,
        probability_permille: pm,
        hold_below_permille: threshold,
        hold: pm < threshold,
        reason: pm < threshold ? `confidence ${pm}/1000 below ${threshold}` : "confident",
        request_id: j?.x_0g_trace?.request_id ?? null,
        raw_response: r.rawResponse.slice(0, 2000),
      };
    } catch (e) {
      return { model, hold: false, error: (e as Error).message.slice(0, 300) };
    }
  }

  async allowlist(): Promise<{ signers: string[]; providers: AllowlistEntry[] }> {
    const found = await this.router.providers(this.cfg.zg.visionModel);
    const providers: AllowlistEntry[] = [];
    for (const p of found) {
      try {
        const s = await this.services.get(p.address);
        if (!s.teeSignerAcknowledged || !/tee/i.test(s.verifiability)) continue;
        providers.push({ provider: s.provider, signer: s.teeSigner, url: s.url, endpoint: p.endpoint.name, verifiability: s.verifiability, source: s.source });
      } catch {
        /* unreadable service record: not allowlisted */
      }
    }
    const signers = [...new Set([...providers.map((p) => p.signer), ...this.cfg.zg.extraSigners].map((s) => s.toLowerCase()))];
    return { signers, providers };
  }
}

/** /v1/decisions response schema is undocumented: look for the answer's probability. */
export function findProbability(j: any): number | null {
  const keys = ["probability", "prob", "p", "confidence", "score", "yes"];
  const seen = new Set<any>();
  const walk = (o: any, depth: number): number | null => {
    if (!o || typeof o !== "object" || depth > 6 || seen.has(o)) return null;
    seen.add(o);
    for (const k of keys) {
      const v = o[k];
      if (typeof v === "number" && v >= 0 && v <= 1) return v;
    }
    for (const v of Object.values(o)) {
      const r = walk(v, depth + 1);
      if (r !== null) return r;
    }
    return null;
  };
  return walk(j?.answers?.confident ?? j?.answers ?? j?.results ?? j, 0);
}
