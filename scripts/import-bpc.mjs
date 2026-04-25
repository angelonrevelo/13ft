#!/usr/bin/env node
// Fetch the current Bypass Paywalls Clean sites.js from a public mirror,
// transpile entries we understand into our schema, and emit
// sites.generated.js next to our hand-curated sites.js.
//
// Design:
//  - Hand-curated sites.js wins. sites.generated.js fills in gaps only.
//  - BPC fields → ours:
//      domain                             → key in DEFAULT_SITES
//      group: [d1, d2, …]                 → expand into one entry per d
//      useragent: "googlebot"|"bingbot"  → strategy + (optional) custom UA
//      allow_cookies: 1                   → allowCookies: true
//      block_regex: /re/ | "re"          → blockRegex: [RegExp]
//      amp_unhide: 1                      → ampRedirect: true
//      remove_cookies_select_drop: [...] → dropCookies: [...]
//      block_selectors: sel|[sel]        → cssRules.hide: [sel]
//      exception_selectors: sel|[sel]    → cssRules.reveal: [sel]
//  - Unsupported fields (cs_code, ld_json_remove, block_javascript,
//    group_rule references) are silently skipped and counted.
//  - Output is deterministic (domains sorted) so diffs are reviewable.
//
// Usage:
//   node scripts/import-bpc.mjs                    # write sites.generated.js
//   node scripts/import-bpc.mjs --dry-run          # print counts, don't write
//   node scripts/import-bpc.mjs --source <path>    # use local BPC file
//   node scripts/import-bpc.mjs --filter 'nytimes,wsj'  # only these substrings

import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, "..");
const OUT_PATH = path.join(PROJECT_ROOT, "sites.generated.js");
const BPC_URL =
  "https://raw.githubusercontent.com/csns1/bypass-paywalls-chrome-clean-magnolia1234/master/sites.js";

const BINGBOT_UA =
  "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";

// --- CLI ---
const argv = process.argv.slice(2);
const flags = {
  dryRun: argv.includes("--dry-run"),
  source: argAfter("--source"),
  filter: (argAfter("--filter") || "").split(",").filter(Boolean)
};
function argAfter(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}

// --- Fetch or read source ---
async function loadSource() {
  if (flags.source) return fs.readFileSync(flags.source, "utf8");
  const res = await fetch(BPC_URL, {
    headers: { "user-agent": "13ft-import/1.0" }
  });
  if (!res.ok) throw new Error(`BPC fetch ${res.status}: ${BPC_URL}`);
  return res.text();
}

// --- Parse BPC sites.js by evaluating it in a sandbox ---
function parseBpc(source) {
  const sb = {
    console: { log: () => {}, warn: () => {}, error: () => {} },
    RegExp, Object, Array, Symbol, Math, Date, JSON,
    URL, Error, TypeError, Promise,
    setTimeout: () => 0, clearTimeout: () => {},
    chrome: null, browser: null,
    self: null, window: null
  };
  sb.self = sb;
  sb.window = sb;
  sb.globalThis = sb;
  vm.createContext(sb);
  // BPC's file uses top-level `var defaultSites = { … };` plus some
  // helper functions. We only care about the object literal.
  try {
    vm.runInContext(source, sb, { filename: "bpc-sites.js" });
  } catch (e) {
    // Some helper code may rely on browser globals we didn't stub.
    // That's fine — we just need `defaultSites` to be populated.
    if (!sb.defaultSites) throw new Error(`eval failed: ${e.message}`);
  }
  if (!sb.defaultSites) throw new Error("defaultSites not found in source");
  return sb.defaultSites;
}

function isValidDomain(d) {
  if (typeof d !== "string") return false;
  if (d.startsWith("#") || d.startsWith("___")) return false;  // BPC options
  if (!d.includes(".")) return false;                          // "options" keys
  return true;
}

// Duck-type RegExp so we survive cross-realm values (vm-evaluated
// BPC source uses the vm's own RegExp, not ours).
function isRegex(v) {
  return !!(v && typeof v === "object" && typeof v.source === "string" &&
    typeof v.test === "function");
}

// --- Translate one BPC entry into our per-domain rule shape ---
function translateEntry(name, entry) {
  // Collect target domains (primary + group members), filtering out
  // BPC's internal pseudo-keys like "#options_..." and "###_ref".
  const targets = [];
  if (isValidDomain(entry.domain)) targets.push(entry.domain);
  if (Array.isArray(entry.group)) {
    for (const d of entry.group) if (isValidDomain(d)) targets.push(d);
  }
  if (targets.length === 0) return [];

  const rule = {};

  // Strategy / UA.
  if (entry.useragent === "googlebot") {
    rule.strategy = "googlebot";
  } else if (entry.useragent === "bingbot") {
    rule.strategy = "googlebot";
    rule.customUserAgent = BINGBOT_UA;
  }
  // If no UA override, we leave strategy unset → 13ft defaults to
  // googlebot (same as BPC's implicit behavior for "strip cookies
  // only"). Users can override via popup.

  if (entry.allow_cookies === 1 || entry.allow_cookies === true) {
    rule.allowCookies = true;
  }

  // block_regex — can be a cross-realm RegExp, a string, an array of
  // those, or (in a few entries) a string template with {domain}
  // placeholders. Duck-type so cross-realm values work.
  const br = entry.block_regex;
  if (br) {
    const patterns = Array.isArray(br) ? br : [br];
    const out = [];
    for (const p of patterns) {
      if (isRegex(p)) {
        try { out.push(new RegExp(p.source)); } catch { /* skip */ }
      } else if (typeof p === "string") {
        try { out.push(new RegExp(p)); } catch { /* invalid RE, skip */ }
      }
    }
    if (out.length) rule.blockRegex = out;
  }

  if (entry.amp_unhide === 1 || entry.amp_unhide === true) {
    rule.ampRedirect = true;
  }

  if (Array.isArray(entry.remove_cookies_select_drop)) {
    rule.dropCookies = [...entry.remove_cookies_select_drop];
  }

  // CSS selectors.
  const css = {};
  if (entry.block_selectors) {
    css.hide = Array.isArray(entry.block_selectors)
      ? [...entry.block_selectors]
      : [entry.block_selectors];
  }
  if (entry.exception_selectors) {
    css.reveal = Array.isArray(entry.exception_selectors)
      ? [...entry.exception_selectors]
      : [entry.exception_selectors];
  }
  if (Object.keys(css).length) rule.cssRules = css;

  // Emit one entry per target domain, substituting {domain} in regex
  // sources (BPC uses this placeholder in group-shared patterns).
  const out = [];
  for (const domain of targets) {
    let r = rule;
    if (rule.blockRegex?.some((re) => /\{domain\}/.test(re.source))) {
      r = {
        ...rule,
        blockRegex: rule.blockRegex.map((re) => {
          const replaced = re.source.replaceAll("{domain}", escapeRe(domain));
          try { return new RegExp(replaced); } catch { return re; }
        })
      };
    }
    out.push({ domain, rule: r });
  }
  return out;
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// --- Serialize to a readable JS source string ---
function stringifyRule(rule, indent = "    ") {
  const entries = Object.entries(rule);
  if (entries.length === 0) return "{}";
  const inner = entries
    .map(([k, v]) => `${indent}  ${k}: ${stringifyValue(v, indent + "  ")}`)
    .join(",\n");
  return `{\n${inner}\n${indent}}`;
}

function stringifyValue(v, indent) {
  if (isRegex(v)) {
    // Serialize via source. RegExp.source already escapes forward
    // slashes as \/ when parsed from a /.../ literal, so we wrap
    // without adding another layer. For sources from
    // `new RegExp("...")` constructors, unescaped `/` is legal inside
    // the delimiters too — both forms reconstruct to valid literals.
    let src = v.source;
    // Escape ONLY unescaped forward slashes (those not preceded by \).
    src = src.replace(/(^|[^\\])\//g, "$1\\/");
    return "/" + src + "/";
  }
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    const parts = v.map((x) => stringifyValue(x, indent));
    const oneLiner = "[" + parts.join(", ") + "]";
    if (oneLiner.length <= 100) return oneLiner;
    return "[\n" + parts.map((p) => indent + "  " + p).join(",\n") + "\n" + indent + "]";
  }
  if (v && typeof v === "object") {
    return stringifyRule(v, indent);
  }
  if (typeof v === "string") return JSON.stringify(v);
  return String(v);
}

// --- Main ---
async function main() {
  const source = await loadSource();
  const defaultSites = parseBpc(source);

  let totalEntries = 0;
  let translated = 0;
  let skippedReference = 0;
  let skippedEmpty = 0;
  const rules = new Map(); // domain → rule (last write wins if duplicate)

  for (const [name, entry] of Object.entries(defaultSites)) {
    totalEntries++;
    const out = translateEntry(name, entry);
    if (out.length === 0) {
      if (typeof entry.domain === "string" && entry.domain.startsWith("###_")) {
        skippedReference++;
      } else {
        skippedEmpty++;
      }
      continue;
    }
    for (const { domain, rule } of out) {
      if (flags.filter.length && !flags.filter.some((f) => domain.includes(f))) {
        continue;
      }
      rules.set(domain, rule);
      translated++;
    }
  }

  // Stable sort.
  const sortedKeys = [...rules.keys()].sort();

  console.log(`BPC entries processed: ${totalEntries}`);
  console.log(`  translated:     ${translated}  (${rules.size} unique domains)`);
  console.log(`  skipped (ref):  ${skippedReference}`);
  console.log(`  skipped (empty):${skippedEmpty}`);

  if (flags.dryRun) {
    console.log("\n(--dry-run: no file written)");
    return;
  }

  // Emit sites.generated.js
  const header = `// AUTO-GENERATED by scripts/import-bpc.mjs. DO NOT EDIT BY HAND.
// Source: ${BPC_URL}
// Run \`node scripts/import-bpc.mjs\` to refresh.
//
// Hand-curated DEFAULT_SITES (in sites.js) takes precedence — entries
// here are only applied for domains NOT already present there.

(function () {
  self.DEFAULT_SITES = self.DEFAULT_SITES || {};
  const generated = {
`;
  const body = sortedKeys
    .map((k) => `    ${JSON.stringify(k)}: ${stringifyRule(rules.get(k))}`)
    .join(",\n");
  const footer = `
  };
  for (const k of Object.keys(generated)) {
    if (!self.DEFAULT_SITES[k]) self.DEFAULT_SITES[k] = generated[k];
  }
})();
`;

  const full = header + body + footer;
  fs.writeFileSync(OUT_PATH, full);
  console.log(`\nwrote: ${OUT_PATH} (${(full.length / 1024).toFixed(1)} KB)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
