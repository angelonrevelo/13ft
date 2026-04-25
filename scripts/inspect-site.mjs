#!/usr/bin/env node
// Inspect a live paywalled page and propose a sites.js entry.
//
// Usage:
//   node scripts/inspect-site.mjs <url>
//
// Drives a clean Chromium (no 13ft extension loaded) against the URL,
// records network requests + cookies + JSON-LD + rel=amphtml + paywall
// element candidates, then prints a proposed entry you can paste into
// sites.js. Output is advisory — a human should verify each field
// before committing.
//
// Requires:
//   cd /tmp/13ft-pw && npm i playwright  # already installed if you
//                                         # ran the earlier tests

import path from "node:path";

// Resolve Playwright from the test harness install.
const PW_DIR = "/tmp/13ft-pw/node_modules/playwright";
let chromium;
try {
  ({ chromium } = await import(path.join(PW_DIR, "index.mjs")));
} catch {
  try {
    ({ chromium } = await import("playwright"));
  } catch {
    console.error(
      "playwright not found. Run: cd /tmp/13ft-pw && npm i playwright"
    );
    process.exit(2);
  }
}

const url = process.argv[2];
if (!url) {
  console.error("usage: node scripts/inspect-site.mjs <url>");
  process.exit(1);
}
let targetUrl;
try { targetUrl = new URL(url); }
catch { console.error(`invalid url: ${url}`); process.exit(1); }

const host = targetUrl.hostname.replace(/^www\./, "");

const PAYWALL_HINTS = /paywall|meter|subscribe|gate|piano|tinypass|journey|reg.?wall|metering/i;

const browser = await chromium.launch({
  headless: false,
  args: ["--no-first-run"]
});
const ctx = await browser.newContext();
const page = await ctx.newPage();

const requests = [];
const failedRequests = [];
page.on("request", (req) => {
  requests.push({
    url: req.url(),
    type: req.resourceType(),
    method: req.method()
  });
});
page.on("requestfailed", (req) => {
  failedRequests.push({ url: req.url(), err: req.failure()?.errorText });
});

try {
  await page.goto(url, { waitUntil: "networkidle", timeout: 30000 });
} catch (e) {
  console.error(`navigation problem (continuing with partial data): ${e.message}`);
}

// --- Collect signals ---

// JSON-LD with isAccessibleForFree:false
const jsonLdSelectors = await page.evaluate(() => {
  function* walk(node, paywalled = false) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const c of node) yield* walk(c, paywalled);
      return;
    }
    if (typeof node !== "object") return;
    const flag = node.isAccessibleForFree;
    const p = paywalled || flag === false || flag === "False" || flag === "false";
    if (p && typeof node.cssSelector === "string" && node.cssSelector.trim()) {
      yield node.cssSelector.trim();
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") yield* walk(v, p);
    }
  }
  const out = new Set();
  for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      for (const sel of walk(JSON.parse(s.textContent || "null"))) out.add(sel);
    } catch {}
  }
  return [...out];
});

const ampHref = await page.evaluate(() => {
  const l = document.querySelector('link[rel="amphtml"]');
  return l?.href || null;
});

// Fixed-position full-viewport overlays with paywall-ish naming.
const overlayCandidates = await page.evaluate((hintRe) => {
  const re = new RegExp(hintRe, "i");
  const matches = [];
  for (const el of document.querySelectorAll("div, section, aside")) {
    if (!(el instanceof HTMLElement)) continue;
    const id = el.id || "";
    const cls = typeof el.className === "string" ? el.className : "";
    if (!re.test(id + " " + cls)) continue;
    const cs = getComputedStyle(el);
    if (cs.position !== "fixed" && cs.position !== "absolute") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < window.innerWidth * 0.5) continue;
    matches.push({
      id: el.id || null,
      tag: el.tagName.toLowerCase(),
      classes: cls.split(/\s+/).slice(0, 4),
      zIndex: cs.zIndex,
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`
    });
    if (matches.length >= 5) break;
  }
  return matches;
}, PAYWALL_HINTS.source);

const cookies = await ctx.cookies();
const cookiesOnHost = cookies
  .filter((c) => c.domain.endsWith(host.split(".").slice(-2).join(".")))
  .map((c) => ({ name: c.name, domain: c.domain, value: c.value.slice(0, 20) }));

const suspectScripts = requests
  .filter((r) => r.type === "script" || r.type === "xhr")
  .filter((r) => PAYWALL_HINTS.test(r.url))
  .slice(0, 20)
  .map((r) => r.url);

const ampVariantMismatch = ampHref && ampHref !== url &&
  !/\/amp\/|[?&]outputType=amp\b|\.amp\./.test(url);

// --- Emit proposed entry ---
const lines = [];
lines.push(`# 13ft inspection: ${url}`);
lines.push("");

// Proposed regexes — collapse to unique host+path fragments. All
// special chars get escaped for a JS /.../ literal; then we
// generalize hex-hash segments and hash-suffixed filenames so the
// rule survives minor rebuilds of the bundle.
function escapeRegexLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}
const regexCandidates = new Set();
for (const s of suspectScripts) {
  try {
    const u = new URL(s);
    let body = escapeRegexLiteral(u.hostname + u.pathname);
    // Replace literal hex-hash segments with a wildcard.
    body = body
      .replace(/\\\/[a-f0-9]{8,}\\\//g, "\\/.+\\/")
      .replace(/[a-f0-9]{8,}\\\.js$/, ".+\\.js");
    regexCandidates.add(`/${body}/`);
  } catch {}
}

lines.push(`"${host}": {`);
lines.push(`  strategy: "googlebot",`);
if (cookiesOnHost.length > 0 && !cookiesOnHost.some((c) => PAYWALL_HINTS.test(c.name))) {
  lines.push(`  allowCookies: true,  // site sets several session cookies; usually safer to keep`);
}

if (regexCandidates.size > 0) {
  lines.push(`  blockRegex: [`);
  for (const r of regexCandidates) lines.push(`    ${r},`);
  lines.push(`  ],`);
}

const meteredCookies = cookiesOnHost.filter((c) =>
  PAYWALL_HINTS.test(c.name) || /meter|count|view|visit|gdpr/i.test(c.name)
);
if (meteredCookies.length > 0) {
  lines.push(`  dropCookies: [${meteredCookies.map((c) => JSON.stringify(c.name)).join(", ")}],`);
}

if (ampVariantMismatch) {
  lines.push(`  ampRedirect: true,  // <link rel="amphtml" href="${ampHref}">`);
}

if (jsonLdSelectors.length > 0 || overlayCandidates.length > 0) {
  lines.push(`  cssRules: {`);
  if (overlayCandidates.length > 0) {
    lines.push(`    hide: [`);
    for (const o of overlayCandidates) {
      const sel = o.id
        ? `#${o.id}`
        : `${o.tag}.${o.classes[0] || ""}`;
      lines.push(`      "${sel}",  // ${o.tag} ${o.size} z=${o.zIndex}`);
    }
    lines.push(`    ],`);
  }
  if (jsonLdSelectors.length > 0) {
    lines.push(`    reveal: [`);
    for (const sel of jsonLdSelectors) {
      lines.push(`      ${JSON.stringify(sel)},  // from JSON-LD isAccessibleForFree:false`);
    }
    lines.push(`    ],`);
  }
  lines.push(`  },`);
}

lines.push(`},`);
lines.push("");

// --- Diagnostic summary ---
lines.push("## signals");
lines.push(`- total requests: ${requests.length}`);
lines.push(`- failed requests: ${failedRequests.length}`);
lines.push(`- suspect scripts: ${suspectScripts.length}`);
for (const s of suspectScripts.slice(0, 10)) lines.push(`    - ${s}`);
lines.push(`- cookies on host: ${cookiesOnHost.length} (${cookiesOnHost.map((c) => c.name).slice(0, 10).join(", ")})`);
lines.push(`- JSON-LD paywalled selectors: ${jsonLdSelectors.length}`);
for (const s of jsonLdSelectors) lines.push(`    - ${s}`);
lines.push(`- rel=amphtml: ${ampHref || "(none)"}`);
lines.push(`- overlay candidates: ${overlayCandidates.length}`);
for (const o of overlayCandidates) {
  lines.push(`    - ${o.tag}${o.id ? "#" + o.id : ""}.${(o.classes[0] || "")} ${o.size} z=${o.zIndex}`);
}

console.log(lines.join("\n"));

await browser.close();
