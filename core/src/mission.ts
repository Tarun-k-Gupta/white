/**
 * Mission orchestration in the core:
 *   manifest -> 0G Storage -> robot prepares (genesis) -> registerMission on 0G Chain -> takeoff
 *   checkpoint -> 0G Compute (sealed) -> bundle back to the robot (the robot decides whether to act)
 *   entries -> writer queue -> 0G Storage, anchor every N decisions, close with trajectory hash
 * Plus the demo hooks a judge uses: kill switch, forged decision, tampered answer, tampered log.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AbiCoder, Wallet, hexlify, keccak256, randomBytes, toUtf8Bytes } from "ethers";
import type { Config } from "./config";
import { RegistryClient } from "./chain/registry";
import { type Entry, canonicalJson, entryHash, goJson, sha256Hex } from "./lib/canonical";
import { type Bundle, type Policy, expectedEcho, extractContent, parseAnswer } from "./lib/interlock";
import { SerialQueue } from "./lib/queue";
import { RobotClient } from "./robotClient";
import type { Storage } from "./storage";
import { type AllowlistEntry, type CheckpointRequest, ZgDecider } from "./zg/decide";
import { ZgUnreachable } from "./zg/router";
import { type MissionIndex, type Report, loadFromChain, verifyMission } from "./verifier/core";

const MANIFEST_VERSION = 1;

export interface Attempt {
  at: number;
  kind: "0g" | "forged" | "tampered" | "error";
  endpoint?: string;
  request_id?: string | null;
  chat_id?: string | null;
  latency_ms?: number;
  answer?: unknown;
  precheck?: string;
  error?: string;
  robot_result?: string;
}

export interface MissionRecord {
  id: string;
  createdAt: string;
  status: "preparing" | "flying" | "ended" | "closed" | "error";
  robot: string;
  robotId: string;
  seed: number;
  manifest: any;
  manifestText: string;
  manifestRoot: string | null;
  manifestTx: string | null;
  allowlist: AllowlistEntry[];
  entries: Entry[];
  roots: Record<number, { root: string; tx: string | null }>;
  crops: Record<number, { root: string | null; tx: string | null }>;
  checkpoints: Record<number, { k: number; status: string; attempts: Attempt[] }>;
  chain: {
    registerTx: string | null;
    anchors: { count: number; head: string; indexRoot: string; tx: string | null }[];
    closeTx: string | null;
    indexRoot: string | null;
  };
  decisionsSinceAnchor: number;
  anchoredCount: number;
  replay: any | null;
  errors: string[];
}

export class Missions {
  current: MissionRecord | null = null;
  records = new Map<string, MissionRecord>();
  demo = { forgeArmed: false, tamperArmed: false };
  readonly queue = new SerialQueue();
  private cropB64 = new Map<string, string>();
  private dir: string;
  private saveTimers = new Map<string, NodeJS.Timeout>();

  constructor(
    private cfg: Config,
    public decider: ZgDecider,
    public storage: Storage,
    public registry: RegistryClient | null,
    public robot: RobotClient,
  ) {
    this.dir = join(cfg.dataDir, "missions");
    mkdirSync(this.dir, { recursive: true });
    for (const f of readdirSync(this.dir).filter((f) => f.endsWith(".json"))) {
      try {
        const r: MissionRecord = JSON.parse(readFileSync(join(this.dir, f), "utf8"));
        this.records.set(r.id, r);
      } catch {
        /* ignore corrupt record */
      }
    }
  }

  get link() {
    return this.decider.router.link;
  }

  private persist(rec: MissionRecord) {
    clearTimeout(this.saveTimers.get(rec.id));
    this.saveTimers.set(
      rec.id,
      setTimeout(() => writeFileSync(join(this.dir, `${rec.id}.json`), JSON.stringify(rec)), 250),
    );
  }

  private fail(rec: MissionRecord, msg: string) {
    rec.errors.push(`${new Date().toISOString()} ${msg}`);
    console.error(`[core] ${rec.id.slice(0, 10)}: ${msg}`);
    this.persist(rec);
  }

  policyOf(rec: MissionRecord): Policy {
    return rec.manifest.policy;
  }

  // ------------------------------------------------------------------ start
  async start(opts: { defects?: any[]; seed?: number }): Promise<MissionRecord> {
    if (this.current && (this.current.status === "preparing" || this.current.status === "flying"))
      throw new Error("a mission is already in progress");
    const health = await this.robot.health().catch(() => {
      throw new Error(`robot adapter not reachable at ${this.robot.base} (start it: npm run robot)`);
    });
    const robot: string = health.robot;
    const chain = this.cfg.chain;
    const robotId = chain.robotId || keccak256(toUtf8Bytes("blackbox-dev-robot"));
    if (this.registry) {
      if (!chain.robotId) throw new Error("ROBOT_ID is not set (run: npm run setup:robot)");
      if (!(await this.registry.isOperator(robotId, robot)))
        throw new Error(`robot ${robot} is not a zerobot operator of ${robotId.slice(0, 10)} (run: npm run setup:robot)`);
    }
    const allow = await this.decider.allowlist();
    if (!allow.signers.length)
      throw new Error(`no TEE signers found for ${this.cfg.zg.visionModel}: refusing to fly without an allowlist`);

    const seed = opts.seed ?? Math.floor(Math.random() * 2 ** 31);
    const missionId = keccak256(
      AbiCoder.defaultAbiCoder().encode(["address", "bytes32", "uint256", "bytes32"], [robot, robotId, Date.now(), hexlify(randomBytes(32))]),
    );
    const p = this.cfg.policy;
    const manifest = {
      v: MANIFEST_VERSION,
      kind: "blackbox.mission-manifest",
      mission_id: missionId,
      robot_id: robotId,
      robot,
      chain_id: chain.enabled ? chain.network.chainId : 0,
      registry: chain.enabled ? chain.registry : "0x0000000000000000000000000000000000000000",
      robot_registry: chain.enabled ? chain.robotRegistry : null,
      seed,
      sim: { backend: this.cfg.sim.backend },
      policy: {
        vision_model: this.cfg.zg.visionModel,
        trust_mode: this.cfg.zg.trustMode,
        tee_signers: allow.signers,
        tee_binding: p.teeBinding,
        nonce_hex_len: p.nonceHexLen,
        lease_ms: p.leaseMs,
        max_asks: p.maxAsks,
        anchor_every: p.anchorEvery,
        decision_model: this.cfg.zg.decisionModel || null,
        hold_below_permille: this.cfg.zg.decisionModel ? this.cfg.zg.holdBelowPermille : null,
        human_timeout_ms: p.humanTimeoutMs,
      },
      compute: {
        mode: this.cfg.zg.mode,
        endpoints: this.cfg.zg.endpoints,
        providers: allow.providers.map((a) => ({ provider: a.provider, signer: a.signer, url: a.url, endpoint: a.endpoint, verifiability: a.verifiability })),
        service_registry: this.cfg.zg.mode === "mock" ? "mock" : `${this.cfg.zg.servingContract}@16661`,
      },
      storage: { kind: this.storage.kind, network: this.cfg.storage.network.name },
      created_at: new Date().toISOString(),
    };
    const manifestText = canonicalJson(manifest);
    const rec: MissionRecord = {
      id: missionId,
      createdAt: manifest.created_at,
      status: "preparing",
      robot,
      robotId,
      seed,
      manifest,
      manifestText,
      manifestRoot: null,
      manifestTx: null,
      allowlist: allow.providers,
      entries: [],
      roots: {},
      crops: {},
      checkpoints: {},
      chain: { registerTx: null, anchors: [], closeTx: null, indexRoot: null },
      decisionsSinceAnchor: 0,
      anchoredCount: 1,
      replay: null,
      errors: [],
    };
    this.records.set(missionId, rec);
    this.current = rec;
    try {
      const up = await this.queue.run(() => this.storage.upload(toUtf8Bytes(manifestText)));
      rec.manifestRoot = up.root;
      rec.manifestTx = up.txHash;
      const prep = await this.robot.prepare({ manifest_text: manifestText, manifest_root: up.root, defects: opts.defects ?? [] });
      await this.onEntry(prep.genesis);
      if (this.registry) {
        const seedHash = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256"], [seed]));
        rec.chain.registerTx = await this.queue.run(() =>
          this.registry!.registerMission(missionId, robotId, robot, seedHash, up.root, prep.genesis.hash),
        );
      }
      await this.robot.go();
      rec.status = "flying";
      this.persist(rec);
      console.log(`[core] mission ${missionId.slice(0, 10)} flying (seed ${seed}, ${allow.signers.length} TEE signer(s))`);
      return rec;
    } catch (e) {
      rec.status = "error";
      this.fail(rec, `start failed: ${(e as Error).message}`);
      throw e;
    }
  }

  // ------------------------------------------------------------- checkpoint
  async onCheckpoint(req: CheckpointRequest): Promise<{ ok: boolean; bundle?: Bundle; error?: string }> {
    const rec = this.records.get(req.mission_id);
    if (!rec) return { ok: false, error: "unknown mission" };
    const k = req.checkpoint;
    const cpv = (rec.checkpoints[k] ??= { k, status: "asking", attempts: [] });
    const cropKey = `${rec.id}:${k}`;
    if (!this.cropB64.has(cropKey)) {
      this.cropB64.set(cropKey, req.crop_png_b64);
      if (this.cfg.storage.storeCrops) {
        rec.crops[k] = { root: null, tx: null };
        this.queue
          .run(() => this.storage.upload(Buffer.from(req.crop_png_b64, "base64")))
          .then((s) => ((rec.crops[k] = { root: s.root, tx: s.txHash }), this.persist(rec)))
          .catch((e) => this.fail(rec, `crop ${k} upload: ${e.message}`));
      }
    }
    if (this.demo.forgeArmed) {
      this.demo.forgeArmed = false;
      const forged = forgeBundle(req, this.policyOf(rec));
      const at: Attempt = { at: Date.now(), kind: "forged", answer: { label: "decoy", action: "continue" } };
      cpv.attempts.push(at);
      this.robot
        .decision(forged, "operator console")
        .then((r) => (at.robot_result = r.accepted ? "ACCEPTED (!)" : `refused: ${r.reason}`))
        .catch((e) => (at.robot_result = `error: ${e.message}`));
    }
    try {
      const { bundle, precheck } = await this.decider.decide(req, this.policyOf(rec));
      let out = bundle;
      const at: Attempt = {
        at: Date.now(),
        kind: "0g",
        endpoint: bundle.endpoint,
        request_id: bundle.request_id,
        chat_id: bundle.chat_id,
        latency_ms: bundle.latency_ms,
        answer: precheck.answer,
        precheck: precheck.reason,
      };
      cpv.attempts.push(at);
      if (this.demo.tamperArmed && precheck.accepted) {
        this.demo.tamperArmed = false;
        const t = tamperBundle(bundle);
        out = t.bundle;
        cpv.attempts.push({ at: Date.now(), kind: "tampered", answer: t.answer, request_id: bundle.request_id });
      }
      cpv.status = "answered";
      this.persist(rec);
      return { ok: true, bundle: out };
    } catch (e) {
      const msg = (e as Error).message;
      cpv.attempts.push({ at: Date.now(), kind: "error", error: msg });
      cpv.status = e instanceof ZgUnreachable ? "unreachable" : "error";
      this.persist(rec);
      return { ok: false, error: msg };
    }
  }

  // ---------------------------------------------------------------- entries
  async onEntry(entry: Entry): Promise<{ ok: boolean; error?: string }> {
    const rec = this.records.get(entry.mission_id);
    if (!rec) return { ok: false, error: "unknown mission" };
    const have = rec.entries[entry.seq];
    if (have) return have.hash === entry.hash ? { ok: true } : { ok: false, error: `conflicting entry #${entry.seq}` };
    if (entryHash(entry) !== entry.hash) return { ok: false, error: `entry #${entry.seq} hash does not recompute` };
    rec.entries[entry.seq] = entry;
    const seq = entry.seq;
    this.queue
      .run(() => this.storage.upload(toUtf8Bytes(canonicalJson(entry))))
      .then((s) => ((rec.roots[seq] = { root: s.root, tx: s.txHash }), this.persist(rec)))
      .catch((e) => this.fail(rec, `entry #${seq} upload: ${e.message}`));
    if (["decision", "human", "safe_stop"].includes(entry.kind)) {
      rec.decisionsSinceAnchor++;
      if (rec.decisionsSinceAnchor >= this.cfg.policy.anchorEvery) {
        rec.decisionsSinceAnchor = 0;
        this.queueAnchor(rec, false);
      }
    }
    if (entry.kind === "mission_end") {
      rec.status = "ended";
      this.queueAnchor(rec, true);
    }
    this.persist(rec);
    return { ok: true };
  }

  private contiguous(rec: MissionRecord) {
    let n = 0;
    while (rec.entries[n]) n++;
    return n;
  }

  private index(rec: MissionRecord, count: number): MissionIndex {
    return {
      v: 1,
      mission_id: rec.id,
      manifest_root: rec.manifestRoot!,
      count,
      entries: rec.entries.slice(0, count).map((e) => ({ seq: e.seq, kind: e.kind, hash: e.hash, root: rec.roots[e.seq]?.root ?? null })),
      crops: Object.fromEntries(Object.entries(rec.crops).map(([k, v]) => [k, v.root ?? ""])),
    };
  }

  private queueAnchor(rec: MissionRecord, close: boolean) {
    this.queue
      .run(async () => {
        const count = this.contiguous(rec);
        if (!close && count <= rec.anchoredCount) return;
        const head = rec.entries[count - 1].hash;
        const idx = await this.storage.upload(toUtf8Bytes(canonicalJson(this.index(rec, count))));
        rec.chain.indexRoot = idx.root;
        let tx: string | null = null;
        if (close) {
          const end = rec.entries[count - 1];
          if (end.kind !== "mission_end") throw new Error("close requested before mission_end arrived");
          const traj = end.body.trajectory_hash;
          const { signature } = await this.robot.sign({ type: "close", mission_id: rec.id, count, head, index_root: idx.root, trajectory_hash: traj });
          if (this.registry) tx = await this.registry.close(rec.id, count, head, idx.root, traj, signature);
          rec.chain.closeTx = tx;
          rec.status = "closed";
        } else {
          const { signature } = await this.robot.sign({ type: "anchor", mission_id: rec.id, count, head, index_root: idx.root });
          if (this.registry) tx = await this.registry.anchor(rec.id, count, head, idx.root, signature);
        }
        rec.chain.anchors.push({ count, head, indexRoot: idx.root, tx });
        rec.anchoredCount = count;
        this.persist(rec);
        console.log(`[core] ${close ? "closed" : "anchored"} ${rec.id.slice(0, 10)} at ${count} entries ${tx ?? "(no chain)"}`);
        if (close) {
          rec.replay = await this.robot.replay(rec.entries).catch((e) => ({ match: null, error: e.message }));
          this.persist(rec);
        }
      })
      .catch((e) => this.fail(rec, `${close ? "close" : "anchor"}: ${e.message}`));
  }

  // ----------------------------------------------------------------- verify
  async chainView(missionId: string) {
    if (!this.registry) return null;
    const [mission, anchors] = await Promise.all([this.registry.getMission(missionId), this.registry.getAnchors(missionId)]);
    const robotIsOperator = mission ? await this.registry.isOperator(mission.robotId, mission.robot) : null;
    const net = this.cfg.chain.network;
    return { network: net.name, chainId: net.chainId, registry: this.cfg.chain.registry, robotRegistry: this.cfg.chain.robotRegistry, mission, anchors, robotIsOperator };
  }

  /** source=storage re-reads everything from 0G Chain + 0G Storage; source=local uses the core's copy. */
  async verify(missionId: string, source: "storage" | "local" = "storage", entriesOverride?: Entry[]): Promise<Report> {
    const rec = this.records.get(missionId);
    if (source === "storage" && this.registry && !entriesOverride) {
      const n = this.cfg.chain.network;
      const inp = await loadFromChain({
        rpc: n.rpc,
        chainId: n.chainId,
        network: n.name,
        registry: this.cfg.chain.registry,
        missionId,
        fetchRoot: (r) => this.storage.download(r),
      });
      return verifyMission({ ...inp, replay: rec?.replay ?? null });
    }
    if (!rec) throw new Error("unknown mission");
    return verifyMission({
      missionId,
      entries: entriesOverride ?? rec.entries,
      manifestText: rec.manifestText,
      chain: await this.chainView(missionId),
      roots: Object.fromEntries(Object.entries(rec.roots).map(([k, v]) => [k, v.root])),
      replay: entriesOverride ? null : rec.replay,
    });
  }

  /** Beat 3b: lower one severity in a local copy of the log and verify that copy. */
  async tamperedReport(missionId: string, seq?: number) {
    const rec = this.records.get(missionId);
    if (!rec) throw new Error("unknown mission");
    const copy: Entry[] = JSON.parse(JSON.stringify(rec.entries));
    const target = seq ?? copy.findIndex((e) => e.kind === "decision" && e.body.answer?.severity > 0);
    const i = target >= 0 ? target : copy.findIndex((e) => e.kind === "decision");
    if (i < 0) throw new Error("no decision entry to tamper with yet");
    const e = copy[i];
    let change: string;
    if (e.kind === "decision") {
      const before = e.body.answer.severity;
      e.body.answer.severity = Math.max(0, before - 2);
      change = `entry #${i}: severity ${before} -> ${e.body.answer.severity}`;
    } else {
      e.t_ms += 1;
      change = `entry #${i}: t_ms +1`;
    }
    const report = await this.verify(missionId, "local", copy);
    return { change, seq: i, report };
  }

  // ------------------------------------------------------------------- view
  summary(rec: MissionRecord | null) {
    if (!rec) return null;
    const ex = this.cfg.chain.network.explorer;
    const txUrl = (t: string | null) => (t && ex ? `${ex}/tx/${t}` : null);
    return {
      id: rec.id,
      status: rec.status,
      createdAt: rec.createdAt,
      robot: rec.robot,
      robotId: rec.robotId,
      seed: rec.seed,
      manifestRoot: rec.manifestRoot,
      manifestUrl: rec.manifestRoot ? this.storage.fileUrl(rec.manifestRoot) : null,
      manifestTxUrl: this.storage.txUrl(rec.manifestTx),
      policy: rec.manifest.policy,
      allowlist: rec.allowlist,
      registerTx: rec.chain.registerTx,
      registerTxUrl: txUrl(rec.chain.registerTx),
      anchors: rec.chain.anchors.map((a) => ({ ...a, txUrl: txUrl(a.tx), indexUrl: this.storage.fileUrl(a.indexRoot) })),
      closeTx: rec.chain.closeTx,
      closeTxUrl: txUrl(rec.chain.closeTx),
      checkpoints: rec.checkpoints,
      crops: rec.crops,
      replay: rec.replay,
      errors: rec.errors.slice(-8),
      entries: rec.entries.filter(Boolean).map((e) => ({
        seq: e.seq,
        kind: e.kind,
        hash: e.hash,
        t_ms: e.t_ms,
        root: rec.roots[e.seq]?.root ?? null,
        rootUrl: rec.roots[e.seq] ? this.storage.fileUrl(rec.roots[e.seq].root) : null,
        txUrl: this.storage.txUrl(rec.roots[e.seq]?.tx ?? null),
        body: summarizeBody(e),
      })),
    };
  }

  crop(missionId: string, k: number): Buffer | null {
    const b = this.cropB64.get(`${missionId}:${k}`);
    return b ? Buffer.from(b, "base64") : null;
  }
}

function summarizeBody(e: Entry) {
  const b = e.body ?? {};
  switch (e.kind) {
    case "decision":
    case "hold":
      return {
        checkpoint: b.checkpoint,
        answer: b.answer,
        action_applied: b.action_applied ?? null,
        target_mm: b.target_mm,
        request_id: b.zg?.request_id,
        chat_id: b.zg?.chat_id,
        provider: b.zg?.provider,
        endpoint: b.zg?.endpoint,
        latency_ms: b.zg?.latency_ms,
        router_tee_verified: b.zg?.router_tee_verified,
        signer: b.interlock?.signer,
        binding: b.interlock?.binding,
        tee_text: b.zg?.tee?.text,
        decision_model: b.decision_model ? { ...b.decision_model, raw_response: undefined } : null,
      };
    case "rejected":
      return { checkpoint: b.checkpoint, reason: b.reason, source: b.source, attempted_answer: b.attempted_answer, signer: b.signer, request_id: b.zg?.request_id };
    case "safe_stop":
      return { checkpoint: b.checkpoint, reason: b.reason, asks: b.asks, refused: b.refused, last_error: b.last_error };
    case "mission_start":
      return { manifest_root: b.manifest_root, manifest_hash: b.manifest_hash, defects: b.defects, backend: b.backend };
    default:
      return b;
  }
}

/** A perfectly formed answer for this checkpoint, signed by the operator's own key instead of 0G's TEE. */
function forgeBundle(req: CheckpointRequest, policy: Policy): Bundle {
  const operator = Wallet.createRandom();
  const answer = { nonce: expectedEcho(req.nonce, policy.nonce_hex_len ?? 64), label: "decoy", severity: 0, action: "continue" };
  const chat = crypto.randomUUID();
  const broker = {
    id: `chatcmpl-${chat}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "0GM-1.0-35B-A3B",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(answer) } }],
  };
  const fakeReq = JSON.stringify({ forged: true });
  const text = `${sha256Hex(fakeReq)}:${sha256Hex(goJson(broker))}`;
  return {
    mission_id: req.mission_id,
    checkpoint: req.checkpoint,
    endpoint: "operator-console",
    request_id: crypto.randomUUID(),
    chat_id: chat,
    chat_id_source: "header",
    provider: null,
    model: "0gm-1.0-35b-a3b",
    router_tee_verified: true,
    latency_ms: 0,
    request_sha256: sha256Hex(fakeReq),
    raw_response: goJson({ ...broker, x_0g_trace: { request_id: crypto.randomUUID(), tee_verified: true } }),
    tee: { text, signature: operator.signMessageSync(text), signing_address: operator.address, service_url: "operator-console" },
  };
}

/** The real 0G answer with its real TEE signature, but the action flipped (skip a crack / dive on a decoy). */
function tamperBundle(b: Bundle): { bundle: Bundle; answer: Record<string, unknown> } {
  const body = JSON.parse(b.raw_response);
  const a = parseAnswer(extractContent(b.raw_response));
  const flipped =
    a.action === "descend" ? { ...a, label: "decoy", severity: 0, action: "continue" } : { ...a, label: "crack", severity: 3, action: "descend" };
  body.choices[0].message.content = JSON.stringify(flipped);
  return { bundle: { ...b, raw_response: goJson(body) }, answer: { label: flipped.label, action: flipped.action } };
}
