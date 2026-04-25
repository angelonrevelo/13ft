# Live tests

These run 13ft against **real publisher articles**, not synthetic
fixtures. Use them when you want a real-world checkpoint: which
rules still work, which publishers tightened their paywalls since
the last release.

**Not a CI gate.** They're flaky (articles disappear, sites can
bot-block our test runner, network blips), slow (~30 seconds per
publisher), and require network. They produce a markdown report,
not a pass/fail signal.

## Run

```sh
# Curated mode (default — runs the ~25 hand-curated publishers):
node tests/live/run.mjs                              # all curated (~10 min)
node tests/live/run.mjs --filter atlantic            # one site by key
node tests/live/run.mjs --filter atlantic,wired,ft   # comma-separated keys
node tests/live/run.mjs --json out.json              # also write JSON dump
node tests/live/run.mjs --timeout 30000              # per-site nav timeout

# URL-only mode (spot-check ANY single article):
node tests/live/run.mjs --url https://www.nytimes.com/2026/04/24/us/politics/example.html
# Skips homepage scraping. Works on any host whether it's in
# DEFAULT_SITES or not (universal googlebot fallback applies).

# Generic mode (best-effort scrape across every host in DEFAULT_SITES):
node tests/live/run.mjs --generic                    # first 50 hosts
node tests/live/run.mjs --generic --generic-limit 200
node tests/live/run.mjs --generic --filter spiegel.de,lemonde.fr
# Reads sites.js + sites.generated.js (~600 hosts), iterates each
# with a generic homepage-link scorer. Slow + noisy; ~60% of sites
# yield a usable URL. Useful for the long tail you don't have a
# curated picker for.
```

Curated keys: `atlantic`, `wired`, `newyorker`, `bostonglobe`, `time`,
`spiegel`, `lemonde`, `ft`, `economist`, `bloomberg`, `medium`,
`nytimes`, `wapo`, `wsj`, `forbes`, `marketwatch`, `latimes`,
`lefigaro`, `welt`, `zeit`, `elpais`, `telegraph`, `thestar`,
`globeandmail`, `hbr`, `foreignaffairs`.

Requires Playwright. If you've already run the e2e suite, it's
installed at `/tmp/13ft-pw/node_modules/playwright` and the runner
finds it automatically. Otherwise:
```sh
cd tests/live && npm init -y && npm i playwright
```

## What it does

For each publisher:

1. **Scrape** — open the homepage in a clean Chromium, find a
   current paywalled article URL via a per-site regex against
   `<a href>` patterns.
2. **Vanilla** — open the article in a fresh Chromium with no
   extension. Record body length, paywall markers, page title.
3. **With 13ft** — open in another fresh Chromium with the
   extension loaded and the host enabled. Wait ~5s for rules to
   fire + content script + auto-fallback. Record same observations.
4. **Classify** — apply heuristics:
   - **WIN** — body delta > 1500 chars AND fewer paywall markers.
   - **WIN-SSR** — our `__NEXT_DATA__` extractor injected a panel.
   - **WIN-OVERLAY** — paywall markers gone (subset of WIN).
   - **PARTIAL** — body delta > 500 AND no subscribe prompt.
   - **NO-CHANGE** — identical to vanilla.
   - **BLOCKED** — body < 500 chars (publisher served us less than vanilla).
   - **ESCALATED** — challenge page when vanilla had none (bot detection upgrade).
   - **SKIPPED** — couldn't find an article URL on homepage.
   - **ERROR** — unhandled exception during navigation.

## Sample output

```markdown
## Live test results

Run at: 2026-04-25T12:34:56Z

| publisher       | vanilla → 13ft | delta  | verdict     |
|-----------------|----------------|-------:|-------------|
| The Atlantic    | 2493 → 9748    | +7255  | WIN         |
| Wired           | 1890 → 8201    | +6311  | WIN         |
| The New Yorker  | 2104 → 7980    | +5876  | WIN-OVERLAY |
| Boston Globe    | 1240 → 7102    | +5862  | WIN         |
| Time            | 3104 → 9420    | +6316  | WIN         |
| Der Spiegel     | 4012 → 8950    | +4938  | WIN         |
| Le Monde        | 4018 → 117     | -3901  | BLOCKED     |
| Financial Times | 2535 → 564     | -1971  | ESCALATED   |
| The Economist   | 2683 → 2683    | 0      | NO-CHANGE   |
| Bloomberg       | 1892 → 4220    | +2328  | PARTIAL     |
| Medium          | 215 → 8902     | +8687  | WIN         |

Summary: WIN=7  PARTIAL=1  NO-CHANGE=1  BLOCKED=1  ESCALATED=1
```

## How to interpret

- **WIN / WIN-SSR / WIN-OVERLAY:** the rule for this site works.
  Nothing to do.
- **PARTIAL:** body got longer but the subscribe prompt is still
  present. Consider tightening `cssRules.hide` for this site.
- **NO-CHANGE:** rule fired but produced no observable difference.
  Either the article wasn't paywalled to begin with (false-paywall
  scrape) or the rule is no-op'ing. Re-run to check.
- **BLOCKED:** the site detected our bypass and served less content
  than vanilla. Check whether `dropCookies` is too aggressive or
  the `Googlebot` UA triggered active extension detection. May
  need to switch the default strategy to `cookie-reset` or `proxy`.
- **ESCALATED:** the site upgraded from a normal paywall to a
  Cloudflare/PerimeterX challenge in response to our bypass. Strong
  signal to swap default strategy to `proxy` for this host (skip
  `googlebot` entirely so we don't trigger the challenge).
- **SKIPPED:** homepage layout changed and our article-link regex
  no longer matches. Update the `pick` function in `run.mjs` for
  this site.

## Tracking trends across runs

Pass `--json out.json` to dump structured results. You can keep a
log of recent runs:

```sh
node tests/live/run.mjs --json tests/live/runs/$(date +%F).json
```

Compare deltas across runs to spot regressions:

```sh
diff <(jq '.results[] | {site, verdict}' tests/live/runs/2026-04-18.json) \
     <(jq '.results[] | {site, verdict}' tests/live/runs/2026-04-25.json)
```

## Ethics + frequency

Running automated bot traffic against real publishers IS the kind
of thing their anti-bot teams notice. Some guardrails:

- **Don't run on every commit.** Weekly or pre-release is enough.
- **One article per publisher per run** — the runner picks just
  one current article from the homepage; we don't crawl.
- **Timeouts default to 20s** — we're not pounding the server.
- **Each session is fresh** — no persistent fingerprint to make
  us look like a bot farm; each run looks like a different user.

If you find your test machine getting bot-blocked even on vanilla
runs, the publisher fingerprinted Playwright/Chromium itself. At
that point, live testing isn't viable for that site from this
machine. Switch to a real Chrome profile via `channel: "chrome"`
(but accept the Developer Mode toggle issue).

## Adding a new site

Each `SITES` entry needs:

```js
{
  key: "shortname",
  label: "Display Name",
  homepage: "https://www.publisher.com/",
  enableHost: "publisher.com",
  pick: () => {
    // Runs in the page context. Return the URL string of one
    // current paywalled article, or null if none found.
    const re = /url-pattern-for-this-publisher's-articles/;
    for (const a of [...document.querySelectorAll("a[href]")]) {
      try {
        const u = new URL(a.href);
        if (u.hostname.endsWith("publisher.com") && re.test(u.pathname))
          return u.toString();
      } catch {}
    }
    return null;
  }
}
```

The regex needs to be specific enough to land on an ARTICLE URL,
not a section page or topic listing. Inspect the publisher's
homepage manually first, find a few article URLs, look for a
common path pattern.
