# Sites

Per-domain configuration. Two files contribute to `DEFAULT_SITES`:

- [sites.js](../sites.js) — hand-curated. ~30 entries for the
  publishers we care about most: NYT, WaPo, WSJ, Bloomberg, FT,
  Atlantic, Economist, all 7 Condé Nast properties, all 10 Hearst
  magazines, plus regionals.
- [sites.generated.js](../sites.generated.js) — auto-generated from
  Bypass Paywalls Clean. ~600 entries. Hand-curated wins per-domain,
  so editing sites.js never gets stomped by re-imports.

Both are loaded into the SW (`importScripts`) and into content scripts
(`content_scripts.js` array in [manifest.json](../manifest.json)).

## Schema

```js
self.DEFAULT_SITES = {
  "<host>": {
    // Strategy
    strategy: "googlebot" | "bingbot" | "cookie-reset" | "proxy"
              | "perplexitybot" | "claudebot" | "gptbot" | "mobile",
    allowCookies:      false | true,         // skip Cookie removal
    useGoogleReferer:  true | false,         // override referer
    customUserAgent:   "Mozilla/5.0 …",      // override strategy UA

    // Network-layer rules
    blockRegex:        [/regex/, "string"],  // DNR block-rule patterns
    printRedirect: {
      match:   /^https?:\/\/.../,            // DNR regex source
      replace: "https://print.example.com/$1" // \1, \2 capture-group refs
    },

    // Content-script behaviors
    cssRules: {
      hide:            ["selector", …],
      reveal:          ["selector", …]
    },
    dropCookies:       ["cookieName", …],
    consentInject:     true | [{name, value}, …],
    ampRedirect:       true,
    customJs:          "fnNameInCustomJs"
  }
};
```

Everything except `strategy` is optional. An entry can be just
`{ strategy: "googlebot" }` and that's a complete rule.

The strategy field accepts any of the 8 strategies in
[strategies.md](strategies.md). The 4 in the auto-fallback chain
(`googlebot`, `bingbot`, `cookie-reset`, `proxy`) cycle automatically
on failure; the others (AI crawlers, mobile) are manual-only.

### `strategy` (required)

See [strategies.md](strategies.md) for the four strategies and their
chain order.

### `allowCookies`

Default: false (Cookie header removed). Set to `true` for sites
that break without session cookies — NYT, WaPo serve a "please
enable cookies" wall to anonymous-cookie-less requests, even
Googlebot.

### `useGoogleReferer`

Default: true. Set to `false` to keep the browser's natural Referer
instead of `https://www.google.com/search?q=<host>` (or
`https://www.bing.com/search?q=<host>` for bingbot strategy).
Rare — used when the site checks Referer + UA consistency and our
synthetic referer triggers a flag.

### `customUserAgent`

Override the strategy-default UA. Used by the BPC import for sites
that BPC ships with a non-default UA.

### `blockRegex` (highest impact field)

Array of `RegExp` objects (or pattern strings) matching URLs of
paywall JS / metering APIs. Compiled into DNR `action: { type:
"block" }` rules at priority 2 (higher than the header-rewrite
rule). Prevents the paywall from ever loading.

DNR's `regexFilter` accepts a [RE2 subset](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest#concepts-regexFilter):
no lookbehinds, no backreferences. Most BPC patterns work as-is.

Examples from sites.js:

```js
"nytimes.com": {
  blockRegex: [
    /meter-svc\.nytimes\.com\/meter\.js/,
    /mwcm\.nyt\.com\/.+\.js/
  ]
}

// Shared SaaS patterns at the top of sites.js:
const AMP_PAYWALL_JS = /cdn\.ampproject\.org\/v\d\/amp-(access|subscriptions)-.+\.js/;
const TINYPASS_JS    = /\.tinypass\.com\//;
const PIANO_JS       = /\.piano\.io\/(api|xbuilder|esp|id\/api)/;

"economist.com":  { strategy: "cookie-reset", blockRegex: [TINYPASS_JS, AMP_PAYWALL_JS] },
"theatlantic.com": { strategy: "googlebot",  blockRegex: [AMP_PAYWALL_JS], dropCookies: ["articleViews"] }
```

### `cssRules`

```js
cssRules: {
  hide:   ["selector", …],   // querySelectorAll → remove
  reveal: ["selector", …]    // querySelectorAll → force visible
}
```

Selector reference is broad CSS3:
- attribute selectors with case-insensitive flag: `[class*='paywall' i]`
- combinators: `article > .body`, `[data-testid*='article' i]`
- pseudo-classes: `:not([class])`

`reveal` runs FIRST in the strip pipeline. Revealed elements get
tracked in a WeakSet; the subsequent `hide` pass and the generic
behavioral overlay remover skip them. This prevents "the article
body itself happens to have 'paywall' in its class name and gets
nuked" bugs.

`hide` selectors with `[class*='foo' i]` benefit from the
`normalizeClassToken` helper — class names get normalized to strip
trailing hex hashes (`paywallfragment-a8b3f9e` → `paywallfragment`)
before the OVERLAY_HINTS check, so CSS-in-JS sites work even though
their class suffixes change every build.

### `dropCookies`

```js
dropCookies: ["nyt-purr", "nyt-gdpr"]
```

Content script expires each named cookie across four path/domain
combinations on every page load:

```js
document.cookie = `${name}=; expires=…; path=/`;
document.cookie = `${name}=; expires=…; path=/; domain=${location.hostname}`;
document.cookie = `${name}=; expires=…; path=/; domain=.${location.hostname}`;
document.cookie = `${name}=; expires=…; path=/; domain=.${eTLDplus1}`;
```

Affects the NEXT request — the current request already went out
with cookies. User reloads to see the meter-reset effect. This
matches BPC's `remove_cookies_select_drop` semantics.

### `ampRedirect`

```js
ampRedirect: true
```

Content script looks for `<link rel="amphtml" href="...">`. If the
href is set and not equal to the current location, navigates there
via `location.replace()`. AMP pages historically omit paywall JS
and serve full bodies for indexing.

Currently seeded only on `wsj.com` — most publishers stopped emitting
AMP variants when Google deprecated AMP in Top Stories (2021). Some
older content still has them.

### `consentInject`

```js
consentInject: true
// or specific cookies:
consentInject: [{ name: "myConsent", value: "yes" }]
```

Pre-populates GDPR consent cookies on every page load so EU sites
that gate behind a consent banner skip the banner entirely. With
`true`, injects 5 well-known consent-cookie patterns:
- `euconsent-v2` (IAB TCF v2 accepted-all string)
- `OptanonConsent` (OneTrust accepted-all)
- `OptanonAlertBoxClosed` (OneTrust dismissal flag)
- `didomi_token` (Didomi accept-all marker)
- `cookieyes-consent` (CookieYes accept-all)

Cookies set on path `/`, host domain, and eTLD+1 (e.g.
`.example.com` for `www.example.com`) to catch subdomain-scoped
variants.

### `printRedirect`

```js
printRedirect: {
  match:   "^https?://(?:www\\.)?example\\.com/article/(\\d+)",
  replace: "https://print.example.com/article/$1"
}
```

Per-site DNR redirect rule (priority 3, above block + modify) for
publishers that maintain print-friendly URLs. `match` uses DNR's
RE2 subset (no lookbehinds, no backreferences). `replace` may use
`$1`, `$2` for capture groups. Examples:

- NYT: `/article` → `/print/article`
- WSJ: `wsj.com` → `print.wsj.com`

### `customJs`

```js
customJs: "nyt_defuseMeter"
```

References a function name in `CUSTOM_JS_FUNCTIONS` (defined in
[custom.js](../custom.js)). On every navigation the SW calls
`chrome.scripting.executeScript({ world: "MAIN", injectImmediately:
true, func: <named-function> })`.

Available functions in custom.js:
- `nyt_defuseMeter` — stubs NYT's meter module pre-init.
- `piano_defuse` — stubs `window.tp` so Piano never paywalls.
- `unregisterPageSW` — calls
  `navigator.serviceWorker.getRegistrations().then(rs => rs.forEach(r => r.unregister()))`.
  Use when the publisher's own SW gates paywall content
  server-side.
- `_testMarker` — test-only.

The function runs in the page's main JavaScript world (not the
isolated content-script world), so it can monkey-patch `window.fetch`,
`XMLHttpRequest`, `localStorage`, page-defined globals like
`window.tp` (Piano).

Constraints:
- Function must be self-contained (no closures over outer-scope
  variables — Chrome serializes via `Function.prototype.toString`).
- No `chrome.*` API access (main world has no extension bridge).
- Idempotent — guard with a sentinel like `if (window.__ft13_patched)
  return;` because the script may inject multiple times across
  same-host navigations.

`injectImmediately: true` is best-effort. It's NOT a guaranteed
document_start. Page inline scripts can run first. For interceptors
that need to beat boot-time scripts, prefer `blockRegex` (network
layer, fires unconditionally before page JS).

## Adding a new site

### Method 1: copy from BPC (most leverage)

Run the import. If the site is in BPC's catalog, you get it for free:

```sh
node scripts/import-bpc.mjs
```

This rewrites [sites.generated.js](../sites.generated.js). 374 BPC
entries → 602 of our entries (group expansion). Hand-curated entries
in sites.js still take precedence on overlap.

### Method 2: heuristic inspector

For sites BPC doesn't have:

```sh
node scripts/inspect-site.mjs https://example-publisher.com/article-url
```

Drives clean Chromium against the URL, scrapes signals (JSON-LD
selectors, paywall script URLs, cookies, rel=amphtml, fixed-position
overlays), prints a paste-ready entry. Output is advisory — review
before committing.

Example output:
```
"127.0.0.1": {
  strategy: "googlebot",
  blockRegex: [
    /127\.0\.0\.1\/paywall-bundle-.+\.js/,
  ],
  dropCookies: ["paywall_counter", "meter_visits"],
  ampRedirect: true,
  cssRules: {
    hide: ["#paywall-overlay"],
    reveal: [".paid-body"]
  }
}
```

Paste into the appropriate section of [sites.js](../sites.js).

### Method 3: manual

Look at the failing site in DevTools:
1. **Network tab** — find the script that injects the paywall. Add
   it to `blockRegex`.
2. **Application → Cookies** — find the meter cookie. Add to
   `dropCookies`.
3. **Elements** — find the overlay. Add to `cssRules.hide`.
4. **DevTools console** — `document.querySelectorAll('script[type="application/ld+json"]').forEach(s => console.log(s.textContent))` —
   if you see `isAccessibleForFree: false`, that already works
   universally without per-site config.

## BPC field translation

Reference for what `import-bpc.mjs` does (in
[scripts/import-bpc.mjs:translateEntry](../scripts/import-bpc.mjs)):

| BPC field                        | Our schema                              |
|----------------------------------|-----------------------------------------|
| `domain: "<host>"`               | the entry key                           |
| `group: ["<host>", …]`           | one entry per array member              |
| `useragent: "googlebot"`         | `strategy: "googlebot"`                 |
| `useragent: "bingbot"`           | `strategy: "googlebot" + customUserAgent` |
| `allow_cookies: 1`               | `allowCookies: true`                    |
| `block_regex: /re/`              | `blockRegex: [/re/]`                    |
| `block_regex: ["re", …]`         | `blockRegex: [new RegExp(...)]`         |
| `amp_unhide: 1`                  | `ampRedirect: true`                     |
| `remove_cookies_select_drop: [..]` | `dropCookies: [...]`                  |
| `block_selectors: ".sel"`        | `cssRules.hide: [".sel"]`               |
| `exception_selectors: ".sel"`    | `cssRules.reveal: [".sel"]`             |

Skipped (no equivalent yet):
- `cs_code` — imperative custom JS as inline strings. We don't `eval`.
- `ld_json_remove` — JSON-LD property removal.
- `block_javascript: 1` — block ALL JS on the site.
- `group_rule` references — cross-entry indirection.
- `remove_cookies_select_hold` — keep-these-drop-rest cookies.

The import counts these and reports `skipped (empty)`.

## Site precedence

When a host appears in multiple sources:

1. `siteOverrides[host]` (chrome.storage.local) — user override or
   auto-fallback's recorded strategy. Wins everything.
2. `DEFAULT_SITES[host]` from [sites.js](../sites.js) — hand-
   curated. Wins generated.
3. `DEFAULT_SITES[host]` from [sites.generated.js](../sites.generated.js)
   — BPC import. Fills gaps only.
4. Implicit fallback — `{ strategy: "googlebot" }`. Universal-only mode.

Subdomain matching (`baili.substack.com` → `substack.com`) is done by
`canonicalConfiguredHost` in [background.js](../background.js).

## Testing site changes

Quick validation (vm-based, fast):
```sh
node /tmp/13ft-test-phase1.mjs
```

Real-Chrome end-to-end:
```sh
cd /tmp/13ft-pw && node drive.mjs
```

To verify a specific site config produces the right rule shape, add
a one-off assertion in `/tmp/13ft-test-phase1.mjs` and re-run.
