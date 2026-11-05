import { esc, renderReport, short } from "/report.js";

const $ = (id) => document.getElementById(id);
const S = {
  cfg: null,
  status: null,
  robot: null,
  samples: [],
  missionId: null,
  pending: [], // defects placed before takeoff
  mode: "crack",
  world: { img: null, key: "" },
  variant: { crack: 0, decoy: 0 },
};

async function api(path, body) {
  const opt = body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.ok === false) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function toast(msg, ms = 4000) {
  const t = $("toast");
  t.textContent = msg;
  t.style.display = "block";
  clearTimeout(toast.t);
  toast.t = setTimeout(() => (t.style.display = "none"), ms);
}

const guard = (fn) => async (...a) => {
  try {
    await fn(...a);
  } catch (e) {
    toast(e.message, 6000);
  }
};

// ------------------------------------------------------------------ geometry
const DEF = { deck: [24000, 8000], home: [-2000, 4000] };
function geo(canvas, deck = DEF.deck) {
  const W = canvas.width, H = canvas.height;
  const x0 = -3200, x1 = deck[0] + 1000, y0 = -900, y1 = deck[1] + 900;
  const s = Math.min(W / (x1 - x0), H / (y1 - y0));
  const ox = (W - (x1 - x0) * s) / 2 - x0 * s, oy = (H - (y1 - y0) * s) / 2 - y0 * s;
  return { s, X: (x) => ox + x * s, Y: (y) => oy + y * s, inv: (px, py) => [Math.round((px - ox) / s), Math.round((py - oy) / s)] };
}

function drawScene(ctx, g, o) {
  const { deck, home, waypoints, defects, checkpoints, samples, pose, pending, phase, pendingCp, pulse, ghost, notes } = o;
  const W = ctx.canvas.width, H = ctx.canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#0f141b";
  ctx.fillRect(0, 0, W, H);
  // deck
  const dx = g.X(0), dy = g.Y(0), dw = deck[0] * g.s, dh = deck[1] * g.s;
  if (o.img) ctx.drawImage(o.img, dx, dy, dw, dh);
  else {
    ctx.fillStyle = "#8e8c88";
    ctx.fillRect(dx, dy, dw, dh);
  }
  ctx.strokeStyle = "rgba(255,255,255,.10)";
  ctx.lineWidth = 1;
  for (let x = 0; x <= deck[0]; x += 1000) line(ctx, g.X(x), dy, g.X(x), dy + dh);
  for (let y = 0; y <= deck[1]; y += 1000) line(ctx, dx, g.Y(y), dx + dw, g.Y(y));
  ctx.strokeStyle = "rgba(255,255,255,.35)";
  ctx.strokeRect(dx, dy, dw, dh);
  // lawnmower path
  if (waypoints?.length) {
    ctx.setLineDash([6, 6]);
    ctx.strokeStyle = "rgba(92,200,255,.35)";
    ctx.beginPath();
    ctx.moveTo(g.X(home[0]), g.Y(home[1]));
    for (const [x, y] of waypoints) ctx.lineTo(g.X(x), g.Y(y));
    ctx.stroke();
    ctx.setLineDash([]);
  }
  // home pad
  ctx.strokeStyle = "#5cc8ff";
  ctx.lineWidth = 2;
  circle(ctx, g.X(home[0]), g.Y(home[1]), 14, false);
  ctx.fillStyle = "#5cc8ff";
  ctx.font = "bold 13px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("H", g.X(home[0]), g.Y(home[1]) + 5);
  // placed defects (texture already shows the mark; label it)
  for (const d of [...(defects || []), ...(pending || [])]) {
    const c = d.kind === "crack" ? "#ff7a59" : "#f2d15c";
    if (!o.img || d.pendingDraw) {
      ctx.strokeStyle = c;
      ctx.lineWidth = 3;
      line(ctx, g.X(d.x_mm - 400), g.Y(d.y_mm + 150), g.X(d.x_mm + 400), g.Y(d.y_mm - 150));
    }
    ctx.strokeStyle = c;
    ctx.lineWidth = 1.5;
    circle(ctx, g.X(d.x_mm), g.Y(d.y_mm), 0.55 * 1000 * g.s, false);
    ctx.fillStyle = c;
    ctx.font = "600 11px sans-serif";
    ctx.fillText(d.kind, g.X(d.x_mm), g.Y(d.y_mm) - 0.6 * 1000 * g.s - 4);
  }
  // checkpoint outcomes
  for (const cp of checkpoints || []) {
    const [x, y] = cp.target_mm;
    const col = cp.outcome === "descend" ? "#3ddc97" : cp.outcome === "continue" ? "#8a99ad" : cp.outcome === "safe_stop" ? "#ffbf47" : "#b48cff";
    ctx.fillStyle = col;
    circle(ctx, g.X(x), g.Y(y), 5, true);
    ctx.font = "600 11px ui-monospace, monospace";
    ctx.fillText(`#${cp.k} ${cp.outcome ?? "…"}`, g.X(x), g.Y(y) + 18);
  }
  // split-screen annotations
  for (const n of notes || []) {
    ctx.fillStyle = n.color;
    ctx.strokeStyle = n.color;
    ctx.lineWidth = 2;
    circle(ctx, g.X(n.x), g.Y(n.y), 0.7 * 1000 * g.s, false);
    ctx.font = "700 12px sans-serif";
    ctx.fillText(n.text, g.X(n.x), g.Y(n.y) + 0.7 * 1000 * g.s + 14);
  }
  // trail
  if (samples?.length) {
    ctx.strokeStyle = ghost ? "rgba(255,122,89,.9)" : "rgba(92,200,255,.9)";
    ctx.lineWidth = 2;
    ctx.beginPath();
    samples.forEach((p, i) => (i ? ctx.lineTo(g.X(p[1]), g.Y(p[2])) : ctx.moveTo(g.X(p[1]), g.Y(p[2]))));
    ctx.stroke();
  }
  // pending checkpoint pulse
  if (pendingCp) {
    const [x, y] = pendingCp.target_mm;
    ctx.strokeStyle = `rgba(255,191,71,${0.5 + 0.5 * Math.sin(pulse / 3)})`;
    ctx.lineWidth = 3;
    circle(ctx, g.X(x), g.Y(y), 0.6 * 1000 * g.s + 4 * Math.sin(pulse / 3), false);
    if (pose) line(ctx, g.X(pose[0]), g.Y(pose[1]), g.X(x), g.Y(y));
  }
  // drone
  if (pose) {
    const [x, y, z] = pose;
    const r = 9 + Math.min(8, z / 450);
    ctx.fillStyle = "rgba(0,0,0,.35)";
    circle(ctx, g.X(x) + z * g.s * 0.25, g.Y(y) + z * g.s * 0.25, r, true);
    ctx.fillStyle = ghost ? "#ff7a59" : phase === "SAFE_RTH" || phase === "STOPPED" ? "#ffbf47" : "#5cc8ff";
    for (const [ax, ay] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) circle(ctx, g.X(x) + ax * r * 0.8, g.Y(y) + ay * r * 0.8, r * 0.45, true);
    circle(ctx, g.X(x), g.Y(y), r * 0.55, true);
  }
}
const line = (c, a, b, x, y) => (c.beginPath(), c.moveTo(a, b), c.lineTo(x, y), c.stroke());
const circle = (c, x, y, r, fill) => (c.beginPath(), c.arc(x, y, Math.max(0, r), 0, Math.PI * 2), fill ? c.fill() : c.stroke());

// ------------------------------------------------------------------ main map
const map = $("map");
const mctx = map.getContext("2d");
let pulse = 0;
function render() {
  pulse++;
  const sim = S.robot?.sim;
  const deck = sim?.deck_mm ?? DEF.deck;
  const g = geo(map, deck);
  drawScene(mctx, g, {
    img: sim ? S.world.img : null,
    deck,
    home: sim?.home_mm ?? DEF.home,
    waypoints: sim?.waypoints_mm,
    defects: sim?.defects,
    pending: sim && sim.phase !== "LANDED" && sim.phase !== "STOPPED" ? [] : S.pending.map((d) => ({ ...d, pendingDraw: true })),
    checkpoints: sim?.checkpoints,
    samples: S.samples,
    pose: sim?.pose_mm,
    phase: sim?.phase,
    pendingCp: sim?.pending,
    pulse,
  });
  requestAnimationFrame(render);
}

map.addEventListener("click", guard(async (ev) => {
  const r = map.getBoundingClientRect();
  const px = ((ev.clientX - r.left) / r.width) * map.width, py = ((ev.clientY - r.top) / r.height) * map.height;
  const deck = S.robot?.sim?.deck_mm ?? DEF.deck;
  const [x, y] = geo(map, deck).inv(px, py);
  if (x < 300 || y < 300 || x > deck[0] - 300 || y > deck[1] - 300) return toast("Place defects on the deck");
  const variant = S.variant[S.mode]++ % (S.mode === "crack" ? 5 : 2);
  const phase = S.robot?.sim?.phase;
  if (phase && !["LANDED", "STOPPED"].includes(phase) && S.status?.mission?.status === "flying") {
    await api("/api/world/place", { kind: S.mode, x_mm: x, y_mm: y, variant });
  } else {
    S.pending.push({ kind: S.mode, x_mm: x, y_mm: y, variant });
  }
}));

// ------------------------------------------------------------------ polling
async function pollRobot() {
  try {
    const st = await api(`/api/robot/state?since=${S.samples.length}`);
    if (st.mission_id !== S.missionId) {
      S.missionId = st.mission_id;
      S.samples = [];
      S.world.key = "";
    } else S.samples.push(...st.samples);
    S.robot = st;
    const key = `${st.mission_id}:${st.sim?.defects?.length ?? 0}`;
    if (st.sim && key !== S.world.key) {
      S.world.key = key;
      const img = new Image();
      img.onload = () => (S.world.img = img);
      img.src = `/api/robot/world.png?k=${encodeURIComponent(key)}`;
    }
    renderHud();
    renderEvents();
  } catch {
    S.robot = null;
    $("hud").innerHTML = `<span style="color:var(--bad)">robot adapter offline</span>`;
  }
  setTimeout(pollRobot, 120);
}

async function pollStatus() {
  try {
    S.status = await api("/api/status");
    renderStatus();
  } catch (e) {
    $("chips").innerHTML = `<span class="chip bad">core offline</span>`;
  }
  setTimeout(pollStatus, 900);
}

// ------------------------------------------------------------------ renderers
function renderChips() {
  const c = S.cfg, st = S.status;
  const chips = [];
  if (c.chain) chips.push(`<span class="chip ok">0G Chain · ${esc(c.chain.network)} ${c.chain.chainId}</span>`);
  else chips.push(`<span class="chip warn">chain disabled</span>`);
  chips.push(c.zg.mode === "mock" ? `<span class="chip warn">0G Compute · MOCK</span>` : `<span class="chip ok">0G Compute · ${esc(c.zg.model)} · ${esc(c.zg.trustMode)}</span>`);
  chips.push(c.storage.kind === "0g" ? `<span class="chip ok">0G Storage · turbo</span>` : `<span class="chip warn">storage · local dev</span>`);
  if (S.robot) chips.push(`<span class="chip">robot ${esc(short(S.robot.robot, 8))}</span>`);
  if (st?.demo?.linkDown) chips.push(`<span class="chip bad">0G LINK CUT</span>`);
  $("chips").innerHTML = chips.join("");
  $("mockbar").hidden = c.zg.mode !== "mock";
}

function renderHud() {
  const st = S.robot, sim = st?.sim, cp = st?.checkpoint;
  if (!sim) {
    $("hud").innerHTML = `<span>robot <b>${esc(short(st?.robot, 8))}</b></span><span>no mission · place cracks and decoys, then Start</span><span>${S.pending.length} placed</span>`;
    $("leaseBar").style.width = "0";
    return;
  }
  const [x, y, z] = sim.pose_mm;
  const items = [
    ["phase", sim.phase],
    ["t", (sim.t_ms / 1000).toFixed(1) + " s"],
    ["pos", `${(x / 1000).toFixed(1)}, ${(y / 1000).toFixed(1)} m`],
    ["alt", (z / 1000).toFixed(2) + " m"],
    ["physics", sim.backend],
    ["log", `${st.log_len} entries`],
  ];
  if (st.outbox_pending) items.push(["outbox", `${st.outbox_pending} waiting${st.outbox_error ? " (" + st.outbox_error + ")" : ""}`]);
  if (cp && (cp.status === "waiting" || cp.status === "await_human")) {
    items.push(["checkpoint", `#${cp.k} ${cp.status === "waiting" ? "asking 0G" : "awaiting human"} · lease ${(cp.remaining_ms / 1000).toFixed(1)} s`]);
    if (cp.refused) items.push(["refused", cp.refused]);
    if (cp.last_error) items.push(["last error", cp.last_error.slice(0, 80)]);
    $("leaseBar").style.width = `${(100 * cp.remaining_ms) / cp.lease_ms}%`;
  } else $("leaseBar").style.width = "0";
  if (sim.final) items.push(["final", sim.final]);
  $("hud").innerHTML = items.map(([k, v]) => `<span>${k} <b>${esc(v)}</b></span>`).join("");
}

function renderEvents() {
  const ev = S.robot?.events ?? [];
  $("events").innerHTML = ev
    .slice()
    .reverse()
    .map((e) => `<div class="${esc(e.level)}">${new Date(e.t).toLocaleTimeString()} ${esc(e.text)}</div>`)
    .join("");
}

function linkOr(url, text) {
  return url ? `<a target="_blank" href="${esc(url)}">${esc(text)}</a>` : esc(text);
}

function verifierUrl(m) {
  const c = S.cfg;
  const base = c.publicVerifierUrl || `${location.origin}/verify.html`;
  const q = new URLSearchParams({ mission: m.id });
  if (c.chain) {
    q.set("network", c.chain.network);
    q.set("registry", c.chain.registry);
  }
  if (!c.publicVerifierUrl || c.storage.kind !== "0g") q.set("api", location.origin);
  return `${base}?${q}`;
}

function renderStatus() {
  renderChips();
  const st = S.status, m = st.mission;
  $("btnKill").classList.toggle("on", !!st.demo.linkDown);
  $("btnKill").textContent = st.demo.linkDown ? "Restore 0G link" : "Cut 0G link";
  $("btnForge").textContent = st.demo.forgeArmed ? "Forge armed…" : 'Forge "continue"';
  $("btnTamperAns").textContent = st.demo.tamperArmed ? "Tamper armed…" : "Tamper 0G answer";
  $("queueInfo").textContent = st.queue ? `writer queue: ${st.queue} pending` : "writer queue idle";
  $("btnStart").disabled = m && (m.status === "flying" || m.status === "preparing");
  if (!m) return;
  $("missionId").textContent = `${short(m.id, 12)} · ${m.status}`;
  $("lnkVerifier").href = verifierUrl(m);
  // record
  // values are HTML: plain text goes through esc() here
  const replay = !m.replay
    ? "after close"
    : m.replay.match
      ? `<span style="color:var(--ok)">trajectory hash matches ${esc(short(m.replay.trajectory_hash))}</span>`
      : `<span style="color:var(--bad)">${esc(m.replay.error || (m.replay.mismatches || []).join("; ") || "trajectory hash differs")}</span>`;
  const kv = [
    ["mission", esc(m.id)],
    ["manifest root", linkOr(m.manifestTxUrl || m.manifestUrl, m.manifestRoot ?? "uploading…")],
    ["TEE allowlist", esc((m.policy.tee_signers || []).map((s) => short(s, 10)).join(", "))],
    ["registerMission", m.registerTx ? linkOr(m.registerTxUrl, short(m.registerTx, 12)) : S.cfg.chain ? "pending…" : "chain disabled"],
    ["anchors", m.anchors.map((a) => linkOr(a.txUrl, `${a.count} entries`)).join(" · ") || "none yet"],
    ["closeMission", m.closeTx ? linkOr(m.closeTxUrl, `closed ${short(m.closeTx, 12)}`) : m.status === "closed" ? "closed (no chain)" : "open"],
    ["replay", replay],
  ];
  if (m.errors.length) kv.push(["errors", `<span style="color:var(--bad)">${esc(m.errors[m.errors.length - 1])}</span>`]);
  $("recordKv").innerHTML = kv.map(([k, v]) => `<span>${k}</span><b>${v}</b>`).join("");
  // ledger
  $("ledger").innerHTML =
    `<tr><th>#</th><th>kind</th><th>what</th><th>hash</th><th>0G Storage</th></tr>` +
    m.entries
      .slice()
      .reverse()
      .map((e) => `<tr><td>${e.seq}</td><td class="k-${e.kind}">${e.kind}</td><td>${esc(entryWhat(e))}</td><td>${short(e.hash, 8)}</td><td>${e.root ? linkOr(e.txUrl || e.rootUrl, short(e.root, 8)) : "uploading…"}</td></tr>`)
      .join("");
  renderFeed(m);
}

function entryWhat(e) {
  const b = e.body || {};
  switch (e.kind) {
    case "mission_start": return `manifest ${short(b.manifest_root, 8)}, ${b.defects?.length ?? 0} defects, ${b.backend}`;
    case "world": return `${b.kind ?? b.defect?.kind} placed`;
    case "decision": return `cp ${b.checkpoint}: ${b.answer?.label} → ${b.action_applied} (req ${short(b.request_id, 8)})`;
    case "rejected": return `cp ${b.checkpoint}: ${b.reason}`;
    case "safe_stop": return `cp ${b.checkpoint ?? "–"}: ${b.reason}`;
    case "hold": return `cp ${b.checkpoint}: hold (${b.decision_model?.reason ?? ""})`;
    case "human": return `cp ${b.checkpoint}: human → ${b.action}`;
    case "mission_end": return `${b.final}, trajectory ${short(b.trajectory_hash, 8)}`;
    default: return "";
  }
}

function renderFeed(m) {
  const byK = new Map();
  const get = (k) => (byK.has(k) ? byK.get(k) : (byK.set(k, { k, refusals: [] }), byK.get(k)));
  for (const e of m.entries) {
    const b = e.body || {};
    if (typeof b.checkpoint !== "number") continue;
    const c = get(b.checkpoint);
    if (e.kind === "decision") c.decision = { ...b, seq: e.seq, root: e.root, rootUrl: e.txUrl || e.rootUrl };
    if (e.kind === "rejected") c.refusals.push(b);
    if (e.kind === "safe_stop") c.stop = b;
    if (e.kind === "hold") c.hold = b;
    if (e.kind === "human") c.human = b;
  }
  const live = S.robot?.checkpoint;
  if (live && S.robot.mission_id === m.id) {
    const c = get(live.k);
    c.live = live;
  }
  for (const [k, v] of Object.entries(m.checkpoints || {})) get(Number(k)).attempts = v.attempts;
  const cards = [...byK.values()].sort((a, b) => b.k - a.k).map((c) => card(m, c));
  $("feedCount").textContent = `${byK.size} checkpoint(s)`;
  $("feed").innerHTML = cards.join("") || `<div class="muted">Waiting for the first checkpoint…</div>`;
}

function card(m, c) {
  let cls = "", badge = `<span class="badge dim">asking 0G…</span>`;
  const d = c.decision;
  if (d) [cls, badge] = ["accepted", `<span class="badge ok">accepted · ${esc(d.action_applied)}</span>`];
  else if (c.stop) [cls, badge] = ["stopped", `<span class="badge warn">safe stop</span>`];
  else if (c.human) [cls, badge] = ["accepted", `<span class="badge hold">human · ${esc(c.human.action)}</span>`];
  else if (c.hold) [cls, badge] = ["hold", `<span class="badge hold">calibrated hold</span>`];
  else if (c.refusals.length) cls = "refused";
  if (c.refusals.length) badge += ` <span class="badge bad">${c.refusals.length} refused</span>`;
  const a = d?.answer ?? c.hold?.answer;
  let kv = "";
  if (d || c.hold) {
    const x = d ?? c.hold;
    kv = `<div class="kv">
      <span>request_id</span><b>${esc(x.request_id)}</b>
      <span>chat id</span><b>${esc(x.chat_id)}</b>
      <span>TEE signer</span><b>${esc(short(x.signer, 12))} ✔ allowlisted</b>
      <span>binding</span><b>${esc(x.binding)} · nonce echoed ✔</b>
      <span>endpoint</span><b>${esc(x.endpoint)} · ${esc(x.latency_ms)} ms${x.router_tee_verified ? " · router tee_verified" : ""}</b>
      ${d?.root ? `<span>0G Storage</span><b>${linkOr(d.rootUrl, short(d.root, 10))}</b>` : ""}
    </div>`;
  }
  const refusals = c.refusals.map((r) => `<div class="refusal">✘ ${esc(r.source)}: ${esc(r.reason)}</div>`).join("");
  const stop = c.stop ? `<div class="refusal" style="color:var(--warn);background:#251d0b">⏹ ${esc(c.stop.reason)}${c.stop.last_error ? ` · ${esc(c.stop.last_error)}` : ""}</div>` : "";
  let hold = "";
  if (c.hold && !c.human && !c.stop) {
    const dm = c.hold.decision_model || {};
    hold = `<div class="refusal" style="color:var(--hold);background:#1b1430">${esc(dm.model)}: ${esc(dm.reason)} - the robot holds and asks a human
      <div class="row" style="display:flex;gap:6px;margin-top:6px"><button data-human="${c.k}" data-action="descend">Approve descend</button><button data-human="${c.k}" data-action="continue">Approve continue</button></div></div>`;
  }
  const live = c.live && c.live.status === "waiting" && !d ? `<div class="muted mono" style="margin-top:6px">lease ${(c.live.remaining_ms / 1000).toFixed(1)} s · asks ${c.live.asks}${c.live.last_error ? " · " + esc(c.live.last_error.slice(0, 90)) : ""}</div>` : "";
  return `<div class="cp ${cls}">
    <img src="/api/missions/${m.id}/crop/${c.k}.png" alt="crop ${c.k}" onerror="this.style.visibility='hidden'" />
    <div>
      <div class="head"><b>Checkpoint ${c.k}</b>${badge}</div>
      ${a ? `<div style="margin-top:4px">0G: <span class="ans ${esc(a.label)}">${esc(a.label)}</span> · severity ${esc(a.severity)} · ${esc(a.action)}</div>` : ""}
      ${kv}${refusals}${stop}${hold}${live}
    </div></div>`;
}

$("feed").addEventListener("click", guard(async (ev) => {
  const b = ev.target.closest("button[data-human]");
  if (!b) return;
  await api("/api/robot/human", { checkpoint: Number(b.dataset.human), action: b.dataset.action });
}));

// ------------------------------------------------------------------ modal
function openModal(html) {
  $("modalBox").innerHTML = html;
  $("modal").classList.add("open");
}
const closeModal = () => ($("modal").classList.remove("open"), (split.stop = true));
$("modal").addEventListener("click", (e) => {
  if (e.target.id === "modal" || e.target.closest("[data-close]")) closeModal();
});
document.addEventListener("keydown", (e) => e.key === "Escape" && closeModal());
const closeBtn = `<button data-close>Close</button>`;

// ------------------------------------------------------------------ buttons
$("modeCrack").onclick = () => ((S.mode = "crack"), $("modeCrack").classList.add("on"), $("modeDecoy").classList.remove("on"));
$("modeDecoy").onclick = () => ((S.mode = "decoy"), $("modeDecoy").classList.add("on"), $("modeCrack").classList.remove("on"));

$("btnStart").onclick = guard(async () => {
  $("btnStart").disabled = true;
  toast("Uploading manifest to 0G Storage, registering the mission on 0G Chain…", 8000);
  try {
    await api("/api/mission/start", { defects: S.pending });
    S.pending = [];
  } finally {
    $("btnStart").disabled = false;
  }
});

$("btnKill").onclick = guard(async () => {
  const down = !S.status?.demo?.linkDown;
  await api("/api/demo/link", { down });
  toast(down ? "0G link cut. The next checkpoint gets no signed answer: the lease expires and the robot safe-stops." : "0G link restored.");
});
$("btnEstop").onclick = guard(async () => api("/api/robot/estop", {}));
$("btnForge").onclick = guard(async () => {
  await api("/api/demo/forge", {});
  toast("Armed: at the next checkpoint the operator console sends a forged 'continue' signed with the operator's own key.");
});
$("btnTamperAns").onclick = guard(async () => {
  await api("/api/demo/tamper-answer", {});
  toast("Armed: the core will flip 0G's next answer to 'continue' but keep 0G's real TEE signature.");
});
$("btnTamperLog").onclick = guard(async () => {
  const m = S.status?.mission;
  if (!m) throw new Error("no mission yet");
  const t = await api(`/api/missions/${m.id}/tamper-log`, {});
  openModal(`<h3>Verifier on a tampered copy <span class="sp"></span>${closeBtn}</h3>
    <div class="muted" style="margin-bottom:10px">Changed in a local copy of the log: <b class="mono">${esc(t.change)}</b>. The on-chain anchors and robot signatures expose it.</div>
    ${renderReport(t.report)}`);
});
$("btnVerify").onclick = guard(async () => {
  const m = S.status?.mission;
  if (!m) throw new Error("no mission yet");
  openModal(`<h3>Verifying ${esc(short(m.id, 12))}… <span class="sp"></span>${closeBtn}</h3><div class="muted">Reading the registry on 0G Chain and every entry from 0G Storage.</div>`);
  const src = S.cfg.chain ? "storage" : "local";
  const r = await api(`/api/missions/${m.id}/verify?source=${src}`);
  openModal(`<h3>Verifier <span class="sp"></span><a target="_blank" href="${esc(verifierUrl(m))}">open public verifier ↗</a> ${closeBtn}</h3>${renderReport(r)}`);
});
$("btnQR").onclick = guard(async () => {
  const m = S.status?.mission;
  if (!m) throw new Error("no mission yet");
  const url = verifierUrl(m);
  let img = "";
  if (window.qrcode) {
    const q = window.qrcode(0, "M");
    q.addData(url);
    q.make();
    img = `<div class="qr">${q.createSvgTag({ cellSize: 6, margin: 2 })}</div>`;
  }
  openModal(`<h3>Verify on your phone <span class="sp"></span>${closeBtn}</h3>${img}<p class="mono" style="overflow-wrap:anywhere">${esc(url)}</p>
    ${location.hostname === "127.0.0.1" || location.hostname === "localhost" ? `<p class="muted">Set PUBLIC_VERIFIER_URL to your deployed verifier so phones can open it.</p>` : ""}`);
});

// split screen counterfactual
const split = { stop: false };
$("btnSplit").onclick = guard(async () => {
  const sim = S.robot?.sim;
  if (!sim) throw new Error("no mission yet");
  const cf = await api("/api/counterfactual", { force: "continue" });
  openModal(`<h3>Same seed, same world. Only 0G's answers differ. <span class="sp"></span>${closeBtn}</h3>
    <div class="split">
      <div><div class="cap" style="color:var(--accent)">0G decided</div><canvas id="cvA" width="900" height="340"></canvas></div>
      <div><div class="cap" style="color:var(--crack)">0G's answer forced to "continue"</div><canvas id="cvB" width="900" height="340"></canvas></div>
    </div><p class="muted">Left: the logged mission. Right: the replay with every 0G action overridden. The right drone flies past the crack: 0G's answer moved the robot.</p>`);
  split.stop = false;
  const A = cf.actual, B = cf.counterfactual;
  const end = Math.max(A.at(-1)?.[0] ?? 0, B.at(-1)?.[0] ?? 0);
  const cA = $("cvA").getContext("2d"), cB = $("cvB").getContext("2d");
  const gA = geo($("cvA"), sim.deck_mm), gB = geo($("cvB"), sim.deck_mm);
  let t = 0;
  const upTo = (arr) => arr.filter((p) => p[0] <= t);
  // label each checkpoint 0G sent the drone down to, once the drone has passed it
  const dove = (sim.checkpoints || []).filter((c) => c.outcome === "descend");
  const passed = (c) => t >= c.step;
  const step = () => {
    if (split.stop) return;
    t = Math.min(end, t + 240 * 0.25);
    const a = upTo(A), b = upTo(B);
    const base = { img: S.world.img, deck: sim.deck_mm, home: sim.home_mm, waypoints: sim.waypoints_mm, defects: sim.defects };
    const note = (text, color) => dove.filter(passed).map((c) => ({ x: c.target_mm[0], y: c.target_mm[1], text, color }));
    drawScene(cA, gA, { ...base, samples: a, pose: a.at(-1)?.slice(1), notes: note("inspected", "#3ddc97") });
    drawScene(cB, gB, { ...base, samples: b, pose: b.at(-1)?.slice(1), ghost: true, notes: note("crack skipped", "#ff5d6c") });
    if (t < end) requestAnimationFrame(step);
  };
  step();
});

// ------------------------------------------------------------------ boot
(async () => {
  S.cfg = await api("/api/config");
  renderChips();
  pollRobot();
  pollStatus();
  render();
})();
