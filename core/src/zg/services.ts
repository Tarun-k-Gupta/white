/**
 * Reads a provider's service record from 0G Compute's InferenceServing
 * contract (mainnet, chain 16661): the broker URL that serves signatures and
 * the TEE signer address. Same selection rule as the SDK's processResponse().
 */
import { Contract, JsonRpcProvider } from "ethers";
import type { Config } from "../config";

const SERVING_ABI = [
  "function getService(address provider) view returns (tuple(address provider,string serviceType,string url,uint256 inputPrice,uint256 outputPrice,uint256 updatedAt,string model,string verifiability,string additionalInfo,address teeSignerAddress,bool teeSignerAcknowledged) service)",
];

export interface ServiceRecord {
  provider: string;
  url: string;
  model: string;
  verifiability: string;
  teeSigner: string; // effective signing address for chat signatures
  teeSignerAcknowledged: boolean;
  additionalInfo: string;
  source: string;
}

export function effectiveSigner(teeSignerAddress: string, additionalInfo: string): string {
  try {
    const info = JSON.parse(additionalInfo || "{}");
    const centralized = info.ProviderType === "centralized";
    if (info.TargetSeparated === true && !centralized && info.TargetTeeAddress) return info.TargetTeeAddress;
  } catch {
    /* keep teeSignerAddress */
  }
  return teeSignerAddress;
}

export class ServiceDirectory {
  private cache = new Map<string, ServiceRecord>();
  private contract: Contract | null = null;

  constructor(private cfg: Config["zg"]) {
    if (cfg.mode !== "mock") {
      this.contract = new Contract(cfg.servingContract, SERVING_ABI, new JsonRpcProvider(cfg.servingRpc));
    }
  }

  async get(provider: string): Promise<ServiceRecord> {
    const key = provider.toLowerCase();
    const hit = this.cache.get(key);
    if (hit) return hit;
    let rec: ServiceRecord;
    if (this.cfg.mode === "mock") {
      const res = await fetch(`${this.cfg.mockUrl}/mock/services/${provider}`);
      if (!res.ok) throw new Error(`mock service record for ${provider}: HTTP ${res.status}`);
      const s: any = await res.json();
      rec = {
        provider: s.provider,
        url: s.url,
        model: s.model,
        verifiability: s.verifiability,
        teeSigner: effectiveSigner(s.teeSignerAddress, s.additionalInfo),
        teeSignerAcknowledged: !!s.teeSignerAcknowledged,
        additionalInfo: s.additionalInfo,
        source: "mock (not a 0G signer)",
      };
    } else {
      const s = await this.contract!.getService(provider);
      rec = {
        provider: s.provider,
        url: String(s.url).replace(/\/$/, ""),
        model: s.model,
        verifiability: s.verifiability,
        teeSigner: effectiveSigner(s.teeSignerAddress, s.additionalInfo),
        teeSignerAcknowledged: s.teeSignerAcknowledged,
        additionalInfo: s.additionalInfo,
        source: `InferenceServing ${this.cfg.servingContract} @ ${this.cfg.servingRpc}`,
      };
    }
    this.cache.set(key, rec);
    return rec;
  }
}

export interface ChatSignature {
  text: string;
  signature: string;
  signing_address?: string;
  chatId: string;
}

/** GET {url}/v1/proxy/signature/{chatID}?model= - tries each chat id candidate in order. */
export async function fetchSignature(svc: ServiceRecord, chatIds: string[], timeoutMs = 6000): Promise<ChatSignature> {
  const errors: string[] = [];
  for (const id of chatIds) {
    const url = `${svc.url}/v1/proxy/signature/${encodeURIComponent(id)}?model=${encodeURIComponent(svc.model)}`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        errors.push(`${id}: HTTP ${res.status}`);
        continue;
      }
      const j: any = await res.json();
      if (typeof j.text === "string" && typeof j.signature === "string")
        return { text: j.text, signature: j.signature, signing_address: j.signing_address, chatId: id };
      errors.push(`${id}: unexpected body`);
    } catch (e) {
      errors.push(`${id}: ${(e as Error).message}`);
    }
  }
  throw new Error(`TEE signature not found (${errors.join("; ")})`);
}
