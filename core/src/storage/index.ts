/**
 * Episode-log storage.
 *   0g    - 0G Storage via @0gfoundation/0g-storage-ts-sdk (MemData + Indexer, turbo indexer)
 *   local - content-addressed files under core/data/storage (dev only, labelled as such)
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { Indexer, MemData } from "@0gfoundation/0g-storage-ts-sdk";
import type { Config } from "../config";
import { keccakHex } from "../lib/canonical";

export interface Stored {
  root: string;
  txHash: string | null;
  size: number;
}

export interface Storage {
  kind: "0g" | "local";
  label: string;
  upload(bytes: Uint8Array): Promise<Stored>;
  download(root: string): Promise<Uint8Array>;
  fileUrl(root: string): string | null;
  txUrl(tx: string | null): string | null;
}

export class ZgStorage implements Storage {
  kind = "0g" as const;
  label: string;
  private indexer: Indexer;
  private signer: Wallet;

  constructor(private cfg: Config["storage"]) {
    if (!cfg.operatorKey) throw new Error("STORAGE=0g needs OPERATOR_PRIVATE_KEY (or STORAGE_PRIVATE_KEY) with testnet 0G for fees");
    this.indexer = new Indexer(cfg.indexer);
    this.signer = new Wallet(cfg.operatorKey, new JsonRpcProvider(cfg.rpc));
    this.label = `0G Storage (${cfg.network.name}, ${cfg.indexer})`;
  }

  async upload(bytes: Uint8Array): Promise<Stored> {
    const file = new MemData(bytes);
    const [tree, treeErr] = await file.merkleTree();
    if (treeErr || !tree) throw new Error(`merkle tree: ${treeErr}`);
    // The SDK types target ethers v5 signers; runtime-compatible with v6.
    const [tx, err] = await this.indexer.upload(file, this.cfg.rpc, this.signer as any, {
      finalityRequired: this.cfg.waitFinality,
    } as any);
    if (err) throw new Error(`0G Storage upload: ${err.message ?? err}`);
    if ("rootHash" in tx) return { root: tx.rootHash, txHash: tx.txHash, size: bytes.length };
    return { root: tx.rootHashes[0], txHash: tx.txHashes[0], size: bytes.length };
  }

  async download(root: string): Promise<Uint8Array> {
    const [blob, err] = await this.indexer.downloadToBlob(root, { proof: true } as any);
    if (!err && blob) return new Uint8Array(await blob.arrayBuffer());
    const res = await fetch(`${this.cfg.indexer}/file?root=${root}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    if (!res.ok || (buf.length < 200 && new TextDecoder().decode(buf).includes('"code":101')))
      throw new Error(`0G Storage download ${root}: ${err ?? `HTTP ${res.status}`}`);
    return buf;
  }

  fileUrl(root: string) {
    return `${this.cfg.indexer}/file?root=${root}`;
  }

  txUrl(tx: string | null) {
    return tx && this.cfg.network.storagescan ? `${this.cfg.network.storagescan}/tx/${tx}` : null;
  }
}

export class LocalStorage implements Storage {
  kind = "local" as const;
  label = "local dev storage (NOT 0G - set STORAGE=0g)";
  private dir: string;

  constructor(dataDir: string, private publicBase: string) {
    this.dir = join(dataDir, "storage");
    mkdirSync(this.dir, { recursive: true });
  }

  async upload(bytes: Uint8Array): Promise<Stored> {
    const root = keccakHex(bytes);
    const p = join(this.dir, root);
    if (!existsSync(p)) writeFileSync(p, bytes);
    return { root, txHash: null, size: bytes.length };
  }

  async download(root: string): Promise<Uint8Array> {
    return new Uint8Array(readFileSync(join(this.dir, root.toLowerCase())));
  }

  fileUrl(root: string) {
    return `${this.publicBase}/api/storage/${root}`;
  }

  txUrl() {
    return null;
  }
}

export function makeStorage(cfg: Config, publicBase: string): Storage {
  return cfg.storage.mode === "0g" ? new ZgStorage(cfg.storage) : new LocalStorage(cfg.dataDir, publicBase);
}
