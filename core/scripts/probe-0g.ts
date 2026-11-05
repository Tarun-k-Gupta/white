/**
 * Gate A probe against the live 0G stack (run before kickoff, with a real sk- key):
 *   npm run probe                      # vision accuracy, nonce echo, TEE signature + binding, latency
 *   npm run probe -- --echo 20         # also send the nonce-echo prompt 20 times
 *   npm run probe -- --storage         # 1 KB MemData upload + read-back on 0G Storage
 *   npm run probe -- --images <dir>    # your own crack-*.png / decoy-*.png crops
 * Prints which TEE binding holds (set TEE_BINDING) and a lease recommendation (set LEASE_MS).
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { hexlify, randomBytes, toUtf8Bytes } from "ethers";
import { REPO_ROOT, loadConfig } from "../src/config";
import { responseHashCandidates, splitSignedText } from "../src/lib/interlock";
import { makeStorage } from "../src/storage";
import { ZgDecider } from "../src/zg/decide";
import { RouterClient } from "../src/zg/router";
import { ServiceDirectory } from "../src/zg/services";

const argv = process.argv.slice(2);
const opt = (k: string) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : undefined);
const cfg = loadConfig();
if (cfg.zg.mode === "router" && !cfg.zg.apiKey) throw new Error("ZG_API_KEY (sk-...) is not set - create one at https://pc.0g.ai");

const router = new RouterClient(cfg.zg, { down: false });
const decider = new ZgDecider(cfg, router, new ServiceDirectory(cfg.zg));

console.log(`0G Compute: ${cfg.zg.endpoints.map((e) => `${e.name}=${e.url}`).join(", ")}  model ${cfg.zg.visionModel}  trust ${cfg.zg.trustMode}\n`);
const allow = await decider.allowlist();
for (const p of allow.providers) console.log(`provider ${p.provider}  ${p.verifiability}  signer ${p.signer}  ${p.url}  [${p.endpoint}]`);
if (!allow.signers.length) throw new Error("no acknowledged TEE signer found for the model");
const policy = { tee_signers: allow.signers, tee_binding: "auto", nonce_hex_len: cfg.policy.nonceHexLen };

const dir = opt("images") ?? join(REPO_ROOT, "robot", "assets", "probe");
const images = readdirSync(dir).filter((f) => /^(crack|decoy).*\.png$/i.test(f)).sort();
const echoN = Number(opt("echo") ?? 0);
const jobs = [...images.map((f) => ({ f, echo: false })), ...Array.from({ length: echoN }, () => ({ f: images[0], echo: true }))];

const rows: any[] = [];
const bindings = new Map<string, number>();
for (const { f, echo } of jobs) {
  const nonce = hexlify(randomBytes(32));
  const req = {
    mission_id: hexlify(randomBytes(32)), checkpoint: rows.length, step: 0, nonce, obs_hash: hexlify(randomBytes(32)), pix_hash: "",
    pose_mm: [0, 0, 3000], target_mm: [0, 0], detector_score: 50, crop_png_b64: readFileSync(join(dir, f)).toString("base64"), deadline_ms: 30000,
  };
  const t0 = Date.now();
  try {
    const { bundle, precheck } = await decider.decide(req, policy);
    const text = bundle.tee.text ?? "";
    const h = splitSignedText(text);
    const cands = responseHashCandidates(bundle.raw_response);
    const matched = h ? Object.entries(cands).filter(([, v]) => v === h[1]).map(([k]) => k) : [];
    for (const m of matched) bindings.set(m, (bindings.get(m) ?? 0) + 1);
    const row = {
      image: f, echo, want: f.split("-")[0], got: precheck.answer?.label ?? "-", action: precheck.answer?.action ?? "-",
      accepted: precheck.accepted, reason: precheck.reason, ms: Date.now() - t0, request_id: bundle.request_id,
      chat_id: `${bundle.chat_id} (${bundle.chat_id_source})`, signer: precheck.signer, binding: matched.join("+") || "NONE",
      reqHashMatch: h ? h[0] === bundle.request_sha256 : null, teeVerified: bundle.router_tee_verified, teeError: (bundle as any).tee_error,
    };
    rows.push(row);
    console.log(`${row.accepted ? "✔" : "✘"} ${f.padEnd(14)} ${row.want}->${row.got}/${row.action}  ${row.ms} ms  binding=${row.binding}  req_hash_match=${row.reqHashMatch}  router_tee_verified=${row.teeVerified}  ${row.accepted ? "" : row.reason}`);
    if (rows.length === 1) {
      console.log(`   signed text: ${text.slice(0, 140)}`);
      console.log(`   request_id ${row.request_id}  chat ${row.chat_id}${row.teeError ? "  tee_error " + row.teeError : ""}`);
    }
  } catch (e) {
    rows.push({ image: f, echo, error: (e as Error).message, ms: Date.now() - t0 });
    console.log(`✘ ${f}: ${(e as Error).message}`);
  }
}

const cls = rows.filter((r) => !r.echo && !r.error);
const cracks = cls.filter((r) => r.want === "crack");
const decoys = cls.filter((r) => r.want === "decoy");
const ms = rows.filter((r) => !r.error).map((r) => r.ms).sort((a, b) => a - b);
const median = ms[Math.floor(ms.length / 2)] ?? 0;
const echoed = rows.filter((r) => r.echo && r.accepted).length;
console.log(`\nGate A`);
console.log(`  cracks flagged   ${cracks.filter((r) => r.got === "crack" || r.got === "unsure").length}/${cracks.length} (need >= 4/5)`);
console.log(`  decoys rejected  ${decoys.filter((r) => r.action === "continue").length}/${decoys.length} (need all)`);
console.log(`  answers accepted ${rows.filter((r) => r.accepted).length}/${rows.length} (parse + nonce + TEE signer + binding)`);
if (echoN) console.log(`  nonce echo       ${echoed}/${echoN}`);
console.log(`  median latency   ${median} ms -> LEASE_MS=${Math.min(12000, Math.max(3000, 3 * median))}`);
console.log(`  TEE binding      ${[...bindings.entries()].map(([k, v]) => `${k}:${v}`).join(" ") || "NONE MATCHED - see README 'TEE binding'"}`);

if (argv.includes("--storage")) {
  const storage = makeStorage(cfg, "http://127.0.0.1");
  const data = toUtf8Bytes(JSON.stringify({ probe: hexlify(randomBytes(16)), pad: "x".repeat(960) }));
  const t = Date.now();
  const up = await storage.upload(data);
  const back = await storage.download(up.root);
  console.log(`  storage          ${storage.label}: root ${up.root} tx ${up.txHash} (${Date.now() - t} ms) read-back ${Buffer.from(back).equals(Buffer.from(data)) ? "OK" : "MISMATCH"}`);
}
