# 13ft

A Chrome MV3 paywall-bypass extension. Distributed (no central server),
user-installable from your filesystem, ~600 publishers covered out of
the box via an automated import from [Bypass Paywalls Clean][bpc].

## What it does

**Network layer (DNR):**
- Crawler UA spoofing — Googlebot, Bingbot, Mobile Safari, plus
  AI-crawler UAs (PerplexityBot, ClaudeBot, GPTBot) for publishers
  with revenue-sharing deals.
- Per-host search-result Referer (e.g. `google.com/search?q=<host>`)
  to look like a legitimate search-click.
- `blockRegex` rules that kill paywall JS at the network layer
  before it loads (NYT's `meter.js`, Piano/Tinypass bundles, AMP
  paywall modules, Condé Nast's journey scripts).
- Print-URL redirect (`printRedirect: { match, replace }`).
- Proxy redirects (archive.ph, web.archive.org, freedium.cfd,
  freedium-mirror.cfd, readmedium.com, custom Ladder).
- AMP cache redirect to `cdn.ampproject.org/c/s/<host>/<path>`.

**Main world (executeScript):**
- Per-site customJs injectors (`nyt_defuseMeter`, `piano_defuse`,
  `unregisterPageSW`).
- **Universal fetch/XHR interceptor** ([lib/unpaywall-main.js](lib/unpaywall-main.js))
  — rewrites `accessLevel:"paid"` / `isAccessibleForFree:false` and
  16 other paywall flags in JSON responses *before* the page reads
  them. Catches the entire class of API-gated paywalls our DOM
  stripping can't see.
- **Hybrid SSR rewrite** ([lib/ssr-rewrite-main.js](lib/ssr-rewrite-main.js))
  — modifies `__NEXT_DATA__` / `__NUXT__` / `__REMIX_CONTEXT__` /
  `__APOLLO_STATE__` JSON before React/Vue/Svelte hydrates, so the
  page renders the article in its native template.

**DOM layer (content script):**
- JSON-LD `isAccessibleForFree:false` unhide (Google's spec).
- SSR state extractor — explicit-key walker + aggressive heuristic
  scorer for non-standard JSON shapes.
- Targeted cookie expiry (`dropCookies` per site).
- Cookie-consent injection (`consentInject`) — pre-populates GDPR
  consent cookies so EU sites render without the banner.
- Per-site `cssRules: { hide, reveal }` with class-name fuzzing for
  CSS-in-JS sites.
- AMP variant detection (`<link rel="amphtml">`).
- Generic article-body rescue — finds the largest substantial-text
  descendant of `<article>`/`<main>` and force-reveals it (handles
  Wired-style "renders briefly then hides" without needing per-site
  selectors).
- **Stability detector + 7-day persistence** — once content is
  stable, the host gets cached. Future visits skip the heavy
  observer and use a 3-second fast-path.

**Failure handling:**
- 4-step strategy chain (`googlebot → bingbot → cookie-reset → proxy`)
  with auto-fallback when the failure detector identifies anti-bot
  challenges, "verify human" prompts, error markers.
- Mozilla Readability **Reader Mode** ([lib/reader-render.js](lib/reader-render.js))
  with Markdown export, audio TTS, font/size controls,
  light/dark/sepia themes, send-to-Pocket — the universal fallback
  when the body is anywhere in the DOM.
- **Local LLM article completer** ([llm.html](llm.html)) — when
  every strategy exhausts, popup offers a WebLLM Phi-3 summary of
  what the article is probably about. Pure client-side, no API key.
- **Statistics dashboard** ([dashboard.html](dashboard.html)) —
  per-host failure counts, strategy-chain Sankey, proxy health
  table, rules cache status.
- **Diagnostic mode** — popup toggle that observes paywall traffic
  + DOM markers, exports a paste-ready sites.js entry for new
  publishers.

## Install

1. Open [chrome://extensions](chrome://extensions).
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select this directory.
4. Pin the **13ft** toolbar icon.

The extension installs unpacked from your filesystem. It's not on
the Chrome Web Store and never will be — Google's developer policy
explicitly prohibits paywall-bypass extensions.

## Use

Click the 13ft icon on any paywalled page. The popup shows:

- **Big toggle** — turns the bypass on/off for the current host.
- **Strategy** — `Googlebot UA`, `Bingbot UA`, `Cookie reset`,
  `Proxy`, plus AI-crawler variants in an `<optgroup>`. Auto-fallback
  cycles `googlebot → bingbot → cookie-reset → proxy` on failure.
- **Content proxy** — for Medium/proxy-strategy sites. Default
  web.archive.org. Custom Ladder URL supported.
- **Check** — probes the selected proxy, refreshes health table.
- **Reader Mode** — extract+display the article via Mozilla
  Readability, with Markdown copy / TTS / typography controls.
- **Get LLM summary…** — appears when the strategy chain
  exhausted; opens the WebLLM Phi-3 completer.
- **Advanced** (collapsible) — diagnostic mode toggle, "Generate
  report" for new sites, "Refresh rules now," dashboard link.

When 13ft is on, the toolbar badge shows **ON** (green). Auto-fallback
shows **RTRY** (orange). Chain exhausted → **FAIL** (red).

`BLOCKED_HOSTS` (Reddit, Twitter, GitHub, etc.) refuse toggle ON —
Googlebot UA from a non-Google IP triggers their bot block, making
things worse than vanilla.

## Quickly test it works

[https://www.theatlantic.com/](https://www.theatlantic.com/) →
pick any article from the homepage → click 13ft icon → toggle ON.
The "TO READ THIS STORY, SIGN IN OR START A DIGITAL SUBSCRIPTION"
prompt disappears, the byline + full body render. Verified end-to-end
in [/tmp/13ft-pw/demo-atlantic.mjs](/tmp/13ft-pw/demo-atlantic.mjs):
2,493 chars vanilla → 9,748 chars with 13ft.

For sites that won't work see [docs/limitations.md](docs/limitations.md).

## Architecture in one paragraph

[manifest.json](manifest.json) is MV3 with permissions:
declarativeNetRequest + storage + tabs + scripting + alarms.
[background.js](background.js) (service worker) owns DNR rule
installation, proxy health probing, dynamic main-world content
script registration, customJs injection, failure-driven fallback,
Reader Mode + LLM page launching. [content.js](content.js) runs at
document_end on every page; reads per-host config; applies challenge
skip / consent injection / dropCookies / AMP redirect / overlay
strip / JSON-LD unhide / SSR extraction / generic body rescue;
runs an 80-ms-throttled MutationObserver for 10 seconds (3s
fast-path on cached-stable hosts) that catches publisher fade-then-
hide attempts; persists `stableHosts` to short-circuit future
visits. [sites.js](sites.js) holds the schema + ~30 hand-curated
entries. [sites.generated.js](sites.generated.js) holds ~595 entries
auto-imported from BPC. [custom.js](custom.js) is the registry of
named main-world injectors. [lib/unpaywall-main.js](lib/unpaywall-main.js)
+ [lib/ssr-rewrite-main.js](lib/ssr-rewrite-main.js) are the two
main-world doc_start scripts registered dynamically per enabled
host. [lib/readability.js](lib/readability.js) (vendored) +
[lib/reader-render.js](lib/reader-render.js) drive Reader Mode.
[dashboard.html](dashboard.html) and [llm.html](llm.html) are
extension pages.

Full breakdown in [docs/architecture.md](docs/architecture.md).

## Maintain it

```sh
node scripts/import-bpc.mjs --json sites.generated.json
# → fetches BPC, transpiles, writes JSON. Host that JSON anywhere
# (GitHub Pages, gist, your CDN) and configure rulesUrl in popup
# → SW auto-refreshes weekly via chrome.alarms.

node scripts/inspect-site.mjs <url>
# → scrape a paywalled page, propose a sites.js entry from observed
# signals. Or use the popup's "Generate report" button after enabling
# diagnostic mode.

node tests/live/run.mjs                    # vs ~26 real publishers
node tests/live/run.mjs --filter atlantic  # one site
node tests/live/run.mjs --url <url>        # spot-check single URL
node tests/live/run.mjs --generic          # iterate DEFAULT_SITES
```

## Run the tests

Unit tests (vm-based, fast):
```sh
node /tmp/13ft-test-phase1.mjs
```

E2E tests (Playwright + bundled Chromium, ~5 minutes total for all):
```sh
cd /tmp/13ft-pw
node drive.mjs                  # popup + DNR install + purge
node verify-content.mjs         # JSON-LD + cssRules
node verify-block.mjs           # DNR block rules on the wire
node verify-advanced.mjs        # ampRedirect + dropCookies + customJs
node verify-inspector.mjs       # scripts/inspect-site.mjs
node verify-ssr-piano.mjs       # __NEXT_DATA__ + universal injection
node verify-fallback.mjs        # failure detector + chain advance
node verify-bingbot.mjs         # bingbot UA on the wire
node verify-hardening.mjs       # challenge-skip + stealth + failover
node verify-polish.mjs          # per-host referer + SSR prepend
node verify-improve.mjs         # AMP cache + aggressive SSR + Wayback save
node verify-100bypass.mjs       # AI bots + fetch interceptor + Reader
node verify-longtail.mjs        # mobile UA + SW unreg + consent + SSR + print
node verify-tier1.mjs           # auto-update + diag + dashboard + Reader v2 + LLM
node verify-fadethenhide.mjs    # fade-then-hide reveal-vs-hide fight
node verify-stability.mjs       # stability detector + persistence
```

17 suites, ~234 assertions. Details in [docs/testing.md](docs/testing.md).

## Limits we cannot beat

Some sites are structurally unbypassable from any browser extension.
See [docs/limitations.md](docs/limitations.md) — the short version:

- **FCrDNS-verified sites** (FT, Bloomberg premium, WSJ premium,
  Le Monde): they verify Googlebot's IP belongs to Google's
  published ranges. Auto-failover routes through Wayback. For a
  cleaner path, run the [self-hosted companion](companion/README.md)
  — a Docker template that gives 13ft an opt-in datacenter IP for
  these sites without becoming 12ft.io v2.
- **Server-gated content** (Substack paid posts, Patreon locked,
  Ghost paid, beehiiv premium): the article body never reaches the
  client. Physically impossible without a subscription.
- **Active extension detection** (Le Monde): publisher detects 13ft
  and serves an error page. Auto-fallback recognizes this and
  advances to proxy.

## Optional: self-hosted companion (FCrDNS-stuck sites)

The extension handles ~80% of paywalled sites client-side. The
remaining ~20% — FT, Bloomberg premium, WSJ premium, Le Monde —
verify Googlebot requests come from Google's IP ranges, which a
browser extension running on your home IP can't fake.

The [`companion/`](companion/README.md) directory has a Docker
template that wraps [Ladder](https://github.com/everywall/ladder)
+ FlareSolverr. Run it locally (`docker compose up -d`) or deploy
to Fly.io for $0–$2/month. Then point 13ft's `Content proxy →
custom (Ladder)…` field at it. 13ft routes FCrDNS-stuck sites
through your own IP, the rest stays client-side.

You're the operator, you own the IP, no central service for
publishers to DMCA. That's what makes it a 13ft ladder rather
than a 12ft.io clone. See [companion/README.md](companion/README.md).

## Credits

- **[Bypass Paywalls Clean][bpc]** (`magnolia1234`, MIT) — the
  per-site rules database we import. Four years of community
  reverse-engineering compressed into [sites.generated.js](sites.generated.js).
  The `import-bpc.mjs` script transpiles BPC entries into our schema.
- **[Mozilla Readability](https://github.com/mozilla/readability)**
  (Apache 2.0) — vendored in [lib/readability.js](lib/readability.js).
  Powers Reader Mode.
- **[WebLLM](https://github.com/mlc-ai/web-llm)** (Apache 2.0) —
  loaded from MLC's CDN, runs Phi-3-mini-4k-instruct in-browser
  for the article completer.
- **[12ft.io](https://en.wikipedia.org/wiki/12ft)** — original
  centralized version of the Googlebot-UA trick. Taken down by
  News/Media Alliance on July 14, 2025. The naming convention
  "13ft" follows the same ladder metaphor.
- **[everywall/ladder](https://github.com/everywall/ladder)** —
  self-hosted reverse-proxy alternative; supported as a custom
  proxy via the popup's "custom (Ladder)…" option.

## License

The code in this repository is for personal use and educational
research. Per-site rule patterns originate from BPC (MIT). Mozilla
Readability is Apache 2.0. WebLLM is Apache 2.0. Use responsibly.

[bpc]: https://github.com/csns1/bypass-paywalls-chrome-clean-magnolia1234
