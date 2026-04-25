#!/usr/bin/env node
// Live test runner — exercises the extension against real paywalled
// publisher articles. Not a CI gate. Run when you want a real-world
// checkpoint of which rules still work:
//
//   node tests/live/run.mjs                    # all sites
//   node tests/live/run.mjs --filter atlantic  # subset
//   node tests/live/run.mjs --json out.json    # also dump JSON
//
// For each publisher: scrapes the homepage to find a current
// paywalled article URL, then opens that article in two clean
// Chromium sessions — one vanilla, one with the 13ft extension
// loaded — and compares body length, paywall markers, redirect
// destinations.
//
// Output: a markdown table you can paste into a release-notes
// section. Optional JSON dump for tracking deltas across runs.

import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXT_DIR = path.resolve(__dirname, "..", "..");

// Playwright — try local node_modules first, then the shared install
// at /tmp/13ft-pw, then global. Same pattern as scripts/inspect-site.mjs.
let chromium;
const LOOKUPS = [
  path.resolve(__dirname, "node_modules/playwright/index.mjs"),
  "/tmp/13ft-pw/node_modules/playwright/index.mjs",
  "playwright"
];
for (const candidate of LOOKUPS) {
  try {
    ({ chromium } = await import(candidate));
    break;
  } catch { /* try next */ }
}
if (!chromium) {
  console.error("playwright not found. Run: cd /tmp/13ft-pw && npm i playwright");
  process.exit(2);
}

// --- CLI ---
const argv = process.argv.slice(2);
function argAfter(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
// Comma-separated list of site keys to run. Empty = all.
const FILTER = (argAfter("--filter") || "").toLowerCase()
  .split(",").map((s) => s.trim()).filter(Boolean);
const JSON_OUT = argAfter("--json");
const TIMEOUT = parseInt(argAfter("--timeout") || "20000", 10);

// --url <url>: skip homepage scraping; spot-check this exact URL.
// Works on any host the user has configured in DEFAULT_SITES OR
// would land in the universal-fallback (googlebot strategy by default).
const URL_ARG = argAfter("--url");

// --generic: load DEFAULT_SITES via vm, run the generic homepage
// scraper across every entry. Best-effort; some sites won't yield a
// usable URL. Use --generic-limit N to cap the number tested.
const GENERIC = argv.includes("--generic");
const GENERIC_LIMIT = parseInt(argAfter("--generic-limit") || "50", 10);

// --- Site catalog. Each entry has a homepage URL + a function (run
// in the page context via page.evaluate) that picks one current
// paywalled article URL.
const SITES = [
  {
    key: "atlantic",
    label: "The Atlantic",
    homepage: "https://www.theatlantic.com/",
    enableHost: "theatlantic.com",
    pick: () => {
      const re = /^\/[a-z-]+\/archive\/\d{4}\/\d{2}\/[a-z0-9-]+\/\d+\/?$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("theatlantic.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "wired",
    label: "Wired",
    homepage: "https://www.wired.com/",
    enableHost: "wired.com",
    pick: () => {
      const re = /^\/story\/[a-z0-9-]+\/?$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("wired.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "newyorker",
    label: "The New Yorker",
    homepage: "https://www.newyorker.com/",
    enableHost: "newyorker.com",
    pick: () => {
      const re = /^\/(magazine|news|culture|books|humor)\/[a-z0-9-]+\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("newyorker.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "bostonglobe",
    label: "Boston Globe",
    homepage: "https://www.bostonglobe.com/",
    enableHost: "bostonglobe.com",
    pick: () => {
      const re = /\/\d{4}\/\d{2}\/\d{2}\//;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("bostonglobe.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "time",
    label: "Time",
    homepage: "https://time.com/",
    enableHost: "time.com",
    pick: () => {
      const re = /^\/\d+\/[a-z0-9-]+\/?$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname === "time.com" && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "spiegel",
    label: "Der Spiegel",
    homepage: "https://www.spiegel.de/",
    enableHost: "spiegel.de",
    pick: () => {
      const re = /\/[a-z]+\/[a-z0-9äöü-]+-a-[a-f0-9-]+\.html$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("spiegel.de") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "lemonde",
    label: "Le Monde",
    homepage: "https://www.lemonde.fr/",
    enableHost: "lemonde.fr",
    pick: () => {
      const re = /\/article\/\d{4}\/\d{2}\/\d{2}\//;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("lemonde.fr") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "ft",
    label: "Financial Times",
    homepage: "https://www.ft.com/",
    enableHost: "ft.com",
    pick: () => {
      const re = /\/content\/[a-f0-9-]{8,}/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("ft.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "economist",
    label: "The Economist",
    homepage: "https://www.economist.com/",
    enableHost: "economist.com",
    pick: () => {
      const re = /\/(briefing|leaders|finance-and-economics|business|culture|science-and-technology|united-states|the-americas|asia|china|europe|britain|middle-east-and-africa|international|essay)\/\d{4}\/\d{2}\/\d{2}\//;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("economist.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "bloomberg",
    label: "Bloomberg",
    homepage: "https://www.bloomberg.com/",
    enableHost: "bloomberg.com",
    pick: () => {
      const re = /^\/news\/(articles|features)\/\d{4}-\d{2}-\d{2}\//;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("bloomberg.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "medium",
    label: "Medium",
    homepage: "https://medium.com/",
    enableHost: "medium.com",
    pick: () => {
      const re = /\/[\w@-]+\/[a-z0-9-]+-[a-f0-9]{8,}\/?$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("medium.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },

  // ----- Curated tier expansion -----
  // Major US news. NYT/WaPo are FCrDNS-prone; expect proxy fallback.
  {
    key: "nytimes",
    label: "The New York Times",
    homepage: "https://www.nytimes.com/",
    enableHost: "nytimes.com",
    pick: () => {
      const re = /^\/\d{4}\/\d{2}\/\d{2}\/[a-z-]+\/[a-z0-9-]+\.html$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("nytimes.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "wapo",
    label: "Washington Post",
    homepage: "https://www.washingtonpost.com/",
    enableHost: "washingtonpost.com",
    pick: () => {
      const re = /^\/[a-z-]+\/\d{4}\/\d{2}\/\d{2}\//i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("washingtonpost.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "wsj",
    label: "Wall Street Journal",
    homepage: "https://www.wsj.com/",
    enableHost: "wsj.com",
    pick: () => {
      const re = /^\/articles\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("wsj.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "forbes",
    label: "Forbes",
    homepage: "https://www.forbes.com/",
    enableHost: "forbes.com",
    pick: () => {
      // Forbes URL: /sites/<author>/<year>/<month>/<day>/<slug>/
      const re = /^\/sites\/[a-z0-9-]+\/\d{4}\/\d{2}\/\d{2}\//i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("forbes.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "marketwatch",
    label: "MarketWatch",
    homepage: "https://www.marketwatch.com/",
    enableHost: "marketwatch.com",
    pick: () => {
      const re = /^\/story\/[a-z0-9-]+-[a-f0-9]{6,}/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("marketwatch.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "latimes",
    label: "Los Angeles Times",
    homepage: "https://www.latimes.com/",
    enableHost: "latimes.com",
    pick: () => {
      const re = /^\/[a-z-]+\/story\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("latimes.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  // European publishers
  {
    key: "lefigaro",
    label: "Le Figaro",
    homepage: "https://www.lefigaro.fr/",
    enableHost: "lefigaro.fr",
    pick: () => {
      // Le Figaro: /<section>/YYYY/MM/DD/<slug>-<id>.php or /<section>/<slug>-<id>
      const re = /\/[a-z0-9-]+-\d{8,}/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("lefigaro.fr") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "welt",
    label: "Die Welt",
    homepage: "https://www.welt.de/",
    enableHost: "welt.de",
    pick: () => {
      // Welt: /<section>/article<id>/<slug>.html
      const re = /\/article\d+\/[a-zA-Z0-9-]+\.html$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("welt.de") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "zeit",
    label: "Die Zeit",
    homepage: "https://www.zeit.de/",
    enableHost: "zeit.de",
    pick: () => {
      // Zeit: /YYYY/NN/<slug> or /<section>/YYYY-MM/<slug>
      const re = /\/\d{4}[-/]\d{2}\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("zeit.de") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "elpais",
    label: "El País",
    homepage: "https://elpais.com/",
    enableHost: "elpais.com",
    pick: () => {
      // El País: /<section>/YYYY-MM-DD/<slug>.html
      const re = /\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+\.html$/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("elpais.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "telegraph",
    label: "The Telegraph",
    homepage: "https://www.telegraph.co.uk/",
    enableHost: "telegraph.co.uk",
    pick: () => {
      const re = /^\/[a-z-]+\/\d{4}\/\d{2}\/\d{2}\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("telegraph.co.uk") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  // Canadian publishers
  {
    key: "thestar",
    label: "Toronto Star",
    homepage: "https://www.thestar.com/",
    enableHost: "thestar.com",
    pick: () => {
      const re = /^\/[a-z-]+\/[a-z0-9-]+\/article_[a-f0-9-]{8,}/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("thestar.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "globeandmail",
    label: "The Globe and Mail",
    homepage: "https://www.theglobeandmail.com/",
    enableHost: "theglobeandmail.com",
    pick: () => {
      const re = /^\/[a-z-]+\/article-[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("theglobeandmail.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  // Magazines
  {
    key: "hbr",
    label: "Harvard Business Review",
    homepage: "https://hbr.org/",
    enableHost: "hbr.org",
    pick: () => {
      const re = /^\/\d{4}\/\d{2}\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("hbr.org") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  },
  {
    key: "foreignaffairs",
    label: "Foreign Affairs",
    homepage: "https://www.foreignaffairs.com/",
    enableHost: "foreignaffairs.com",
    pick: () => {
      const re = /^\/articles\/[a-z0-9-]+\/\d{4}-\d{2}-\d{2}\/[a-z0-9-]+/i;
      for (const a of [...document.querySelectorAll("a[href]")]) {
        try { const u = new URL(a.href);
          if (u.hostname.endsWith("foreignaffairs.com") && re.test(u.pathname)) return u.toString();
        } catch {}
      }
      return null;
    }
  }
];

// --- Helpers ---

async function findArticle(site) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  let url = null;
  try {
    await page.goto(site.homepage, {
      waitUntil: "domcontentloaded", timeout: TIMEOUT
    });
    await page.waitForTimeout(1500);
    url = await page.evaluate(`(${site.pick.toString()})()`);
  } catch (e) {
    // Homepage scrape failed — many things could cause this; report
    // but don't crash.
  }
  await browser.close();
  return url;
}

async function captureSession(articleUrl, site, withExtension) {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), "13ft-live-"));
  const args = ["--no-first-run", "--no-default-browser-check"];
  if (withExtension) {
    args.push(`--disable-extensions-except=${EXT_DIR}`);
    args.push(`--load-extension=${EXT_DIR}`);
  }
  const ctx = await chromium.launchPersistentContext(userData, {
    headless: false, args
  });
  if (withExtension) {
    let sw = null;
    for (let i = 0; i < 100; i++) {
      sw = ctx.serviceWorkers().find((s) => s.url().includes("/background.js"));
      if (sw) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    if (!sw) {
      await ctx.close();
      fs.rmSync(userData, { recursive: true, force: true });
      throw new Error("no SW");
    }
    await new Promise((r) => setTimeout(r, 500));
    await sw.evaluate(async (host) => {
      await chrome.storage.local.set({ enabledHosts: [host] });
      // eslint-disable-next-line no-undef
      await syncRules();
    }, site.enableHost);
  }

  const page = await ctx.newPage();
  let httpStatus = null, navError = null;
  try {
    const resp = await page.goto(articleUrl, {
      waitUntil: "domcontentloaded", timeout: TIMEOUT
    });
    httpStatus = resp?.status() ?? null;
  } catch (e) {
    navError = e.message.split("\n")[0];
  }
  // Allow rules to fire, content script to run, late paywalls to
  // inject + be removed, SSR extraction to complete, auto-fallback
  // to ride out one strategy if needed.
  await page.waitForTimeout(5000);

  let observations;
  try {
    observations = await page.evaluate(() => {
      const text = document.body?.innerText || "";
      return {
        title: (document.title || "").slice(0, 80),
        finalUrl: location.href,
        bodyLength: text.length,
        paywallMarkers: [
          ...document.querySelectorAll(
            "[id*='paywall' i], [class*='paywall' i], [class*='regwall' i], " +
            "[class*='subscribe' i][class*='modal' i]"
          )
        ].length,
        hasSsrPanel: [...document.querySelectorAll("div")].some((el) =>
          /^13ft — extracted from SSR state/.test((el.textContent || "").trim())
        ),
        offerSubscribe:
          /(subscribe|sign up) (to|now)|create.+account|abonnez-vous|sign in to read/i
            .test(text),
        challengePage: /verify you are human|just a moment|security verification/i
          .test(text)
      };
    });
  } catch {
    observations = {
      title: "(eval failed)", finalUrl: page.url(), bodyLength: 0,
      paywallMarkers: 0, hasSsrPanel: false, offerSubscribe: false,
      challengePage: false
    };
  }

  await ctx.close();
  fs.rmSync(userData, { recursive: true, force: true });
  return { ...observations, httpStatus, navError };
}

function classify(r) {
  if (r.error || r.skipped) return "SKIPPED";
  const v = r.vanilla, w = r.withExt;
  if (w.challengePage && !v.challengePage) return "ESCALATED";
  if (w.bodyLength < 500) return "BLOCKED";
  if (w.hasSsrPanel) return "WIN-SSR";

  const delta = w.bodyLength - v.bodyLength;
  const overlayRemoved = v.paywallMarkers > 0 && w.paywallMarkers === 0;
  const promptRemoved = v.offerSubscribe && !w.offerSubscribe;

  // Big body delta + paywall or prompt gone → unambiguous win.
  if (delta > 1500 && (overlayRemoved || promptRemoved)) return "WIN";
  // Body delta this large is itself unambiguous (publisher unlikely
  // to serve >3KB of new content without us actually having bypassed).
  if (delta > 3000) return "WIN";
  // Smaller delta but at least no subscribe prompt + no overlay.
  if (delta > 500 && !w.offerSubscribe && w.paywallMarkers === 0) return "PARTIAL";
  // Overlay gone but body unchanged (rare — the body was already in
  // the DOM, only the overlay was masking it visually).
  if (overlayRemoved && delta >= 0) return "WIN-OVERLAY";
  if (delta === 0) return "NO-CHANGE";
  return "UNCLEAR";
}

async function runOne(site) {
  console.log(`\n[${site.key}] ${site.label}`);
  const articleUrl = await findArticle(site);
  if (!articleUrl) {
    console.log("  ✗ no article found on homepage — skipping");
    return { site: site.key, label: site.label, skipped: "no article URL" };
  }
  console.log(`  url: ${articleUrl.slice(0, 80)}${articleUrl.length > 80 ? "…" : ""}`);
  let vanilla, withExt;
  try {
    vanilla = await captureSession(articleUrl, site, false);
  } catch (e) {
    return { site: site.key, label: site.label, articleUrl, error: "vanilla: " + e.message };
  }
  try {
    withExt = await captureSession(articleUrl, site, true);
  } catch (e) {
    return { site: site.key, label: site.label, articleUrl, vanilla, error: "13ft: " + e.message };
  }
  const r = { site: site.key, label: site.label, articleUrl, vanilla, withExt };
  r.verdict = classify(r);
  console.log(
    `  vanilla: status=${vanilla.httpStatus} body=${vanilla.bodyLength} paywall=${vanilla.paywallMarkers}\n` +
    `  13ft:    status=${withExt.httpStatus} body=${withExt.bodyLength} paywall=${withExt.paywallMarkers} ssr=${withExt.hasSsrPanel}\n` +
    `  → ${r.verdict}  (delta: ${withExt.bodyLength - vanilla.bodyLength})`
  );
  return r;
}

function emitMarkdownTable(results) {
  const headers = ["publisher", "vanilla → 13ft", "delta", "verdict"];
  const align   = ["---", "---", "---:", "---"];
  const lines = [
    `| ${headers.join(" | ")} |`,
    `| ${align.join(" | ")} |`
  ];
  for (const r of results) {
    if (r.skipped || r.error) {
      lines.push(`| ${r.label} | — | — | ${r.skipped || r.error} |`);
      continue;
    }
    const v = r.vanilla.bodyLength, w = r.withExt.bodyLength;
    const delta = w - v;
    lines.push(
      `| ${r.label} | ${v} → ${w} | ${delta > 0 ? "+" + delta : delta} | ${r.verdict} |`
    );
  }
  return lines.join("\n");
}

function emitSummary(results) {
  const tally = {};
  for (const r of results) {
    const k = r.skipped ? "SKIPPED" : r.error ? "ERROR" : r.verdict;
    tally[k] = (tally[k] || 0) + 1;
  }
  const ordered = ["WIN", "WIN-SSR", "WIN-OVERLAY", "PARTIAL", "NO-CHANGE",
                   "UNCLEAR", "BLOCKED", "ESCALATED", "SKIPPED", "ERROR"];
  return ordered.filter((k) => tally[k]).map((k) => `${k}=${tally[k]}`).join("  ");
}

// --- URL-only mode helpers ---

async function runOneFromUrl(url) {
  let parsed;
  try { parsed = new URL(url); }
  catch { console.error(`invalid --url: ${url}`); process.exit(1); }
  const enableHost = parsed.hostname.replace(/^www\./, "");
  const site = {
    key: "url",
    label: parsed.hostname,
    homepage: null,
    enableHost,
    pick: () => null
  };
  console.log(`\n[url] ${parsed.hostname}\n  url: ${url}`);
  let vanilla, withExt;
  try { vanilla = await captureSession(url, site, false); }
  catch (e) { return { site: "url", label: parsed.hostname, articleUrl: url, error: "vanilla: " + e.message }; }
  try { withExt = await captureSession(url, site, true); }
  catch (e) { return { site: "url", label: parsed.hostname, articleUrl: url, vanilla, error: "13ft: " + e.message }; }
  const r = { site: "url", label: parsed.hostname, articleUrl: url, vanilla, withExt };
  r.verdict = classify(r);
  console.log(
    `  vanilla: status=${vanilla.httpStatus} body=${vanilla.bodyLength} paywall=${vanilla.paywallMarkers}\n` +
    `  13ft:    status=${withExt.httpStatus} body=${withExt.bodyLength} paywall=${withExt.paywallMarkers} ssr=${withExt.hasSsrPanel}\n` +
    `  → ${r.verdict}  (delta: ${withExt.bodyLength - vanilla.bodyLength})`
  );
  return r;
}

// --- Generic mode helpers ---
//
// Loads DEFAULT_SITES from sites.js + sites.generated.js into a vm
// context (same pattern as the unit tests), then iterates each
// host with a best-effort homepage scraper.

import vm from "node:vm";

function loadDefaultSitesViaVm() {
  const sitesSrc = fs.readFileSync(path.join(EXT_DIR, "sites.js"), "utf8");
  const generatedSrc = fs.readFileSync(path.join(EXT_DIR, "sites.generated.js"), "utf8");
  const sb = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    RegExp, Object, Array, Symbol, Math, Date, JSON, URL,
    Error, TypeError, Promise
  };
  sb.self = sb;
  vm.createContext(sb);
  try { vm.runInContext(sitesSrc, sb, { filename: "sites.js" }); }
  catch { /* ignore — we just need DEFAULT_SITES */ }
  try { vm.runInContext(generatedSrc, sb, { filename: "sites.generated.js" }); }
  catch {}
  return sb.DEFAULT_SITES || {};
}

// Best-effort generic article picker. Runs in the page context.
// Scores each same-host link by URL shape; returns the highest-
// scoring candidate.
const GENERIC_PICK_FN = function () {
  const ANTI = /\/(category|categories|tag|tags|topic|topics|author|authors|search|feed|rss|about|contact|subscribe|sign|login|account|terms|privacy|policy|help)\b/i;
  const here = location.hostname.replace(/^www\./, "");
  let best = { score: 0, url: null };
  for (const a of [...document.querySelectorAll("a[href]")]) {
    let u;
    try { u = new URL(a.href); } catch { continue; }
    const aHost = u.hostname.replace(/^www\./, "");
    // Allow same-host or subdomain matches.
    if (!(aHost === here || aHost.endsWith("." + here))) continue;
    const p = u.pathname;
    if (p === "/" || p.length < 8) continue;
    if (ANTI.test(p)) continue;
    let score = 0;
    const segs = p.split("/").filter(Boolean);
    if (segs.length >= 3) score += 30;
    if (segs.length >= 2) score += 15;
    // Date-ish path
    if (/\/\d{4}[/-]\d{2}[/-]\d{2}\//.test(p)) score += 40;
    if (/\/\d{4}\//.test(p)) score += 10;
    // Slug + numeric id
    if (/[a-z]+(?:-[a-z0-9]+){2,}/i.test(segs[segs.length - 1] || "")) score += 25;
    if (/\d{6,}/.test(p)) score += 15;
    if (/\.html?$/i.test(p)) score += 10;
    // Bonus if anchor's text looks like a headline
    const txt = (a.textContent || "").trim();
    if (txt.length > 30 && txt.length < 200 && /\s/.test(txt)) score += 20;
    if (score > best.score) { best = { score, url: u.toString() }; }
  }
  return best.url;
};

async function findArticleGeneric(host) {
  const browser = await chromium.launch({ headless: false });
  const page = await browser.newPage();
  let url = null;
  for (const homepage of [`https://www.${host}/`, `https://${host}/`]) {
    try {
      await page.goto(homepage, { waitUntil: "domcontentloaded", timeout: TIMEOUT });
      await page.waitForTimeout(1500);
      url = await page.evaluate(`(${GENERIC_PICK_FN.toString()})()`);
      if (url) break;
    } catch {}
  }
  await browser.close();
  return url;
}

async function runOneGeneric(host) {
  console.log(`\n[generic] ${host}`);
  const articleUrl = await findArticleGeneric(host);
  if (!articleUrl) {
    console.log("  ✗ no article URL found via generic scrape — skipping");
    return { site: host, label: host, skipped: "generic scrape failed" };
  }
  console.log(`  url: ${articleUrl.slice(0, 80)}${articleUrl.length > 80 ? "…" : ""}`);
  const site = { key: host, label: host, homepage: null, enableHost: host, pick: () => null };
  let vanilla, withExt;
  try { vanilla = await captureSession(articleUrl, site, false); }
  catch (e) { return { site: host, label: host, articleUrl, error: "vanilla: " + e.message }; }
  try { withExt = await captureSession(articleUrl, site, true); }
  catch (e) { return { site: host, label: host, articleUrl, vanilla, error: "13ft: " + e.message }; }
  const r = { site: host, label: host, articleUrl, vanilla, withExt };
  r.verdict = classify(r);
  console.log(
    `  vanilla: status=${vanilla.httpStatus} body=${vanilla.bodyLength} paywall=${vanilla.paywallMarkers}\n` +
    `  13ft:    status=${withExt.httpStatus} body=${withExt.bodyLength} paywall=${withExt.paywallMarkers} ssr=${withExt.hasSsrPanel}\n` +
    `  → ${r.verdict}  (delta: ${withExt.bodyLength - vanilla.bodyLength})`
  );
  return r;
}

async function main() {
  // Mode 1: --url <url> spot check. Skip everything else.
  if (URL_ARG) {
    console.log(`Live test — single URL\n`);
    console.log(`Started: ${new Date().toISOString()}`);
    const r = await runOneFromUrl(URL_ARG);
    const results = [r];
    console.log("\n\n## Live test results");
    console.log(`Run at: ${new Date().toISOString()}`);
    console.log(emitMarkdownTable(results));
    console.log("Summary: " + emitSummary(results));
    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
      fs.writeFileSync(JSON_OUT, JSON.stringify({
        runAt: new Date().toISOString(), results, summary: emitSummary(results)
      }, null, 2));
      console.log(`\nJSON dump: ${JSON_OUT}`);
    }
    return;
  }

  // Mode 2: --generic over every DEFAULT_SITES entry.
  if (GENERIC) {
    const all = Object.keys(loadDefaultSitesViaVm());
    let hosts = FILTER.length === 0 ? all : all.filter((h) => FILTER.includes(h));
    if (hosts.length > GENERIC_LIMIT) {
      console.log(`Truncating ${hosts.length} hosts → first ${GENERIC_LIMIT} (raise via --generic-limit)`);
      hosts = hosts.slice(0, GENERIC_LIMIT);
    }
    console.log(`Live test — generic mode, ${hosts.length} hosts\n`);
    console.log(`Started: ${new Date().toISOString()}`);
    const results = [];
    for (const host of hosts) {
      try { results.push(await runOneGeneric(host)); }
      catch (e) {
        console.log(`  ✗ unhandled: ${e.message}`);
        results.push({ site: host, label: host, error: e.message });
      }
    }
    console.log("\n\n## Live test results (generic)");
    console.log(`Run at: ${new Date().toISOString()}`);
    console.log("");
    console.log(emitMarkdownTable(results));
    console.log("");
    console.log("Summary: " + emitSummary(results));
    if (JSON_OUT) {
      fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
      fs.writeFileSync(JSON_OUT, JSON.stringify({
        runAt: new Date().toISOString(), results, summary: emitSummary(results),
        mode: "generic"
      }, null, 2));
      console.log(`\nJSON dump: ${JSON_OUT}`);
    }
    return;
  }

  // Mode 3 (default): curated SITES.
  const sites = FILTER.length === 0
    ? SITES
    : SITES.filter((s) => FILTER.includes(s.key));
  console.log(`Live test — ${sites.length} site${sites.length === 1 ? "" : "s"}\n`);
  console.log(`Started: ${new Date().toISOString()}`);

  const results = [];
  for (const site of sites) {
    try {
      results.push(await runOne(site));
    } catch (e) {
      console.log(`  ✗ unhandled: ${e.message}`);
      results.push({ site: site.key, label: site.label, error: e.message });
    }
  }

  console.log("\n\n## Live test results");
  console.log("");
  console.log(`Run at: ${new Date().toISOString()}`);
  console.log("");
  console.log(emitMarkdownTable(results));
  console.log("");
  console.log("Summary: " + emitSummary(results));

  if (JSON_OUT) {
    fs.mkdirSync(path.dirname(path.resolve(JSON_OUT)), { recursive: true });
    fs.writeFileSync(JSON_OUT, JSON.stringify({
      runAt: new Date().toISOString(),
      results,
      summary: emitSummary(results)
    }, null, 2));
    console.log(`\nJSON dump: ${JSON_OUT}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
