import { esc, renderReport } from "./report.js";

const $ = (id) => document.getElementById(id);
const V = window.BlackboxVerifier;
const q = new URLSearchParams(location.search);
for (const k of ["mission", "network", "registry", "api"]) if (q.get(k)) $(k).value = q.get(k);

// When served by a Blackbox core, prefill from its config.
fetch("/api/config")
  .then((r) => (r.ok ? r.json() : null))
  .then((c) => {
    if (!c?.chain) return;
    if (!q.get("network")) $("network").value = c.chain.network;
    if (!q.get("registry")) $("registry").value = c.chain.registry;
    if (!q.get("api") && c.storage.kind !== "0g") $("api").value = location.origin;
  })
  .catch(() => {});

function fetchRootFn(network) {
  const api = $("api").value.trim().replace(/\/$/, "");
  const indexer = V.NETWORK_DEFAULTS[network]?.indexer;
  return async (root) => {
    const urls = [];
    if (api && !/indexer/.test(api)) urls.push(`${api}/api/storage/${root}`);
    urls.push(`${api && /indexer/.test(api) ? api : indexer}/file?root=${root}`);
    let last = "";
    for (const u of urls) {
      try {
        const r = await fetch(u);
        const b = new Uint8Array(await r.arrayBuffer());
        if (r.ok && !(b.length < 200 && new TextDecoder().decode(b).includes('"code":101'))) return b;
        last = `HTTP ${r.status}`;
      } catch (e) {
        last = e.message;
      }
    }
    throw new Error(`could not fetch ${root} from 0G Storage (${last})`);
  };
}

function storageLink(network) {
  const ind = V.NETWORK_DEFAULTS[network]?.indexer;
  return ind ? (root) => `${ind}/file?root=${root}` : null;
}

async function run(localEntries) {
  const out = $("out");
  out.hidden = false;
  const missionId = $("mission").value.trim();
  const network = $("network").value;
  const net = V.NETWORK_DEFAULTS[network];
  out.innerHTML = `<div class="muted">Reading ${esc(network)} registry and 0G Storage…</div>`;
  try {
    if (!/^0x[0-9a-fA-F]{64}$/.test(missionId)) throw new Error("enter a mission id (0x + 64 hex)");
    const inputs = await V.loadFromChain({ rpc: net.rpc, chainId: net.chainId, network, registry: $("registry").value.trim(), missionId, fetchRoot: fetchRootFn(network) });
    if (localEntries) inputs.entries = localEntries;
    const report = V.verifyMission(inputs);
    const ex = net.explorer;
    const head = `<h2>Report ${localEntries ? "(local copy)" : ""} <span class="sp"></span>${ex ? `<a target="_blank" href="${ex}/address/${esc($("registry").value.trim())}">registry on chainscan ↗</a>` : ""}</h2>`;
    out.innerHTML = head + renderReport(report, { root: storageLink(network) });
  } catch (e) {
    out.innerHTML = `<div class="verdict bad">Could not verify</div><div class="refusal">${esc(e.message)}</div>`;
  }
}

$("go").onclick = () => run(null);
$("file").onchange = async (ev) => {
  const f = ev.target.files[0];
  if (!f) return;
  const t = await f.text();
  const entries = f.name.endsWith(".jsonl") ? t.split("\n").filter(Boolean).map((l) => JSON.parse(l)) : JSON.parse(t).entries ?? JSON.parse(t);
  run(entries);
};
if (q.get("mission")) run(null);
