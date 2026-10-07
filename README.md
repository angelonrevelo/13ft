<p align="center">
  <img src="https://img.shields.io/badge/Chrome-MV3_extension-4285F4?logo=googlechrome&logoColor=white" alt="Chrome MV3 extension">
  <img src="https://img.shields.io/badge/JavaScript-no_build_step-F7DF1E?logo=javascript&logoColor=black" alt="JavaScript, no build step">
  <img src="https://img.shields.io/badge/install-load_unpacked-lightgrey" alt="Install: load unpacked">
</p>

# 13ft

**A Chrome extension that gets you past news paywalls — no server, no account, ~600 publishers out of the box.**

12ft.io used to do this centrally until it was taken down in 2025. 13ft does the
same trick from inside your own browser instead: it makes the page believe you
are a search-engine crawler, strips the paywall scripts before they load, and
reveals the article text that was already sent to you.

When that is not enough, it falls back step by step — a different crawler
identity, a cookie reset, then an archive proxy — and as a last resort opens the
article in a clean Reader Mode. Site rules come from the community-maintained
[Bypass Paywalls Clean][bpc] list, imported automatically.

It is not on the Chrome Web Store and will not be: Google's policy forbids
paywall-bypass extensions, so you install it from this folder.

## Quick start

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and pick this folder.
4. Pin the **13ft** icon.

Try it: open any article on [theatlantic.com](https://www.theatlantic.com/),
click the 13ft icon, flip the toggle on. The sign-in prompt disappears and the
full story renders.

## Using it

- **Toggle** — turns 13ft on or off for the site you are on. The badge reads
  **ON** (green), **RTRY** (orange, trying the next strategy) or **FAIL** (red).
- **Strategy** — pick how 13ft disguises the request; it cycles automatically if
  one fails.
- **Reader Mode** — a clean, distraction-free copy of the article with themes,
  read-aloud and Markdown copy.
- **Dashboard** — which sites failed, which strategies worked, proxy health.

Some sites (Reddit, X, GitHub…) are deliberately blocked from being toggled on,
because the crawler disguise makes them worse, not better.

## Configuration

No `.env` and no API keys. Everything lives in the popup: the content proxy
(Wayback by default, or your own [Ladder](https://github.com/everywall/ladder)
URL) and an optional rules URL for weekly auto-updates.

## How it works

```
click toggle
   │
   ├─ network  : crawler User-Agent + search Referer, block paywall scripts
   ├─ page JS  : rewrite "paid" flags in API/JSON before the page reads them
   └─ DOM      : unhide JSON-LD articles, strip overlays, rescue the body
   │
   failed? → googlebot → bingbot → cookie reset → archive proxy → Reader Mode
```

A few sites (FT, Bloomberg, WSJ premium) check that "Googlebot" really comes
from Google's IP ranges, which no extension can fake; the optional
[self-hosted companion](companion/README.md) covers those. Subscriber-only
content that never reaches your browser (Substack paid, Patreon) cannot be
recovered at all — see [docs/limitations.md](docs/limitations.md).

## More

- [docs/internals.md](docs/internals.md) — full feature list, popup reference, architecture, maintenance scripts, test suites
- [docs/architecture.md](docs/architecture.md) · [docs/sites.md](docs/sites.md) · [docs/strategies.md](docs/strategies.md) · [docs/testing.md](docs/testing.md) · [docs/hardening.md](docs/hardening.md)
- [CHANGELOG.md](CHANGELOG.md)

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
