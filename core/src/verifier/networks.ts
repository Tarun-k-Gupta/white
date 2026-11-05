/** Browser-side copy of the public network facts in config.ts (no fs / dotenv here). */
export const NETWORK_DEFAULTS: Record<string, { chainId: number; rpc: string; explorer: string; indexer: string; storagescan: string }> = {
  galileo: {
    chainId: 16602,
    rpc: "https://evmrpc-testnet.0g.ai",
    explorer: "https://chainscan-galileo.0g.ai",
    indexer: "https://indexer-storage-testnet-turbo.0g.ai",
    storagescan: "https://storagescan-galileo.0g.ai",
  },
  mainnet: {
    chainId: 16661,
    rpc: "https://evmrpc.0g.ai",
    explorer: "https://chainscan.0g.ai",
    indexer: "https://indexer-storage-turbo.0g.ai",
    storagescan: "https://storagescan.0g.ai",
  },
  local: { chainId: 31337, rpc: "http://127.0.0.1:8545", explorer: "", indexer: "", storagescan: "" },
};
