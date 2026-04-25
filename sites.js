// 13ft — curated default site config.
//
// ─── Two-layer architecture ──────────────────────────────────────
// Universal mechanisms (always on — no per-site config needed):
//   1. Googlebot UA + Google Referer spoof + Cookie strip as the
//      default strategy for any unknown host.
//   2. JSON-LD unhide (Schema.org paywalled-content spec) — any site
//      that marks paywalled regions via `isAccessibleForFree:false`
//      + `hasPart.cssSelector` has those regions revealed.
//   3. Generic overlay heuristics — fixed/absolute-positioned
//      elements with paywall/regwall/modal-subscribe in id/class
//      are removed.
//   4. Medium-family proxy redirect (archive.ph / wayback / freedium)
//      handled entirely by BUILTIN_PROXIES + the proxy strategy.
//
// Per-site refinements (optional — this file + sites.generated.js):
//   5. blockRegex: kill paywall JS before it loads (highest impact).
//   6. cssRules: site-specific hide/reveal selectors.
//   7. ampRedirect, dropCookies, customJs: situational tools.
//
// Universal-only mode: delete every entry from DEFAULT_SITES and
// the extension still bypasses metered paywalls via mechanisms 1–4.
// You lose: block_regex shortcuts on hardened sites (WSJ/Bloomberg/FT
// will 401/403 under bare Googlebot UA), per-publisher overlay rules
// (Condé Nast/Hearst). You keep: everything that "just works" on
// spec-compliant metered publishers.
//
// ─── sites.generated.js ──────────────────────────────────────────
// ~600 extra entries imported from the Bypass Paywalls Clean project
// via `node scripts/import-bpc.mjs`. Hand-curated entries here WIN
// over generated ones, so edit freely — the generator won't stomp.
//
// ─── Schema ──────────────────────────────────────────────────────
// Keyed by registrable domain (no www., no subdomain). Subdomains of
// the listed domain are matched automatically at rule-build time.
//
// Strategies:
//   "googlebot"    — spoof Googlebot UA + Google referer, strip cookies.
//                    Works on sites that serve the full article to
//                    search crawlers for SEO (most major newspapers).
//   "proxy"        — redirect main_frame to the user-selected content
//                    proxy (archive.ph / freedium.cfd / readmedium.com /
//                    web.archive.org / custom Ladder). Required when the
//                    article body isn't in the HTML for non-members
//                    (Medium, paid Substacks).
//   "cookie-reset" — strip cookies only, keep real UA. Beats sites that
//                    meter by cookie (N-free-articles walls) without
//                    triggering their Googlebot-detection heuristics.
//
// Per-domain overrides:
//   allowCookies:      skip the Cookie removal (some sites break without
//                      session cookies — rare).
//   useGoogleReferer:  set to false to keep the original referer.
//   customUserAgent:   override the default Googlebot UA.
//   cssRules:          { hide: [selectors], reveal: [selectors] }
//                      hide:   remove these nodes (paywall overlays).
//                      reveal: force these nodes visible (article bodies
//                              hidden behind display:none / blur / truncate).
//                      Selectors can use `[class*='foo' i]` for fuzzy
//                      matching — useful for CSS-in-JS sites where the
//                      class name suffix changes per build.
//   blockRegex:        Array of RegExp or strings matching URL paths of
//                      paywall JS/API calls to block at the network
//                      layer via DNR. This is the highest-impact
//                      technique — prevents the paywall from ever
//                      running, rather than removing it after injection.
//                      Patterns are matched against the FULL request
//                      URL. Use DNR regex subset: no lookbehinds, no
//                      backreferences.
//   ampRedirect:       true → content script looks for
//                      <link rel="amphtml"> and navigates there.
//                      AMP pages often omit paywall JS entirely.
//   dropCookies:       [cookieName, ...]. Client-side expires each
//                      named cookie across path+domain combinations so
//                      the next request resets the meter counter. Used
//                      for metered sites where the paywall state lives
//                      in a named cookie (NYT, Atlantic, Cond\u00e9 Nast).
//   customJs:          Name of a function in CUSTOM_JS_FUNCTIONS
//                      (custom.js). Injected into the page's MAIN
//                      world at document_start for monkey-patching
//                      fetch/XHR/globals before the paywall boots.
//
// Shared regex fragments (referenced by multiple sites).
//
// Users can add their own entries or override any of these via the
// extension popup (stored in chrome.storage.local as `siteOverrides`).

// Hosts where enabling 13ft is actively counterproductive. These sites
// detect Googlebot UAs from non-Google IPs and block the request outright
// (Reddit's "whoa there, pardner" 403 is the canonical example), or
// simply aren't paywalled. The popup shows a disabled toggle on these.
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

// Shared paywall-JS regex patterns. Referenced by site entries below.
// These are the ubiquitous SaaS paywall/meter providers — blocking
// them at the network layer stops a large fraction of paywalls cold.
const AMP_PAYWALL_JS = /cdn\.ampproject\.org\/v\d\/amp-(access|subscriptions)-.+\.js/;
const TINYPASS_JS    = /\.tinypass\.com\//;
const PIANO_JS       = /\.piano\.io\/(api|xbuilder|esp|id\/api)/;

self.DEFAULT_SITES = {
  // --- A. Googlebot-bypass (full article in HTML for crawlers) ---
  // Note: several large publishers (FT, NYT, Bloomberg, WSJ, Economist)
  // now do FCrDNS / Google-IP-range verification on Googlebot, so the UA
  // spoof may fail. Fall back to proxy strategy from the popup if needed.
  //
  // Nearly every entry now carries blockRegex — these patterns match
  // the paywall JS bundles the site loads; blocking them prevents the
  // paywall from ever initializing. Rules sourced from the community
  // Bypass Paywalls Clean project (MIT-licensed).
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
  },
  "washingtonpost.com": {
    strategy: "googlebot",
    allowCookies: true,
    blockRegex: [/\.washingtonpost\.com\/tetro\/evaluate/],
    cssRules: {
      hide: ["[class*='paywall' i]", "[data-qa*='paywall' i]"],
      reveal: ["article", "[data-qa='article-body']"]
    }
  },
  "wsj.com": {
    strategy: "googlebot",
    allowCookies: true,
    ampRedirect: true,            // WSJ's /amp/ pages omit paywall JS
    blockRegex: [/cdn\.cxense\.com\//, AMP_PAYWALL_JS]
  },
  "bloomberg.com": {
    strategy: "googlebot",
    blockRegex: [
      TINYPASS_JS,
      /assets\.bwbx\.io\/s\d\/(fence\/plug-client|javelin\/.+\/transporter)\//
    ]
  },
  "barrons.com":        { strategy: "googlebot", blockRegex: [/cdn\.cxense\.com\//, AMP_PAYWALL_JS] },
  "ft.com":             { strategy: "googlebot", blockRegex: [AMP_PAYWALL_JS] },
  "businessinsider.com":{ strategy: "googlebot" },
  "forbes.com":         { strategy: "googlebot", allowCookies: true, blockRegex: [TINYPASS_JS, AMP_PAYWALL_JS] },
  "fortune.com":        { strategy: "googlebot" },
  "hbr.org":            { strategy: "googlebot", blockRegex: [TINYPASS_JS] },
  "marketwatch.com":    { strategy: "googlebot", allowCookies: true, blockRegex: [/cdn\.cxense\.com\//] },
  "foreignaffairs.com": {
    strategy: "googlebot",
    blockRegex: [/\.foreignaffairs\.com\/sites\/default\/files\/js\/js_[^y].+\.js/]
  },
  "foreignpolicy.com":  { strategy: "googlebot", allowCookies: true },
  "theatlantic.com": {
    strategy: "googlebot",
    blockRegex: [AMP_PAYWALL_JS],
    dropCookies: ["articleViews"]
  },
  "newyorker.com":      { strategy: "googlebot", blockRegex: [/journey\.newyorker\.com\/build-.+\.js/, AMP_PAYWALL_JS] },
  "time.com":           { strategy: "googlebot" },
  "newsweek.com":       { strategy: "googlebot" },
  "latimes.com":        { strategy: "googlebot" },
  "seattletimes.com":   { strategy: "googlebot" },
  "bostonglobe.com":    { strategy: "googlebot" },
  "chicagotribune.com": { strategy: "googlebot" },
  "telegraph.co.uk":    { strategy: "googlebot" },
  "theglobeandmail.com":{ strategy: "googlebot" },
  "thestar.com":        { strategy: "googlebot" },
  "lemonde.fr":         { strategy: "googlebot" },
  "lefigaro.fr":        { strategy: "googlebot" },
  "spiegel.de":         { strategy: "googlebot" },
  "welt.de":            { strategy: "googlebot" },
  "zeit.de":            { strategy: "googlebot" },
  "haaretz.com":        { strategy: "googlebot" },

  // --- Condé Nast magazines (shared paywall infrastructure) ---
  // All served by the same Piano-based "journey" bundle; blocking
  // `journey.<domain>/build-*.js` + the AMP paywall JS neutralizes the
  // overlay on every property.
  "bonappetit.com":   { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.bonappetit\.com\/build-.+\.js/,   AMP_PAYWALL_JS] },
  "gq.com":           { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.gq\.com\/build-.+\.js/,           AMP_PAYWALL_JS] },
  "vanityfair.com":   { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.vanityfair\.com\/build-.+\.js/,   AMP_PAYWALL_JS] },
  "vogue.com":        { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.vogue\.com\/build-.+\.js/,        AMP_PAYWALL_JS] },
  "architecturaldigest.com": { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.architecturaldigest\.com\/build-.+\.js/, AMP_PAYWALL_JS] },
  "self.com":         { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.self\.com\/build-.+\.js/,         AMP_PAYWALL_JS] },
  "pitchfork.com":    { strategy: "googlebot", dropCookies: ["pay_ent_smp"], blockRegex: [/journey\.pitchfork\.com\/build-.+\.js/,    AMP_PAYWALL_JS] },

  // --- Hearst magazines (single shared bootstrap script) ---
  "esquire.com":           { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "elle.com":              { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "cosmopolitan.com":      { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "menshealth.com":        { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "womenshealthmag.com":   { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "popularmechanics.com":  { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "goodhousekeeping.com":  { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "housebeautiful.com":    { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "townandcountrymag.com": { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },
  "roadandtrack.com":      { strategy: "googlebot", allowCookies: true, blockRegex: [/nexus\.ensighten\.com\/hearst\/mag\/Bootstrap\.js/] },

  // --- B. Proxy (server-side gating — content not in HTML) ---
  // Note: Substack paid posts were dropped. RSS truncates with "Read more"
  // and the full body requires an authenticated substack.sid cookie. No
  // proxy (archive.ph, freedium, etc.) reliably renders them. Leaving
  // substack unconfigured so the popup shows googlebot fallback, which
  // won't help but won't actively break anything either.
  "medium.com":         { strategy: "proxy" },

  // --- C. Cookie-reset (soft N-free-articles counters) ---
  "economist.com": {
    strategy: "cookie-reset",
    blockRegex: [TINYPASS_JS, AMP_PAYWALL_JS]
  },
  "wired.com": {
    strategy: "cookie-reset",
    blockRegex: [/journey\.wired\.com\/build-.+\.js/, AMP_PAYWALL_JS],
    dropCookies: ["pay_ent_smp"],
    cssRules: {
      // Condé Nast shared patterns. Class names are CSS-in-JS hashed
      // (e.g. `PaywallFragment-abc123`) — normalizeClassToken strips
      // the hash so [class*='paywallfragment' i] matches regardless.
      hide: [
        "[class*='paywallfragment' i]",
        "[class*='paywallbarrier' i]",
        "[class*='RegWallFragment' i]",
        "[class*='journey-unit' i]"
      ],
      reveal: [
        "[class*='body__container' i]",
        "[class*='paywall-body' i]",
        "[class*='article-body' i]"
      ]
    }
  },
  "vox.com":            { strategy: "cookie-reset" }
};
