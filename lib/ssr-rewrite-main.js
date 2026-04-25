// 13ft — hybrid SSR rewrite (runs at document_start, MAIN world).
//
// Companion to lib/unpaywall-main.js. Rewrites paywall flags inside
// SSR JSON tags (__NEXT_DATA__, __NUXT__, __REMIX_CONTEXT__,
// __APOLLO_STATE__, application/json blocks) BEFORE the page's
// React/Vue/Svelte hydration runs. The framework boots from the
// rewritten data and renders the article natively in its own
// template — no "13ft extracted panel," just looks like a normal
// article that was never paywalled.
//
// Falls back gracefully if no recognizable SSR shape is found; the
// existing document_end SSR extractor in content.js still injects
// the panel as a last-resort visible-content path.

(function () {
  if (window.__ft13_ssrRewritten) return;
  window.__ft13_ssrRewritten = true;

  // Same flag flips as lib/unpaywall-main.js — keeping these
  // independent so each can be enabled separately.
  const REWRITES = [
    [/"isAccessibleForFree"\s*:\s*false/g,           '"isAccessibleForFree":true'],
    [/"isAccessibleForFree"\s*:\s*"[Ff]alse"/g,      '"isAccessibleForFree":"True"'],
    [/"accessLevel"\s*:\s*"paid"/g,                  '"accessLevel":"free"'],
    [/"accessLevel"\s*:\s*"premium"/g,               '"accessLevel":"free"'],
    [/"accessLevel"\s*:\s*"locked"/g,                '"accessLevel":"unlocked"'],
    [/"hasPaidAccess"\s*:\s*false/g,                 '"hasPaidAccess":true'],
    [/"isPaywalled"\s*:\s*true/g,                    '"isPaywalled":false'],
    [/"isPaywall"\s*:\s*true/g,                      '"isPaywall":false'],
    [/"requireSubscription"\s*:\s*true/g,            '"requireSubscription":false'],
    [/"meterStatus"\s*:\s*"locked"/g,                '"meterStatus":"unlocked"'],
    [/"contentLockType"\s*:\s*"paywall"/g,           '"contentLockType":"none"'],
    [/"isPremium"\s*:\s*true/g,                      '"isPremium":false'],
    [/"is_premium"\s*:\s*true/g,                     '"is_premium":false'],
    [/"subscriberOnly"\s*:\s*true/g,                 '"subscriberOnly":false'],
    [/"subscribers_only"\s*:\s*true/g,               '"subscribers_only":false'],
    [/"members_only"\s*:\s*true/g,                   '"members_only":false'],
    [/"hasContentAccess"\s*:\s*false/g,              '"hasContentAccess":true'],
    [/"showPaywall"\s*:\s*true/g,                    '"showPaywall":false'],
    [/"paywallStatus"\s*:\s*"locked"/g,              '"paywallStatus":"unlocked"']
  ];

  function rewrite(text) {
    let out = text;
    let changed = false;
    for (const [re, repl] of REWRITES) {
      const next = out.replace(re, repl);
      if (next !== out) { changed = true; out = next; }
    }
    return changed ? out : null;
  }

  // We need to act BEFORE React/Vue/Svelte read the SSR script tag.
  // At document_start there's no <body>, but <head> may already have
  // begun parsing. The SSR <script> usually sits in <body> or at the
  // bottom of <head>. We use a MutationObserver on documentElement
  // to catch each SSR tag the moment it's appended; we rewrite its
  // textContent before the framework's bootstrap runs (which it
  // can't do until at least DOMContentLoaded — well after we mutate).
  const SELECTORS = [
    'script#__NEXT_DATA__',
    'script#__NUXT__',
    'script#__REMIX_CONTEXT__',
    'script#__APOLLO_STATE__',
    'script[type="application/json"]'
  ];

  function tryRewrite(el) {
    if (!(el instanceof HTMLElement) || el.tagName !== "SCRIPT") return false;
    if (el.dataset && el.dataset.ft13Rewritten) return false;
    // Only touch JSON-typed or known-id scripts.
    const type = (el.getAttribute("type") || "").toLowerCase();
    const id = el.id || "";
    const knownId = /^__(NEXT_DATA|NUXT|REMIX_CONTEXT|APOLLO_STATE)__$/.test(id);
    if (!knownId && !/json/.test(type)) return false;

    const original = el.textContent || "";
    if (!original) return false;
    // No min-length threshold — non-matching rewrites are no-ops, and
    // small SSR scripts (test fixtures, lightweight configs) might
    // still contain paywall flags worth flipping.
    const out = rewrite(original);
    if (!out) return false;
    el.textContent = out;
    if (el.dataset) el.dataset.ft13Rewritten = "1";
    return true;
  }

  // Sweep anything already present (rare at doc_start).
  for (const sel of SELECTORS) {
    document.querySelectorAll(sel).forEach(tryRewrite);
  }

  // Watch for newly-appended SSR scripts. Re-scanning all known
  // selectors on every mutation batch is the simplest way to handle
  // the parser's piecemeal insertion order: the script element is
  // appended empty, then its Text content is appended in a separate
  // mutation. Walking child Text-node additions back to their parent
  // script element is fiddly; rescanning everything is cheaper and
  // idempotent (tryRewrite no-ops on already-rewritten elements via
  // the dataset.ft13Rewritten flag).
  function rescanAll() {
    for (const sel of SELECTORS) {
      try { document.querySelectorAll(sel).forEach(tryRewrite); }
      catch {}
    }
  }
  const obs = new MutationObserver(rescanAll);
  obs.observe(document.documentElement, {
    childList: true, subtree: true, characterData: true
  });

  // Stop observing after DOMContentLoaded — React/Vue/Svelte boot
  // around then, and any later SSR injection won't be hydration data.
  document.addEventListener("DOMContentLoaded", () => {
    setTimeout(() => obs.disconnect(), 100);
  }, { once: true });
})();
