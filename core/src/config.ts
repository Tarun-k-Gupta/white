import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, "..", "..");
export const CORE_ROOT = resolve(HERE, "..");

const envFile = resolve(REPO_ROOT, process.env.BLACKBOX_ENV ?? ".env");
if (existsSync(envFile)) dotenv.config({ path: envFile });

export interface Network {
  name: string;
  chainId: number;
  rpc: string;
  explorer: string;
  storagescan: string;
  indexer: string;
  zerobotRegistry: string;
}

/** Public network facts (docs.0g.ai, checked Nov 2026). */
export const NETWORKS: Record<string, Network> = {
  galileo: {
    name: "galileo",
    chainId: 16602,
    rpc: "https://evmrpc-testnet.0g.ai",
    explorer: "https://chainscan-galileo.0g.ai",
    storagescan: "https://storagescan-galileo.0g.ai",
    indexer: "https://indexer-storage-testnet-turbo.0g.ai",
    zerobotRegistry: "0x291162e93D7A80Eb8F738882a28a7a8A5FBA73bb",
  },
  mainnet: {
    name: "mainnet",
    chainId: 16661,
    rpc: "https://evmrpc.0g.ai",
    explorer: "https://chainscan.0g.ai",
    storagescan: "https://storagescan.0g.ai",
    indexer: "https://indexer-storage-turbo.0g.ai",
    zerobotRegistry: "", // zerobot is not on mainnet yet: deploy SimpleRobotRegistry (see README)
  },
  local: {
    name: "local",
    chainId: 31337,
    rpc: "http://127.0.0.1:8545",
    explorer: "",
    storagescan: "",
    indexer: "",
    zerobotRegistry: "",
  },
};

export interface Endpoint {
  name: string;
  url: string; // base URL ending in /v1
}

const env = (k: string, d = "") => (process.env[k] ?? "").trim() || d;
const int = (k: string, d: number) => {
  const v = env(k);
  return v ? parseInt(v, 10) : d;
};

function parseEndpoints(raw: string, fallback: Endpoint[]): Endpoint[] {
  if (!raw) return fallback;
  return raw.split(",").map((part, i) => {
    const [a, b] = part.includes("=") ? part.split("=", 2) : [`endpoint${i}`, part];
    return { name: a.trim(), url: b.trim().replace(/\/$/, "") };
  });
}

export function loadConfig() {
  const chainName = env("CHAIN", "galileo");
  const chainEnabled = chainName !== "none";
  const net = { ...(NETWORKS[chainEnabled ? chainName : "local"] ?? NETWORKS.galileo) };
  if (env("RPC_URL")) net.rpc = env("RPC_URL");

  const storageMode = env("STORAGE", chainName === "galileo" || chainName === "mainnet" ? "0g" : "local");
  const storageNet = NETWORKS[env("STORAGE_NETWORK", chainName === "mainnet" ? "mainnet" : "galileo")];

  const zgMode = env("ZG_MODE", "router") as "router" | "mock";
  const mockUrl = env("MOCK_0G_URL", "http://127.0.0.1:8790");
  const endpoints =
    zgMode === "mock"
      ? [{ name: "mock", url: `${mockUrl}/v1` }]
      : parseEndpoints(env("ZG_ROUTER_ENDPOINTS"), [{ name: "mainnet", url: "https://router-api.0g.ai/v1" }]);

  let extraBody: Record<string, unknown> = {};
  if (env("ZG_VISION_EXTRA_BODY")) extraBody = JSON.parse(env("ZG_VISION_EXTRA_BODY"));

  return {
    port: int("CORE_PORT", 8787),
    host: env("CORE_HOST", "127.0.0.1"),
    dataDir: resolve(REPO_ROOT, env("CORE_DATA_DIR", "core/data")),
    robotUrl: env("ROBOT_URL", "http://127.0.0.1:8801").replace(/\/$/, ""),
    publicVerifierUrl: env("PUBLIC_VERIFIER_URL"),
    chain: {
      enabled: chainEnabled,
      network: net,
      registry: env("BLACKBOX_REGISTRY"),
      robotRegistry: env("ROBOT_REGISTRY", net.zerobotRegistry),
      robotId: env("ROBOT_ID"),
      operatorKey: env("OPERATOR_PRIVATE_KEY"),
    },
    storage: {
      mode: storageMode as "0g" | "local",
      network: storageNet,
      indexer: env("STORAGE_INDEXER", storageNet.indexer),
      rpc: env("STORAGE_RPC", storageNet.rpc),
      operatorKey: env("STORAGE_PRIVATE_KEY", env("OPERATOR_PRIVATE_KEY")),
      waitFinality: env("STORAGE_WAIT_FINALITY", "false") === "true",
      storeCrops: env("STORE_CROPS", "true") === "true",
    },
    zg: {
      mode: zgMode,
      mockUrl,
      endpoints,
      apiKey: env("ZG_API_KEY", zgMode === "mock" ? "sk-mock" : ""),
      visionModel: env("ZG_VISION_MODEL", "0gm-1.0-35b-a3b"),
      trustMode: env("ZG_TRUST_MODE", "private"),
      extraBody,
      servingRpc: env("ZG_SERVING_RPC", "https://evmrpc.0g.ai"),
      // 0G Compute InferenceServing on mainnet (from @0gfoundation/0g-compute-ts-sdk constants)
      servingContract: env("ZG_SERVING_CONTRACT", "0x47340d900bdFec2BD393c626E12ea0656F938d84"),
      extraSigners: env("TEE_SIGNER_ALLOWLIST").split(",").map((s) => s.trim()).filter(Boolean),
      decisionModel: env("ZG_DECISION_MODEL"),
      holdBelowPermille: int("DECISION_HOLD_BELOW", 600),
      requestTimeoutMs: int("ZG_REQUEST_TIMEOUT_MS", 15000),
    },
    policy: {
      leaseMs: int("LEASE_MS", zgMode === "mock" ? 6000 : 12000),
      nonceHexLen: int("NONCE_HEX_LEN", 64),
      anchorEvery: int("ANCHOR_EVERY", 2),
      teeBinding: env("TEE_BINDING", "auto"),
      maxAsks: int("MAX_ASKS", 2),
      humanTimeoutMs: int("HUMAN_TIMEOUT_MS", 60000),
    },
    sim: {
      backend: env("SIM_BACKEND", "pybullet"),
    },
  };
}

export type Config = ReturnType<typeof loadConfig>;
