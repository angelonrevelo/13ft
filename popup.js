const $ = (id) => document.getElementById(id);

function send(msg) {
  return new Promise((resolve) => chrome.runtime.sendMessage(msg, resolve));
}

const STRATEGY_LABEL = {
  googlebot: "Googlebot UA + Google search referer, cookies stripped.",
  bingbot: "Bingbot UA + Bing search referer, cookies stripped. Some sites are laxer on Bingbot than Googlebot.",
  proxy: "Redirects main_frame through the selected content proxy.",
  "cookie-reset": "Keeps real UA; strips cookies to reset free-article counters.",
  perplexitybot: "PerplexityBot UA. Use on publishers with Perplexity revenue-share deals (WaPo, Fortune, CNN, Time).",
  claudebot: "ClaudeBot UA. Anthropic's crawler — some publishers grant it full content access.",
  gptbot: "GPTBot UA. OpenAI's crawler — works on publishers with OpenAI deals (AP, FT-partial, Atlantic).",
  mobile: "Mobile Safari UA. Some sites serve simpler/less-paywalled mobile pages."
};

let lastState = null;

function render(state) {
  lastState = state;
  const site = $("site");
  const btn = $("toggle");
  const stratSel = $("strategy");
  const proxySel = $("proxy");
  const proxySection = $("proxySection");
  const customRow = $("customUrlRow");
  const customUrl = $("customUrl");
  const hint = $("proxyHint");
  const globalHint = $("globalHint");

  // Populate proxy dropdown once.
  if (proxySel.options.length === 0 && Array.isArray(state.proxyOptions)) {
    for (const key of state.proxyOptions) {
      const opt = document.createElement("option");
      opt.value = key;
      opt.textContent = key === "custom" ? "custom (Ladder)…" : key;
      proxySel.appendChild(opt);
    }
  }
  if (state.proxy) proxySel.value = state.proxy;
  if (typeof state.customProxyUrl === "string") {
    customUrl.value = state.customProxyUrl;
  }

  if (!state.host) {
    site.textContent = "Not an http(s) page";
    btn.disabled = true;
    btn.textContent = "OFF";
    btn.className = "off";
    stratSel.disabled = true;
    proxySection.classList.add("hidden");
    return;
  }

  site.innerHTML = "";
  site.appendChild(document.createTextNode(state.host));
  if (state.blocked) {
    const badge = document.createElement("span");
    badge.className = "badge";
    badge.style.background = "#a61b1b";
    badge.style.color = "#fff";
    badge.textContent = "blocked";
    site.appendChild(document.createTextNode(" "));
    site.appendChild(badge);

    btn.disabled = true;
    btn.textContent = "OFF";
    btn.className = "off";
    stratSel.disabled = true;
    proxySection.classList.add("hidden");
    globalHint.textContent =
      "Not a paywalled site — 13ft won't help here, and enabling it may " +
      "trigger bot-blocks on the site. Toggle disabled.";
    return;
  }
  if (state.strategy) {
    const badge = document.createElement("span");
    badge.className = "badge " + state.strategy;
    badge.textContent = state.strategy;
    site.appendChild(document.createTextNode(" "));
    site.appendChild(badge);
  }

  btn.disabled = false;
  btn.textContent = state.enabled ? "ON" : "OFF";
  btn.className = state.enabled ? "on" : "off";

  stratSel.disabled = false;
  stratSel.value = state.strategy || "googlebot";

  // Proxy section is only relevant when strategy is "proxy".
  proxySection.classList.toggle("hidden", stratSel.value !== "proxy");
  customRow.style.display = proxySel.value === "custom" ? "" : "none";

  // Surface auto-failover state when the SW routed around an
  // unreachable user-chosen proxy.
  let baseHint = STRATEGY_LABEL[stratSel.value] || "";
  if (state.proxyFailedOver && stratSel.value === "proxy") {
    baseHint =
      `${state.proxyFailedOver} unreachable — auto-routing through ${state.proxy}. ` +
      baseHint;
  }
  hint.textContent = baseHint;
  globalHint.textContent =
    "Toggle a site on, then reload. Unknown sites default to Googlebot.";

  // LLM completer is offered when the chain exhausted on this host —
  // we tried every strategy and gave up, so the user is the last
  // line of defense. The completer takes the visible teaser + URL
  // and lets a local Phi-3 describe what the article is probably
  // about. Pure client-side, no API.
  $("llmRow").style.display = state.exhausted ? "" : "none";

  renderProxyHealth(state);
}

function renderProxyHealth(state) {
  const tbody = document.querySelector("#proxyHealthTable tbody");
  const details = $("proxyHealthDetails");
  if (!tbody || !details) return;
  const health = state.proxyHealth || {};
  const builtins = (state.proxyOptions || []).filter((k) => k !== "custom");
  if (builtins.length === 0) {
    details.style.display = "none";
    return;
  }
  details.style.display = "";

  const rows = builtins.map((key) => {
    const h = health[key];
    let status, color, latency;
    if (!h) { status = "?"; color = "#888"; latency = "not yet checked"; }
    else if (h.reachable) {
      status = "OK";
      color = "#2ea44f";
      latency = h.latencyMs != null ? `${h.latencyMs}ms` : "";
    } else {
      status = "FAIL";
      color = "#a61b1b";
      latency = "unreachable";
    }
    const isCurrent = key === state.proxy;
    return `<tr>
      <td style="color:${color}; font-weight:700; padding:2px 6px 2px 0">${status}</td>
      <td style="padding:2px 6px 2px 0">${key}${isCurrent ? " ←" : ""}</td>
      <td style="padding:2px 0; color:#888; text-align:right">${latency}</td>
    </tr>`;
  });
  tbody.innerHTML = rows.join("");
}

async function refresh() {
  const state = await send({ type: "getState" });
  render(state || {});
}

$("toggle").addEventListener("click", async () => {
  $("toggle").disabled = true;
  await send({ type: "toggle" });
  window.close();
});

$("strategy").addEventListener("change", async (e) => {
  if (!lastState?.host) return;
  await send({ type: "setStrategy", host: lastState.host, strategy: e.target.value });
  await refresh();
});

$("proxy").addEventListener("change", async (e) => {
  const val = e.target.value;
  $("customUrlRow").style.display = val === "custom" ? "" : "none";
  const payload = { type: "setProxy", proxy: val };
  if (val === "custom") payload.customProxyUrl = $("customUrl").value.trim();
  await send(payload);
  await refresh();
});

$("customUrl").addEventListener("change", async (e) => {
  await send({
    type: "setProxy",
    proxy: "custom",
    customProxyUrl: e.target.value.trim()
  });
  await refresh();
});

// Probe the selected proxy's origin to detect DNS / network / TLS
// failures early. no-cors means we can't read the response, but a DNS
// failure (common for blocked .cfd) throws TypeError synchronously —
// which is exactly the signal we want. Any non-throw = reachable.
const PROXY_PROBE_URL = {
  "archive.ph":           "https://archive.ph/",
  "web.archive.org":      "https://web.archive.org/",
  "freedium.cfd":         "https://freedium.cfd/",
  "freedium-mirror.cfd":  "https://freedium-mirror.cfd/",
  "readmedium.com":       "https://readmedium.com/"
};

$("llmCompleter").addEventListener("click", async () => {
  await send({ type: "openLlmCompleter" });
  window.close();
});

$("readerMode").addEventListener("click", async () => {
  const btn = $("readerMode");
  btn.disabled = true;
  btn.textContent = "extracting…";
  const resp = await send({ type: "enableReaderMode" });
  btn.disabled = false;
  btn.textContent = "Reader Mode";
  if (resp?.ok) window.close();
  else if (resp?.reason) {
    btn.textContent = `Reader Mode (${resp.reason})`;
    setTimeout(() => { btn.textContent = "Reader Mode"; }, 2000);
  }
});

$("checkProxy").addEventListener("click", async () => {
  const btn = $("checkProxy");
  const hint = $("proxyHint");
  const state = lastState;
  if (!state) return;
  let probeUrl = PROXY_PROBE_URL[state.proxy];
  if (state.proxy === "custom") {
    probeUrl = ($("customUrl").value || state.customProxyUrl || "").trim();
  }
  if (!probeUrl) {
    hint.textContent = "No URL to check.";
    return;
  }
  btn.disabled = true;
  const prev = btn.textContent;
  btn.textContent = "…";
  try {
    await fetch(probeUrl, { method: "GET", mode: "no-cors", cache: "no-store" });
    hint.textContent = `OK — ${state.proxy} reachable.`;
  } catch (e) {
    hint.textContent =
      `FAIL — ${state.proxy} unreachable (${e.name}). Your DNS or network ` +
      `may be blocking it. Try web.archive.org.`;
  }
  // Trigger a SW-side probe of every proxy so resolveProxy gets fresh
  // health data (enables auto-failover on the next navigation).
  send({ type: "probeProxies" }).catch(() => {});
  btn.disabled = false;
  btn.textContent = prev;
});

// --- Advanced section: diagnostic mode + rules refresh + dashboard ---

async function loadAdvancedState() {
  const status = await send({ type: "getRulesStatus" });
  const ageHours = status?.updatedAt
    ? Math.round((Date.now() - status.updatedAt) / 3600000)
    : null;
  $("rulesStatus").textContent =
    `Rules: ${status?.count ?? 0} remote entries · ` +
    (ageHours == null ? "never refreshed" : `updated ${ageHours}h ago`);

  const { diagnosticMode } = await chrome.storage.local.get("diagnosticMode");
  $("diagnosticToggle").checked = !!diagnosticMode;
}

$("diagnosticToggle").addEventListener("change", async (e) => {
  await send({ type: "setDiagnosticMode", enabled: e.target.checked });
});

$("generateReport").addEventListener("click", async () => {
  const btn = $("generateReport");
  btn.disabled = true;
  btn.textContent = "extracting…";
  const r = await send({ type: "getDiagnosticReport" });
  btn.disabled = false;
  btn.textContent = "Generate report";
  if (!r?.ok) {
    btn.textContent = `(${r?.reason || "failed"})`;
    setTimeout(() => { btn.textContent = "Generate report"; }, 2000);
    return;
  }
  const blob = new Blob([r.entry], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  chrome.tabs.create({ url });
});

$("refreshRules").addEventListener("click", async () => {
  const b = $("refreshRules");
  b.disabled = true;
  const prev = b.textContent;
  b.textContent = "refreshing…";
  const r = await send({ type: "refreshRules" });
  b.disabled = false;
  b.textContent = r?.ok ? `OK · ${r.count} entries` : `(${r?.reason || "failed"})`;
  setTimeout(() => { b.textContent = prev; loadAdvancedState(); }, 2500);
});

refresh();
loadAdvancedState();
