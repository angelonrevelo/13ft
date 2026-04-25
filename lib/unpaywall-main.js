// 13ft — universal fetch / XHR response rewriter.
//
// Registered dynamically by the service worker via
// chrome.scripting.registerContentScripts on every enabled host, with
// `world: "MAIN"` and `runAt: "document_start"` so the patches install
// before the page can call fetch/XHR.
//
// What it does: monkey-patches window.fetch + XMLHttpRequest so that
// JSON responses get scanned for common paywall flag patterns and
// rewritten in flight. The page's own JS then sees a "free" response.
//
// This catches a class of paywalls that DOM stripping can't: React/
// Next.js sites that gate the article body via an API call. The page
// boots, fetches /api/article/<id>, sees `accessLevel: "paid"`, and
// hides the body. We rewrite the response before the page reads it.
//
// Constraints:
//  - Runs in the page's MAIN world. No chrome.* APIs available.
//  - Must be idempotent — page may load multiple times via SPA nav.
//  - Must not break legitimate non-paywall responses. Regex matches
//    only specific paywall-flag shapes; pages without those flags
//    pass through unmodified.

(function () {
  if (window.__ft13_fetchPatched) return;
  window.__ft13_fetchPatched = true;

  // The actual rewrite. Conservative: only flips known paywall flags
  // to their "no paywall" equivalents. If a response doesn't contain
  // any of these patterns, it's returned unchanged.
  function unpaywall(text) {
    if (typeof text !== "string" || text.length === 0) return text;
    let out = text;
    out = out
      .replace(/"isAccessibleForFree"\s*:\s*false/g,           '"isAccessibleForFree":true')
      .replace(/"isAccessibleForFree"\s*:\s*"[Ff]alse"/g,      '"isAccessibleForFree":"True"')
      .replace(/"accessLevel"\s*:\s*"paid"/g,                  '"accessLevel":"free"')
      .replace(/"accessLevel"\s*:\s*"premium"/g,               '"accessLevel":"free"')
      .replace(/"accessLevel"\s*:\s*"locked"/g,                '"accessLevel":"unlocked"')
      .replace(/"hasPaidAccess"\s*:\s*false/g,                 '"hasPaidAccess":true')
      .replace(/"isPaywalled"\s*:\s*true/g,                    '"isPaywalled":false')
      .replace(/"isPaywall"\s*:\s*true/g,                      '"isPaywall":false')
      .replace(/"requireSubscription"\s*:\s*true/g,            '"requireSubscription":false')
      .replace(/"meterStatus"\s*:\s*"locked"/g,                '"meterStatus":"unlocked"')
      .replace(/"contentLockType"\s*:\s*"paywall"/g,           '"contentLockType":"none"')
      .replace(/"isPremium"\s*:\s*true/g,                      '"isPremium":false')
      .replace(/"is_premium"\s*:\s*true/g,                     '"is_premium":false')
      .replace(/"subscriberOnly"\s*:\s*true/g,                 '"subscriberOnly":false')
      .replace(/"subscribers_only"\s*:\s*true/g,               '"subscribers_only":false')
      .replace(/"members_only"\s*:\s*true/g,                   '"members_only":false')
      .replace(/"hasContentAccess"\s*:\s*false/g,              '"hasContentAccess":true')
      .replace(/"showPaywall"\s*:\s*true/g,                    '"showPaywall":false')
      .replace(/"paywallStatus"\s*:\s*"locked"/g,              '"paywallStatus":"unlocked"');
    return out;
  }

  // --- fetch patch ---
  const origFetch = window.fetch;
  window.fetch = function () {
    const args = arguments;
    const promise = origFetch.apply(this, args);
    return promise.then(async (response) => {
      try {
        const ct = (response.headers.get("content-type") || "").toLowerCase();
        if (!/json/.test(ct)) return response;
        const text = await response.clone().text();
        const rewritten = unpaywall(text);
        if (rewritten === text) return response;
        return new Response(rewritten, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers
        });
      } catch {
        return response;
      }
    });
  };

  // --- XMLHttpRequest patch ---
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function () {
    return origOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    const xhr = this;
    xhr.addEventListener("readystatechange", function () {
      if (xhr.readyState !== 4) return;
      try {
        const ct = (xhr.getResponseHeader("content-type") || "").toLowerCase();
        if (!/json/.test(ct)) return;
        // responseText is read-only; override via defineProperty.
        const orig = xhr.responseText;
        const rewritten = unpaywall(orig);
        if (rewritten === orig) return;
        Object.defineProperty(xhr, "responseText", {
          configurable: true, value: rewritten
        });
        try {
          if (xhr.responseType === "" || xhr.responseType === "text") {
            Object.defineProperty(xhr, "response", {
              configurable: true, value: rewritten
            });
          } else if (xhr.responseType === "json") {
            Object.defineProperty(xhr, "response", {
              configurable: true, value: JSON.parse(rewritten)
            });
          }
        } catch {}
      } catch {}
    });
    return origSend.apply(this, arguments);
  };
})();
