// 13ft — client-side paywall stripping.
//
// Runs on every page. If the site is enabled:
//  1. Apply generic paywall-overlay heuristics (fixed-position, high
//     z-index, paywall-ish id/class names).
//  2. Reveal content paywalled per Google's Schema.org paywalled-content
//     spec: parse JSON-LD `<script>` tags for `hasPart.cssSelector`
//     entries flagged `isAccessibleForFree:false` and force those nodes
//     visible. This is the highest-yield universal technique — works on
//     most large metered publishers without any per-site config.
//  3. Apply per-site `cssRules` from sites.js when present (hide
//     overlays, reveal article bodies with targeted selectors).
//
// All work is idempotent and re-runs on DOM mutations, since many
// paywalls inject overlays after load.

// Wayback save-now handler. When our proxy strategy redirects a
// paywalled URL to web.archive.org/web/.../<url> and Wayback has no
// snapshot of that URL, Wayback shows a "Hrm." page and stops there.
// We detect that, then redirect to web.archive.org/save/<url> which
// asks Wayback to fetch + cache the article from THEIR backend
// (whitelisted IPs, exempt from publisher anti-bot). Once saved,
// Wayback redirects to the new snapshot.
async function tryWaybackSaveNow(enabledHosts) {
  if (location.pathname.startsWith("/save/")) return false;
  const m = location.pathname.match(/^\/web\/[^/]+\/(https?:\/\/.+)$/);
  if (!m) return false;
  const originalUrl = m[1] + location.search + location.hash;
  let originalHost;
  try {
    originalHost = new URL(originalUrl).hostname.replace(/^www\./, "");
  } catch { return false; }

  // Only auto-save if the user enabled bypass for this host. We
  // don't want to trigger save-now on random Wayback browsing.
  const matched = (enabledHosts || []).some(
    (d) => originalHost === d || originalHost.endsWith("." + d)
  );
  if (!matched) return false;

  // Wait for Wayback's no-capture UI to render before we sniff.
  await new Promise((r) => setTimeout(r, 1200));
  const bodyText = (document.body?.innerText || "").slice(0, 4000);
  const hasNoCapture =
    !!document.querySelector("#hrm") ||
    /Hrm\.|we have no record of this URL|URL not found in calendar|This URL has been excluded/i
      .test(bodyText);
  if (!hasNoCapture) return false;

  // Sentinel: prevents redirect loops if /save/ itself ends up at
  // a no-capture state (very rare but possible).
  const SENTINEL = "__ft13_wayback_saved_" + originalUrl;
  if (sessionStorage.getItem(SENTINEL)) return false;
  sessionStorage.setItem(SENTINEL, "1");

  location.replace("https://web.archive.org/save/" + originalUrl);
  return true;
}

(async function () {
  const host = location.hostname.replace(/^www\./, "");
  const { enabledHosts, siteOverrides, diagnosticMode } =
    await chrome.storage.local.get([
      "enabledHosts", "siteOverrides", "diagnosticMode"
    ]);

  // ---- Diagnostic mode ----
  // When enabled, the content script logs every paywall-shaped
  // request URL + suspicious DOM element + meter cookie to a
  // window-attached buffer. The popup's "Generate report" button
  // reads this buffer and emits a paste-ready sites.js entry.
  // Runs on ALL pages (not just enabled hosts) when diagnosticMode
  // is on so users can probe new sites before adding them.
  if (diagnosticMode) {
    self.__ft13_diag = self.__ft13_diag || {
      host, scriptUrls: [], cookies: [], paywallElements: [],
      jsonLdSelectors: [], ampHref: null, ssrShape: null,
      startedAt: Date.now()
    };
    const PAYWALL_HINTS = /paywall|meter|subscribe|gate|piano|tinypass|journey|reg.?wall|metering/i;
    // Intercept all <script src> additions via PerformanceObserver
    // (initiator type "script") + a MutationObserver fallback for
    // dynamic injects.
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          if (e.initiatorType === "script" && PAYWALL_HINTS.test(e.name)) {
            if (self.__ft13_diag.scriptUrls.length < 100 &&
                !self.__ft13_diag.scriptUrls.includes(e.name)) {
              self.__ft13_diag.scriptUrls.push(e.name);
            }
          }
        }
      });
      po.observe({ type: "resource", buffered: true });
    } catch {}

    setTimeout(() => {
      // After a beat, snapshot DOM signals.
      try {
        for (const el of document.querySelectorAll(
          "[id*='paywall' i], [class*='paywall' i], " +
          "[id*='regwall' i], [class*='regwall' i], " +
          "[id*='metering' i], [class*='metering' i]"
        )) {
          const tag = el.tagName.toLowerCase();
          const sel = el.id ? `#${el.id}` :
            (typeof el.className === "string" ? "." + el.className.split(/\s+/)[0] : tag);
          if (self.__ft13_diag.paywallElements.length < 50 &&
              !self.__ft13_diag.paywallElements.includes(sel)) {
            self.__ft13_diag.paywallElements.push(sel);
          }
        }
        const ampLink = document.querySelector('link[rel="amphtml"]');
        if (ampLink) self.__ft13_diag.ampHref = ampLink.href;
        const cookies = document.cookie.split(/;\s*/).map((c) => c.split("=")[0])
          .filter((n) => n && PAYWALL_HINTS.test(n) || /meter|count|view|visit|gdpr/i.test(n));
        self.__ft13_diag.cookies = cookies;
        // Note SSR shape detected
        const ssrTag = document.querySelector(
          "script#__NEXT_DATA__, script#__NUXT__, script#__REMIX_CONTEXT__"
        );
        if (ssrTag) self.__ft13_diag.ssrShape = ssrTag.id;
      } catch {}
    }, 2500);
  }


  // Wayback special-case: runs even when web.archive.org isn't in
  // enabledHosts itself (we landed here via a proxy redirect).
  if (host === "web.archive.org") {
    await tryWaybackSaveNow(enabledHosts || []);
    return; // never run normal strip pipeline on Wayback.
  }

  if (!enabledHosts || enabledHosts.length === 0) return;

  // Match exact host OR any parent domain (so overlays get stripped on
  // `baili.substack.com` when `substack.com` is enabled).
  const enabledParent = enabledHosts.find(
    (d) => host === d || host.endsWith("." + d)
  );
  if (!enabledParent) return;

  // --- Challenge-page guard ---
  //
  // If we're on (or framed inside) a known anti-bot challenge surface
  // — Cloudflare's challenge stage, PerimeterX, DataDome, Akamai
  // BotManager — DO NOT modify the DOM. Mutating a challenge page
  // can interfere with its own JS (which validates DOM integrity
  // before granting a clearance cookie), causing reload loops we
  // can't escape from. We still let the failure detector at the
  // bottom of this script run so auto-fallback can kick in.
  function looksLikeChallengePage() {
    const h = location.hostname;
    if (
      /^(challenges\.cloudflare\.com|client\.perimeterx\.net|.+\.captcha-delivery\.com|.+\.datadome\.co)$/i
        .test(h)
    ) return true;
    const titleLower = (document.title || "").toLowerCase();
    if (/just a moment|security verification|security check|access denied/.test(titleLower)) {
      return true;
    }
    if (document.querySelector(
      "#challenge-stage, #challenge-form, #cf-challenge-running, " +
      "iframe[src*='challenges.cloudflare'], " +
      "iframe[src*='ct.captcha-delivery.com']"
    )) return true;
    return false;
  }
  const onChallenge = looksLikeChallengePage();

  // Per-site rules — merge default (from sites.js) with user override
  // (from chrome.storage.local.siteOverrides). Override wins per-field
  // so a user can extend a default entry with additional dropCookies /
  // customJs / ampRedirect without re-declaring everything.
  // DEFAULT_SITES is on `self` because sites.js runs as a content
  // script before this file (declared first in content_scripts.js).
  const defaults = (self.DEFAULT_SITES && self.DEFAULT_SITES[enabledParent]) || {};
  const overrides = (siteOverrides && siteOverrides[enabledParent]) || {};
  const siteRules = { ...defaults, ...overrides };
  const cssRules = siteRules.cssRules || {};

  // --- AMP redirect. If this site flags ampRedirect and the page
  // has a canonical <link rel="amphtml"> pointing elsewhere, redirect
  // to GOOGLE'S AMP CACHE rather than the publisher's own AMP URL.
  // The cache (cdn.ampproject.org) serves cleaned AMP HTML from
  // Google's CDN — Google IS the bot, so the publisher's anti-bot
  // doesn't apply. URL shape for HTTPS sources:
  //   https://cdn.ampproject.org/c/s/<host>/<path>
  // For HTTP sources, drop the trailing /s/.
  if (!onChallenge && siteRules.ampRedirect) {
    const ampLink = document.querySelector('link[rel="amphtml"]');
    const ampHref = ampLink?.href;
    const alreadyAmp =
      /\/amp\/|[?&]outputType=amp\b|\.amp\.|cdn\.ampproject\.org/
        .test(location.href);
    if (ampHref && ampHref !== location.href && !alreadyAmp) {
      let target = ampHref;
      try {
        const u = new URL(ampHref);
        const cachePrefix = u.protocol === "https:"
          ? "https://cdn.ampproject.org/c/s/"
          : "https://cdn.ampproject.org/c/";
        target = cachePrefix + u.host + u.pathname + u.search + u.hash;
      } catch {
        // Malformed amphtml href — fall back to the raw URL.
      }
      location.replace(target);
      return; // page is leaving; no further stripping needed.
    }
  }

  // --- Cookie-consent injection. Pre-populates GDPR consent cookies
  // so EU sites render content without showing a consent banner.
  // Most cookie-banner libs check for these BEFORE rendering the
  // banner; pre-populating skips the banner entirely.
  // siteRules.consentInject: true | "array of {name, value}".
  if (!onChallenge && siteRules.consentInject) {
    const yearFromNow = new Date(Date.now() + 365 * 86400 * 1000).toUTCString();
    const COOKIE_OPTS = `; expires=${yearFromNow}; path=/; SameSite=Lax`;
    // Common consent-cookie patterns. Values represent "accepted all
    // categories" in their respective formats:
    //  - euconsent-v2: minimal valid IAB TCF v2 consent string
    //  - OptanonConsent: OneTrust accepted-all
    //  - consentUUID: Sourcepoint UUID (random)
    //  - cmpcc / didomi: common European library cookies
    const DEFAULT_CONSENT = [
      { name: "euconsent-v2", value: "CPaCxIAPaCxIAAGABCENB-CgAP_AAH_AAATIK7Nf_X__b3_j-_5_f_t0eY1P9_7__-0zjhfdt-8N3f_X_L8X42M7vF36pq4KuR4Eu3LBIQdlHOHcTUmw6okVrTPsbk2Mr7NKJ7PEinMbe2dYGH9_n93TuZKY7_____z__7N_4__9_-_8AA" },
      { name: "OptanonConsent", value: "isGpcEnabled=0&datestamp=" + new Date().toISOString() + "&version=202401.1.0&isIABGlobal=false&hosts=&consentId=auto&interactionCount=1&landingPath=NotLandingPage&groups=C0001:1,C0002:1,C0003:1,C0004:1" },
      { name: "OptanonAlertBoxClosed", value: new Date().toISOString() },
      { name: "didomi_token", value: "auto-accepted" },
      { name: "cookieyes-consent", value: "consentid:auto,consent:yes,action:yes" }
    ];
    const cookies = Array.isArray(siteRules.consentInject)
      ? siteRules.consentInject
      : DEFAULT_CONSENT;
    for (const c of cookies) {
      try {
        document.cookie = `${c.name}=${c.value}${COOKIE_OPTS}`;
        document.cookie = `${c.name}=${c.value}${COOKIE_OPTS}; domain=.${location.hostname}`;
        const parts = location.hostname.split(".");
        if (parts.length >= 2) {
          document.cookie = `${c.name}=${c.value}${COOKIE_OPTS}; domain=.${parts.slice(-2).join(".")}`;
        }
      } catch {}
    }
  }

  // --- Targeted cookie drop. Removes named cookies on the current
  // domain so the NEXT request resets the paywall counter / gating
  // flag. BPC's `remove_cookies_select_drop` analog. Current request
  // already went out with them; user must reload once to see effect.
  if (!onChallenge && Array.isArray(siteRules.dropCookies)) {
    const past = "Thu, 01 Jan 1970 00:00:00 GMT";
    for (const name of siteRules.dropCookies) {
      document.cookie = `${name}=; expires=${past}; path=/`;
      document.cookie = `${name}=; expires=${past}; path=/; domain=${location.hostname}`;
      document.cookie = `${name}=; expires=${past}; path=/; domain=.${location.hostname}`;
      // Also try a public-suffix-stripped domain (".example.com" for
      // "www.example.com"). This catches cookies scoped one level up.
      const parts = location.hostname.split(".");
      if (parts.length >= 2) {
        document.cookie =
          `${name}=; expires=${past}; path=/; domain=.${parts.slice(-2).join(".")}`;
      }
    }
  }

  const OVERLAY_HINTS = [
    "paywall", "piano-", "tp-modal", "tp-backdrop", "meter-",
    "subscribe", "subscription", "regwall", "reg-wall", "register-wall",
    "offer-wall", "gate", "metering", "modal-subscribe"
  ];

  // Borrowed from easydiv's detector.js:93 (normalizeClassToken). Strips
  // CSS-in-JS hashes (emotion, styled-components, CSS Modules) so a
  // stable prefix check matches across publisher builds.
  function normalizeClassToken(tok) {
    if (!tok) return "";
    if (/^_[a-z0-9]{5,}$/i.test(tok)) return "";          // e.g. _a1b2c3d
    if (/^(css|sc|jsx)-[a-z0-9-]{4,}$/i.test(tok)) return ""; // emotion/styled-components/jsx
    const m = tok.match(/^(.+?)[-_][a-f0-9]{5,}$/i);
    if (m) return m[1];                                    // trailing hash → strip
    return tok.toLowerCase();
  }

  function looksLikeOverlay(el) {
    if (!(el instanceof HTMLElement)) return false;
    const id = (el.id || "").toLowerCase();
    const cls = (typeof el.className === "string" ? el.className : "")
      .split(/\s+/)
      .map(normalizeClassToken)
      .join(" ")
      .toLowerCase();
    const hay = id + " " + cls;
    return OVERLAY_HINTS.some((h) => hay.includes(h));
  }

  // Force-visible styles. Paywall CSS commonly uses one of these six
  // techniques; we override all of them with !important.
  const REVEAL_STYLES = [
    ["display", "block"],
    ["visibility", "visible"],
    ["opacity", "1"],
    ["filter", "none"],
    ["-webkit-filter", "none"],
    ["max-height", "none"],
    ["height", "auto"],
    ["overflow", "visible"],
    ["pointer-events", "auto"]
  ];

  function reveal(el) {
    if (!(el instanceof HTMLElement)) return;
    for (const [prop, val] of REVEAL_STYLES) {
      el.style.setProperty(prop, val, "important");
    }
  }

  // Walk a JSON-LD blob recursively, yielding every cssSelector whose
  // ancestor object has isAccessibleForFree set to false/"False".
  // Schema.org spec: https://developers.google.com/search/docs/appearance/structured-data/paywalled-content
  function* jsonLdPaywalledSelectors(node, ancestorPaywalled = false) {
    if (!node) return;
    if (Array.isArray(node)) {
      for (const child of node) yield* jsonLdPaywalledSelectors(child, ancestorPaywalled);
      return;
    }
    if (typeof node !== "object") return;
    const flag = node.isAccessibleForFree;
    const paywalled = ancestorPaywalled ||
      flag === false || flag === "False" || flag === "false";
    if (paywalled && typeof node.cssSelector === "string" && node.cssSelector.trim()) {
      yield node.cssSelector.trim();
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") yield* jsonLdPaywalledSelectors(v, paywalled);
    }
  }

  function revealJsonLdPaywalled() {
    const scripts = document.querySelectorAll(
      'script[type="application/ld+json"]'
    );
    for (const s of scripts) {
      let data;
      try { data = JSON.parse(s.textContent || "null"); }
      catch { continue; }
      for (const sel of jsonLdPaywalledSelectors(data)) {
        try {
          document.querySelectorAll(sel).forEach(reveal);
        } catch {
          // invalid selector — ignore.
        }
      }
    }
  }

  // --- SSR state extraction ---
  //
  // Modern React/Next.js/Nuxt publishers serialize the full article
  // body as JSON inside a <script> tag for server-side rendering,
  // then only render the teaser in the DOM for anonymous users. We
  // can read that JSON directly — the content is present, it's just
  // not painted. This beats the paywall without any UA spoofing or
  // IP-fingerprint exposure. It's the single most powerful bypass
  // against modern JS-framework publishers (NYT, Atlantic, Vox,
  // Wired-like stacks).
  //
  // Strategy: walk each known SSR script tag, look for string values
  // that look like article bodies (long text with HTML paragraph
  // markers or block structures), and append the recovered body to
  // the existing <article> element with a clear visual marker.

  const SSR_SCRIPT_SELECTORS = [
    "script#__NEXT_DATA__",
    "script#__NUXT__",
    "script#__REMIX_CONTEXT__",
    "script#__APOLLO_STATE__",
    'script[type="application/json"][data-sveltekit-fetched]'
  ];

  // Keys the top-level content is most commonly stored under. Ordered
  // by specificity — more specific keys checked first.
  const ARTICLE_BODY_KEYS = [
    "articleBody", "bodyHtml", "body_html", "renderedBody",
    "body", "content", "html", "text"
  ];

  function looksLikeArticleHtml(s) {
    if (typeof s !== "string") return false;
    if (s.length < 500) return false;
    // Must contain at least one paragraph-ish marker to distinguish
    // from ad scripts, URLs, etc. Accept HTML, markdown, or
    // double-newline-separated prose.
    return /<p[\s>]|<\/p>|\n\n|<div|<h[1-6][\s>]/i.test(s);
  }

  function walkForArticleBody(node, depth = 0, path = "") {
    if (!node || depth > 18) return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const r = walkForArticleBody(node[i], depth + 1, path + `[${i}]`);
        if (r) return r;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    // Check well-known keys first.
    for (const k of ARTICLE_BODY_KEYS) {
      const v = node[k];
      if (looksLikeArticleHtml(v)) return { body: v, path: path + "." + k };
    }
    // Then recurse. Skip obviously-metadata keys so we don't waste
    // cycles on cookie arrays etc.
    const SKIP = new Set(["cookies", "headers", "metadata", "tracking"]);
    for (const [k, v] of Object.entries(node)) {
      if (SKIP.has(k.toLowerCase())) continue;
      if (v && typeof v === "object") {
        const r = walkForArticleBody(v, depth + 1, path + "." + k);
        if (r) return r;
      }
    }
    return null;
  }

  // --- Aggressive fallback walker ---
  //
  // When the explicit-key search misses (publisher uses a non-standard
  // SSR shape — Apollo cache, custom Redux tree, GraphQL persistedQuery
  // response), score every leaf string and return the highest-scoring
  // one above a confidence threshold. Heuristics:
  //   - length (capped, longer = more likely body)
  //   - HTML tag density (real bodies have <p>, <a>, <h2>)
  //   - paragraph markers (<p>/<br>/double-newline)
  //   - adjacency to metadata sibling keys (title, byline, headline)
  //   - penalties for URLs, base64 blobs, JSON literals
  function scoreArticleCandidate(str, parentKeys) {
    if (typeof str !== "string" || str.length < 800) return 0;
    const trimmed = str.trim();
    if (!trimmed) return 0;
    if (/^https?:\/\//.test(trimmed)) return 0;            // URL
    if (/^[A-Za-z0-9+/=]{500,}$/.test(trimmed)) return 0;  // base64
    if (/^\s*[{[]/.test(trimmed) && /[}\]]\s*$/.test(trimmed)) return 0; // JSON literal
    const wordCount = trimmed.split(/\s+/).length;
    if (wordCount < 100) return 0;

    let score = Math.min(str.length, 50000);
    const tagCount = (str.match(/<\w+/g) || []).length;
    const paragraphMarkers = (str.match(/<p[\s>]|<\/p>|\n\n|<br\s*\/?>/gi) || []).length;
    if (tagCount === 0 && paragraphMarkers < 3) return 0;
    score *= 1 + tagCount / 100;
    score *= 1 + paragraphMarkers / 50;

    const META = new Set([
      "title", "headline", "author", "byline", "publishedat",
      "datepublished", "kicker", "subhead", "dek", "subtitle",
      "summary", "description", "ledeMedia", "lede"
    ]);
    if (parentKeys.some((k) => META.has(k.toLowerCase()))) score *= 2;
    return score;
  }

  function walkForArticleBodyAggressive(node, depth = 0, path = "", parentKeys = [], best = { score: 0 }) {
    if (!node || depth > 18) return best;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        walkForArticleBodyAggressive(node[i], depth + 1, path + `[${i}]`, parentKeys, best);
      }
      return best;
    }
    if (typeof node !== "object") return best;
    const SKIP = new Set(["cookies", "headers", "metadata", "tracking"]);
    const keys = Object.keys(node);
    for (const k of keys) {
      if (SKIP.has(k.toLowerCase())) continue;
      const v = node[k];
      if (typeof v === "string") {
        const s = scoreArticleCandidate(v, keys);
        if (s > best.score) {
          best.score = s;
          best.body = v;
          best.path = path + "." + k;
        }
      } else if (v && typeof v === "object") {
        walkForArticleBodyAggressive(v, depth + 1, path + "." + k, keys, best);
      }
    }
    return best;
  }

  // IIFE-scoped flag — survives MutationObserver re-entry without a
  // DOM marker. Adversarial publishers scanning for `[data-13ft-*]`
  // attributes won't find anything to fingerprint.
  let ssrPanelInjected = false;

  function revealFromSsrState() {
    if (ssrPanelInjected) return false;

    const scripts = document.querySelectorAll(SSR_SCRIPT_SELECTORS.join(", "));
    if (scripts.length === 0) return false;

    for (const s of scripts) {
      let data;
      try {
        let text = s.textContent || "";
        // Nuxt puts data under window.__NUXT__=(function(){...}()) —
        // can't parse. Next.js is plain JSON. Skip if first char
        // isn't { or [.
        text = text.trim();
        if (text[0] !== "{" && text[0] !== "[") continue;
        data = JSON.parse(text);
      } catch { continue; }

      // Try explicit-key walk first (high confidence). Fall back to
      // score-based aggressive walk for non-standard SSR shapes.
      let found = walkForArticleBody(data);
      if (!found) {
        const best = walkForArticleBodyAggressive(data);
        if (best.body && best.score > 5000) {
          found = { body: best.body, path: best.path + " (heuristic)" };
        }
      }
      if (!found) continue;

      // Inject. Find a sensible host element — prefer <article>,
      // fall back to main, then body.
      const articleEl =
        document.querySelector("article") ||
        document.querySelector("main") ||
        document.body;
      if (!articleEl) return false;

      const panel = document.createElement("div");
      panel.style.cssText = [
        "margin: 2em 0",
        "padding: 1.5em",
        "border-left: 4px solid #2ea44f",
        "background: rgba(46,164,79,0.06)",
        "font-family: inherit",
        "line-height: 1.6"
      ].join(";");
      const header = document.createElement("div");
      header.style.cssText =
        "font-size: 11px; color: #2ea44f; font-weight: 700; " +
        "letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 1em";
      header.textContent = `13ft — extracted from SSR state (${found.path})`;
      panel.appendChild(header);

      const body = document.createElement("div");
      // The extracted body is likely HTML. Use innerHTML to render
      // paragraphs/links, but scrub <script> / event-handler
      // attributes to avoid running attacker-controlled JS if the
      // payload was tampered with upstream.
      body.innerHTML = found.body;
      body.querySelectorAll("script").forEach((el) => el.remove());
      body.querySelectorAll("*").forEach((el) => {
        for (const attr of [...el.attributes]) {
          if (attr.name.toLowerCase().startsWith("on")) {
            el.removeAttribute(attr.name);
          }
        }
      });
      panel.appendChild(body);
      // Prepend so the recovered body is the FIRST thing the user
      // sees — they don't have to scroll past the truncated teaser
      // and (sometimes still-rendered) paywall prompt to reach it.
      articleEl.prepend(panel);
      markRevealed(panel);
      ssrPanelInjected = true;
      return true;
    }
    return false;
  }

  function applySiteRevealRules() {
    if (!Array.isArray(cssRules.reveal)) return;
    for (const sel of cssRules.reveal) {
      try { document.querySelectorAll(sel).forEach(reveal); }
      catch {}
    }
  }

  // Generic article-body rescue. For sites where our cssRules.reveal
  // selectors don't match the actual body class (Wired hits this —
  // they ship paywall JS that hides the body via a class we can't
  // pre-name), find the largest substantial text block under
  // <article> or <main> and force it visible. Won't help on hard-
  // gated sites where the body never reaches the DOM, but fixes the
  // "renders briefly then hides" pattern.
  function rescueLargestArticleBody() {
    const containers = document.querySelectorAll("article, main");
    if (containers.length === 0) return;
    for (const c of containers) {
      let best = null, bestLen = 0;
      // Walk descendants; pick the deepest element with substantial
      // text content. Avoid revealing the whole <article> (would
      // re-show ads, recommendations, etc.) — pick the tightest
      // container that has the article text.
      const walker = document.createTreeWalker(
        c, NodeFilter.SHOW_ELEMENT,
        { acceptNode: (n) => {
          if (!(n instanceof HTMLElement)) return NodeFilter.FILTER_REJECT;
          // Skip nav, header, footer, aside, script.
          if (/^(NAV|HEADER|FOOTER|ASIDE|SCRIPT|STYLE|FORM|BUTTON|IFRAME)$/.test(n.tagName)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }}
      );
      let n;
      while ((n = walker.nextNode())) {
        const len = (n.innerText || "").length;
        // Prefer the deepest substantial block to avoid revealing
        // the whole article shell.
        if (len > 1500 && len > bestLen * 0.85) {
          best = n; bestLen = len;
        }
      }
      if (best) reveal(best);
    }
  }

  // Stealth — we used to tag revealed elements with
  // `data-13ft-revealed`, which was trivially detectable by an
  // adversarial publisher's anti-bypass JS. Switch to a WeakSet so
  // tracking has zero DOM footprint. The set is GC'd with the
  // elements it references; nothing observable survives.
  const revealedSet = new WeakSet();

  function markRevealed(el) {
    if (el instanceof HTMLElement) revealedSet.add(el);
  }
  function isMarkedRevealed(el) {
    return el instanceof HTMLElement && revealedSet.has(el);
  }
  const origReveal = reveal;
  // Wrap reveal() so every revealed element gets tagged — the overlay
  // remover then knows not to nuke them.
  // eslint-disable-next-line no-func-assign
  reveal = function (el) { origReveal(el); markRevealed(el); };

  function strip() {
    // Restore scrolling: many paywalls set overflow:hidden on <html>/<body>.
    for (const el of [document.documentElement, document.body]) {
      if (!el) continue;
      el.style.setProperty("overflow", "auto", "important");
      el.style.setProperty("position", "static", "important");
      el.style.removeProperty("height");
    }

    // Unblur/unhide blurred or truncated article bodies. Do this BEFORE
    // overlay removal so revealed bodies get marked and survive.
    document
      .querySelectorAll(
        "[class*='blur' i], [class*='truncat' i], " +
        "[class*='fade' i][class*='article' i]"
      )
      .forEach(reveal);

    // Spec-driven reveal (Schema.org paywalled-content JSON-LD) and
    // per-site reveal rules run FIRST — these mark content as
    // "definitely keep" so the overlay remover below doesn't touch it.
    revealJsonLdPaywalled();
    revealFromSsrState();
    applySiteRevealRules();
    rescueLargestArticleBody();

    // Explicit modal elements from known paywall vendors. Safe to
    // always remove — these are paywall-specific custom elements.
    document.querySelectorAll("tp-modal, tp-backdrop").forEach((el) => el.remove());

    // Behavioral overlay removal. Gate on position:fixed + overlay-ish
    // naming to avoid nuking article content whose class happens to
    // contain "paywall" (e.g. `.paywalled-body` on a page that follows
    // the JSON-LD spec — that element is CONTENT, not overlay).
    for (const el of document.querySelectorAll("div, section, aside")) {
      if (isMarkedRevealed(el)) continue;
      if (!looksLikeOverlay(el)) continue;
      const cs = getComputedStyle(el);
      const zIdx = parseInt(cs.zIndex, 10);
      const isOverlayPositioned =
        cs.position === "fixed" ||
        (cs.position === "absolute" && (zIdx >= 100 || cs.zIndex === "auto"));
      if (isOverlayPositioned) el.remove();
    }

    // Per-site explicit hide list. Applied last so user/curated rules
    // override everything else.
    if (Array.isArray(cssRules.hide)) {
      for (const sel of cssRules.hide) {
        try {
          document.querySelectorAll(sel).forEach((el) => {
            if (!isMarkedRevealed(el)) el.remove();
          });
        } catch {}
      }
    }
  }

  if (!onChallenge) {
    strip();

    // Re-strip as the page mutates — paywall scripts often inject
    // late. Two observers:
    //   1. childList + subtree on body — catches new overlay nodes.
    //   2. attributes on body subtree — catches the "render then
    //      hide" pattern where a paywall script applies
    //      `display: none !important` to the article body after
    //      we've already revealed it. Re-running strip() on
    //      attribute mutations re-asserts our reveal styles.
    //      Inline `!important` battles last-write-wins; running on
    //      every mutation means we get the last word as long as
    //      we keep observing.
    // Throttle: a reveal-vs-hide loop with a publisher's own
    // MutationObserver could thrash 100s of times/second. Cap at one
    // strip() per 80ms; queued mutations during that window collapse
    // to a single trailing call.
    let stripTimer = null;
    let stripPending = false;
    function scheduleStrip() {
      if (stripTimer) { stripPending = true; return; }
      strip();
      stripTimer = setTimeout(() => {
        stripTimer = null;
        if (stripPending) { stripPending = false; scheduleStrip(); }
      }, 80);
    }

    // ---- Stability detection + persistence ----
    // Once content is visibly stable, disconnect the observer early.
    // Saves CPU and avoids interfering with the page after our work
    // is done. We persist the host as "stable" — future visits skip
    // the heavy observer entirely.
    function isContentStable() {
      const containers = document.querySelectorAll("article, main");
      for (const c of containers) {
        if (!(c instanceof HTMLElement)) continue;
        const cs = getComputedStyle(c);
        if (cs.display === "none" || cs.visibility === "hidden" ||
            parseFloat(cs.opacity) === 0) continue;
        const txt = c.innerText || "";
        if (txt.length > 1500) return true;
      }
      return false;
    }

    async function markStable() {
      try {
        const got = await chrome.storage.local.get("stableHosts");
        const map = got.stableHosts || {};
        map[enabledParent] = {
          strategy: siteRules.strategy || "googlebot",
          stableAt: Date.now()
        };
        await chrome.storage.local.set({ stableHosts: map });
      } catch {}
    }
    async function unmarkStable() {
      try {
        const got = await chrome.storage.local.get("stableHosts");
        const map = got.stableHosts || {};
        if (map[enabledParent]) {
          delete map[enabledParent];
          await chrome.storage.local.set({ stableHosts: map });
        }
      } catch {}
    }

    // Was this host previously verified stable on the current
    // strategy? Fast-path: brief 5s observer (catch obvious late
    // paywalls), no early-disconnect probe (already trusted).
    const STABLE_TTL_MS = 7 * 24 * 3600 * 1000;
    const stableHostsMap =
      (await chrome.storage.local.get("stableHosts")).stableHosts || {};
    const cachedStable = stableHostsMap[enabledParent];
    const fastPath = cachedStable &&
      cachedStable.strategy === (siteRules.strategy || "googlebot") &&
      Date.now() - cachedStable.stableAt < STABLE_TTL_MS;

    function startObserver({ duration }) {
      const target = document.body || document.documentElement;
      let disconnected = false;
      const obs = new MutationObserver((records) => {
        if (disconnected) return;
        let needStrip = false;
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
        attributes: true, attributeFilter: ["style", "class", "hidden"]
      });

      // Hard ceiling: always run the full duration. We don't
      // disconnect early on stability — many publishers fire paywall
      // JS late (2-5s after page load), and an early disconnect
      // would miss them. Persistence is for FUTURE visits: if we
      // end the duration with content stable, mark the host so
      // subsequent loads use the shorter fast-path window.
      setTimeout(() => {
        if (disconnected) return;
        disconnected = true;
        obs.disconnect();
        if (isContentStable()) {
          markStable();
        } else if (cachedStable) {
          // Was stable before, isn't now — publisher tightened.
          unmarkStable();
        }
      }, duration);
    }

    function start() {
      // 10s default — long enough to catch most late-firing paywalls
      // (Wired/Condé Nast fire at 1-3s; some publishers fire at
      // 5-7s). Short enough to not feel like 13ft is "still doing
      // things" forever after page load. Fast-path: 3s for
      // previously-stable hosts.
      const duration = fastPath ? 3000 : 10000;
      startObserver({ duration });
    }
    if (document.body) start();
    else requestAnimationFrame(start);
  }

  // ---- Failure detection ----
  //
  // Some publishers detect the bypass and serve worse content than
  // vanilla (Le Monde error page) or escalate to anti-bot challenges
  // (FT → Cloudflare CAPTCHA). When that happens we want to back off
  // to the next strategy automatically. Run ~3s after main strip so
  // late-injected challenge UIs have time to appear.
  //
  // We only fire on DEFINITIVE markers — DOM elements unique to bot
  // challenges or unambiguous error text. False positives here
  // trigger an unwanted reload, so we err toward strict matching.

  function isProxyPage() {
    // If we're on one of our own proxy domains the failure markers
    // could be the proxy's UI ("snapshot not available"), not the
    // publisher's anti-bot. Skip detection there.
    return /^(web\.archive\.org|archive\.ph|archive\.today|freedium(-mirror)?\.cfd|readmedium\.com)$/i
      .test(location.hostname);
  }

  function detectBypassFailure() {
    if (isProxyPage()) return null;

    // 1. Cloudflare / Akamai / generic anti-bot challenge DOM
    const challengeSelectors = [
      "#challenge-stage",
      "#challenge-form",
      ".cf-wrapper",
      "[class*='cf-error']",
      "iframe[src*='challenges.cloudflare']",
      "iframe[src*='ct.captcha-delivery.com']",
      "#cf-challenge-running",
      "#main-iframe[src*='captcha']"
    ];
    for (const sel of challengeSelectors) {
      if (document.querySelector(sel)) return "challenge-dom";
    }

    // 2. Title or first 4KB of text matching an anti-bot pattern
    const HEAD_TEXT = (document.title + " " + (document.body?.innerText || "")
      .slice(0, 4000)).toLowerCase();
    const PATTERNS = [
      /security verification/,
      /just a moment/,
      /verify (you are|that you are) (a )?human/,
      /please verify you are human/,
      /access (denied|blocked)/,
      /unusual traffic from your computer/,
      /enable javascript and cookies to continue/,
      /please disable (your )?ad ?blocker/,
      /something went wrong.+disable.+(extension|ad ?blocker|browser)/,
      /error 1015\b/, /error 1020\b/, /error 1010\b/, /ray id:/
    ];
    for (const re of PATTERNS) {
      if (re.test(HEAD_TEXT)) return "anti-bot-text";
    }

    return null;
  }

  setTimeout(() => {
    const failure = detectBypassFailure();
    if (!failure) return;
    try {
      chrome.runtime.sendMessage({
        type: "bypassFailed",
        host: location.hostname.replace(/^www\./, ""),
        url: location.href,
        reason: failure
      });
    } catch {
      // sendMessage can throw if SW was suspended mid-handshake.
      // Not fatal — next page load will detect again.
    }
  }, 3000);
})();
