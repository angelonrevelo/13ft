# Architecture

13ft is a Chrome MV3 extension. It runs entirely in the user's browser
— no central server, no network endpoint. Each user installs unpacked
from this directory.

## File layout

```
13feet/
├── manifest.json                MV3 manifest. Permissions, content
│                                scripts list, action popup.
├── background.js                Service worker (~1100 lines).
│                                Owns DNR rule installation + dynamic
│                                main-world content-script registration,
│                                strategy resolution, failure-driven
│                                fallback, proxy health probing,
│                                customJs injection, Reader-Mode +
│                                LLM-completer launching, auto-update
│                                alarm + JSON refresh.
├── content.js                   Content script (~870 lines). Runs at
│                                document_end on every page. Reads
│                                per-host config, applies challenge-
│                                skip / consent injection / dropCookies
│                                / AMP redirect / overlay strip /
│                                JSON-LD unhide / SSR extraction /
│                                generic body rescue. Throttled
│                                MutationObserver (10s default, 3s
│                                fast-path on cached-stable hosts).
├── custom.js                    Registry of named main-world
│                                injectors: nyt_defuseMeter,
│                                piano_defuse, unregisterPageSW,
│                                _testMarker.
├── sites.js                     Hand-curated DEFAULT_SITES (~30
│                                publishers). Schema definition.
│                                BLOCKED_HOSTS list.
├── sites.generated.js           Auto-generated from BPC (~595
│                                publishers). Hand-curated wins.
├── popup.html / popup.js        Toolbar UI. Strategy + proxy +
│                                Reader Mode + LLM (when exhausted)
│                                + Advanced section (diagnostic,
│                                refresh rules, dashboard link).
├── dashboard.html / .js         chrome-extension://<id>/dashboard.html.
│                                Statistics + Sankey + per-host failure
│                                table + proxy health + rules cache.
├── llm.html / .js               WebLLM Phi-3 article completer.
│                                Opens with ?url=<failed-url>
│                                &teaser=<observed-text>.
├── lib/
│   ├── readability.js           Mozilla Readability (Apache 2.0,
│                                vendored, 2,812 lines).
│   ├── reader-render.js         Reader Mode UI: toolbar with MD
│                                copy / Listen / font controls /
│                                themes / Pocket / close.
│   ├── unpaywall-main.js        Main-world doc_start fetch/XHR
│                                interceptor. Rewrites paywall flags
│                                in JSON responses before page reads.
│   └── ssr-rewrite-main.js      Main-world doc_start SSR rewriter.
│                                Modifies __NEXT_DATA__ etc. before
│                                React/Vue/Svelte hydrates.
├── companion/                   Optional self-hosted server-side
│                                bypass for FCrDNS-stuck sites.
│                                Docker-compose stack wrapping
│                                everywall/ladder + flaresolverr.
│                                Not loaded by the extension; users
│                                run it separately and point the
│                                popup's "custom (Ladder)…" proxy
│                                field at it. See companion/README.md.
├── scripts/
│   ├── import-bpc.mjs           Fetch + transpile BPC sites.js
│   │                            into our schema. Output formats:
│   │                            JS file (default) or `--json file`.
│   └── inspect-site.mjs         Drive Chromium against a URL,
│                                propose a sites.js entry from
│                                observed signals.
├── tests/live/
│   ├── run.mjs                  Live test runner — exercises 26
│   │                            curated publishers OR --url <url>
│   │                            for spot-check OR --generic for
│   │                            iterating DEFAULT_SITES.
│   ├── README.md                How-to + interpretation.
│   └── runs/                    JSON dumps from past runs.
├── README.md
├── CHANGELOG.md
└── docs/                        This directory.
```

## Permissions

Declared in [manifest.json](../manifest.json):

| Permission                  | Why                                                |
|-----------------------------|----------------------------------------------------|
| `declarativeNetRequest`     | Header rewrite + redirect + block + print rules    |
| `storage`                   | `chrome.storage.local` for all persistent state    |
| `tabs`                      | `chrome.tabs.query` / `update` / `reload`          |
| `scripting`                 | `chrome.scripting.executeScript({ world:"MAIN" })` + dynamic `registerContentScripts` |
| `alarms`                    | Periodic proxy health probe + weekly rules refresh |
| `host_permissions: <all_urls>` | Required for DNR + content scripts                 |

No remote-code execution. All injected JS lives in
[custom.js](../custom.js) or [lib/](../lib/). We never `eval()` fetched
content. Auto-update accepts JSON only — BPC's raw sites.js can't be
parsed in the SW because MV3's CSP forbids `'unsafe-eval'`.

## Component model

```
                ┌──────────────────────────────────────────────────┐
                │  POPUP                                           │
                │  popup.html + popup.js                           │
                │                                                  │
                │  • Read state from SW (getState)                 │
                │  • Toggle / setStrategy / setProxy / probeProxies│
                │  • Reader Mode button → openReaderMode           │
                │  • LLM Completer button (when exhausted)         │
                │  • Advanced: diagnostic toggle, refreshRules,    │
                │    dashboard link, generateReport                │
                └────────────────┬─────────────────────────────────┘
                                 │ chrome.runtime.sendMessage
                                 ▼
┌────────────────────────────────────────────────────────────────────┐
│  SERVICE WORKER (background.js)                                    │
│                                                                    │
│  importScripts("sites.js", "sites.generated.js", "custom.js")      │
│                                                                    │
│  ┌─ Storage ─────────────────────────────────┐                     │
│  │ enabledHosts        Set<host>             │                     │
│  │ contentProxy        proxy key             │                     │
│  │ customProxyUrl      string (Ladder)       │                     │
│  │ siteOverrides       {host: cfg}           │                     │
│  │ strategyFailures    {host: counts}        │                     │
│  │ exhaustedHosts      [host, …]             │                     │
│  │ proxyHealth         {key: probe}          │                     │
│  │ remoteSitesGenerated {host: cfg}          │  (auto-update)      │
│  │ remoteSitesGeneratedAt timestamp          │                     │
│  │ rulesUrl            string (config)       │                     │
│  │ stableHosts         {host: {strategy,...}}│  (persistence)      │
│  │ diagnosticMode      boolean               │                     │
│  └───────────────────────────────────────────┘                     │
│                                                                    │
│  ┌─ Logic ───────────────────────────────────┐                     │
│  │ resolveSiteConfig(host)                   │  cascading lookup    │
│  │ resolveProxy()                            │  with auto-failover  │
│  │ buildRules(host)                          │  header + block      │
│  │                                           │    + redirect + print│
│  │ syncRules()                               │  + main-world script │
│  │                                           │    registration      │
│  │ injectCustomJs(tabId, url)                │  on tabs.onUpdated   │
│  │ handleBypassFailed(msg)                   │  strategy chain      │
│  │ probeAllProxies()                         │  on alarm or message │
│  │ refreshRemoteRules()                      │  weekly + manual     │
│  └───────────────────────────────────────────┘                     │
│                                                                    │
│  Listeners:                                                        │
│   • runtime.onMessage   (popup + content-script)                   │
│   • tabs.onUpdated      (badge + customJs injection)               │
│   • tabs.onActivated    (badge)                                    │
│   • alarms.onAlarm      (proxy probe / rules update)               │
│   • runtime.onStartup   (purge + alarm setup)                      │
│   • runtime.onInstalled (purge + alarm setup)                      │
└────┬─────────────────────┬───────────────────┬─────────────────────┘
     │ DNR rules           │ executeScript     │ registerContentScripts
     ▼                     ▼                   ▼
┌─────────────┐     ┌──────────────┐     ┌──────────────────────────┐
│ Network     │     │ Page MAIN    │     │ Page MAIN (doc_start)    │
│ • headers   │     │ world        │     │ • lib/unpaywall-main.js  │
│ • block     │     │ • per-site   │     │   patches fetch/XHR      │
│ • proxy     │     │   customJs   │     │ • lib/ssr-rewrite-main.js│
│ • print     │     │ • Reader Mode│     │   rewrites SSR JSON      │
│   redirect  │     │   injection  │     │   pre-hydration          │
└─────────────┘     └──────────────┘     └──────────────────────────┘

                                       ┌────────────────────────────┐
                                       │ CONTENT SCRIPT (ISOLATED,  │
                                       │ document_end)              │
                                       │ sites.js + sites.generated │
                                       │  + content.js              │
                                       │                            │
                                       │ Pipeline:                  │
                                       │  1. Diagnostic-mode setup  │
                                       │  2. Wayback save-now check │
                                       │  3. Challenge-page guard   │
                                       │  4. AMP cache redirect     │
                                       │  5. consentInject cookies  │
                                       │  6. dropCookies            │
                                       │  7. strip() — JSON-LD,     │
                                       │     SSR, cssRules,         │
                                       │     overlay heuristics,    │
                                       │     rescueLargestArticle   │
                                       │  8. MutationObserver +     │
                                       │     stability detect       │
                                       │     (10s / 3s fast-path)   │
                                       │  9. Failure detector       │
                                       │     (3s delay)             │
                                       └────────────────────────────┘

                              ┌────────────────────────────────────┐
                              │ DASHBOARD (extension page)         │
                              │ chrome-extension://<id>/dashboard  │
                              │ Reads chrome.storage.local         │
                              │ Renders Sankey + tables            │
                              └────────────────────────────────────┘

                              ┌────────────────────────────────────┐
                              │ LLM COMPLETER (extension page)     │
                              │ chrome-extension://<id>/llm.html?  │
                              │   url=<failed-article>             │
                              │   &teaser=<observed-text>          │
                              │ Loads WebLLM + Phi-3 from CDN      │
                              └────────────────────────────────────┘
```

## Data flow: typical page load

1. Browser commits navigation. `tabs.onUpdated` fires with
   `status: "loading"`.
2. SW handler:
   - `refreshTabBadge` reads enabled state, sets badge to ON.
   - `injectCustomJs` resolves host config, fires
     `chrome.scripting.executeScript({ world:"MAIN" })` for any
     applicable `customJs` function from `custom.js`.
3. **Dynamic main-world content scripts already registered for
   this host:** `lib/unpaywall-main.js` + `lib/ssr-rewrite-main.js`
   run at document_start in the page's MAIN world. They monkey-
   patch `fetch` / `XMLHttpRequest` and start a MutationObserver
   on documentElement watching for `<script id="__NEXT_DATA__">`
   etc., respectively.
4. DNR rules matching the host fire on the request:
   - `modifyHeaders` rewrites User-Agent, Referer, removes Cookie.
   - `block` rules drop paywall JS URLs.
   - `redirect` rules: print-URL or proxy.
5. Server returns HTML. As parser inserts SSR `<script>` tags,
   `ssr-rewrite-main.js`'s observer rewrites their JSON in place
   (paywall flags flipped). Framework hydrates from rewritten data.
6. Page's own JS calls `fetch("/api/article/<id>")`.
   `unpaywall-main.js`'s patched `fetch` intercepts the response,
   rewrites `accessLevel:"paid"` → `"free"` etc. before page reads.
7. Content script (ISOLATED, document_end):
   - Reads enabled config + stableHosts cache.
   - If diagnosticMode is on: starts PerformanceObserver +
     schedules DOM snapshot.
   - Wayback handler: if on `web.archive.org/web/*/<url>` and
     no-capture markers detected, redirect to `/save/<url>`.
   - Challenge-page guard: if Cloudflare/PerimeterX/DataDome
     markers, skip strip pipeline.
   - AMP redirect, consent inject, dropCookies.
   - strip(): JSON-LD unhide → SSR state extraction → site
     reveal rules → behavioral overlay removal → site hide rules
     → rescue largest article body.
   - Start MutationObserver:
     - **First visit:** 10s observer with throttled strip on every
       relevant mutation. End-of-window: if stable, mark stable.
     - **Cached-stable visit:** 3s fast-path observer (no
       early disconnect because publisher could have tightened).
   - 3s later: failure detector. If anti-bot challenge or
     "verify human" markers present, send `bypassFailed` to SW.
8. SW receives `bypassFailed`: advance strategy in chain
   (`siteOverrides[host]`), `syncRules`, reload tab.

## Storage schema

`chrome.storage.local` keys, all owned by 13ft:

| Key                         | Shape                                      |
|-----------------------------|--------------------------------------------|
| `enabledHosts`              | `string[]` — toggled-ON hosts              |
| `contentProxy`              | `string` — proxy key                       |
| `customProxyUrl`            | `string` — Ladder URL                      |
| `siteOverrides`             | `{ [host]: { strategy, ... } }`            |
| `strategyFailures`          | `{ [host]: { [strategy]: count } }`        |
| `exhaustedHosts`            | `string[]`                                 |
| `proxyHealth`               | `{ [key]: { reachable, latencyMs, lastChecked } }` |
| `remoteSitesGenerated`      | `{ [host]: rule }` — auto-update cache     |
| `remoteSitesGeneratedAt`    | `number` — last refresh timestamp          |
| `rulesUrl`                  | `string` — auto-update URL (configurable)  |
| `stableHosts`               | `{ [host]: { strategy, stableAt } }` 7-day TTL |
| `diagnosticMode`            | `boolean`                                  |

Session DNR rules don't persist across browser restart — the SW
re-syncs on `onStartup` / `onInstalled`. Same for the alarm-driven
proxy health probe + rules refresh.

## Why MV3 (and what it cost us)

- **No `webRequest.filterResponseData()`.** Chrome MV3 removed it.
  We can't rewrite response bodies at the network layer. Workaround:
  `lib/unpaywall-main.js` patches `fetch`/`XHR` from the page's MAIN
  world after the response arrives. Catches API-gated paywalls.
- **`chrome.scripting.executeScript({ injectImmediately: true })`
  is best-effort.** Page inline `<script>` can run first.
  Compensate by using `blockRegex` for things that must be
  killed at the network layer, and `chrome.scripting.registerContentScripts`
  with `runAt:"document_start"` + `world:"MAIN"` for SSR rewriter +
  fetch interceptor (these reliably run before page scripts).
- **SW CSP forbids `'unsafe-eval'`.** Auto-update can't
  `new Function()` to parse BPC's raw JS. Pivoted to JSON-only.
- **Match patterns require `:*` for non-default ports.**
  `*://host/*` only matches `:80`/`:443`. We add explicit
  `:*/*` variants.
- **`chrome.userScripts` requires per-extension toggle**
  (Chrome 138+). We avoid it.

## Tier 3: optional self-hosted companion

The extension is Tier 1 (network DNR rules) + Tier 2 (DOM/MAIN-world
manipulation). Together those bypass ~80% of curated publishers.

The remaining ~20% — FT, Bloomberg premium, WSJ premium, Le Monde —
verify Googlebot's IP via FCrDNS. A browser extension running on a
home IP can't beat that. For users who want to read those sites,
[`companion/`](../companion/README.md) ships an opt-in third tier:

```
┌──────────┐   ┌──────────────┐   ┌────────────────────────┐
│ Browser  │──▶│ 13ft popup → │──▶│ User's Ladder instance │
│          │   │ proxy strat  │   │ • localhost:8080       │
└──────────┘   └──────────────┘   │ • or fly.dev / Tailnet │
                                  └─────────┬──────────────┘
                                            │ Googlebot UA
                                            │ + datacenter IP
                                            ▼
                                  ┌────────────────────────┐
                                  │ FT / Bloomberg / WSJ   │
                                  │ • FCrDNS check passes  │
                                  │   (IP not residential) │
                                  │ • returns full article │
                                  └────────────────────────┘
```

What the companion is:
- A `docker-compose.yml` wrapping
  [everywall/ladder](https://github.com/everywall/ladder) (Go
  reverse proxy with paywall-bypass rules) + FlareSolverr.
- A `fly.toml` for one-click cloud deploy ($0–$2/month).
- A `ladder-config/ruleset.yaml` with starter rules for the
  FCrDNS-class sites (Googlebot UA + Google referer +
  FlareSolverr passthrough where needed).

What it is not:
- Not a public service. Each user runs their own instance.
- Not loaded by the extension. The extension's "custom (Ladder)…"
  proxy field has been there since 0.7.0; the companion is just a
  pre-configured Ladder instance you point that field at.
- Not a 12ft.io clone. 12ft was a single server proxying every
  user; the companion is per-user, on infrastructure you own.
  Publisher TOS complaints land in your inbox, which means
  scaling = you control whether to expose it beyond localhost.

The boundary between extension and companion is intentional. The
extension is one-click install with no server dependency. The
companion is opt-in for the sites the extension structurally
can't reach. Most users will never need it. See
[`companion/README.md`](../companion/README.md) for setup,
threat model, and the "share my paid subscription with my
family on logged-out devices" use case.

## Why distributed (no server)

12ft.io was a single server proxying every user. The News/Media
Alliance got it taken down July 14, 2025 with a TOS complaint to
the webhost. 13ft has no central server — every user runs their
own copy. The closest takedown vector is the Chrome Web Store
(already not a distribution path for us — we're unpacked-only).

The trade-off: we can't pool intelligence across users. Each user
starts fresh. We compensate via the [BPC import](../scripts/import-bpc.mjs)
— community intelligence flows in via that one weekly script. The
auto-update mechanism in 0.15.0 makes this fully automatic if the
user hosts the JSON output anywhere reachable.
