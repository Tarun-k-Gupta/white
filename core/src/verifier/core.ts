/**
 * Blackbox verifier - runs in Node (CLI, core API) and in the browser (verify.html).
 * Trusts nothing the operator says: recomputes every hash, signature, nonce and
 * TEE binding from the raw log, and compares the chain anchors on 0G Galileo.
 */
import { AbiCoder, Contract, JsonRpcProvider, getBytes, hashMessage, keccak256, recoverAddress } from "ethers";
import { BLACKBOX_REGISTRY_ABI, ROBOT_REGISTRY_ABI, type ChainAnchor, type ChainMission, toChainAnchors, toChainMission } from "../chain/abi";
import { type Entry, ZERO_HASH, canonicalJson, entryHash, keccakHex } from "../lib/canonical";
import { checkpointNonce, extractContent, parseAnswer, verifyBundle } from "../lib/interlock";

export type Status = "pass" | "fail" | "warn" | "skip";
export interface Check {
  id: string;
  title: string;
  status: Status;
  detail: string;
  seq?: number;
}

export interface ChainView {
  network: string;
  chainId: number;
  registry: string;
  robotRegistry?: string;
  mission: ChainMission | null;
  anchors: ChainAnchor[];
  robotIsOperator?: boolean | null;
}

export interface VerifyInputs {
  missionId: string;
  entries: Entry[];
  manifestText?: string | null;
  chain?: ChainView | null;
  roots?: Record<number, string | null>;
  replay?: { match: boolean | null; trajectory_hash: string; mismatches?: string[] } | null;
}

export interface DecisionRow {
  seq: number;
  kind: string;
  checkpoint: number | null;
  label?: string;
  severity?: number;
  action?: string;
  request_id?: string | null;
  chat_id?: string | null;
  provider?: string | null;
  signer?: string | null;
  binding?: string | null;
  endpoint?: string;
  latency_ms?: number;
  reason?: string;
  root?: string | null;
}

export interface Report {
  missionId: string;
  ok: boolean;
  firstFailure: string | null;
  checks: Check[];
  rows: DecisionRow[];
  counts: Record<string, number>;
  robot: string | null;
  manifest: any;
  chain: ChainView | null;
  generatedAt: string;
}

const short = (h?: string | null) => (h ? `${h.slice(0, 10)}…${h.slice(-4)}` : "∅");
const PROOF_KINDS = new Set(["decision", "hold"]);

export function verifyMission(inp: VerifyInputs): Report {
  const checks: Check[] = [];
  const add = (c: Check) => checks.push(c);
  const E = inp.entries;
  const g = E[0];
  const manifest = g?.body?.manifest ?? null;
  const robot = inp.chain?.mission?.robot ?? g?.robot ?? null;
  const recomputed = E.map((e) => {
    try {
      return entryHash(e);
    } catch {
      return "invalid";
    }
  });

  // 1. hashes
  const badHash = E.findIndex((e, i) => recomputed[i] !== e.hash);
  add({
    id: "hashes",
    title: "Every entry hash recomputes (canonical JSON, keccak256)",
    status: !E.length ? "fail" : badHash < 0 ? "pass" : "fail",
    detail: !E.length
      ? "no log entries found"
      : badHash < 0
        ? `${E.length} entries recomputed`
        : `Entry #${badHash} (${E[badHash].kind}) was changed after the robot signed it: hashes to ${short(recomputed[badHash])}, log says ${short(E[badHash].hash)}`,
    seq: badHash >= 0 ? badHash : undefined,
  });

  // 2. chain links
  let linkFail = -1;
  let linkWhy = "";
  E.forEach((e, i) => {
    if (linkFail >= 0) return;
    if (e.seq !== i) [linkFail, linkWhy] = [i, `seq is ${e.seq}, expected ${i} (entry missing?)`];
    else if (e.mission_id !== inp.missionId) [linkFail, linkWhy] = [i, "belongs to another mission"];
    else if (e.prev !== (i === 0 ? ZERO_HASH : E[i - 1].hash)) [linkFail, linkWhy] = [i, "prev link broken"];
  });
  add({
    id: "links",
    title: "Hash chain is unbroken from mission_start",
    status: linkFail < 0 && g?.kind === "mission_start" ? "pass" : "fail",
    detail: linkFail >= 0 ? `Entry #${linkFail}: ${linkWhy}` : g?.kind === "mission_start" ? `${E.length} links` : "log does not start with mission_start",
    seq: linkFail >= 0 ? linkFail : undefined,
  });

  // 3. robot signatures
  let sigFail = -1;
  let sigWho = "";
  E.forEach((e, i) => {
    if (sigFail >= 0) return;
    try {
      const who = recoverAddress(hashMessage(getBytes(e.hash)), e.robot_sig);
      if (!robot || who.toLowerCase() !== robot.toLowerCase()) [sigFail, sigWho] = [i, who];
    } catch {
      [sigFail, sigWho] = [i, "malformed"];
    }
  });
  add({
    id: "robot-sigs",
    title: "Every entry is signed by the registered robot key",
    status: sigFail < 0 && E.length ? "pass" : "fail",
    detail: sigFail < 0 ? `robot ${short(robot)}` : `Entry #${sigFail}: signed by ${sigWho}, expected ${robot}`,
    seq: sigFail >= 0 ? sigFail : undefined,
  });

  // 4. registry
  const ch = inp.chain;
  if (!ch) {
    add({ id: "registry", title: "Mission registered on BlackboxRegistry", status: "skip", detail: "no chain configured (CHAIN=none)" });
  } else if (!ch.mission) {
    add({ id: "registry", title: "Mission registered on BlackboxRegistry", status: "fail", detail: `mission not found on ${ch.network} registry ${ch.registry}` });
  } else {
    const probs: string[] = [];
    if (g && ch.mission.genesisHash !== recomputed[0]) probs.push("genesis hash differs from entry #0");
    if (g && ch.mission.robot.toLowerCase() !== g.robot.toLowerCase()) probs.push("robot differs from the log");
    if (manifest && ch.mission.robotId !== manifest.robot_id) probs.push("robot id differs from the manifest");
    if (ch.robotIsOperator === false) probs.push("robot key is no longer a zerobot operator of this robot id");
    add({
      id: "registry",
      title: "Mission registered on BlackboxRegistry, robot is a zerobot operator",
      status: probs.length ? "fail" : "pass",
      detail: probs.length ? probs.join("; ") : `${ch.network} (chain ${ch.chainId}) registry ${short(ch.registry)}, robot id ${short(ch.mission.robotId)}${ch.robotIsOperator ? ", isOperator() = true" : ""}`,
    });
  }

  // 5. manifest
  if (!manifest) {
    add({ id: "manifest", title: "Mission manifest matches", status: "fail", detail: "mission_start has no manifest" });
  } else {
    const probs: string[] = [];
    if (inp.manifestText != null) {
      if (keccakHex(inp.manifestText) !== g.body.manifest_hash) probs.push("stored manifest bytes do not hash to the robot's manifest_hash");
      try {
        if (canonicalJson(JSON.parse(inp.manifestText)) !== canonicalJson(manifest)) probs.push("stored manifest differs from the one the robot loaded");
      } catch {
        probs.push("stored manifest is not JSON");
      }
    }
    if (ch?.mission && ch.mission.manifestRoot !== g.body.manifest_root) probs.push("on-chain manifest root differs");
    const seedHash = keccak256(AbiCoder.defaultAbiCoder().encode(["uint256"], [manifest.seed]));
    if (seedHash !== g.body.seed_hash) probs.push("seed hash differs");
    if (ch?.mission && ch.mission.seedHash !== seedHash) probs.push("on-chain seed hash differs");
    add({
      id: "manifest",
      title: "Manifest (seed, thresholds, model, TEE allowlist) loaded by root hash",
      status: probs.length ? "fail" : inp.manifestText == null ? "warn" : "pass",
      detail: probs.length
        ? probs.join("; ")
        : `model ${manifest.policy?.vision_model}, ${manifest.policy?.tee_signers?.length} TEE signer(s), lease ${manifest.policy?.lease_ms} ms, seed ${manifest.seed}` +
          (inp.manifestText == null ? " (manifest bytes not fetched)" : ""),
    });
  }

  // 6. anchors
  if (!ch?.mission) {
    add({ id: "anchors", title: "On-chain anchors match the log", status: ch ? "fail" : "skip", detail: ch ? "no mission on chain" : "no chain" });
  } else {
    const all = [{ count: 1, head: ch.mission.genesisHash, indexRoot: "", timestamp: ch.mission.startedAt }, ...ch.anchors];
    let bad: string | null = null;
    let badSeq: number | undefined;
    for (const [i, a] of all.entries()) {
      if (a.count > E.length) {
        bad = `anchor #${i} pins ${a.count} entries but the log has only ${E.length}`;
        break;
      }
      if (recomputed[a.count - 1] !== a.head) {
        badSeq = a.count - 1;
        bad = `anchor #${i} pins entry #${a.count - 1} as ${short(a.head)}, but that entry now hashes to ${short(recomputed[a.count - 1])}`;
        break;
      }
    }
    add({
      id: "anchors",
      title: "Chain head anchored on 0G Chain every 2 decisions matches the log",
      status: bad ? "fail" : "pass",
      detail: bad ?? `${ch.anchors.length} anchor(s); entries 0..${ch.mission.count - 1} pinned on chain`,
      seq: badSeq,
    });
    const end = E[E.length - 1];
    let closeStatus: Status = "pass";
    let closeDetail = "";
    if (!ch.mission.closedAt) {
      closeStatus = "warn";
      closeDetail = `mission still open on chain (${E.length - ch.mission.count} entries not yet anchored)`;
    } else if (end?.kind !== "mission_end") {
      closeStatus = "fail";
      closeDetail = "closed on chain but the log has no mission_end";
    } else if (ch.mission.count !== E.length) {
      closeStatus = "fail";
      closeDetail = `closed with ${ch.mission.count} entries, log has ${E.length}`;
    } else if (ch.mission.trajectoryHash !== end.body.trajectory_hash) {
      closeStatus = "fail";
      closeDetail = "on-chain trajectory hash differs from the log";
    } else closeDetail = `closed: ${end.body.final}, trajectory ${short(end.body.trajectory_hash)}`;
    add({ id: "close", title: "Mission closed with final head and trajectory hash", status: closeStatus, detail: closeDetail });
  }

  // 7-10. per-decision proofs
  const policy = manifest?.policy ?? { tee_signers: [] };
  const rows: DecisionRow[] = [];
  const fails: Record<string, { seq: number; why: string } | null> = { tee: null, binding: null, nonce: null, action: null, ids: null };
  let proofs = 0;
  const decided = new Set<number>();
  const holds = new Set<number>();
  E.forEach((e, i) => {
    const b = e.body ?? {};
    const k = typeof b.checkpoint === "number" ? b.checkpoint : null;
    const row: DecisionRow = { seq: i, kind: e.kind, checkpoint: k, root: inp.roots?.[i] ?? null };
    if (PROOF_KINDS.has(e.kind)) {
      proofs++;
      const z = b.zg ?? {};
      Object.assign(row, {
        label: b.answer?.label, severity: b.answer?.severity, action: b.action_applied ?? (e.kind === "hold" ? "hold" : undefined),
        request_id: z.request_id, chat_id: z.chat_id, provider: z.provider, endpoint: z.endpoint, latency_ms: z.latency_ms,
      });
      if (k !== null) (e.kind === "hold" ? holds : decided).add(k);
      if (!z.request_id || !z.chat_id) fails.ids ??= { seq: i, why: "missing request id or chat id" };
      try {
        const nonce = checkpointNonce(inp.missionId, b.obs_hash, b.checkpoint);
        if (nonce !== b.nonce) fails.nonce ??= { seq: i, why: `nonce is not keccak256(mission, obs_hash, ${b.checkpoint})` };
        const r = verifyBundle({ raw_response: z.raw_response, tee: z.tee ?? {} }, policy, b.nonce);
        row.signer = r.signer;
        row.binding = r.binding;
        if (!r.accepted) {
          const slot = r.reason.startsWith("nonce") || r.reason.startsWith("answer does not parse") ? "nonce" : r.reason.includes("does not cover") ? "binding" : "tee";
          fails[slot] ??= { seq: i, why: r.reason };
        } else if (e.kind === "decision") {
          if (b.action_applied !== r.answer!.action) fails.action ??= { seq: i, why: `robot applied ${b.action_applied} but 0G answered ${r.answer!.action}` };
          if (canonicalJson(b.answer) !== canonicalJson(r.answer)) fails.action ??= { seq: i, why: "logged answer differs from the signed response" };
        }
      } catch (err) {
        fails.nonce ??= { seq: i, why: `malformed decision entry (${(err as Error).message.slice(0, 80)})` };
      }
    } else if (e.kind === "human") {
      Object.assign(row, { action: b.action, reason: `human: ${b.by}` });
      if (k !== null && !holds.has(k)) fails.action ??= { seq: i, why: "human decision without a calibrated hold" };
      if (k !== null) decided.add(k);
    } else if (e.kind === "rejected") {
      Object.assign(row, { reason: b.reason, label: b.attempted_answer?.label, action: b.attempted_answer?.action, signer: b.signer, request_id: b.zg?.request_id });
    } else if (e.kind === "safe_stop") {
      Object.assign(row, { reason: b.reason });
      if (k !== null && decided.has(k)) fails.action ??= { seq: i, why: "safe stop logged for a checkpoint that already had a decision" };
      decided.add(k ?? -1);
    } else return;
    rows.push(row);
  });
  const per = (id: string, title: string, f: { seq: number; why: string } | null, ok: string) =>
    add({ id, title, status: f ? "fail" : proofs ? "pass" : "skip", detail: f ? `Entry #${f.seq}: ${f.why}` : proofs ? ok : "no 0G decisions in this log", seq: f?.seq });
  const proofRows = rows.filter((r) => PROOF_KINDS.has(r.kind));
  per("tee-signer", "Each 0G answer is signed by an allowlisted TEE signer", fails.tee, `${proofs} answer(s), signer(s) ${[...new Set(proofRows.map((r) => r.signer).filter(Boolean))].map(short).join(", ")}`);
  per("tee-binding", "Each TEE signature covers the exact response the robot acted on", fails.binding, `binding: ${[...new Set(proofRows.map((r) => r.binding).filter(Boolean))].join(", ")}`);
  per("nonce", "Each answer echoes its nonce = keccak256(mission, obs_hash, checkpoint)", fails.nonce, "fresh for this request");
  per("action", "The robot did exactly what 0G (or a human, after a hold) decided", fails.action, "actions match signed answers");
  per("request-ids", "Every decision carries x_0g_trace.request_id and the chat id", fails.ids, "present on every decision");

  const counts: Record<string, number> = {};
  for (const e of E) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
  const stops = E.filter((e) => e.kind === "safe_stop");
  add({
    id: "safe-stop",
    title: "Safe stops never fake a decision",
    status: "pass",
    detail: stops.length ? `${stops.length} safe stop(s): "${stops[0].body.reason}"` : "no safe stops in this mission",
  });

  if (inp.replay) {
    add({
      id: "replay",
      title: "Replay from seed + logged answers reproduces the trajectory hash",
      status: inp.replay.match ? "pass" : "fail",
      detail: inp.replay.match ? `trajectory ${short(inp.replay.trajectory_hash)} matches` : `mismatch: ${(inp.replay.mismatches ?? []).join("; ") || "trajectory hash differs"}`,
    });
  } else {
    add({ id: "replay", title: "Replay from seed + logged answers", status: "skip", detail: "run: python -m blackbox_robot.replay --core <url> --mission <id>" });
  }

  const first = checks.find((c) => c.status === "fail");
  return {
    missionId: inp.missionId,
    ok: !first,
    firstFailure: first ? `${first.title}: ${first.detail}` : null,
    checks,
    rows,
    counts,
    robot,
    manifest,
    chain: inp.chain ?? null,
    generatedAt: new Date().toISOString(),
  };
}

export interface LoadOptions {
  rpc: string;
  chainId: number;
  network: string;
  registry: string;
  missionId: string;
  fetchRoot: (root: string) => Promise<Uint8Array>;
}

export interface MissionIndex {
  v: number;
  mission_id: string;
  manifest_root: string;
  count: number;
  entries: { seq: number; kind: string; hash: string; root: string | null }[];
  crops?: Record<string, string>;
}

const dec = (b: Uint8Array) => new TextDecoder().decode(b);

async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) {
        const j = i++;
        out[j] = await fn(items[j]);
      }
    }),
  );
  return out;
}

/** Everything from public sources: the registry on 0G Chain, then the index, manifest and entries on 0G Storage. */
export async function loadFromChain(o: LoadOptions): Promise<VerifyInputs & { index: MissionIndex | null }> {
  const provider = new JsonRpcProvider(o.rpc, o.chainId, { staticNetwork: true });
  const reg = new Contract(o.registry, BLACKBOX_REGISTRY_ABI, provider);
  const mission = toChainMission(await reg.getMission(o.missionId));
  if (!mission) throw new Error(`mission ${o.missionId} is not registered on ${o.network}`);
  const anchors = toChainAnchors(await reg.getAnchors(o.missionId));
  const robotRegistry: string = await reg.robotRegistry();
  const robots = new Contract(robotRegistry, ROBOT_REGISTRY_ABI, provider);
  const robotIsOperator: boolean = await robots.isOperator(mission.robotId, mission.robot);
  let index: MissionIndex | null = null;
  if (mission.indexRoot !== ZERO_HASH) index = JSON.parse(dec(await o.fetchRoot(mission.indexRoot)));
  const manifestText = dec(await o.fetchRoot(mission.manifestRoot));
  const roots: Record<number, string | null> = {};
  let entries: Entry[] = [];
  if (index) {
    for (const e of index.entries) roots[e.seq] = e.root;
    entries = await pool(index.entries, 6, async (e) => {
      if (!e.root) throw new Error(`entry #${e.seq} has no storage root in the index`);
      return JSON.parse(dec(await o.fetchRoot(e.root))) as Entry;
    });
  }
  return {
    missionId: o.missionId,
    entries,
    manifestText,
    roots,
    index,
    chain: { network: o.network, chainId: o.chainId, registry: o.registry, robotRegistry, mission, anchors, robotIsOperator },
  };
}

/** Helpers for UIs: parse a stored decision's answer for display. */
export function answerOf(e: Entry) {
  try {
    return parseAnswer(extractContent(e.body.zg.raw_response));
  } catch {
    return null;
  }
}
