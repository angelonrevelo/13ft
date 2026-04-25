// Reads chrome.storage.local + storage state into the dashboard UI.
// Pure read-only; no mutations.

const $ = (id) => document.getElementById(id);
const STRATEGIES = ["googlebot", "bingbot", "cookie-reset", "proxy"];
const COLORS = {
  googlebot: "#1f6feb", bingbot: "#008373",
  "cookie-reset": "#a06800", proxy: "#111",
  exhausted: "#a61b1b"
};

async function load() {
  const all = await chrome.storage.local.get(null);
  const failures = all.strategyFailures || {};
  const exhausted = new Set(all.exhaustedHosts || []);
  const enabled = new Set(all.enabledHosts || []);
  const overrides = all.siteOverrides || {};
  const proxyHealth = all.proxyHealth || {};
  const remoteRules = all.remoteSitesGenerated || {};
  const remoteUpdatedAt = all.remoteSitesGeneratedAt || null;

  $("lastUpdated").textContent =
    `Generated at ${new Date().toLocaleString()}.`;

  // --- Overview tile ---
  const allHosts = new Set([
    ...enabled, ...exhausted, ...Object.keys(failures), ...Object.keys(overrides)
  ]);
  let totalFailures = 0;
  for (const m of Object.values(failures)) {
    for (const c of Object.values(m)) totalFailures += c;
  }
  const reachableProxies = Object.values(proxyHealth)
    .filter((p) => p && p.reachable).length;
  $("overview").innerHTML = `
    <div class="stat-row"><span>Hosts known</span><b>${allHosts.size}</b></div>
    <div class="stat-row"><span>Currently enabled</span><b>${enabled.size}</b></div>
    <div class="stat-row"><span>Exhausted (chain failed)</span><b>${exhausted.size}</b></div>
    <div class="stat-row"><span>Total strategy-failure events</span><b>${totalFailures}</b></div>
    <div class="stat-row"><span>Proxies reachable</span><b>${reachableProxies}/${Object.keys(proxyHealth).length || 5}</b></div>
    <div class="stat-row"><span>Hand-curated overrides</span><b>${Object.keys(overrides).length}</b></div>
    <div class="stat-row" style="border-bottom:none"><span>Remote rules cached</span><b>${Object.keys(remoteRules).length}</b></div>
  `;

  // --- Sankey (chain transitions, simplified) ---
  // Aggregate counts: how many hosts hit each strategy. The sankey
  // shows flow googlebot→bingbot→cookie-reset→proxy→exhausted with
  // counts on each edge derived from `failures` (a host that failed
  // googlebot then bingbot must have transitioned through both).
  const totals = { googlebot: 0, bingbot: 0, "cookie-reset": 0, proxy: 0, exhausted: 0 };
  for (const [host, perStrat] of Object.entries(failures)) {
    if (perStrat.googlebot) totals.googlebot += perStrat.googlebot;
    if (perStrat.bingbot) totals.bingbot += perStrat.bingbot;
    if (perStrat["cookie-reset"]) totals["cookie-reset"] += perStrat["cookie-reset"];
    if (perStrat.proxy) totals.proxy += perStrat.proxy;
    if (exhausted.has(host)) totals.exhausted += 1;
  }
  drawSankey(totals);
  $("sankeyDetail").textContent =
    `Counts represent failure events. Hosts that succeeded on the first ` +
    `strategy don't appear here at all (no failures recorded).`;

  // --- Per-host table ---
  const tbody = $("hostsTable").querySelector("tbody");
  const sortedHosts = [...allHosts].sort((a, b) => {
    const fa = failures[a] || {};
    const fb = failures[b] || {};
    const sa = Object.values(fa).reduce((s, n) => s + n, 0);
    const sb = Object.values(fb).reduce((s, n) => s + n, 0);
    return sb - sa || a.localeCompare(b);
  });
  if (sortedHosts.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">No host data yet.</td></tr>`;
  } else {
    tbody.innerHTML = sortedHosts.map((h) => {
      const f = failures[h] || {};
      const isExh = exhausted.has(h);
      const isOn = enabled.has(h);
      const status = isExh
        ? `<span class="strategy exhausted">EXHAUSTED</span>`
        : isOn
        ? `<span class="strategy ${(overrides[h]?.strategy) || "googlebot"}">${(overrides[h]?.strategy) || "googlebot"}</span>`
        : `<span style="color:#888">disabled</span>`;
      return `<tr>
        <td>${esc(h)}</td>
        <td class="r">${f.googlebot || ""}</td>
        <td class="r">${f.bingbot || ""}</td>
        <td class="r">${f["cookie-reset"] || ""}</td>
        <td class="r">${f.proxy || ""}</td>
        <td>${status}</td>
      </tr>`;
    }).join("");
  }

  // --- Proxy health ---
  const ptbody = $("proxyTable").querySelector("tbody");
  const proxyEntries = Object.entries(proxyHealth);
  if (proxyEntries.length === 0) {
    ptbody.innerHTML = `<tr><td colspan="4" class="empty">Probe hasn't run yet. Open the popup → Check button.</td></tr>`;
  } else {
    ptbody.innerHTML = proxyEntries.map(([k, v]) => {
      const ok = v?.reachable;
      const lat = v?.latencyMs != null ? `${v.latencyMs} ms` : "—";
      const when = v?.lastChecked
        ? `${Math.round((Date.now() - v.lastChecked) / 60000)} min ago`
        : "—";
      return `<tr>
        <td>${esc(k)}</td>
        <td><span style="color:${ok ? "#2ea44f" : "#a61b1b"}; font-weight:700">${ok ? "OK" : "FAIL"}</span></td>
        <td class="r">${lat}</td>
        <td class="r" style="color:#888">${when}</td>
      </tr>`;
    }).join("");
  }

  // --- Rules cache ---
  const ageHours = remoteUpdatedAt
    ? Math.round((Date.now() - remoteUpdatedAt) / 3600000) : null;
  $("rulesPanel").innerHTML = `
    <div class="stat-row"><span>Remote URL</span>
      <span class="raw" style="text-align:right">${esc(all.rulesUrl || "(default)")}</span></div>
    <div class="stat-row"><span>Last refresh</span>
      <b>${ageHours == null ? "never" : ageHours + " h ago"}</b></div>
    <div class="stat-row" style="border-bottom:none"><span>Entries</span>
      <b>${Object.keys(remoteRules).length}</b></div>
  `;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;");
}

function drawSankey(totals) {
  // Hand-rolled SVG: 5 strategy nodes laid out left-to-right with
  // edges proportional to the failure counts cascading through the
  // chain. Width-height are viewBox units (600×220).
  const svg = document.querySelector("svg.sankey");
  if (!svg) return;
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const order = ["googlebot", "bingbot", "cookie-reset", "proxy", "exhausted"];
  const max = Math.max(1, ...order.map((k) => totals[k] || 0));
  const W = 600, H = 220, NODE_W = 80, GAP = (W - NODE_W * 5) / 4;

  const xs = order.map((_, i) => i * (NODE_W + GAP));
  const heights = order.map((k) => Math.max(8, ((totals[k] || 0) / max) * 160));
  const ys = heights.map((h) => (H - h) / 2);

  // Edges (rectangles bridging adjacent nodes, height = min of the two)
  for (let i = 0; i < order.length - 1; i++) {
    const left = order[i], right = order[i + 1];
    const flowH = Math.min(heights[i], heights[i + 1]);
    const yMid = H / 2;
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    const x1 = xs[i] + NODE_W;
    const x2 = xs[i + 1];
    const cx = (x1 + x2) / 2;
    path.setAttribute("d",
      `M ${x1} ${yMid - flowH / 2} ` +
      `C ${cx} ${yMid - flowH / 2}, ${cx} ${yMid - flowH / 2}, ${x2} ${yMid - flowH / 2} ` +
      `L ${x2} ${yMid + flowH / 2} ` +
      `C ${cx} ${yMid + flowH / 2}, ${cx} ${yMid + flowH / 2}, ${x1} ${yMid + flowH / 2} Z`);
    path.setAttribute("fill", COLORS[left]);
    path.setAttribute("opacity", "0.25");
    svg.appendChild(path);
  }
  // Nodes
  order.forEach((k, i) => {
    const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
    r.setAttribute("x", xs[i]);
    r.setAttribute("y", ys[i]);
    r.setAttribute("width", NODE_W);
    r.setAttribute("height", heights[i]);
    r.setAttribute("fill", COLORS[k]);
    r.setAttribute("rx", 3);
    svg.appendChild(r);
    // Label
    const t = document.createElementNS("http://www.w3.org/2000/svg", "text");
    t.setAttribute("x", xs[i] + NODE_W / 2);
    t.setAttribute("y", ys[i] - 6);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("font-size", "11");
    t.setAttribute("font-family", "system-ui, sans-serif");
    t.setAttribute("fill", "currentColor");
    t.textContent = k;
    svg.appendChild(t);
    // Count
    const c = document.createElementNS("http://www.w3.org/2000/svg", "text");
    c.setAttribute("x", xs[i] + NODE_W / 2);
    c.setAttribute("y", ys[i] + heights[i] + 14);
    c.setAttribute("text-anchor", "middle");
    c.setAttribute("font-size", "10");
    c.setAttribute("font-family", "system-ui, sans-serif");
    c.setAttribute("fill", "currentColor");
    c.setAttribute("opacity", "0.7");
    c.textContent = totals[k] || 0;
    svg.appendChild(c);
  });
}

load();
