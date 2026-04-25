# Changelog

Loose semantic versioning, but the project is unpacked-only — there's
no Chrome Web Store release boundary. Each entry below corresponds to
a feature batch from development. Order is chronological (newest first).

## 0.18.0 — Companion (Tier 3, opt-in self-hosted FCrDNS bypass)

- **`companion/` directory** — self-hosted server-side bypass for
  the FCrDNS-stuck publishers (FT, Bloomberg premium, WSJ premium,
  Le Monde) the extension structurally can't reach client-side.
- **`docker-compose.yml`** wraps
  [everywall/ladder](https://github.com/everywall/ladder) +
  [FlareSolverr](https://github.com/FlareSolverr/FlareSolverr).
  Bound to `127.0.0.1:8080` by default. Users point the popup's
  existing "custom (Ladder)…" proxy field at it.
- **`fly.toml`** for one-click cloud deploy ($0–$2/month). Ladder
  only on the free shared-cpu-1x tier; FlareSolverr too heavy for
  the free RAM ceiling but most FCrDNS sites work without it.
- **`ladder-config/ruleset.yaml`** — starter rules for the four
  FCrDNS-class publishers with Googlebot UA, Google referer,
  FlareSolverr passthrough, and a Le Monde extension-detection
  mask injection.
- **No extension code changes.** The "custom (Ladder)…" proxy
  option has been there since 0.7.0; the companion is just a
  pre-configured Ladder instance to point that field at.
- **Architecture:** Tier 1 (DNR) + Tier 2 (DOM/MAIN-world) stays
  client-side and one-click installable. Tier 3 (companion) is
  per-user, self-hosted, opt-in. Documented in
  `docs/architecture.md`.

## 0.17.0 — Stability + persistence (Wired fade-then-hide fix)

- **Stability detector + 7-day persistence.** After the observer's
  10s ceiling, if content ended visible (>1500 chars in
  `<article>`/`<main>` with computed display !== "none"), the host
  is recorded in `chrome.storage.local.stableHosts` with timestamp
  + strategy. Future visits within 7 days use a 3s fast-path
  observer instead of 10s — saves CPU, avoids interfering with
  the page after our work is done.
- **Cache invalidation:** if a previously-stable host degrades
  (publisher tightened), end-of-window stability check fails and
  the cache entry gets dropped automatically.
- **Strategy mismatch invalidates fast-path:** cached entry's
  strategy must match current `siteOverrides[host].strategy` —
  manual strategy changes drop the cache.
- Tests: `verify-stability.mjs` (7 assertions covering first-
  visit marking, future-visit fast path, degradation handling,
  strategy-change invalidation).

## 0.16.0 — Fade-then-hide (Wired-style fight)

- **MutationObserver now watches attributes.** Filter:
  `["style", "class", "hidden"]` on the body subtree. Catches
  the "render then hide" pattern where a publisher's paywall
  script applies `display: none !important` on article body
  after we've revealed it.
- **Throttled to 80ms.** A reveal-vs-hide loop with a publisher's
  own MutationObserver could thrash 100s of times/second; the
  throttle caps strip() at 12 Hz.
- **Observer duration extended from 8s to 10s** (was previously
  30s in 0.16.0 dev, trimmed back).
- **`rescueLargestArticleBody`** — generic body-rescue heuristic.
  TreeWalker descends `<article>`/`<main>`, picks the deepest
  substantial-text element (>1500 chars), force-reveals it.
  Handles sites where per-site `cssRules.reveal` selectors don't
  match the actual body class (Wired uses CSS-in-JS hashes we
  can't pre-name).
- Tests: `verify-fadethenhide.mjs` (3 assertions including a
  publisher-style `setTimeout` hide + verifying our re-reveal
  wins the !important battle).

## 0.15.0 — Tier-1 features (5 in one batch)

- **Auto-update mechanism** — `chrome.alarms` fires weekly,
  fetches a JSON URL (configurable, empty by default), transpiles
  BPC-shape entries into our schema, stores under
  `remoteSitesGenerated`. `resolveSiteConfig` now cascades
  through user override → sites.js → sites.generated.js → remote
  rules → fallback. Manual refresh via popup "Refresh rules now"
  button. JSON-only (MV3 CSP forbids `new Function`); user runs
  `node scripts/import-bpc.mjs --json out.json` and hosts the
  result.
- **Diagnostic mode** — popup toggle stores
  `chrome.storage.local.diagnosticMode`. Content script (when on)
  uses `PerformanceObserver` to log paywall-shaped script URLs;
  snapshots paywall-classed elements + meter cookies + AMP href +
  SSR shape into `self.__ft13_diag`. "Generate report" reads via
  `chrome.scripting.executeScript` (default ISOLATED world),
  formats a paste-ready sites.js entry, opens in a new tab.
- **Statistics dashboard** — `chrome-extension://<id>/dashboard.html`.
  Five panels: overview tiles, hand-rolled SVG Sankey of strategy
  chain transitions, per-host failure-count table, proxy health
  table, rules cache status. Reads everything from
  `chrome.storage.local`. Light/dark themed.
- **Reader Mode v2** — extends `lib/reader-render.js` with
  toolbar: **MD** (HTML→Markdown converter, ~30 lines covering
  h1-4/p/em/strong/code/blockquote/ul/ol/li/a/img), **Listen**
  (Web Speech API TTS, start/stop), **A−/A+** (font-size 12-28
  stepped), **Aa** (serif/sans toggle), **◐** (light/sepia/dark
  cycle), **Pocket** (saves via getpocket.com/save), **✕**
  (close, also Esc). Settings persist in localStorage.
- **Local LLM article completer** — `llm.html` + `llm.js` open
  via popup button when `exhaustedHosts.includes(host)`. Loads
  WebLLM 0.2.79 from esm.run, downloads
  Phi-3-mini-4k-instruct-q4f16_1-MLC (~1.5 GB cached after
  first use), runs inference locally. Hedged 2-3 paragraph
  description prompt. Streams output. No API key.
- New `alarms` permission (already added in 0.9.0; reaffirmed).
- New extension page: `dashboard.html`, `dashboard.js`,
  `llm.html`, `llm.js`.
- Tests: `verify-tier1.mjs` (27 assertions covering all 5).
- Critical bugs caught by tests:
  - CSP blocks `new Function()` in SW → pivoted to JSON-only.
  - `window` vs `self` in content scripts (ISOLATED) vs MAIN
    world → use `self` + read with default-ISOLATED executeScript.
  - RegExp doesn't survive `chrome.storage.local` structured-
    clone → store regex source strings.

## 0.14.0 — Long-tail bypasses (5 techniques)

- **Mobile UA strategy** (`mobile`) — iPhone Safari UA, no
  Referer override. Some publishers serve simpler/less-paywalled
  mobile pages. Selectable from popup; not in auto-fallback chain.
- **Service-worker un-registration** — new `unregisterPageSW`
  function in `custom.js`. Per-site `customJs: "unregisterPageSW"`
  causes content script to call
  `navigator.serviceWorker.getRegistrations().then(r => r.unregister())`.
  Frees subsequent navigations from publisher-controlled SW
  paywall enforcement.
- **Cookie-consent injection** — new `consentInject: true`
  per-site field. Content script pre-populates 5 GDPR consent
  cookies (`euconsent-v2`, `OptanonConsent`,
  `OptanonAlertBoxClosed`, `didomi_token`, `cookieyes-consent`)
  on every page load. EU sites that gate behind a consent
  banner skip the banner entirely. Cookies set on path + host
  domain + eTLD+1.
- **Hybrid SSR rewrite** — new `lib/ssr-rewrite-main.js`
  registered alongside `lib/unpaywall-main.js` per enabled host.
  Runs at document_start in MAIN world. MutationObserver on
  `documentElement` catches `<script id="__NEXT_DATA__">` (and
  `__NUXT__`/`__REMIX_CONTEXT__`/`__APOLLO_STATE__`/
  `application/json`) when parsed in. Rewrites the JSON in
  place: 19 paywall-flag patterns. Framework hydrates from
  rewritten data and renders the article in its native template
  (no green "extracted from SSR state" panel — looks normal).
- **Print-URL redirect** — new `printRedirect: { match, replace }`
  per-site field. Compiled into a DNR `priority: 3` redirect
  rule. Works for publishers that maintain print-friendly URLs
  (NYT's `/print/<id>`, WSJ's `print.wsj.com`).
- Tests: `verify-longtail.mjs` (12 assertions).
- Critical bugs caught:
  - Match patterns dropped non-default ports — added explicit
    `:*/*` variants.
  - `MutationObserver` on `childList: true` only saw empty
    `<script>` elements, not text content — added
    `characterData: true` and re-scan-all-on-mutation.
  - SSR rewriter's length threshold skipped tiny test fixtures
    — dropped the threshold (no-op rewrites are safe).

## 0.13.0 — Wayback save-now + AMP cache + aggressive SSR

- **Wayback save-now fallback** — when proxy strategy lands on
  `web.archive.org/web/.../<url>` and Wayback shows no-capture
  UI (`#hrm`, "Hrm.", "we have no record"), content script
  redirects to `https://web.archive.org/save/<url>`. Wayback's
  backend fetches the article from THEIR whitelisted IPs, caches
  it, redirects to fresh snapshot. Sentinel via sessionStorage
  prevents redirect loops.
- **AMP cache redirect (Google's CDN)** — `ampRedirect: true`
  now navigates to `cdn.ampproject.org/c/s/<host>/<path>`
  (HTTPS) or `/c/<host>/<path>` (HTTP) instead of the
  publisher's own AMP URL. Google IS the bot — their cache
  serves cleaned AMP from their IPs.
- **Aggressive SSR walker** — score-based fallback when
  explicit-key search misses. Walks every leaf string, scores
  by `length × tag-density × paragraph-density × metadata-
  sibling-bonus`. Penalties for URLs, base64, JSON literals,
  sub-100-word strings. Threshold 5000. Header marks heuristic
  matches: `(.path (heuristic))`.
- Tests: `verify-improve.mjs` (9 assertions).

## 0.12.0 — Universal techniques: SSR + fetch interceptor + Reader

- **Universal fetch/XHR interceptor** — `lib/unpaywall-main.js`
  registered dynamically per enabled host via
  `chrome.scripting.registerContentScripts({ world:"MAIN",
  runAt:"document_start" })`. Monkey-patches `window.fetch` and
  `XMLHttpRequest.send`. JSON responses get scanned for 16
  paywall flag patterns and rewritten in flight.
- **Mozilla Readability fallback** — `lib/readability.js` (2,812
  lines, Apache 2.0, vendored from `mozilla/readability`).
  `lib/reader-render.js` wraps it with a clean overlay UI.
  Popup "Reader Mode" button injects + extracts. The universal
  "if the body is anywhere in the DOM, show it cleanly" answer.
- **AI-crawler UAs** — three new strategies in `STRATEGY_HEADERS`:
  `perplexitybot`, `claudebot`, `gptbot`, with official UA
  strings from each company's bot docs. None set Referer
  override. Selectable from popup `<optgroup>`. Distinct color
  badges.
- New `scripting` permission (already declared, reaffirmed).
- Tests: `verify-100bypass.mjs` (15 assertions).

## 0.11.0 — Polish (per-host referer, SSR prepend, health table)

- **Per-host variable Referer** — was constant `?q=news`, now
  `?q=<host>`. Removes the fingerprint of always-the-same Referer
  across publisher logs.
- **SSR panel prepended** — was `appendChild`, now `prepend`.
  Recovered body is the first thing the user sees.
- **Popup proxy health table** — collapsible `<details>` shows
  each builtin proxy's reachability + latency, color-coded
  OK/FAIL with `←` on the active proxy.
- Tests: `verify-polish.mjs` (9 assertions).

## 0.10.0 — Polish

- Per-host referer: `Referer: https://www.google.com/search?q=<host>`
  (or `bing.com/search?q=<host>` for bingbot strategy) instead of a
  constant `?q=news`. Removes the constant-string fingerprint across
  publisher logs.
- SSR-extraction panel now **prepends** to `<article>` instead of
  appending — recovered body is the first thing the user sees, no
  scrolling past the teaser.
- Popup gains a **Proxy health** `<details>` table showing
  reachability + latency for all 5 builtin proxies, with a `←`
  marker on the currently active one and color-coded OK/FAIL rows.
- Popup's existing **Check** button now also triggers a SW-side
  `probeProxies` round so the auto-failover health cache refreshes.
- Tests: `verify-polish.mjs` (9 assertions) covers all three.

## 0.9.0 — Hardening

- **Challenge-page skip.** Content script detects Cloudflare /
  PerimeterX / DataDome challenge surfaces (`#challenge-stage`,
  `cf-wrapper`, hostname patterns, "Just a moment" titles) and bails
  out of the strip pipeline entirely on those pages. The failure
  detector still runs so auto-fallback proceeds. Prevents reload
  loops where stripping interferes with challenge-resolution JS.
- **Stealth markers.** Replaced `data-13ft-revealed` and
  `data-13ft-ssr` DOM attributes with a `WeakSet` and an IIFE-scoped
  `ssrPanelInjected` flag. Zero `data-13ft-*` attributes leak into
  the DOM after stripping. Adversarial publisher anti-bypass JS
  scanning for those selectors finds nothing.
- **Proxy health checking + auto-failover.** New `alarms`
  permission. SW probes all 5 builtin proxies on
  install/startup and every 30 minutes. Probe is `fetch` with
  `mode:"no-cors"` and 6-second AbortController cutoff. `resolveProxy`
  routes around unreachable proxies automatically (picks the fastest
  reachable alternative by recorded latency).
- Tests: `verify-hardening.mjs` (11 assertions).

## 0.8.0 — Bingbot strategy + smarter referers

- New strategy `bingbot` with the official Bingbot UA and bing.com
  search referer. Sits between `googlebot` and `cookie-reset` in the
  fallback chain because Cloudflare's "Verified Bots" pipeline does
  FCrDNS for Googlebot but is laxer on Bingbot.
- Refactored UA + referer into a `STRATEGY_HEADERS` table indexed by
  strategy name.
- Strategy chain is now 4-step: `googlebot → bingbot → cookie-reset
  → proxy`.
- Popup strategy dropdown adds Bingbot option with teal badge color.
- Tests: `verify-bingbot.mjs` (10 assertions, end-to-end via local
  echo server).

## 0.7.0 — Failure detection + auto-fallback

- New `bypassFailed` message type. Content script runs a 3-second
  delayed detector that scans for anti-bot challenge DOM, error-page
  text patterns ("verify you are human", "security verification",
  "disable ad blocker", "Error 1015"), and posts to the SW.
- SW handler `handleBypassFailed` advances the strategy chain,
  persists the new strategy as a per-host override in
  `chrome.storage.local.siteOverrides`, sets the badge to **RTRY**
  (orange) or **FAIL** (red), and reloads the tab.
- Per-strategy failure counters in `chrome.storage.local.strategyFailures`
  for diagnostics.
- After exhausting the chain, the host is removed from `enabledHosts`
  and added to `exhaustedHosts`.
- Detector skips proxy hosts (web.archive.org, archive.ph, etc.) so
  Wayback's UI doesn't trigger false-positive escalation.
- Tests: `verify-fallback.mjs` (10 assertions).

## 0.6.0 — Universal techniques: SSR extraction + UNIVERSAL_CUSTOM_JS

- `__NEXT_DATA__` / `__NUXT__` / `__REMIX_CONTEXT__` /
  `__APOLLO_STATE__` / SvelteKit fetched-data extractor. Walks SSR
  JSON for `articleBody` / `bodyHtml` / `content` / `body` keys
  matching length+structure heuristics; renders the recovered body
  in a green-bordered panel. Universal — no per-site rules required.
  Immune to FCrDNS (we're reading bytes the server already sent).
- `UNIVERSAL_CUSTOM_JS` array in [custom.js](custom.js): functions
  to inject on every enabled site before any per-site customJs.
  Empty by default — ships with `_testMarker`, `nyt_defuseMeter`,
  and `piano_defuse` available but not auto-applied (MV3 timing
  doesn't reliably beat inline page scripts; production handling
  uses `blockRegex` instead).
- Tests: `verify-ssr-piano.mjs` (5 assertions).

## 0.5.0 — Tooling: BPC import + heuristic inspector

- `scripts/import-bpc.mjs` fetches BPC's `sites.js` from the csns1
  GitHub mirror, transpiles each entry into our schema, writes
  [sites.generated.js](sites.generated.js). 374 BPC entries → 602
  unique domains after group expansion. Hand-curated entries in
  [sites.js](sites.js) win per-domain.
- Field mappings: `useragent: "googlebot"` → `strategy: "googlebot"`,
  `block_regex` → `blockRegex`, `allow_cookies: 1` → `allowCookies:
  true`, `amp_unhide: 1` → `ampRedirect: true`,
  `remove_cookies_select_drop` → `dropCookies`, `block_selectors` /
  `exception_selectors` → `cssRules.hide` / `cssRules.reveal`.
- `scripts/inspect-site.mjs` drives clean Chromium against any URL,
  records JSON-LD selectors / network requests / cookies / rel=amphtml /
  fixed-position overlays, prints a paste-ready sites.js entry.

## 0.4.0 — BPC techniques: blockRegex + ampRedirect + dropCookies + customJs

- `blockRegex: [/regex/, ...]` per-site field. Compiled into DNR
  block rules at priority 2 (higher than header rules). The single
  highest-impact technique — kills paywall JS at the network layer
  before it can run. Rules sourced from BPC for top publishers
  (NYT's `meter-svc`, WaPo's `/tetro/evaluate`, Condé Nast's
  `journey.<domain>/build-*.js`, Hearst's `nexus.ensighten.com/hearst/mag/Bootstrap.js`,
  WSJ's cxense + AMP, Bloomberg's bwbx.io transporter, Forbes /
  Atlantic / Economist's Tinypass, Foreign Affairs' inline JS).
- `ampRedirect: true` content-script behavior — when `<link rel="amphtml">`
  is present and we're not already on AMP, navigate to the AMP href.
- `dropCookies: ["name", ...]` content-script behavior — expires
  named cookies across path/domain combinations on every load.
  Seeded for NYT (`nyt-gdpr`, `nyt-purr`, `nyt-a`), Atlantic
  (`articleViews`), Condé Nast group (`pay_ent_smp`).
- `customJs: "function-name"` — injects a named function from
  `CUSTOM_JS_FUNCTIONS` (in [custom.js](custom.js)) into the page's
  MAIN world via `chrome.scripting.executeScript({ world:"MAIN",
  injectImmediately: true })`. New `scripting` permission.
- Refactored `buildRule` → `buildRules` returning an array (one
  header/redirect rule + N block rules per host).
- Tests: `verify-block.mjs` (9 assertions), `verify-advanced.mjs`
  (10 assertions).

## 0.3.0 — Per-site rules: cssRules + JSON-LD unhide

- `cssRules: { hide: [...], reveal: [...] }` per-site schema.
  `hide` removes nodes; `reveal` forces nodes visible with
  `!important` overrides on display/visibility/opacity/filter/
  max-height/height/overflow/pointer-events.
- Reveal-first ordering: `cssRules.reveal` runs before generic
  overlay removal so nodes tagged for reveal aren't accidentally
  removed by behavioral overlay heuristics.
- JSON-LD `isAccessibleForFree:false` unhide. Walks
  `<script type="application/ld+json">` recursively, extracts
  `cssSelector` from any `hasPart` flagged as paywalled, forces
  those nodes visible. Universal — works on any spec-compliant
  publisher without per-site config.
- `normalizeClassToken` helper borrowed from
  [easydiv](../easydiv/detector.js) — strips trailing hex hashes
  (`paywallfragment-a8b3f9e` → `paywallfragment`) so overlay
  detection works on CSS-in-JS sites with rebuild-randomized class
  names.
- Tests: `verify-content.mjs` (7 assertions).

## 0.2.0 — Multi-proxy + custom Ladder + popup overhaul

- 4 builtin proxies in `BUILTIN_PROXIES`: `archive.ph`,
  `web.archive.org`, `freedium.cfd`, `freedium-mirror.cfd`,
  `readmedium.com`. Default switched from `archive.ph` to
  `web.archive.org` based on April 2026 reachability research
  (archive.today is Cloudflare 1.1.1.2-flagged, FBI-subpoenaed,
  Russia-blocked).
- Custom (Ladder) proxy option — popup accepts a self-hosted
  reverse-proxy URL with the same prefix shape.
- Round-trip path detection — `proxyOriginalUrl` parses the proxy's
  URL back to the original target host so toggle-off navigates
  back to the publisher's URL instead of staying on the proxy.
- `BLOCKED_HOSTS` — Reddit, Twitter, X, Facebook, Instagram,
  YouTube, Google, GitHub, Stack Overflow, localhost. Toggle ON
  refuses on these (Googlebot UA from a non-Google IP triggers
  Reddit's "whoa there, pardner" 403). On startup, purges any of
  these that snuck into `enabledHosts` from prior installs.
- Popup: site display + strategy selector + proxy selector +
  custom URL input + Check button + blocked-host UI.

## 0.1.0 — Initial MVP

- MV3 manifest with declarativeNetRequest + storage + tabs
  permissions.
- Single-strategy implementation: Googlebot UA + Google referer +
  Cookie strip via `chrome.declarativeNetRequest.updateSessionRules`
  with `modifyHeaders` action.
- Medium → archive.ph proxy redirect via `regexFilter` +
  `regexSubstitution`.
- Service-worker rule install on `enabledHosts` change. Session
  rules (not dynamic) — re-synced on `onStartup` / `onInstalled`.
- Content script (`document_end`, `<all_urls>`) with generic
  paywall-overlay heuristics: fixed/absolute-positioned elements
  with paywall/regwall/modal-subscribe in id/class get removed;
  blur/truncate classes get unblurred. MutationObserver scoped
  to `document.body` (with documentElement fallback) for 8 seconds
  to catch late-injected overlays.
- Popup with toggle button and basic strategy selector.
