# Hardening

Defenses we built after live testing exposed real failure modes
(Le Monde "Oops, something went wrong", FT Cloudflare CAPTCHA
escalation, freedium.cfd DNS unreachability, Wired's "render then
hide" pattern).

## Failure detection + auto-fallback chain

The single most impactful hardening. Without it, a single bad
strategy choice makes the user's experience permanently worse than
not having the extension installed.

### How it fires

[content.js](../content.js) runs a 3-second-delayed detector after
every page load. The detector looks for DEFINITIVE markers — false
positives trigger an unwanted reload, so we keep the bar high.

**DOM-based markers:**
```
#challenge-stage
#challenge-form
.cf-wrapper
[class*='cf-error']
iframe[src*='challenges.cloudflare']
iframe[src*='ct.captcha-delivery.com']
#cf-challenge-running
#main-iframe[src*='captcha']
```

**Title + first-4KB-of-text patterns:**
```
/security verification/
/just a moment/
/verify (you are|that you are) (a )?human/
/please verify you are human/
/access (denied|blocked)/
/unusual traffic from your computer/
/enable javascript and cookies to continue/
/please disable (your )?ad ?blocker/
/something went wrong.+disable.+(extension|ad ?blocker|browser)/
/error 1015\b/   /error 1020\b/   /error 1010\b/   /ray id:/
```

When ANY marker matches, the content script posts:
```js
chrome.runtime.sendMessage({
  type: "bypassFailed",
  host: location.hostname.replace(/^www\./, ""),
  url: location.href,
  reason: "challenge-dom" | "anti-bot-text"
});
```

### How the SW handles it

`handleBypassFailed` in [background.js](../background.js):

1. Look up the current strategy for this host (resolved from
   `siteOverrides` / `DEFAULT_SITES`, default `"googlebot"`).
2. Find its position in `STRATEGY_CHAIN = ["googlebot", "bingbot",
   "cookie-reset", "proxy"]`.
3. If there's a next entry: persist it as
   `siteOverrides[host].strategy`, increment failure counter,
   `syncRules`, set badge to **RTRY** (orange), reload the tab.
4. If we're already at the end: remove host from `enabledHosts`,
   add to `exhaustedHosts`, set badge to **FAIL** (red).

After advancing, the next page load uses the new strategy. If
THAT also fails, the cycle repeats — bounded by chain length, no
infinite loop possible.

### Detector skip-list

The detector skips when running on a known proxy host:

```js
function isProxyPage() {
  return /^(web\.archive\.org|archive\.ph|archive\.today|
    freedium(-mirror)?\.cfd|readmedium\.com)$/i.test(location.hostname);
}
```

This prevents Wayback's "snapshot not available" UI from triggering
auto-advance away from a working proxy strategy.

### Per-strategy failure counters

Recorded in `chrome.storage.local.strategyFailures` for diagnostics:

```json
{
  "ft.com": { "googlebot": 5, "bingbot": 4, "cookie-reset": 2 }
}
```

Tells you which strategies are reliably failing on which hosts.
Useful for tuning the rule database (e.g., promote `proxy` to be
the default strategy on FCrDNS-known sites).

## Challenge-page skip

Even with auto-fallback, content script DOM modifications on a
challenge page can interfere with the challenge's own integrity
checks (Cloudflare validates DOM stability before granting a
clearance cookie). So we don't TOUCH challenge pages at all.

`looksLikeChallengePage()` in [content.js](../content.js) checks:

1. **Hostname match:**
   ```
   challenges.cloudflare.com
   client.perimeterx.net
   *.captcha-delivery.com    (DataDome)
   *.datadome.co
   ```
2. **Title patterns:** "just a moment", "security verification",
   "security check", "access denied".
3. **DOM markers:** any of the same elements the failure detector
   uses.

When detected: every part of the strip pipeline is skipped (AMP
redirect, dropCookies, strip(), MutationObserver setup). The
failure detector still runs at the bottom of the IIFE so
auto-fallback can do its thing.

## Stealth: zero DOM fingerprint

Adversarial publishers running anti-bypass JS can scan the DOM
for our signature. Until 0.9.0 we tagged revealed elements with
`data-13ft-revealed` and the SSR panel with `data-13ft-ssr` —
trivial fingerprints.

**0.9.0 changes:**
- Replaced `data-13ft-revealed` with a `WeakSet`:
  ```js
  const revealedSet = new WeakSet();
  function markRevealed(el) {
    if (el instanceof HTMLElement) revealedSet.add(el);
  }
  function isMarkedRevealed(el) {
    return el instanceof HTMLElement && revealedSet.has(el);
  }
  ```
  The set is GC'd with the elements. No DOM observable.

- Replaced `data-13ft-ssr` with an IIFE-scoped boolean:
  ```js
  let ssrPanelInjected = false;
  function revealFromSsrState() {
    if (ssrPanelInjected) return false;
    // ... do work
    ssrPanelInjected = true;
  }
  ```
  Lives in script-scope, survives MutationObserver re-entry,
  invisible to the page.

**Verified by `verify-hardening.mjs`:**
```js
const fingerprintCount = await page.evaluate(() =>
  [...document.querySelectorAll("*")].reduce(
    (n, el) => n + [...el.attributes]
      .filter((a) => /^data-13ft/i.test(a.name)).length,
    0
  )
);
// Expects: 0
```

The visible "13ft — extracted from SSR state" header text on the
SSR panel is intentional user-facing branding. A publisher could
match on the literal "13ft" string in textContent, but text-content
scanning is much slower and more error-prone than attribute
selectors. Trade-off accepted for now; we can randomize the panel
header if needed.

## BLOCKED_HOSTS — preventing self-breakage

Sites where the bypass mechanism actively makes things worse.
Defined in [sites.js](../sites.js):

```js
self.BLOCKED_HOSTS = [
  "reddit.com",
  "twitter.com",
  "x.com",
  "facebook.com",
  "instagram.com",
  "youtube.com",
  "google.com",
  "github.com",
  "stackoverflow.com",
  "localhost"
];
```

**Why each:**
- `reddit.com` — actively detects Googlebot UA from non-Google IP,
  serves a "whoa there, pardner" 403. Vanilla works fine; our UA
  spoof makes it worse.
- `twitter.com` / `x.com` / `facebook.com` / `instagram.com` —
  social platforms with sophisticated bot detection. Same outcome.
- `youtube.com`, `google.com` — Google properties; FCrDNS would
  trivially detect impersonation.
- `github.com`, `stackoverflow.com` — not paywalled. Toggle is a
  user error; we refuse.
- `localhost` — no path to "paywall" on a local dev server.

`isBlockedHost(host)` checks via `domainMatch` for subdomain
inclusion, so `old.reddit.com` and `www.reddit.com` both match.

**Enforcement points:**
1. `toggleHost` returns `{ ok: false, reason: "blocked-host" }`
   without touching storage.
2. `getState` includes `blocked: true` so the popup can render
   the disabled state with explanation.
3. `purgeAndSync` on startup removes any blocked host that snuck
   into `enabledHosts` from a prior install.
4. `canonicalConfiguredHost` folds blocked-host subdomains so the
   popup shows the canonical name.

## Proxy health checking + auto-failover

Discovered by users: freedium.cfd was unreachable from many networks
(Cloudflare's 1.1.1.2 family-filter resolver flagged the .cfd TLD).
A user setting freedium as default proxy got `ERR_NAME_NOT_RESOLVED`
on every Medium link.

### How it works

**Probe function:**
```js
async function probeProxy(url) {
  const start = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 6000);
  try {
    await fetch(url, {
      method: "GET", mode: "no-cors", cache: "no-store",
      redirect: "follow", signal: ac.signal
    });
    return { reachable: true, latencyMs: Date.now() - start,
             lastChecked: Date.now() };
  } catch {
    return { reachable: false, latencyMs: null,
             lastChecked: Date.now() };
  } finally { clearTimeout(timer); }
}
```

`mode: "no-cors"` lets us probe any origin. We can't read the
response, but a TypeError from `fetch` (DNS failure, abort) is
itself the signal.

**Periodic alarm:**
```js
chrome.alarms.create("13ft-proxy-health", { periodInMinutes: 30 });
```

Set up by `ensureProxyHealthAlarm()` on `onStartup` and
`onInstalled`. The alarm handler calls `probeAllProxies()`.

**Storage shape:**
```json
{
  "archive.ph":          { "reachable": true,  "latencyMs": 120, "lastChecked": 1714014000000 },
  "web.archive.org":     { "reachable": true,  "latencyMs": 250, "lastChecked": 1714014000000 },
  "freedium.cfd":        { "reachable": false, "latencyMs": null, "lastChecked": 1714014000000 }
}
```

### How `resolveProxy` uses it

```js
async function resolveProxy() {
  const requestedKey = ...;        // user's selection or default
  const health = await getProxyHealth();
  const requestedHealth = health[requestedKey];

  if (requestedHealth?.reachable === false) {
    // Pick the fastest reachable alternative.
    const alts = Object.keys(BUILTIN_PROXIES)
      .filter((k) => k !== requestedKey)
      .map((k) => ({ k, h: health[k] }))
      .filter(({ h }) => h?.reachable)
      .sort((a, b) => (a.h.latencyMs ?? Infinity) - (b.h.latencyMs ?? Infinity));
    if (alts.length > 0) {
      return { key: alts[0].k, ..., fallback: true,
               failedOver: requestedKey };
    }
  }
  return { key: requestedKey, ..., fallback: false };
}
```

The user's preference is preserved; failover is invisible until
they click the popup, which surfaces:

```
archive.ph unreachable — auto-routing through web.archive.org.
```

If no proxy is reachable, returns the user's choice anyway (better
to attempt and fail visibly than silently break navigation).

### Manual probe

The popup's **Check** button:
1. Does its own client-side probe of the currently-selected proxy
   (immediate user-visible OK/FAIL message).
2. Sends `probeProxies` to the SW so the full health table refreshes
   (powers auto-failover on the next navigation).

The **Proxy health** `<details>` table in the popup surfaces the full
health state: each proxy's reachable/latency status, a `←` marker
on the active proxy.

## Defense in depth

The hardenings stack multiplicatively. A single FT visit:

1. **DNR fires:** UA + Referer rewritten before the request leaves.
2. **Server replies:** 403 Cloudflare challenge.
3. **Page paints:** content script sees `#challenge-stage`,
   skips strip pipeline.
4. **3 seconds later:** failure detector identifies challenge,
   posts `bypassFailed`.
5. **SW advances strategy:** `googlebot` → `bingbot`. Persists,
   reloads.
6. **New navigation:** Bingbot UA + Bing referer.
7. **Server replies:** 403 again (Cloudflare doesn't care).
8. **Detector advances again:** `bingbot` → `cookie-reset`.
9. **New navigation:** real Chrome UA, no cookies.
10. **Server replies:** maybe paywall, maybe not. If yes, advance
    to `proxy` → redirect to web.archive.org.
11. **Wayback serves:** snapshot of the article (or 404).
12. **Detector skips proxy hosts:** no further advance.

The user sees: page loads, briefly reloads twice, ends up on a
Wayback snapshot. Worst case: ends up on a clean failure (no
strategy worked, badge says FAIL, page is the publisher's
challenge — same as without 13ft installed).

## Fade-then-hide (Wired-style fight)

Real production pattern observed in 0.16.0: a publisher's paywall
JS sets `display: none !important` on the article body **after**
the page has already painted the content. The user sees the body
for ~1-2 seconds, then it disappears.

**The CSS battle:** inline `display: block !important` (our reveal)
beats stylesheet `display: none !important`. But if the publisher
also uses inline `!important`, last-write-wins. We need an observer
to re-assert.

**Implementation in [content.js](../content.js):**

```js
const obs = new MutationObserver((records) => {
  for (const r of records) {
    if (r.type === "childList") { needStrip = true; break; }
    if (r.type === "attributes") {
      const el = r.target;
      if (el instanceof HTMLElement &&
          (revealedSet.has(el) || el.closest("article, main"))) {
        needStrip = true; break;
      }
    }
  }
  if (needStrip) scheduleStrip();
});
obs.observe(target, {
  childList: true, subtree: true,
  attributes: true,
  attributeFilter: ["style", "class", "hidden"]
});
```

Watching `attributes` (not just `childList`) means our observer
fires the moment a publisher's script touches the body's style.
The throttle caps strip() at 12 Hz to prevent thrash:

```js
let stripTimer = null, stripPending = false;
function scheduleStrip() {
  if (stripTimer) { stripPending = true; return; }
  strip();
  stripTimer = setTimeout(() => {
    stripTimer = null;
    if (stripPending) { stripPending = false; scheduleStrip(); }
  }, 80);
}
```

**Generic article-body rescue:** when per-site `cssRules.reveal`
selectors don't match (Wired uses CSS-in-JS hashes), `strip()`
calls `rescueLargestArticleBody()` — a TreeWalker descends
`<article>`/`<main>`, finds the deepest substantial-text element
(>1500 chars), force-reveals it.

## Stability + persistence

Once content is visibly stable (added 0.17.0), disconnect the
observer + persist the host as "verified" in
`chrome.storage.local.stableHosts` for 7 days. Future visits use a
3-second fast-path observer instead of the default 10s.

**Stability detection:** an `<article>`/`<main>` container with
visible (non-display:none) text content of >1500 chars.

**Lifecycle:**

```
First visit:
  10s observer → end of window → check stability:
    stable     → mark stableHosts[host] = { strategy, stableAt }
    unstable   → if was previously cached, drop entry

Future visit (within 7 days, same strategy):
  3s observer (catches new late paywalls) → end of window:
    stable     → keep cache (refresh stableAt)
    unstable   → drop cache (publisher tightened)

Strategy change:
  cache invalidates because cached strategy ≠ current strategy
```

**Storage shape:**
```json
{
  "theatlantic.com": {
    "strategy": "googlebot",
    "stableAt": 1714014000000
  }
}
```

**Test coverage:** `verify-stability.mjs` (7 assertions including
first-visit marking, future-visit fast-path preservation, degradation
clearing, strategy-change re-marking).

## What's NOT yet hardened

- **Subresource-level challenge detection** — we only detect when
  the main_frame becomes a challenge page. Some sites embed
  challenges in iframes; we'd need a per-frame detector.
- **Active anti-bypass JS** — a publisher running JS that scans
  for our textContent ("13ft — extracted from SSR state") could
  detect us. We'd need to randomize the panel header to defeat
  that. Trade-off: users lose the visible "where did this come
  from?" affordance.
- **Cookie-banner fatigue interaction** — sites that combine
  consent banners with paywalls (common in EU) may need
  consent-cookie injection to render properly even after we strip
  the paywall. BPC has special handling; we don't yet.
- **Service-worker interception** — sites whose own service worker
  re-fetches the article and applies the paywall server-side. Our
  DNR rules don't apply to requests originated by the page's SW.
  Hard problem; no extension solves this cleanly.
