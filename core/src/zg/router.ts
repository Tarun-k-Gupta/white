/**
 * 0G Router client (OpenAI-compatible, https://router-api.0g.ai/v1).
 * Sealed inference: X-0G-Provider-Trust-Mode: private routes only to TeeML
 * providers, and verify_tee asks the Router to check the TEE signature too.
 * Fails over across endpoints; never returns anything it did not get from 0G.
 */
import type { Config, Endpoint } from "../config";

export class ZgUnreachable extends Error {}

export interface LinkState {
  /** Demo kill switch: behaves exactly like the network path to 0G being cut. */
  down: boolean;
}

export interface RouterResult {
  endpoint: Endpoint;
  status: number;
  rawResponse: string;
  headers: Record<string, string>;
  requestBody: string;
  latencyMs: number;
}

export class RouterClient {
  constructor(
    private cfg: Config["zg"],
    public link: LinkState,
  ) {}

  get endpoints() {
    return this.cfg.endpoints;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.cfg.apiKey) h.authorization = `Bearer ${this.cfg.apiKey}`;
    if (this.cfg.trustMode) h["x-0g-provider-trust-mode"] = this.cfg.trustMode;
    return h;
  }

  /** POST {endpoint}{path} with failover. 4xx (other than 408/429) is a caller error and does not fail over. */
  async post(path: string, body: unknown, timeoutMs: number): Promise<RouterResult> {
    const requestBody = JSON.stringify(body);
    const errors: string[] = [];
    const started = Date.now();
    for (const ep of this.cfg.endpoints) {
      const left = timeoutMs - (Date.now() - started);
      if (left <= 50) break;
      if (this.link.down) {
        errors.push(`${ep.name}: link down`);
        continue;
      }
      const t0 = Date.now();
      try {
        const res = await fetch(ep.url + path, {
          method: "POST",
          headers: this.headers(),
          body: requestBody,
          signal: AbortSignal.timeout(left),
        });
        const rawResponse = await res.text();
        if (res.status >= 500 || res.status === 429 || res.status === 408) {
          errors.push(`${ep.name}: HTTP ${res.status} ${rawResponse.slice(0, 160)}`);
          continue;
        }
        if (!res.ok) throw new Error(`0G ${ep.name} HTTP ${res.status}: ${rawResponse.slice(0, 300)}`);
        const headers: Record<string, string> = {};
        res.headers.forEach((v, k) => (headers[k.toLowerCase()] = v));
        return { endpoint: ep, status: res.status, rawResponse, headers, requestBody, latencyMs: Date.now() - t0 };
      } catch (e) {
        if (e instanceof Error && e.message.startsWith("0G ")) throw e;
        errors.push(`${ep.name}: ${(e as Error).name === "TimeoutError" ? "timeout" : (e as Error).message}`);
      }
    }
    throw new ZgUnreachable(`0G unreachable (${errors.join("; ") || "no time left"})`);
  }

  async providers(model: string): Promise<{ endpoint: Endpoint; address: string; trust?: string }[]> {
    const out: { endpoint: Endpoint; address: string; trust?: string }[] = [];
    for (const ep of this.cfg.endpoints) {
      try {
        const res = await fetch(`${ep.url}/providers?model=${encodeURIComponent(model)}`, {
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) continue;
        const j: any = await res.json();
        for (const p of j.data ?? []) {
          if (String(p.canonical_id ?? p.model_id ?? "").toLowerCase() !== model.toLowerCase()) continue;
          out.push({ endpoint: ep, address: p.address, trust: p.trust_mode ?? p.verifiability });
        }
      } catch {
        /* endpoint offline: its providers just do not join the allowlist */
      }
    }
    return out;
  }
}
