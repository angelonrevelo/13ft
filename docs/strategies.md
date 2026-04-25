# Strategies

A "strategy" is the high-level approach 13ft uses to make a publisher
serve the article body. Strategies are per-host and live in
[sites.js](../sites.js) / [sites.generated.js](../sites.generated.js)
under the `strategy` field.

## The strategy table

| Strategy        | UA                | Referer                       | Cookie | Action       | In auto-chain |
|-----------------|-------------------|-------------------------------|--------|--------------|---------------|
| `googlebot`     | Googlebot Mobile  | `google.com/search?q=<host>`  | strip  | header rewrite | yes (1)     |
| `bingbot`       | Bingbot           | `bing.com/search?q=<host>`    | strip  | header rewrite | yes (2)     |
| `cookie-reset`  | real Chrome       | natural                       | strip  | header rewrite | yes (3)     |
| `proxy`         | n/a (redirect)    | n/a                           | n/a    | main_frame redirect | yes (4) |
| `perplexitybot` | PerplexityBot     | none                          | strip  | header rewrite | manual only |
| `claudebot`     | ClaudeBot         | none                          | strip  | header rewrite | manual only |
| `gptbot`        | GPTBot            | none                          | strip  | header rewrite | manual only |
| `mobile`        | iPhone Safari     | none                          | strip  | header rewrite | manual only |

Plus orthogonal techniques that apply to ANY strategy (in
[sites.md](sites.md)): `blockRegex`, `cssRules`, `dropCookies`,
`ampRedirect`, `customJs`, `consentInject`, `printRedirect`. Plus
universal mechanisms that run on every enabled site regardless of
strategy: JSON-LD unhide, SSR state extraction (panel + hybrid
rewrite), main-world fetch/XHR interceptor, generic article-body
rescue.

## Strategy chain (auto-fallback)

```
STRATEGY_CHAIN = ["googlebot", "bingbot", "cookie-reset", "proxy"]
```

Defined in [background.js](../background.js). When the content
script's failure detector fires `bypassFailed` (anti-bot challenge,
"verify human" prompt, error markers), the SW handler advances the
strategy in `siteOverrides[host]`, increments the failure counter,
reloads the tab, sets badge to **RTRY** (orange).

After all four exhaust, the host is removed from `enabledHosts` and
added to `exhaustedHosts`. Bypass is off. Badge shows **FAIL** (red).
The popup then offers the LLM-completer button as a graceful
fallback for the user.

The AI-crawler UAs (perplexitybot/claudebot/gptbot) and `mobile`
are NOT in the auto-chain — they're available via the popup
dropdown for manual override. Reasoning: chain reloads cost user
time, and these strategies have narrower applicability (only sites
with revenue-share deals or weaker mobile detection).

## googlebot

The original 12ft.io trick. Set `User-Agent: Googlebot Mobile` and
`Referer: https://www.google.com/search?q=<host>`. Most metered
publishers serve the full article body to Googlebot for SEO
indexing.

**Default UA:**
```
Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P)
AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0
Mobile Safari/537.36
(compatible; Googlebot/2.1; +http://www.google.com/bot.html)
```

Mobile Googlebot — Google's mobile-first index favors it.

**Why it stopped working everywhere:** publishers added FCrDNS
(forward-confirmed reverse DNS) verification — they reverse-resolve
the request IP, then forward-resolve the result, and check it
belongs to Google's published IP ranges. Our extension runs from
the user's home IP, never on Google's range. Sites that do FCrDNS
return 401/403 even with a perfect UA. See
[limitations.md](limitations.md).

## bingbot

Same idea, different UA. Cloudflare's "Verified Bots" pipeline does
FCrDNS for Googlebot at scale but is more lenient on Bingbot — many
publishers' anti-bot setups fall through to "trust by UA only" for
Bingbot. Bingbot succeeds on a small but useful set of sites that
block Googlebot.

**UA:**
```
Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko;
compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)
Chrome/103.0.5060.114 Safari/537.36
```

**Referer:** `https://www.bing.com/search?q=<host>`. Matches the UA.

In the auto-fallback chain, bingbot sits between googlebot and
cookie-reset.

## cookie-reset

Don't spoof anything. Use the real Chrome User-Agent. Just strip
the Cookie header on every request to `<host>`. Useful for sites
where the meter counter lives in a cookie:

- **The Economist** — meter cookie + tinypass.
- **Wired** (Condé Nast) — `pay_ent_smp`.
- **Vox** — soft N-free-articles meter.

`cookie-reset` doesn't beat FCrDNS but **at least we look like a
real browser** — much less likely to be blocked outright.

## proxy

Don't ask the publisher at all. Redirect the main_frame request to
a third-party reader that fetches the article server-side.

**Builtin proxies** (in `BUILTIN_PROXIES`):

| Key                    | URL prefix                          | Notes                              |
|------------------------|-------------------------------------|------------------------------------|
| `archive.ph`           | `https://archive.ph/newest/`        | Flaky — Cloudflare 1.1.1.2 blocks |
| `web.archive.org`      | `https://web.archive.org/web/2/`    | Default. Slower but reliable.     |
| `freedium.cfd`         | `https://freedium.cfd/`             | Medium-specific, intermittent     |
| `freedium-mirror.cfd`  | `https://freedium-mirror.cfd/`      | Backup for freedium.cfd           |
| `readmedium.com`       | `https://readmedium.com/`           | Medium-specific, sometimes 403s   |
| `custom`               | user-supplied URL                   | Self-hosted Ladder etc.           |

**Wayback save-now fallback** (0.13.0): if Wayback returns a
no-capture page, the content script auto-redirects to
`https://web.archive.org/save/<url>` to trigger Wayback's backend
fetcher (whitelisted IPs). Snapshot gets created and Wayback
redirects to it.

**Custom (Ladder):** for power users self-hosting
[everywall/ladder](https://github.com/everywall/ladder). Set the
URL in the popup; must follow the URL-prefix shape
(`http://localhost:8080/`).

Auto-failover: SW probes each builtin proxy on alarm + on demand.
When `resolveProxy` runs, if user-selected proxy is marked
unreachable, picks the fastest reachable alternative.

## perplexitybot, claudebot, gptbot (AI-crawler UAs)

Three AI-company crawler UAs added in 0.12.0. Some publishers have
revenue-share deals with these companies and serve full content to
their crawlers (e.g., WaPo + Perplexity, AP + OpenAI).

**UAs:**
```
PerplexityBot:  Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko;
                 compatible; PerplexityBot/1.0;
                 +https://docs.perplexity.ai/guides/bots)

ClaudeBot:       Mozilla/5.0 (compatible; ClaudeBot/1.0;
                 +claudebot@anthropic.com)

GPTBot:          Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko;
                 compatible; GPTBot/1.2;
                 +https://openai.com/gptbot)
```

None set Referer — real AI crawlers don't go through search engines,
and a fake search referer would actually look suspicious.

Selectable from the popup's strategy dropdown under an
`<optgroup label="AI crawlers (revenue-share publishers)">`. Each
gets a distinct color badge (purple/orange/green).

## mobile

Mobile Safari UA. Some publishers serve simpler/less-paywalled
mobile pages with weaker meter enforcement.

**UA:**
```
Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)
AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0
Mobile/15E148 Safari/604.1
```

No Referer override. Selectable from popup; not in auto-chain.

## Picking a strategy by hand

The popup's strategy dropdown overrides the auto-resolved strategy
for the current host. Useful when:

- Site is FCrDNS-known — skip Googlebot, jump straight to proxy.
- Test less-aggressive strategies (cookie-reset is gentlest).
- Try AI-crawler UAs if you suspect the publisher has a deal with
  one of the three AI companies.
- Try mobile UA if the publisher serves easier mobile pages.

Manual choice writes to `siteOverrides[host].strategy`. Auto-fallback
shares the same field, so manual choice will get auto-advanced if
it fails.

## Per-strategy headers reference

```js
// background.js
const STRATEGY_HEADERS = {
  googlebot:     { ua: GOOGLEBOT_UA,     refererBase: "https://www.google.com/search" },
  bingbot:       { ua: BINGBOT_UA,       refererBase: "https://www.bing.com/search"   },
  perplexitybot: { ua: PERPLEXITYBOT_UA, refererBase: null },
  claudebot:     { ua: CLAUDEBOT_UA,     refererBase: null },
  gptbot:        { ua: GPTBOT_UA,        refererBase: null },
  mobile:        { ua: MOBILE_UA,        refererBase: null },
  "cookie-reset":{ ua: null,             refererBase: null }
};
```

`cookie-reset` has both null — only Cookie removal happens.

The actual Referer is built per-host:
```js
refererForHost(refererBase, host)
  // → "https://www.google.com/search?q=<host>"
```

Per-host variable Referer (0.11.0) — was constant `?q=news`,
now `?q=<host>`. Removes the constant-string fingerprint across
publisher logs.

## Per-site overrides on strategy

Site configs can carry strategy-customizing fields:

| Field              | Effect                                          |
|--------------------|-------------------------------------------------|
| `allowCookies: true` | skip Cookie removal (NYT, WaPo serve "enable cookies" wall otherwise) |
| `customUserAgent: "..."` | override strategy-default UA              |
| `useGoogleReferer: false` | disable Referer override                  |

Example from [sites.js](../sites.js):
```js
"nytimes.com": {
  strategy: "googlebot",
  allowCookies: true,
  blockRegex: [
    /meter-svc\.nytimes\.com\/meter\.js/,
    /mwcm\.nyt\.com\/.+\.js/
  ],
  dropCookies: ["nyt-gdpr", "nyt-purr", "nyt-a"],
  customJs: "nyt_defuseMeter",
  cssRules: {
    hide: ["[class*='paywall' i]", "[class*='metering' i]"],
    reveal: ["article", "[data-testid*='article' i]"]
  }
}
```

Most sites just need `strategy` + `blockRegex`.
