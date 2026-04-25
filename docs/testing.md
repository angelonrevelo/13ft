# Testing

17 test suites, ~234 assertions. Two layers:

- **Unit tests** (vm-based) — load the real source files into a
  Node `vm` context with a mocked `chrome.*` surface. Fast (<1s).
  Verify pure-JS logic without spinning up a browser.
- **End-to-end tests** (Playwright + bundled Chromium) — load the
  unpacked extension into a real browser, exercise the actual
  service worker, content scripts, and DNR rules. Slow (~5s
  startup per suite). Verify behavior at the boundary where the
  unit tests can't reach (real DOM, real network requests, real
  DNR enforcement).

Tests live in `/tmp/13ft-pw/` and `/tmp/13ft-test-phase1.mjs` — outside
the project tree so the extension itself stays small and clean.

## Running everything

```sh
# Fast unit suite:
node /tmp/13ft-test-phase1.mjs

# Full e2e:
cd /tmp/13ft-pw && for f in drive content block advanced inspector \
  ssr-piano fallback bingbot hardening polish; do
  echo "=== verify-$f ==="; node verify-$f.mjs 2>&1 | tail -2;
done
```

A clean run produces:
```
PASS 55/55      # vm — pure-JS logic (BLOCKED_HOSTS, resolveSiteConfig,
                #   buildRules, toggleHost, proxy round-trip, etc.)
PASS 17/17      # drive — popup + DNR install + purge
PASS 7/7        # content — JSON-LD + cssRules + normalizeClassToken
PASS 9/9        # block — DNR block rules fire on the wire
PASS 11/11      # advanced — ampRedirect (AMP cache) + dropCookies + customJs
PASS 7/7        # inspector — scripts/inspect-site.mjs output
PASS 5/5        # ssr-piano — __NEXT_DATA__ + UNIVERSAL_CUSTOM_JS
PASS 10/10      # fallback — failure detector + 4-step chain advance
PASS 10/10      # bingbot — UA + per-host referer on the wire
PASS 11/11      # hardening — challenge-skip + stealth + proxy failover
PASS 9/9        # polish — per-host referer + SSR prepend + health table
PASS 9/9        # improve — Wayback save-now + AMP cache + aggressive SSR
PASS 15/15      # 100bypass — AI bots + fetch interceptor + Reader Mode
PASS 12/12      # longtail — mobile UA + SW unreg + consent + SSR rewrite + print
PASS 27/27      # tier1 — auto-update + diag + dashboard + Reader v2 + LLM
PASS 3/3        # fadethenhide — reveal-vs-hide tug-of-war
PASS 7/7        # stability — first-visit marking + persistence + invalidation
```

## Suite map

### Unit: `/tmp/13ft-test-phase1.mjs` (55 assertions)

Loads `sites.js` + `custom.js` + `background.js` (with
`importScripts` stripped) into a `vm.createContext` sandbox. Mocks
`chrome.storage.local` with an in-memory Map; `chrome.tabs`,
`chrome.alarms`, `chrome.declarativeNetRequest` as no-ops with
recorders.

Exercises:
- `BLOCKED_HOSTS` membership for exact + subdomain + tricky
  suffix patterns + null/empty.
- `resolveSiteConfig` for known + unknown + override hosts.
- `resolveProxy` returns the right shape with default + custom +
  unreachable health.
- `buildRules` produces correct DNR rule structure for googlebot,
  bingbot, cookie-reset, proxy strategies.
- `buildBlockRules` emits one block rule per blockRegex pattern
  with priority 2.
- `toggleHost` refuses blocked hosts WITHOUT mutating storage.
- `proxyOriginalUrl` round-trips through every builtin proxy and
  freedium-mirror.
- `canonicalConfiguredHost` folds subdomains for DEFAULT_SITES
  AND BLOCKED_HOSTS AND siteOverrides.
- Universal-only mode: with `DEFAULT_SITES` cleared entirely,
  unknown hosts still resolve to googlebot fallback.
- Per-strategy headers: googlebot vs bingbot UA + referer, both
  distinct, both correctly shaped.

The test exposes internals via a bridge that runs INSIDE the vm
context (because top-level `const` in classic scripts isn't on
globalThis):

```js
const bridge = `
  self._testExports = {
    BLOCKED_HOSTS, DEFAULT_SITES, BUILTIN_PROXIES, DEFAULT_PROXY,
    isBlockedHost, resolveSiteConfig, buildRules, resolveProxy,
    toggleHost, proxyOriginalUrl, canonicalConfiguredHost
  };
`;
```

### E2E: `drive.mjs` (17 assertions)

Baseline real-Chrome smoke test. Loads the extension into bundled
Chromium (system Chrome refuses unpacked without Developer Mode
flipped, and toggling it post-launch doesn't trigger rescan).

Verifies:
- Service worker registers + initializes 603 sites.
- Reddit-as-active-tab → SW classification returns `blocked: true`.
- Stubbed-state popup renders blocked badge + disabled toggle.
- NYT enable installs DNR session rule with Googlebot UA.
- Medium enable installs redirect rule pointing at web.archive.org.
- `purgeAndSync` removes blocked hosts left in `enabledHosts` from
  prior installs, preserves non-blocked hosts.

### E2E: `verify-content.mjs` (7 assertions)

Synthetic paywalled HTML fixtures served from a local HTTP server.
Verifies:
- JSON-LD `isAccessibleForFree:false` + `hasPart.cssSelector`
  reveals hidden content with `display: block !important`.
- Generic overlay heuristic removes a fixed-position element
  matching paywall name pattern.
- CSS-in-JS hashed class (`paywallfragment-abc123`) survives
  `normalizeClassToken` normalization and gets removed.
- `cssRules.reveal` runs before overlay removal so revealed
  elements survive.

### E2E: `verify-block.mjs` (9 assertions)

Local fixture serves `/paywall.js` and `/analytics.js`. Direct DNR
block-rule installation via `sw.evaluate`, then navigate.

Verifies:
- `urlFilter: "*paywall.js"` blocks the request with
  `net::ERR_BLOCKED_BY_CLIENT`. The window's `__PAYWALL_LOADED__`
  flag stays false; document.body is unchanged.
- `analytics.js` (no matching rule) loads normally.
- Production-shape `regexFilter` (mimicking Condé Nast pattern)
  installs without DNR validation errors.
- Enabling `bonappetit.com` produces ≥2 block rules (journey +
  AMP) end-to-end through `syncRules`.
- Enabling `nytimes.com` produces a block rule matching
  `meter-svc.nytimes.com/meter.js`.

### E2E: `verify-advanced.mjs` (10 assertions)

Three feature paths, all real-browser end-to-end:
- **customJs**: SW injects a named function from
  `CUSTOM_JS_FUNCTIONS` into the page's MAIN world via
  `chrome.scripting.executeScript`. Verified by checking
  `window.__ft13_testMarkerRan` after navigation.
- **AMP redirect**: page with `<link rel="amphtml" href="/amp">`,
  ampRedirect:true → tab navigates to /amp.
- **dropCookies**: server sets cookies via `Set-Cookie`, content
  script expires named ones; `ctx.cookies()` confirms removal.
- Plus: sites.js seeded entries for bonappetit (dropCookies),
  wsj (ampRedirect), nyt (customJs) all present at runtime.

### E2E: `verify-inspector.mjs` (7 assertions)

Spins up a fixture page with all five inspectable signals
(JSON-LD selector, paywall script, cookies, rel=amphtml,
fixed-position overlay). Spawns `scripts/inspect-site.mjs` as a
subprocess. Asserts the proposed sites.js entry contains:
- correct host as the entry key
- ampRedirect:true with the comment showing the amphtml URL
- a blockRegex line covering the paywall-bundle JS
- a #paywall-overlay hide candidate
- dropCookies entries for paywall_counter and meter_visits
- a JSON-LD-derived `.paid-body` reveal entry
- exits cleanly with code 0

### E2E: `verify-ssr-piano.mjs` (5 assertions)

`__NEXT_DATA__` extraction:
- Synthetic Next.js-shaped page with paid body in
  `props.pageProps.article.articleBody`.
- Content script's `revealFromSsrState` finds it, prepends a panel
  to `<article>` with the recovered body.
- Header shows the JSON path: `13ft — extracted from SSR state
  (.props.pageProps.article.articleBody)`.
- Idempotent under MutationObserver re-entry (single panel after
  forced re-strip).

`UNIVERSAL_CUSTOM_JS` mechanism:
- Patch in a test-only `_testMarker` function and add to the
  universal list at runtime.
- Verify `window.__ft13_universalRan` is true after navigation
  (mechanism works; whether it beats inline scripts isn't a
  guarantee — see hardening.md notes).

### E2E: `verify-fallback.mjs` (10 assertions)

Manual `handleBypassFailed` calls that walk the chain:
- googlebot → bingbot → cookie-reset → proxy → exhausted
- Verify storage `siteOverrides[host].strategy` updates each step.
- Verify `enabledHosts` removed and `exhaustedHosts` populated
  after exhaustion.
- Verify `strategyFailures` counter for each strategy increments
  by 1.

Plus an end-to-end path:
- Synthetic Cloudflare-challenge fixture (text "Just a moment...",
  `#challenge-stage` div).
- Navigate, wait 5s.
- Confirm `siteOverrides[host].strategy` advanced to `bingbot`.
  (Detector fired AND SW handler advanced AND storage persists.)

### E2E: `verify-bingbot.mjs` (10 assertions)

Local echo server returns request headers as JSON. For each of
googlebot, bingbot, cookie-reset:
- Outgoing UA matches the strategy's expected pattern.
- Outgoing Referer matches expected URL prefix.
- Cookie always stripped (the seeded session cookie doesn't echo).
- googlebot vs bingbot UAs are distinct strings.
- cookie-reset keeps real Chrome UA (NOT Googlebot/Bingbot).

This is the only suite that depends on a real network round-trip
to verify the DNR rule fires on the wire (the rule rewrites
headers AFTER Playwright's CDP hooks observe them, so the only
way to see post-rewrite headers is via the server's perspective).

### E2E: `verify-hardening.mjs` (11 assertions)

Three hardening axes:
- **challenge-skip**: synthetic Cloudflare-style challenge page
  has a paywall-classed element. With 13ft on,
  `#paywall-overlay` is NOT removed (we bailed). The strategy
  still advanced (detector still fired).
- **stealth**: scan all elements for `data-13ft-*` attributes
  → returns 0. Verify generic overlay strip + JSON-LD reveal
  still work.
- **proxy failover**: seed mixed-reachability health data. Set
  user proxy = archive.ph (marked unreachable). `resolveProxy`
  returns web.archive.org as fastest reachable alternative,
  with `failedOver: "archive.ph"` field set. When archive.ph
  is healthy again, no failover. Manual `probeAllProxies` writes
  every builtin's status. Alarm registered.

### E2E: `verify-improve.mjs` (9 assertions)

Wayback save-now fallback, AMP cache redirect, aggressive SSR walker:
- Synthetic AMP-source page with `<link rel="amphtml">` → 13ft
  redirects to Google's AMP cache (`cdn.ampproject.org/c/...`),
  intercepted via `page.route` to verify the cache URL shape.
- Synthetic SSR-shaped page where the article body lives at
  `data.weirdNamespace.contentBlob` (no standard key match) →
  aggressive walker scores it via length + tag-density +
  paragraph-density + metadata-sibling bonus, recovers the body.
- Synthetic Wayback no-capture page with `#hrm` marker →
  content script redirects to `web.archive.org/save/<url>`.
  Sentinel via sessionStorage prevents redirect loops; only
  triggers if original URL host is in enabledHosts.

### E2E: `verify-100bypass.mjs` (15 assertions)

Three universal techniques:
- **AI-crawler UAs:** echoes from local server confirm
  PerplexityBot, ClaudeBot, GPTBot all appear on the wire when
  selected.
- **Fetch interceptor:** synthetic page calls `/api/article`,
  server returns `{accessLevel: "paid"}`, page-side fetch sees
  `"free"` after our `lib/unpaywall-main.js` rewrites it. Body
  renders.
- **Reader Mode:** synthetic article fixture, executeScript
  injects readability.js + reader-render.js → reader overlay
  contains the h1, all paragraphs, excludes nav and footer.

### E2E: `verify-longtail.mjs` (12 assertions)

Five long-tail techniques:
- **Mobile UA:** echo confirms iPhone Safari UA, not Googlebot.
- **SW un-registration:** customJs `unregisterPageSW` runs;
  window flag confirms invocation.
- **Cookie-consent injection:** all 5 GDPR consent cookies
  (euconsent-v2, OptanonConsent, didomi_token, etc.) end up in
  the cookie jar.
- **Hybrid SSR rewrite:** page's hydration script reads
  `__NEXT_DATA__` AFTER `lib/ssr-rewrite-main.js` mutated it →
  sees `accessLevel:"free"`, renders body.
- **Print URL redirect:** `/articles/12345` redirects via DNR
  to `/print/12345`.

### E2E: `verify-tier1.mjs` (27 assertions)

Five Tier-1 features:
- **Auto-update:** mock JSON URL → SW fetches + transpiles BPC
  shape → stored in `remoteSitesGenerated` →
  `resolveSiteConfig` finds new entries → weekly alarm registered.
- **Diagnostic mode:** observer collects paywall-classed
  elements + meter cookies → `getDiagnosticReport` returns a
  paste-ready sites.js entry. Reads via default-ISOLATED
  executeScript (content script's `self.__ft13_diag`).
- **Statistics dashboard:** seeded host data renders 3 host
  rows + 3 proxy rows + 5 Sankey nodes; ft.com row shows
  EXHAUSTED.
- **Reader Mode v2:** all 7 toolbar buttons present (MD, Listen,
  A−, A+, Aa, ◐, Pocket, ✕).
- **LLM completer:** opens with `?url=` and `?teaser=` query
  params; URL + teaser render correctly; Generate button
  initially disabled (until model loads).

### E2E: `verify-fadethenhide.mjs` (3 assertions)

Reproduces the Wired-style "render then hide" pattern. Synthetic
page calls `setTimeout` twice (1.2s and 2.7s) to set
`display: none !important` on the article body. Verifies:
- Baseline (no 13ft): body hidden after timer fires.
- With 13ft: body computed `display: block` after 4 seconds,
  inline style is `block !important`. Our reveal-vs-hide
  observer wins.

### E2E: `verify-stability.mjs` (7 assertions)

Stability detector + persistence:
- First visit (stable page, 11s wait) → host recorded in
  `chrome.storage.local.stableHosts` with strategy + timestamp.
- Second visit (4s wait) → article still visible, cache
  preserved.
- Visit to a degraded variant (body hides at 800ms) → cache
  cleared after observer ceiling.
- Strategy change (cached: googlebot, current: bingbot) →
  re-marked under new strategy.

### E2E: `verify-polish.mjs` (9 assertions)

- per-host referer: googlebot referer is
  `https://www.google.com/search?q=127.0.0.1`; bingbot referer
  is `https://www.bing.com/search?q=127.0.0.1`. NOT the old
  constant `?q=news`.
- SSR panel prepended: `<article>.firstElementChild` is the
  panel; original teaser still present.
- popup health table: 5 rows for 5 builtin proxies; current
  proxy marked with `←`; reachable rows show OK + latency;
  unreachable show FAIL + "unreachable".

## Adding a test

Pick the right suite:
- New strategy / chain change → add to `verify-fallback.mjs` or
  `verify-bingbot.mjs`.
- New schema field → add to `verify-content.mjs` or
  `verify-advanced.mjs`.
- New proxy / network behavior → `verify-block.mjs` or
  `verify-bingbot.mjs`.
- Pure-logic change → add to `/tmp/13ft-test-phase1.mjs`.

Common patterns:
```js
// Wait for SW to register:
async function waitSw() {
  for (let i = 0; i < 100; i++) {
    const sw = ctx.serviceWorkers().find((s) => s.url().includes("/background.js"));
    if (sw) return sw;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("no SW");
}
const sw = await waitSw();
// IMPORTANT: settle delay so onInstalled's purgeAndSync doesn't
// race the test's manual syncRules — duplicate-id error otherwise.
await new Promise((r) => setTimeout(r, 500));
```

```js
// Inject a stubbed getState response (tests that the popup
// renders correctly without depending on the actual active tab):
await popup.addInitScript(() => {
  chrome.runtime.sendMessage = (msg, cb) => {
    const r = msg?.type === "getState" ? STUB_STATE : { ok: true };
    if (cb) cb(r);
    return Promise.resolve(r);
  };
});
```

```js
// Probe the wire by running a local HTTP server that echoes
// request headers. Saves DNS round-trips and avoids flaky
// external dependencies.
import http from "node:http";
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ headers: req.headers }));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
```

## Real Chrome vs bundled Chromium

System Chrome on macOS won't load extensions via `--load-extension`
unless Developer Mode is toggled on `chrome://extensions`. Toggling
it programmatically post-launch doesn't trigger a rescan; only a
fresh Chrome launch with Dev Mode already on will pick up the
extension.

We use bundled Chromium instead (Playwright's `chromium.launchPersistentContext`
without `channel: "chrome"`). It runs in test mode and ignores the
Dev Mode gate.

Real-world install (the user's path) needs Dev Mode flipped — see
[README install steps](../README.md#install).

## Debug tips

- Check the SW's console: `chrome://extensions` → 13ft card →
  "service worker" link.
- Check the content script's console: open DevTools on the page
  itself; the content script logs to that page's console (in the
  isolated world's context).
- Check the popup's console: right-click the toolbar icon →
  "Inspect popup" while popup is open.
- Inspect chrome.storage.local: in the SW console, run
  `chrome.storage.local.get(null).then(console.log)`.
- Inspect installed DNR rules: SW console
  `chrome.declarativeNetRequest.getSessionRules().then(console.log)`.
