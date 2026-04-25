// 13ft — custom per-site main-world injectors.
//
// Each function here runs inside the PAGE's JavaScript world (not the
// extension's isolated world) at document_start, before the page's
// own scripts run. Use for things that can only be done from main
// world: monkey-patching fetch/XMLHttpRequest, overriding globals,
// clearing localStorage before the paywall boots.
//
// Referenced from sites.js via `customJs: "<function-name>"`. The
// service worker injects the named function via
//   chrome.scripting.executeScript({ func, world:"MAIN",
//                                    injectImmediately:true })
// on every `tabs.onUpdated` event where the site is enabled.
//
// Constraints:
//   - Each function must be self-contained (no outer-scope references
//     other than globals available in the page).
//   - Functions are serialized with Function.prototype.toString, so
//     native code, closures, and bound variables won't cross. Use only
//     what's textually inside the function body.
//   - No chrome.* APIs (main world has no extension bridge).
//   - Avoid infinite loops — if a site reloads on localStorage mutation,
//     gate your override with a sentinel window property.
//
// Adding a site: add its function here, then set
//   customJs: "<function-name>"  in sites.js on the matching domain.

// Functions in this array run on EVERY enabled site, before any
// per-site customJs. Injection timing is best-effort (MV3's
// `injectImmediately: true` is not a hard document_start guarantee),
// so defusers that need to beat INLINE page scripts don't belong
// here — they belong in blockRegex at the network layer instead.
// Reserve this list for patches that are (a) idempotent, (b)
// safe to no-op, and (c) effective even if they land after some
// inline scripts have run (e.g., window.fetch monkey-patches that
// intercept fetch calls made AFTER DOMContentLoaded).
self.UNIVERSAL_CUSTOM_JS = [];

self.CUSTOM_JS_FUNCTIONS = {
  // --- test helper — used by Playwright harness ---
  _testMarker: function () {
    window.__ft13_testMarkerRan = true;
    window.__ft13_testMarkerAt = performance.now();
  },

  // --- NYT: neutralize the client-side meter before it boots. ---
  // NYT ships the full article body in HTML for SEO (see JSON-LD unhide)
  // but its meter script counts reads and eventually flips article-body
  // visibility. We block meter-svc and mwcm via blockRegex; this is a
  // defense-in-depth for when those load from CDNs we haven't seen.
  nyt_defuseMeter: function () {
    if (window.__ft13_nytPatched) return;
    window.__ft13_nytPatched = true;
    // Stub the meter module that the app bootstrap imports dynamically.
    const noopMeter = {
      check: () => Promise.resolve({ canAccess: true }),
      increment: () => Promise.resolve(),
      hasAccess: () => true
    };
    Object.defineProperty(window, "__meter__", {
      value: noopMeter, writable: false, configurable: false
    });
  },

  // --- Service-worker un-registration ---
  //
  // Some publishers deploy their own SW that intercepts article
  // requests and applies paywall logic at the SW layer (Cloudflare
  // Workers, Akamai EdgeWorkers, etc.). Our DNR rules don't match
  // requests originated by the page's own SW. Calling unregister()
  // on the page's SW(s) frees subsequent navigations from that gate.
  //
  // Opt-in per-site via customJs because un-registering a SW also
  // breaks legitimate offline / PWA functionality on sites that use
  // SWs for non-paywall reasons.
  unregisterPageSW: function () {
    if (window.__ft13_swUnregistered) return;
    window.__ft13_swUnregistered = true;
    if (!navigator.serviceWorker || typeof navigator.serviceWorker.getRegistrations !== "function") {
      return;
    }
    navigator.serviceWorker.getRegistrations()
      .then((regs) => Promise.all(regs.map((r) => r.unregister().catch(() => {}))))
      .catch(() => {});
  },

  // --- Piano/Tinypass: make tp.push a no-op so the paywall never shows ---
  // Used on any site whose paywall ships via cdn.tinypass.com that
  // escaped our blockRegex (e.g. proxied via publisher's own CDN).
  piano_defuse: function () {
    if (window.__ft13_pianoPatched) return;
    window.__ft13_pianoPatched = true;
    const noop = function () {};
    Object.defineProperty(window, "tp", {
      get: () => ({ push: noop, experience: { execute: noop, init: noop } }),
      configurable: false
    });
  }
};
