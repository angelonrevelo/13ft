# Limitations

What we CAN'T do, why we can't, and what users see when we hit
those walls.

## FCrDNS-verified Googlebot

**The single biggest limit.**

The Googlebot UA trick worked for the first decade of paywall
bypass tools because most sites just checked `User-Agent` strings.
Around 2022-2024, large publishers tightened: they reverse-resolve
the request IP, then forward-resolve the result, then check that
the IP belongs to Google's published ranges
([googlebot.json](https://developers.google.com/search/docs/crawling-indexing/verifying-googlebot)).

**This is called FCrDNS** (forward-confirmed reverse DNS) and it's
unbeatable from a browser extension. Our extension runs from the
user's home IP, which is by definition not in Google's range.

**Sites known to FCrDNS-verify (April 2026):**
- Financial Times — Cloudflare's "Verified Bots" pipeline.
  Confirmed in our live test: vanilla browser shows the cookie
  banner + paywall offer; with 13ft on, Cloudflare returns 403
  with a "Security Verification" CAPTCHA challenge.
- Bloomberg premium articles — sometimes returns "Are you a
  robot?" page with status 403.
- WSJ premium — returns 401, won't even serve homepages to
  Playwright sessions.
- Le Monde — returns "Oops, something went wrong. Please disable
  any ad blockers, or try using a different browser." even
  for Googlebot UAs from non-Google IPs. Active extension
  detection layered on top of FCrDNS.
- Economist on premium content — variable, depends on which
  article tier.

**What 13ft does about it:**
1. Failure detector recognizes the response (Cloudflare CAPTCHA
   markers, "verify human" text patterns) within ~3 seconds.
2. Auto-fallback advances `googlebot → bingbot → cookie-reset →
   proxy`.
3. Bingbot sometimes succeeds (laxer enforcement on FT/Bloomberg
   for a brand of crawler they care less about indexing from).
4. If the chain exhausts, bypass disables and badge shows FAIL.
   User sees the publisher's challenge, same as without our
   extension.

**What we'd need to actually beat FCrDNS:**
- An IP on Google's published ranges. Renting a Google Cloud
  Platform instance with a Googlebot-range IP is ~$5/month and
  technically works, but turns 13ft from "extension" into
  "extension + companion server" — we'd be 12ft.io v2 with all
  the same takedown vulnerabilities.
- Or: go through web.archive.org, which hits the publisher from
  a different IP that has its OWN whitelist deal with major
  publishers. This is exactly what the `proxy` strategy does.

**Practical advice:** for FCrDNS-known sites, manually pick
`proxy` strategy in the popup. Skip the auto-fallback round-trips.

## Server-gated content (truly unbypassable)

Some publishers don't gate the article body in JavaScript or via
CSS. They gate it on the server: the article body simply isn't in
the HTML response sent to non-subscribers.

**This is structurally unbypassable.** No DOM manipulation, no JS
patching, no UA spoofing helps when the bytes never reach the
browser.

**Sites that gate this way:**
- **Substack paid posts.** RSS truncates with "Read more" stub.
  Full body requires authenticated `substack.sid` cookie (paid
  subscription).
- **Patreon locked posts.** Server-gated; "Patreon viewer" sites
  in the wild are scraping aggregators of already-leaked content
  or scams, not real bypasses.
- **Ghost paid posts.** Server checks subscriber status before
  serving content.
- **beehiiv premium.** Custom content-break renderer; free RSS
  excludes premium content.
- **Buttondown, Kit/ConvertKit, Mailchimp paid drops.** All
  server-gate paid newsletter content.
- **Quora** for some questions.
- **Some WSJ/FT premium subscriber-only pieces** — even with
  perfect Googlebot impersonation, they don't include the body
  in the HTML (Google indexes the metadata only).

**What we communicate:**
- The popup will show `googlebot` strategy (default for unknown
  hosts) but nothing visibly works on these sites.
- After auto-fallback exhausts, badge shows FAIL.
- Honest answer: no extension defeats this.

**The one thing that DOES work:** if you HAVE a subscription, the
self-hosted Ladder companion (custom proxy) can use your own
session cookies. See README's "custom (Ladder)" option. Useful for
sharing your subscription's content with family on devices that
aren't logged in.

## Cloudflare CAPTCHA escalation

Our Googlebot UA spoof can trigger an UPGRADE in Cloudflare's bot-
management response — instead of just 403, you get a CAPTCHA the
user has to solve. We literally make things worse than vanilla.

**What happens:**
- Vanilla: user sees the publisher's normal paywall page (some
  content + subscribe button).
- With 13ft on: Cloudflare returns 403 + "Verify you are human"
  challenge. User can't even read the teaser.

**Mitigations in 13ft:**
- Failure detector identifies challenge pages and triggers
  auto-fallback within seconds, so the user doesn't sit on the
  CAPTCHA page long.
- Challenge-page skip prevents our content script from making
  the CAPTCHA itself broken (some Cloudflare challenges do
  integrity checking on the DOM and fail to grant a clearance
  cookie if we mutated the page).
- After exhausting all strategies, the host gets disabled, so
  the next reload is vanilla.

**What it can't fix:**
- The user already sat through one or two reloads. UX delta is
  negative for that visit.
- Once Cloudflare has flagged the IP in a session, even removing
  13ft doesn't immediately clear the flag — they may keep
  challenging for a while.

**Practical advice:** if a site CONSISTENTLY triggers Cloudflare,
manually pin its strategy to `proxy`. That bypasses the entire
publisher → Cloudflare → user pipeline.

## Active extension detection

Some publishers actively scan for our presence and serve a
generic error page when detected.

**Le Monde (confirmed in live testing):** vanilla loads. With
13ft on, the page shows:

> Oops, something went wrong.
> Please check your connection, disable any ad blockers, or try
> using a different browser.

The detection is by some combination of:
- Googlebot UA fingerprint mismatch with rest of request
- Missing cookies on a domain that requires them
- DOM-modification timing (our content script vs page boot order)

**Mitigations in 13ft:**
- Stealth markers (0.9.0): no `data-13ft-*` attributes leak into
  the DOM. Removes the trivial fingerprint.
- WeakSet-based reveal tracking: zero observable state.
- Auto-fallback: Le Monde's error page text matches our detector's
  "something went wrong" + "disable ad blocker" pattern, so we
  immediately advance strategies.

**Limit:** if a publisher decides to actively look for our SSR
panel's "13ft — extracted from SSR state" header text, they could
detect that. We could randomize the panel header to defeat that.
Currently it's intentional user-facing branding — we accept the
trade-off.

## Service-worker-served paywalls

Modern publishers (Vox, parts of NYT) deploy their OWN service
worker that intercepts article requests and applies paywall
checks server-side via Cloudflare Workers or similar edge functions.

**Why this is hard:** Chrome MV3 extensions can't intercept
requests originated by a page's own service worker. Our DNR rules
only match top-level `fetch` from the browser; once a page's SW
takes over and re-fetches the article via `fetch` from inside the
SW context, we're invisible to it.

**Mitigation in 13ft:** SSR state extraction works because the
INITIAL page-load HTML still contains the body in `__NEXT_DATA__`
even if the SW would have replaced it on subsequent navigations.
For first-load articles, we still beat this.

**Limit:** for SPA-style navigations within a session (clicking
between articles without a full page reload), the page's SW
serves the gated body and we can't see it.

## What we accept structurally

These are limits we don't try to fix because the fix would
fundamentally change what 13ft is:

- **No central server.** A self-hosted proxy companion (custom
  Ladder option) gives access to subscription content the user
  legitimately has. We won't build a public proxy for users to
  share — that's 12ft.io and gets DMCA'd.
- **No automatic rule discovery.** When a new publisher we don't
  cover ships a paywall, we don't auto-detect it. Use
  `scripts/inspect-site.mjs` or paste from a BPC update.
- **No mobile.** Chrome on iOS doesn't allow extensions. Chrome
  on Android does (in Beta only); Kiwi/Yandex browsers support
  Chrome MV3 extensions and 13ft works there. We don't ship
  install instructions because the audience is small.
- **No Firefox port.** Firefox has its own paywall-bypass
  ecosystem (Firefox BPC) and supports MV2's
  `webRequest.filterResponseData()` that lets it do response-body
  rewriting Chrome MV3 can't. They have meaningful coverage
  advantages we couldn't match without writing a parallel
  codebase.
- **Chrome Web Store distribution is permanently off.** Their
  developer policy explicitly prohibits paywall-bypass
  extensions. Re-uploading under new accounts terminates the
  developer account. We accept unpacked-only as the distribution
  model.

## Honest expectations

**Sites where 13ft reliably works:**
- Atlantic, Time, Newsweek, Fortune, Business Insider, HBR
- Spiegel, Zeit, Welt (with bingbot fallback)
- Le Figaro, La Repubblica
- Seattle Times, Boston Globe, Chicago Tribune, LA Times
- Toronto Star, Globe and Mail
- Most regional newspapers
- Medium (via web.archive.org redirect)
- Most Condé Nast (Wired, Vogue, GQ, Vanity Fair, Bon Appétit)
- Most Hearst magazines (Esquire, Elle, Cosmopolitan)

**Sites where 13ft USUALLY works but might fail:**
- NYT — works most of the time, occasionally needs a manual
  cookie clear or proxy fallback.
- Washington Post — same.
- The Economist — works for soft-meter articles, fails for hard-
  paywall premium pieces.

**Sites where 13ft USUALLY fails (ends on proxy or vanilla):**
- Financial Times (FCrDNS)
- Bloomberg premium (FCrDNS)
- WSJ premium (FCrDNS + active detection)
- Le Monde (active extension detection)

**Sites where 13ft can never work:**
- Substack paid posts
- Patreon locked posts
- Ghost paid posts
- beehiiv premium
- Any newsletter paid tier

For "USUALLY fails" cases, the proxy fallback (web.archive.org)
gives partial coverage — Wayback has snapshots of many of these,
just not all of them, and not always the latest version. That's
the floor 13ft guarantees: when nothing else works, you usually
get something on Wayback. The Wayback save-now fallback (0.13.0)
auto-triggers a fresh snapshot when no capture exists, which
covers a meaningful additional fraction.

When even that fails, the popup offers the **LLM completer**
(0.15.0) — a local Phi-3 summary of what the article is probably
about based on the visible teaser + URL. Not the article itself,
but a useful gist when nothing else works. Pure client-side, no
API key, no data leaves the user's machine.

## What we DO ship for the unbypassable

- A clear failure UI: badge shows **FAIL** (red), strategy chain
  doesn't keep cycling.
- Reader Mode as a universal floor — Mozilla Readability extracts
  whatever IS in the DOM, even if it's a teaser. Gives the user a
  clean view of whatever leaked.
- LLM completer for pure inference about what the article might
  contain, when there are no body bytes to extract.
- Honest documentation. This file. We don't pretend to bypass what
  we can't.
