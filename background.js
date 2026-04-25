// 13ft — service worker.
//
// Architecture:
//   - DEFAULT_SITES (sites.js) maps registrable domain → strategy.
//   - Users can override any entry or add new ones via chrome.storage.local
//     at `siteOverrides` ({ [host]: { strategy, allowCookies, ... } }).
//   - `enabledHosts` is the set of hostnames the user has toggled ON.
//   - For each enabled host we resolve its effective config (override >
//     default > fallback "googlebot") and install one session DNR rule
//     with a deterministic id (hash of host), so toggles are idempotent.
//
// Strategies:
//   googlebot    → modifyHeaders: UA=Googlebot, Referer=google, Cookie removed
//   cookie-reset → modifyHeaders: Cookie removed (keeps real UA)
//   proxy        → redirect main_frame to <proxy-prefix>\\0
//
// Session rules don't persist across browser restarts; we re-sync on
// startup and install.

importScripts("sites.js", "sites.generated.js", "custom.js");

const GOOGLEBOT_UA =
  "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm) Chrome/103.0.5060.114 Safari/537.36";
const PERPLEXITYBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://docs.perplexity.ai/guides/bots)";
const CLAUDEBOT_UA =
  "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const GPTBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const MOBILE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";

// Per-strategy header defaults. Referer is constructed at rule-build
// time from the host so each rule has a unique referer
// (`https://www.google.com/search?q=<host>` instead of the same
// constant across every site). Looks like a real "search for the
// publisher's domain → click the result" referral, removes the
// trivial constant-string fingerprint.
//
// AI-crawler strategies (perplexitybot/claudebot/gptbot) skip the
// referer entirely — those crawlers don't go through search engines
// and a fake search referer would actually look suspicious.
const STRATEGY_HEADERS = {
  googlebot: {
    ua: GOOGLEBOT_UA,
    refererBase: "https://www.google.com/search"
  },
  bingbot: {
    ua: BINGBOT_UA,
    refererBase: "https://www.bing.com/search"
  },
  perplexitybot: { ua: PERPLEXITYBOT_UA, refererBase: null },
  claudebot:     { ua: CLAUDEBOT_UA,     refererBase: null },
  gptbot:        { ua: GPTBOT_UA,        refererBase: null },
  // Mobile Safari UA — some sites serve simpler/less-paywalled
  // mobile pages with weaker meter enforcement.
  mobile:        { ua: MOBILE_UA,        refererBase: null },
  "cookie-reset": { ua: null, refererBase: null }
};

function refererForHost(refererBase, host) {
  if (!refererBase) return null;
  // We can't use URLSearchParams here because RegExp/URL objects in a
  // worker context are fine, but we want deterministic encoding. Use
  // encodeURIComponent for the q value, plain concat for the rest.
  return `${refererBase}?q=${encodeURIComponent(host)}`;
}

const BUILTIN_PROXIES = {
  "archive.ph": {
    prefix: "https://archive.ph/newest/",
    host: "archive.ph",
    pathRegex: /^\/newest\/(https?:\/\/.+)$/
  },
  "web.archive.org": {
    prefix: "https://web.archive.org/web/2/",
    host: "web.archive.org",
    pathRegex: /^\/web\/[^/]+\/(https?:\/\/.+)$/
  },
  "freedium.cfd": {
    prefix: "https://freedium.cfd/",
    host: "freedium.cfd",
    pathRegex: /^\/(https?:\/\/.+)$/
  },
  "freedium-mirror.cfd": {
    prefix: "https://freedium-mirror.cfd/",
    host: "freedium-mirror.cfd",
    pathRegex: /^\/(https?:\/\/.+)$/
  },
  "readmedium.com": {
    prefix: "https://readmedium.com/",
    host: "readmedium.com",
    pathRegex: /^\/(https?:\/\/.+)$/
  }
};
// Default switched from archive.ph to web.archive.org in April 2026:
// archive.today domains are Cloudflare-flagged on 1.1.1.2, blocked in RU,
// and the registrar received an FBI subpoena in Oct 2025. Wayback is
// slower but far more reliable for most users.
const DEFAULT_PROXY = "web.archive.org";
const CUSTOM_PROXY_KEY = "custom";

const STORAGE = {
  hosts: "enabledHosts",
  proxy: "contentProxy",
  customProxyUrl: "customProxyUrl",
  overrides: "siteOverrides",
  failures: "strategyFailures",
  exhausted: "exhaustedHosts",
  proxyHealth: "proxyHealth",
  remoteRules: "remoteSitesGenerated",
  remoteRulesUpdatedAt: "remoteSitesGeneratedAt",
  diagnostic: "diagnosticMode"
};

// Default URL where remote rules are fetched. Empty = auto-update
// disabled until the user configures `rulesUrl` in storage.
// Should point at a JSON file produced by
//   `node scripts/import-bpc.mjs --json out.json`
// hosted somewhere (GitHub Pages, gist, your own CDN). The SW can't
// parse BPC's raw sites.js because MV3 CSP forbids `new Function()`.
const DEFAULT_RULES_URL = "";

const PROXY_HEALTH_ALARM = "13ft-proxy-health";
const PROXY_HEALTH_TTL_MS = 30 * 60 * 1000; // re-probe at most every 30 min

const RULES_UPDATE_ALARM = "13ft-rules-update";
const RULES_UPDATE_PERIOD_MIN = 7 * 24 * 60; // weekly

// Order in which auto-fallback advances strategies when the content
// script reports a bypass failure. Bingbot sits between Googlebot
// and cookie-reset because some publishers' anti-bot pipelines are
// stricter on Googlebot (FCrDNS, IP-range verification) than on
// Bingbot — trying Bingbot first sometimes succeeds where Googlebot
// 403s. After "proxy" exhausts, we mark the host as exhausted.
const STRATEGY_CHAIN = ["googlebot", "bingbot", "cookie-reset", "proxy"];

// ---------- Regex helpers ----------

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashHost(host) {
  let h = 2166136261;
  for (let i = 0; i < host.length; i++) {
    h ^= host.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 1) || 1;
}

// ---------- Storage accessors ----------

async function readStorage() {
  return chrome.storage.local.get([
    STORAGE.hosts,
    STORAGE.proxy,
    STORAGE.customProxyUrl,
    STORAGE.overrides
  ]);
}

async function getEnabledHosts() {
  const { [STORAGE.hosts]: hosts } = await chrome.storage.local.get(STORAGE.hosts);
  return new Set(hosts || []);
}

async function setEnabledHosts(set) {
  await chrome.storage.local.set({ [STORAGE.hosts]: [...set] });
}

async function getOverrides() {
  const { [STORAGE.overrides]: o } = await chrome.storage.local.get(STORAGE.overrides);
  return o || {};
}

// ---------- Proxy resolution ----------

function parseCustomProxy(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    const basePath = u.pathname.endsWith("/") ? u.pathname : u.pathname + "/";
    const prefix = `${u.protocol}//${u.host}${basePath}`;
    return {
      prefix,
      host: u.hostname,
      pathRegex: new RegExp(
        "^" + escapeRegex(basePath) + "(https?:\\/\\/.+)$"
      )
    };
  } catch {
    return null;
  }
}

async function resolveProxy() {
  const { [STORAGE.proxy]: key, [STORAGE.customProxyUrl]: customUrl } =
    await chrome.storage.local.get([STORAGE.proxy, STORAGE.customProxyUrl]);
  if (key === CUSTOM_PROXY_KEY) {
    const custom = parseCustomProxy(customUrl);
    if (custom) return { key, ...custom, fallback: false };
    // Fall back silently if user picked custom but didn't set a valid URL.
    return { key: DEFAULT_PROXY, ...BUILTIN_PROXIES[DEFAULT_PROXY], fallback: true };
  }
  const requestedKey = BUILTIN_PROXIES[key] ? key : DEFAULT_PROXY;
  const requested = BUILTIN_PROXIES[requestedKey];

  // Auto-failover: if the user's chosen proxy has been probed and is
  // unreachable, route through the fastest reachable alternative
  // instead. Keeps the user's original choice if no health data yet
  // (default trust) or if the probe didn't run.
  const health = await getProxyHealth();
  const requestedHealth = health[requestedKey];
  if (requestedHealth && requestedHealth.reachable === false) {
    // Pick the reachable proxy with lowest latency.
    const candidates = Object.keys(BUILTIN_PROXIES)
      .filter((k) => k !== requestedKey)
      .map((k) => ({ k, h: health[k] }))
      .filter(({ h }) => h && h.reachable)
      .sort((a, b) => (a.h.latencyMs || Infinity) - (b.h.latencyMs || Infinity));
    if (candidates.length > 0) {
      const fk = candidates[0].k;
      return { key: fk, ...BUILTIN_PROXIES[fk], fallback: true, failedOver: requestedKey };
    }
    // No reachable alternative — return the requested anyway. Better
    // than nothing; users see the failure as an unreachable redirect.
  }
  return { key: requestedKey, ...requested, fallback: false };
}

// ---------- Proxy health probe + auto-failover ----------

async function getProxyHealth() {
  const { [STORAGE.proxyHealth]: h } = await chrome.storage.local.get(STORAGE.proxyHealth);
  return h || {};
}

async function setProxyHealth(map) {
  await chrome.storage.local.set({ [STORAGE.proxyHealth]: map });
}

async function probeProxy(url) {
  const start = Date.now();
  // 6-second AbortController guard so a hung proxy doesn't stall the
  // whole probe pass.
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    await fetch(url, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      redirect: "follow",
      signal: ac.signal
    });
    return { reachable: true, latencyMs: Date.now() - start, lastChecked: Date.now() };
  } catch {
    return { reachable: false, latencyMs: null, lastChecked: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

async function probeAllProxies() {
  const map = await getProxyHealth();
  for (const [k, p] of Object.entries(BUILTIN_PROXIES)) {
    map[k] = await probeProxy(p.prefix);
  }
  await setProxyHealth(map);
  return map;
}

async function ensureProxyHealthAlarm() {
  // chrome.alarms.create with same name replaces the existing one.
  await chrome.alarms.create(PROXY_HEALTH_ALARM, { periodInMinutes: 30 });
  // Run once now if no recent health data exists.
  const h = await getProxyHealth();
  const stale = Object.keys(BUILTIN_PROXIES).some((k) =>
    !h[k] || (Date.now() - (h[k].lastChecked || 0) > PROXY_HEALTH_TTL_MS)
  );
  if (stale) probeAllProxies();
}

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROXY_HEALTH_ALARM) probeAllProxies();
  if (alarm.name === RULES_UPDATE_ALARM) refreshRemoteRules().catch(() => {});
});

// ---------- Auto-update for sites.generated.js ----------
//
// Fetches the latest BPC sites.js from a configurable URL, transpiles
// it into our schema, and stores the result in
// chrome.storage.local.remoteSitesGenerated. The storage layer
// becomes the source-of-truth for generated rules — DEFAULT_SITES
// merging logic in resolveSiteConfig falls back to the remote map
// when sites.generated.js doesn't have an entry.
//
// Design notes:
//   - We don't replace sites.generated.js on disk; the file remains
//     as a "shipped baseline" that works offline. Remote refreshes
//     supplement it without overwriting.
//   - Hand-curated sites.js still wins per-domain (preserved by the
//     resolveSiteConfig precedence order).
//   - No signature verification yet — TODO for next iteration. For
//     now we trust whatever URL the user configured.

async function refreshRemoteRules() {
  const { rulesUrl } = await chrome.storage.local.get("rulesUrl");
  const url = rulesUrl || DEFAULT_RULES_URL;
  if (!url) return { ok: false, reason: "no-url" };

  let text;
  try {
    const resp = await fetch(url, {
      cache: "no-store",
      headers: { "user-agent": "13ft-update/1.0" }
    });
    if (!resp.ok) return { ok: false, reason: `http-${resp.status}` };
    text = await resp.text();
  } catch (e) {
    return { ok: false, reason: "fetch-failed: " + (e.message || "?") };
  }

  // Two accepted formats:
  //   1. A JSON file produced by `scripts/import-bpc.mjs --json`
  //      (preferred). Either `{ "<host>": { ...rule } }` flat map,
  //      or BPC's raw shape `{ "<entry-name>": { domain, ... } }`.
  //   2. A BPC sites.js source. NOT parsed in the SW because MV3 CSP
  //      forbids `new Function()`. Users running this against a raw
  //      BPC URL get a clear error. The recommended path is to run
  //      `node scripts/import-bpc.mjs --json out.json` and host the
  //      JSON output (e.g. on GitHub Pages, gist, or your own CDN).
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return {
      ok: false,
      reason: "expected JSON. Run `node scripts/import-bpc.mjs --json " +
              "out.json` and host the JSON output, then point rulesUrl " +
              "at that file."
    };
  }

  // Detect format. If values look like BPC entries (have `domain` or
  // `group` fields), transpile. Otherwise assume already-our-shape.
  const sample = parsed[Object.keys(parsed)[0]] || {};
  let out;
  if (sample && (typeof sample.domain === "string" || Array.isArray(sample.group))) {
    out = transpileBpcEntries(parsed);
  } else {
    // Already in our schema. Filter to JSON-safe entries (no RegExp).
    out = {};
    for (const [host, rule] of Object.entries(parsed)) {
      if (rule && typeof rule === "object") out[host] = rule;
    }
  }

  await chrome.storage.local.set({
    [STORAGE.remoteRules]: out,
    [STORAGE.remoteRulesUpdatedAt]: Date.now()
  });
  await syncRules();
  return { ok: true, count: Object.keys(out).length };
}

function transpileBpcEntries(bpc) {
  // Same field mappings as scripts/import-bpc.mjs. Domains starting
  // with `#` or `###` are BPC's internal pseudo-keys — skipped.
  const out = {};
  for (const entry of Object.values(bpc)) {
    if (!entry || typeof entry !== "object") continue;
    const targets = [];
    if (typeof entry.domain === "string" && !entry.domain.startsWith("#")) {
      targets.push(entry.domain);
    }
    if (Array.isArray(entry.group)) {
      for (const d of entry.group) {
        if (typeof d === "string" && !d.startsWith("#")) targets.push(d);
      }
    }
    if (targets.length === 0) continue;

    const rule = {};
    if (entry.useragent === "googlebot") rule.strategy = "googlebot";
    else if (entry.useragent === "bingbot") rule.strategy = "bingbot";
    if (entry.allow_cookies === 1 || entry.allow_cookies === true) rule.allowCookies = true;
    if (entry.amp_unhide === 1 || entry.amp_unhide === true) rule.ampRedirect = true;
    if (Array.isArray(entry.remove_cookies_select_drop)) {
      rule.dropCookies = [...entry.remove_cookies_select_drop];
    }
    if (entry.block_regex) {
      const ps = Array.isArray(entry.block_regex) ? entry.block_regex : [entry.block_regex];
      const blocks = [];
      for (const p of ps) {
        // Store source strings, not RegExp objects — RegExp doesn't
        // survive chrome.storage's structured-clone round-trip.
        // regexPatternSource (used by buildBlockRules) accepts both
        // forms, so the rule build path doesn't change.
        if (p && typeof p === "object" && typeof p.source === "string") {
          blocks.push(p.source);
        } else if (typeof p === "string") {
          blocks.push(p);
        }
      }
      if (blocks.length) rule.blockRegex = blocks;
    }
    for (const domain of targets) {
      out[domain] = rule;
    }
  }
  return out;
}

// Format a structured diagnostic buffer into a paste-ready
// sites.js entry. Mirrors scripts/inspect-site.mjs but operates on
// data the content script already collected.
function formatDiagEntry(diag) {
  const out = [];
  out.push(`// 13ft diagnostic snapshot of ${diag.host}`);
  out.push(`// (collected ${new Date(diag.startedAt).toISOString()})`);
  out.push(`"${diag.host}": {`);
  out.push(`  strategy: "googlebot",`);
  if (Array.isArray(diag.scriptUrls) && diag.scriptUrls.length > 0) {
    out.push(`  blockRegex: [`);
    for (const u of diag.scriptUrls.slice(0, 12)) {
      try {
        const url = new URL(u);
        const path = url.pathname
          .replace(/\/[a-f0-9]{8,}\//g, "/.+/")
          .replace(/[a-f0-9]{8,}\.js$/, ".+\\.js")
          .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\\\\/g, "\\");
        const host = url.hostname.replace(/\./g, "\\.");
        out.push(`    /${host}${path}/,`);
      } catch {
        out.push(`    // ${u}`);
      }
    }
    out.push(`  ],`);
  }
  if (Array.isArray(diag.cookies) && diag.cookies.length > 0) {
    out.push(`  dropCookies: [${diag.cookies.map((c) => JSON.stringify(c)).join(", ")}],`);
  }
  if (diag.ampHref) {
    out.push(`  ampRedirect: true, // ${diag.ampHref}`);
  }
  if (Array.isArray(diag.paywallElements) && diag.paywallElements.length > 0) {
    out.push(`  cssRules: { hide: [${diag.paywallElements.slice(0, 8).map((s) => JSON.stringify(s)).join(", ")}] },`);
  }
  if (diag.ssrShape) {
    out.push(`  // SSR shape: ${diag.ssrShape} — universal extractor will handle`);
  }
  out.push(`}`);
  return out.join("\n");
}

async function ensureRulesUpdateAlarm() {
  await chrome.alarms.create(RULES_UPDATE_ALARM, {
    periodInMinutes: RULES_UPDATE_PERIOD_MIN
  });
  // Trigger immediately if we've never updated.
  const { [STORAGE.remoteRulesUpdatedAt]: last } = await chrome.storage.local.get(
    STORAGE.remoteRulesUpdatedAt
  );
  if (!last) refreshRemoteRules().catch(() => {});
}

async function allKnownProxyShapes() {
  const builtins = Object.values(BUILTIN_PROXIES);
  const { [STORAGE.customProxyUrl]: customUrl } = await chrome.storage.local.get(
    STORAGE.customProxyUrl
  );
  const custom = parseCustomProxy(customUrl);
  return custom ? [...builtins, custom] : builtins;
}

// ---------- Site config ----------

async function resolveSiteConfig(host) {
  // Precedence: user override > hand-curated sites.js > remotely
  // refreshed rules > shipped sites.generated.js > googlebot fallback.
  const overrides = await getOverrides();
  if (overrides[host]) return overrides[host];
  if (DEFAULT_SITES[host]) return DEFAULT_SITES[host];
  const { [STORAGE.remoteRules]: remote } = await chrome.storage.local.get(STORAGE.remoteRules);
  if (remote && remote[host]) return remote[host];
  return { strategy: "googlebot" };
}

// ---------- Rule builders ----------

function buildHeaderRule(host, cfg) {
  const headers = [];
  const strat = cfg.strategy || "googlebot";
  const sh = STRATEGY_HEADERS[strat];
  if (sh) {
    if (sh.ua) {
      headers.push({
        header: "User-Agent",
        operation: "set",
        value: cfg.customUserAgent || sh.ua
      });
    }
    const referer = refererForHost(sh.refererBase, host);
    if (referer && cfg.useGoogleReferer !== false) {
      headers.push({ header: "Referer", operation: "set", value: referer });
    }
  }
  if (!cfg.allowCookies) {
    headers.push({ header: "Cookie", operation: "remove" });
  }
  if (headers.length === 0) return null;

  return {
    id: hashHost(host),
    priority: 1,
    action: { type: "modifyHeaders", requestHeaders: headers },
    condition: {
      requestDomains: [host],
      resourceTypes: [
        "main_frame",
        "sub_frame",
        "xmlhttprequest",
        "script",
        "stylesheet",
        "image",
        "font",
        "media",
        "other"
      ]
    }
  };
}

// Print-URL redirect rule. When a site exposes a print-friendly URL
// at a predictable path (e.g. `/print/<id>` or `print.publisher.com`)
// and that URL omits paywall JS, redirect main_frame navigations
// from the canonical URL to the print version. Per-site config:
//   printRedirect: {
//     match:   /^https?:\/\/(?:www\.)?example\.com\/articles\/(\d+)/,
//     replace: "https://print.example.com/article/$1"
//   }
// `match` uses DNR's RE2 subset (no lookbehinds, no backrefs).
// `replace` may use \\1, \\2 for capture groups.
function buildPrintRule(host, cfg) {
  const pr = cfg.printRedirect;
  if (!pr) return null;
  const matchSrc = regexPatternSource(pr.match);
  const replace = typeof pr.replace === "string" ? pr.replace : null;
  if (!matchSrc || !replace) return null;
  return {
    id: ((hashHost(host) + 333000031) & 0x7fffffff) || 1,
    priority: 3, // higher than block(2) and modify(1)
    action: { type: "redirect", redirect: { regexSubstitution: replace } },
    condition: {
      regexFilter: matchSrc,
      resourceTypes: ["main_frame"]
    }
  };
}

function buildProxyRule(host, proxy) {
  return {
    id: hashHost(host),
    priority: 1,
    action: {
      type: "redirect",
      redirect: { regexSubstitution: proxy.prefix + "\\0" }
    },
    condition: {
      regexFilter: `^https?://(?:[^/]+\\.)?${escapeRegex(host)}/.*`,
      resourceTypes: ["main_frame"]
    }
  };
}

// Turn a RegExp or string pattern into a DNR-compatible regexFilter.
// DNR's RE2 subset rejects /.../ delimiters and JS modifier flags but
// accepts the pattern source as a string. Duck-type the RegExp check
// (instead of `instanceof`) so it works across realms — content
// scripts, the service worker, and test harnesses all have distinct
// RegExp intrinsics.
function regexPatternSource(pattern) {
  if (pattern && typeof pattern === "object" && typeof pattern.source === "string") {
    return pattern.source;
  }
  if (typeof pattern === "string") return pattern;
  return null;
}

// Block rules carry a priority HIGHER than header/redirect rules so if
// both a modifyHeaders rule and a block rule match the same request
// (they typically don't since block rules target sub-resources), the
// block wins. Each block rule gets a unique id derived from the host
// hash + pattern index; IDs live in a reserved high range to avoid
// collision with the main per-host rule id.
function buildBlockRules(host, patterns) {
  if (!Array.isArray(patterns) || patterns.length === 0) return [];
  const baseId = hashHost(host);
  const rules = [];
  patterns.forEach((pattern, i) => {
    const source = regexPatternSource(pattern);
    if (!source) return;
    // Offset by (i+1) * 100000003 to spread ids and stay within int32.
    const id = ((baseId + (i + 1) * 100000003) & 0x7fffffff) || 1;
    rules.push({
      id,
      priority: 2,
      action: { type: "block" },
      condition: {
        regexFilter: source,
        resourceTypes: [
          "script", "sub_frame", "xmlhttprequest", "image", "media", "other"
        ]
      }
    });
  });
  return rules;
}

async function buildRules(host, proxy) {
  const cfg = await resolveSiteConfig(host);
  const main = cfg.strategy === "proxy"
    ? buildProxyRule(host, proxy)
    : buildHeaderRule(host, cfg);
  const block = buildBlockRules(host, cfg.blockRegex);
  const print = buildPrintRule(host, cfg);
  return [main, ...block, print].filter(Boolean);
}

async function syncRules() {
  const [hosts, proxy] = await Promise.all([getEnabledHosts(), resolveProxy()]);
  const perHost = await Promise.all([...hosts].map((h) => buildRules(h, proxy)));
  const desired = perHost.flat();
  const existing = await chrome.declarativeNetRequest.getSessionRules();
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: existing.map((r) => r.id),
    addRules: desired
  });
  // Keep the main-world fetch/XHR interceptor's registered content
  // scripts in sync with enabledHosts. They run at document_start in
  // the page's main world to patch fetch + XMLHttpRequest before any
  // page JS calls them.
  await syncMainWorldScripts(hosts);
}

const UNPAYWALL_SCRIPT_PREFIX = "13ft-unpaywall-";

async function syncMainWorldScripts(hosts) {
  // Unregister any existing 13ft-* main-world scripts so we can
  // re-register cleanly. registerContentScripts errors on duplicate
  // ids; updating piecemeal is racier than full replace.
  let existing = [];
  try {
    existing = await chrome.scripting.getRegisteredContentScripts();
  } catch { return; /* old Chrome — silently skip */ }

  const ourIds = existing
    .filter((s) => s.id && s.id.startsWith(UNPAYWALL_SCRIPT_PREFIX))
    .map((s) => s.id);
  if (ourIds.length) {
    try {
      await chrome.scripting.unregisterContentScripts({ ids: ourIds });
    } catch { /* ignore — already-gone is fine */ }
  }

  if (!hosts || hosts.size === 0) return;

  const scripts = [...hosts].map((h) => ({
    id: UNPAYWALL_SCRIPT_PREFIX + hashHost(h),
    // Cover bare host (default port) AND any custom port. The
    // explicit `:*/*` form is required for non-standard ports —
    // `*://host/*` only matches :80 / :443.
    matches: [`*://${h}/*`, `*://*.${h}/*`, `*://${h}:*/*`, `*://*.${h}:*/*`],
    // Both files run together at document_start in the page's MAIN
    // world. Order matters slightly: unpaywall-main patches fetch/
    // XHR for late API calls; ssr-rewrite-main rewrites the SSR JSON
    // BEFORE React/Vue/Svelte hydrate, so the page renders the
    // article natively in its own template.
    js: ["lib/unpaywall-main.js", "lib/ssr-rewrite-main.js"],
    runAt: "document_start",
    world: "MAIN",
    allFrames: false,
    persistAcrossSessions: false
  }));
  try {
    await chrome.scripting.registerContentScripts(scripts);
  } catch (e) {
    // Likely an invalid match pattern (host with bad characters).
    // Fall back to registering one-at-a-time so a single bad entry
    // doesn't poison the rest.
    for (const s of scripts) {
      try { await chrome.scripting.registerContentScripts([s]); }
      catch { /* skip this host */ }
    }
  }
}

// ---------- URL + host helpers ----------

function hostOfUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

async function proxyOriginalUrl(url) {
  try {
    const u = new URL(url);
    for (const p of await allKnownProxyShapes()) {
      if (u.hostname !== p.host) continue;
      const m = u.pathname.match(p.pathRegex);
      if (m) return m[1] + u.search + u.hash;
    }
    return null;
  } catch {
    return null;
  }
}

async function effectiveHostOfUrl(url) {
  const orig = await proxyOriginalUrl(url);
  return hostOfUrl(orig || url);
}

// A host matches a configured domain if it equals the domain or is a subdomain.
function domainMatch(host, domain) {
  return host === domain || host.endsWith("." + domain);
}

// Blocked hosts: sites where spoofing Googlebot or redirecting through a
// proxy would break the site without any benefit (they aren't paywalled).
// Checked before any storage mutation in toggleHost and reported in
// getState so the popup can show a disabled UI.
function isBlockedHost(host) {
  if (!host) return false;
  if (host === "localhost") return true;
  return BLOCKED_HOSTS.some((d) => domainMatch(host, d));
}

async function canonicalConfiguredHost(host) {
  // If the host is a subdomain of something in our default list (e.g.
  // `baili.substack.com` → `substack.com`, `old.reddit.com` → `reddit.com`),
  // use the parent for config lookup, rule installation, and popup display.
  const overrides = await getOverrides();
  for (const d of Object.keys(overrides)) if (domainMatch(host, d)) return d;
  for (const d of Object.keys(DEFAULT_SITES)) if (domainMatch(host, d)) return d;
  for (const d of BLOCKED_HOSTS) if (domainMatch(host, d)) return d;
  return host;
}

// ---------- Toggle ----------

async function toggleHost(tab) {
  const rawHost = await effectiveHostOfUrl(tab.url);
  if (!rawHost) return { ok: false, reason: "unsupported-url" };
  const host = await canonicalConfiguredHost(rawHost);
  // Refuse to modify storage or rules for blocked hosts — prevents the
  // Reddit-style self-breakage case. Runs BEFORE any write.
  if (isBlockedHost(host)) return { ok: false, reason: "blocked-host", host };

  const hosts = await getEnabledHosts();
  const wasEnabled = hosts.has(host);
  if (wasEnabled) hosts.delete(host);
  else hosts.add(host);
  await setEnabledHosts(hosts);
  await syncRules();
  await updateBadge(tab.id, !wasEnabled);

  const proxied = await proxyOriginalUrl(tab.url);
  if (wasEnabled && proxied) {
    chrome.tabs.update(tab.id, { url: proxied });
  } else {
    chrome.tabs.reload(tab.id, { bypassCache: true });
  }
  return { ok: true, enabled: !wasEnabled, host };
}

// ---------- Badge ----------

async function updateBadge(tabId, enabled) {
  await chrome.action.setBadgeText({ tabId, text: enabled ? "ON" : "" });
  await chrome.action.setBadgeBackgroundColor({
    tabId,
    color: enabled ? "#2ea44f" : "#888"
  });
}

async function refreshTabBadge(tabId, url) {
  const rawHost = await effectiveHostOfUrl(url);
  if (!rawHost) {
    await chrome.action.setBadgeText({ tabId, text: "" });
    return;
  }
  const host = await canonicalConfiguredHost(rawHost);
  const hosts = await getEnabledHosts();
  await updateBadge(tabId, hosts.has(host));
}

// ---------- Failure-driven strategy fallback ----------
//
// Called when content.js reports an anti-bot challenge / extension-
// block / "verify human" page. Advances to the next strategy in
// STRATEGY_CHAIN, persists it, and reloads the tab. After exhausting
// the chain, removes the host from enabledHosts and marks it
// exhausted so subsequent navigations don't re-trigger the cycle.
async function handleBypassFailed(msg, senderTabId) {
  const host = msg.host && (await canonicalConfiguredHost(msg.host));
  if (!host || isBlockedHost(host)) return { ok: false, reason: "blocked" };
  const hosts = await getEnabledHosts();
  if (!hosts.has(host)) return { ok: false, reason: "not-enabled" };

  // Record failure for diagnostics.
  const failuresStore = await chrome.storage.local.get(STORAGE.failures);
  const failures = failuresStore[STORAGE.failures] || {};
  const cfg = await resolveSiteConfig(host);
  const cur = cfg.strategy || "googlebot";
  failures[host] = failures[host] || {};
  failures[host][cur] = (failures[host][cur] || 0) + 1;
  await chrome.storage.local.set({ [STORAGE.failures]: failures });

  const idx = STRATEGY_CHAIN.indexOf(cur);
  const nextIdx = idx >= 0 ? idx + 1 : 0;
  if (nextIdx < STRATEGY_CHAIN.length) {
    const next = STRATEGY_CHAIN[nextIdx];
    const overrides = await getOverrides();
    overrides[host] = { ...(overrides[host] || {}), strategy: next };
    await chrome.storage.local.set({ [STORAGE.overrides]: overrides });
    await syncRules();
    if (senderTabId != null) {
      await chrome.action.setBadgeText({ tabId: senderTabId, text: "RTRY" });
      await chrome.action.setBadgeBackgroundColor({
        tabId: senderTabId, color: "#a06800"
      });
      chrome.tabs.reload(senderTabId, { bypassCache: true });
    }
    return { ok: true, advancedTo: next };
  }

  // Chain exhausted — disable bypass for this host.
  hosts.delete(host);
  await setEnabledHosts(hosts);
  const exhaustedStore = await chrome.storage.local.get(STORAGE.exhausted);
  const exhausted = exhaustedStore[STORAGE.exhausted] || [];
  if (!exhausted.includes(host)) exhausted.push(host);
  await chrome.storage.local.set({ [STORAGE.exhausted]: exhausted });
  await syncRules();
  if (senderTabId != null) {
    await chrome.action.setBadgeText({ tabId: senderTabId, text: "FAIL" });
    await chrome.action.setBadgeBackgroundColor({
      tabId: senderTabId, color: "#a61b1b"
    });
  }
  return { ok: false, exhausted: true };
}

// ---------- Messaging ----------

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg?.type === "getState") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      if (!tab) return sendResponse({ host: null });
      const rawHost = await effectiveHostOfUrl(tab.url);
      const host = rawHost ? await canonicalConfiguredHost(rawHost) : null;
      const [hosts, proxy, { [STORAGE.customProxyUrl]: customProxyUrl }] =
        await Promise.all([
          getEnabledHosts(),
          resolveProxy(),
          chrome.storage.local.get(STORAGE.customProxyUrl)
        ]);
      const blocked = isBlockedHost(host);
      const cfg = host && !blocked ? await resolveSiteConfig(host) : null;
      const { [STORAGE.exhausted]: exhausted = [] } =
        await chrome.storage.local.get(STORAGE.exhausted);
      sendResponse({
        host,
        blocked,
        enabled: host && !blocked ? hosts.has(host) : false,
        exhausted: host ? exhausted.includes(host) : false,
        strategy: cfg?.strategy || null,
        proxy: proxy.key,
        proxyFailedOver: proxy.failedOver || null,
        customProxyUrl: customProxyUrl || "",
        proxyOptions: [...Object.keys(BUILTIN_PROXIES), CUSTOM_PROXY_KEY],
        proxyHealth: await getProxyHealth()
      });
      return;
    }

    if (msg?.type === "toggle") {
      const [tab] = await chrome.tabs.query({
        active: true,
        lastFocusedWindow: true
      });
      if (!tab) return sendResponse({ ok: false });
      sendResponse(await toggleHost(tab));
      return;
    }

    if (msg?.type === "setProxy") {
      const next =
        BUILTIN_PROXIES[msg.proxy] || msg.proxy === CUSTOM_PROXY_KEY
          ? msg.proxy
          : DEFAULT_PROXY;
      const patch = { [STORAGE.proxy]: next };
      if (typeof msg.customProxyUrl === "string") {
        patch[STORAGE.customProxyUrl] = msg.customProxyUrl.trim();
      }
      await chrome.storage.local.set(patch);
      await syncRules();
      sendResponse({ ok: true, proxy: next });
      return;
    }

    if (msg?.type === "bypassFailed") {
      sendResponse(await handleBypassFailed(msg, _sender?.tab?.id));
      return;
    }

    if (msg?.type === "openLlmCompleter") {
      // Opens the local-LLM article-completer page in a new tab.
      // Passes the active tab's URL + a snapshot of its visible
      // teaser so the LLM has something to ground its summary on.
      const [tab] = await chrome.tabs.query({
        active: true, lastFocusedWindow: true
      });
      let teaser = "";
      if (tab?.id) {
        try {
          const [{ result }] = await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            world: "MAIN",
            func: () =>
              (document.querySelector("article")?.innerText ||
               document.body?.innerText || "").slice(0, 4000)
          });
          teaser = result || "";
        } catch {}
      }
      const llmUrl = chrome.runtime.getURL("llm.html") +
        "?url=" + encodeURIComponent(tab?.url || "") +
        "&teaser=" + encodeURIComponent(teaser);
      chrome.tabs.create({ url: llmUrl });
      sendResponse({ ok: true });
      return;
    }

    if (msg?.type === "enableReaderMode") {
      // Inject Mozilla Readability + a render wrapper into the active
      // tab's main world. Extracts the article and replaces the
      // visible content with a clean reader view. Works on any page
      // where the body bytes exist in the DOM, even if our other
      // strategies failed to remove a paywall overlay.
      const [tab] = await chrome.tabs.query({
        active: true, lastFocusedWindow: true
      });
      if (!tab?.id) return sendResponse({ ok: false, reason: "no-tab" });
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["lib/readability.js"]
        });
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: "MAIN",
          files: ["lib/reader-render.js"]
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message?.slice(0, 40) || "inject-failed" });
      }
      return;
    }

    if (msg?.type === "probeProxies") {
      const health = await probeAllProxies();
      sendResponse({ ok: true, health });
      return;
    }

    if (msg?.type === "getProxyHealth") {
      sendResponse({ ok: true, health: await getProxyHealth() });
      return;
    }

    if (msg?.type === "refreshRules") {
      const r = await refreshRemoteRules();
      sendResponse(r);
      return;
    }

    if (msg?.type === "getRulesStatus") {
      const got = await chrome.storage.local.get([
        STORAGE.remoteRules,
        STORAGE.remoteRulesUpdatedAt,
        "rulesUrl"
      ]);
      const remote = got[STORAGE.remoteRules] || {};
      sendResponse({
        ok: true,
        url: got.rulesUrl || DEFAULT_RULES_URL,
        updatedAt: got[STORAGE.remoteRulesUpdatedAt] || null,
        count: Object.keys(remote).length
      });
      return;
    }

    if (msg?.type === "setDiagnosticMode") {
      await chrome.storage.local.set({ [STORAGE.diagnostic]: !!msg.enabled });
      sendResponse({ ok: true, enabled: !!msg.enabled });
      return;
    }

    if (msg?.type === "getDiagnosticReport") {
      const [tab] = await chrome.tabs.query({
        active: true, lastFocusedWindow: true
      });
      if (!tab?.id) return sendResponse({ ok: false, reason: "no-tab" });
      // window.__ft13_diag is set by content.js in the ISOLATED
      // world. executeScript defaults to ISOLATED, so omit `world`
      // and we read from the right realm.
      try {
        const [{ result }] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => self.__ft13_diag || null
        });
        if (!result) return sendResponse({ ok: false, reason: "no-diag" });
        const entry = formatDiagEntry(result);
        sendResponse({ ok: true, raw: result, entry });
      } catch (e) {
        sendResponse({ ok: false, reason: e.message?.slice(0, 60) });
      }
      return;
    }

    if (msg?.type === "setStrategy") {
      // User override for a specific host.
      const { host, strategy } = msg;
      if (!host || !strategy) return sendResponse({ ok: false });
      const overrides = await getOverrides();
      overrides[host] = { ...(overrides[host] || {}), strategy };
      await chrome.storage.local.set({ [STORAGE.overrides]: overrides });
      await syncRules();
      sendResponse({ ok: true });
      return;
    }

    sendResponse({ ok: false, reason: "unknown-message" });
  })();
  return true;
});

// ---------- Lifecycle ----------

// Inject a main-world per-site function at navigation-commit time.
// `injectImmediately: true` fires before the page's own scripts run on a
// fresh navigation, so patches to fetch/XHR/localStorage land before
// the paywall boots. Silent on error — many injections into error
// pages, chrome:// URLs, etc. will throw and we don't care.
async function injectCustomJs(tabId, url) {
  const rawHost = await effectiveHostOfUrl(url);
  if (!rawHost) return;
  const host = await canonicalConfiguredHost(rawHost);
  if (isBlockedHost(host)) return;
  const hosts = await getEnabledHosts();
  if (!hosts.has(host)) return;

  // Build the injection list: universal defusers first, then per-site.
  // Universal defusers are safe no-ops on sites that don't use their
  // target SaaS (e.g. Piano). Running them on every enabled site
  // covers publishers we haven't hand-fingerprinted.
  const cfg = await resolveSiteConfig(host);
  const names = [
    ...(Array.isArray(self.UNIVERSAL_CUSTOM_JS) ? self.UNIVERSAL_CUSTOM_JS : []),
    ...(cfg.customJs ? [cfg.customJs] : [])
  ];
  for (const name of names) {
    const fn = CUSTOM_JS_FUNCTIONS[name];
    if (typeof fn !== "function") continue;
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        injectImmediately: true,
        func: fn
      });
    } catch {
      // expected on non-injectable pages (chrome://, extension pages).
    }
  }
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status === "loading" && tab.url) {
    refreshTabBadge(tabId, tab.url);
    injectCustomJs(tabId, tab.url);
  }
});

chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  const tab = await chrome.tabs.get(tabId);
  if (tab.url) refreshTabBadge(tabId, tab.url);
});

// Purge any blocked hosts left in enabledHosts from a previous version
// before (re)building rules. Otherwise a user who enabled 13ft on, say,
// reddit.com before we shipped BLOCKED_HOSTS would stay stuck enabled.
async function purgeAndSync() {
  const hosts = await getEnabledHosts();
  let changed = false;
  for (const h of [...hosts]) {
    if (isBlockedHost(h)) {
      hosts.delete(h);
      changed = true;
    }
  }
  if (changed) await setEnabledHosts(hosts);
  await syncRules();
}

chrome.runtime.onStartup.addListener(() => {
  purgeAndSync();
  ensureProxyHealthAlarm();
  ensureRulesUpdateAlarm();
});
chrome.runtime.onInstalled.addListener(() => {
  purgeAndSync();
  ensureProxyHealthAlarm();
  ensureRulesUpdateAlarm();
});
