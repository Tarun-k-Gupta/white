/**
 * npm run verify -- --mission 0x...                      # from 0G Chain + 0G Storage (uses .env network)
 * npm run verify -- --mission 0x... --log tampered.json   # verify a local copy against the chain
 * npm run verify -- --mission 0x... --core http://127.0.0.1:8787   # fetch roots through a core
 */
import { readFileSync } from "node:fs";
import { loadConfig } from "../config";
import { makeStorage } from "../storage";
import { RegistryClient } from "../chain/registry";
import type { Entry } from "../lib/canonical";
import { type Report, loadFromChain, verifyMission } from "./core";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

export function printReport(r: Report) {
  const icon = { pass: "\x1b[32m✔\x1b[0m", fail: "\x1b[31m✘\x1b[0m", warn: "\x1b[33m!\x1b[0m", skip: "\x1b[90m-\x1b[0m" };
  console.log(`\nBlackbox verifier - mission ${r.missionId}`);
  console.log(`robot ${r.robot}   entries ${Object.entries(r.counts).map(([k, v]) => `${k}:${v}`).join(" ")}\n`);
  for (const c of r.checks) console.log(` ${icon[c.status]} ${c.title}\n     ${c.detail}`);
  console.log(`\n${r.ok ? "\x1b[32mVERIFIED\x1b[0m" : `\x1b[31mFAILED\x1b[0m - ${r.firstFailure}`}\n`);
  const ids = r.rows.filter((x) => x.kind === "decision" && x.request_id).slice(0, 3);
  if (ids.length) {
    console.log("sample request ids:");
    for (const x of ids) console.log(`  checkpoint ${x.checkpoint}: request_id ${x.request_id}  entry root ${x.root ?? "-"}`);
  }
}

async function main() {
  const cfg = loadConfig();
  const missionId = arg("mission");
  if (!missionId) throw new Error("usage: npm run verify -- --mission 0x... [--log file] [--core url] [--json]");
  const core = arg("core");
  const storage = makeStorage(cfg, core ?? `http://${cfg.host}:${cfg.port}`);
  const fetchRoot = core
    ? async (root: string) => new Uint8Array(await (await fetch(`${core}/api/storage/${root}`)).arrayBuffer())
    : (root: string) => storage.download(root);
  const log = arg("log");
  let report: Report;
  const n = cfg.chain.network;
  if (log) {
    const raw = readFileSync(log, "utf8");
    const entries: Entry[] = log.endsWith(".jsonl") ? raw.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(raw).entries ?? JSON.parse(raw);
    let chain = null;
    if (cfg.chain.enabled) {
      const reg = new RegistryClient(cfg.chain);
      const mission = await reg.getMission(missionId);
      chain = { network: n.name, chainId: n.chainId, registry: cfg.chain.registry, mission, anchors: await reg.getAnchors(missionId), robotIsOperator: mission ? await reg.isOperator(mission.robotId, mission.robot) : null };
    }
    report = verifyMission({ missionId, entries, chain });
  } else {
    if (!cfg.chain.enabled) throw new Error("CHAIN=none: pass --log to verify a local file");
    const inp = await loadFromChain({ rpc: n.rpc, chainId: n.chainId, network: n.name, registry: arg("registry") ?? cfg.chain.registry, missionId, fetchRoot });
    report = verifyMission(inp);
  }
  if (process.argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else printReport(report);
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e.message);
  process.exit(2);
});
