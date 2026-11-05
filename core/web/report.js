// Shared renderer for verifier reports (dashboard modal + public verify page).
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const short = (h, n = 10) => (h ? `${h.slice(0, n)}…${h.slice(-4)}` : "–");
const ICON = { pass: "✔", fail: "✘", warn: "!", skip: "–" };

export function renderReport(r, links = {}) {
  const verdict = r.ok
    ? `<div class="verdict ok">VERIFIED · ${esc(short(r.missionId, 12))}</div>`
    : `<div class="verdict bad">TAMPERING DETECTED</div><div class="refusal" style="margin-bottom:12px">${esc(r.firstFailure)}</div>`;
  const checks = r.checks
    .map((c) => `<div class="check ${c.status}"><div class="i">${ICON[c.status]}</div><div><div>${esc(c.title)}</div><div class="d">${esc(c.detail)}</div></div></div>`)
    .join("");
  const rows = (r.rows || [])
    .map((x) => {
      const root = x.root ? (links.root ? `<a target="_blank" href="${esc(links.root(x.root))}">${esc(short(x.root, 8))}</a>` : esc(short(x.root, 8))) : "–";
      return `<tr><td>#${x.seq}</td><td class="k-${esc(x.kind)}">${esc(x.kind)}</td><td>${x.checkpoint ?? "–"}</td>
        <td>${esc(x.label ?? "")} ${x.severity ?? ""} ${x.action ? "→ " + esc(x.action) : ""}</td>
        <td>${esc(x.request_id ?? "–")}</td><td>${esc(short(x.signer, 8))}</td><td>${esc(x.binding ?? "")}</td><td>${root}</td>
        <td class="muted">${esc(x.reason ?? "")}</td></tr>`;
    })
    .join("");
  const counts = Object.entries(r.counts || {}).map(([k, v]) => `${k}: ${v}`).join(" · ");
  return `${verdict}
    <div class="muted mono" style="margin-bottom:10px">robot ${esc(r.robot)} · ${esc(counts)}</div>
    <div class="checks">${checks}</div>
    <h3 style="margin:16px 0 8px;font-size:14px">Decisions, refusals and safe stops</h3>
    <div style="overflow:auto"><table class="ledger"><tr><th>entry</th><th>kind</th><th>cp</th><th>answer</th><th>x_0g_trace.request_id</th><th>TEE signer</th><th>binding</th><th>0G Storage root</th><th>note</th></tr>${rows}</table></div>`;
}
