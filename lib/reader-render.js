// 13ft Reader Mode v2 — runs in the page's MAIN world after
// lib/readability.js has been injected. Extracts the article and
// replaces the visible page with a clean reader view.
//
// Adds beyond v1:
//   - Toolbar: copy as Markdown, audio TTS via Web Speech API,
//     font-size controls, font-family toggle (serif/sans),
//     light/dark/sepia themes, send to Pocket
//   - Settings persist in localStorage scoped to ft13_reader_*.

(function () {
  if (typeof Readability !== "function") {
    console.warn("13ft reader: Readability not loaded");
    return;
  }
  if (document.querySelector("[data-13ft-reader]")) return;

  let article = null;
  try {
    const docClone = document.cloneNode(true);
    article = new Readability(docClone).parse();
  } catch (e) {
    console.warn("13ft reader: parse failed", e);
  }
  if (!article || !article.content) {
    console.warn("13ft reader: no extractable article on this page");
    return;
  }

  // ---- Settings (persisted in localStorage) ----
  const SETTING_KEYS = {
    fontSize: "ft13_reader_fontSize",
    fontFamily: "ft13_reader_fontFamily",
    theme: "ft13_reader_theme"
  };
  function getSetting(k, fallback) {
    try { return localStorage.getItem(k) || fallback; }
    catch { return fallback; }
  }
  function setSetting(k, v) {
    try { localStorage.setItem(k, v); } catch {}
  }

  // ---- Theme presets ----
  const THEMES = {
    light: { bg: "#fafaf7", text: "#1a1a1a", accent: "#2ea44f", border: "#ccc" },
    dark:  { bg: "#1a1a1a", text: "#e8e8e8", accent: "#3fb950", border: "#444" },
    sepia: { bg: "#f4ecd8", text: "#5b4636", accent: "#8b6914", border: "#c0a060" }
  };
  const FAMILIES = {
    serif: "'Iowan Old Style','Palatino Linotype','Palatino','Georgia',serif",
    sans:  "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif"
  };

  // ---- HTML → Markdown converter (lightweight, inline) ----
  function htmlToMarkdown(html) {
    const tmp = document.createElement("div");
    tmp.innerHTML = html;
    function walk(node, depth = 0) {
      let out = "";
      for (const c of node.childNodes) {
        if (c.nodeType === Node.TEXT_NODE) {
          out += c.textContent;
          continue;
        }
        if (c.nodeType !== Node.ELEMENT_NODE) continue;
        const tag = c.tagName.toLowerCase();
        const inner = walk(c, depth + 1);
        switch (tag) {
          case "h1": out += "\n# " + inner.trim() + "\n\n"; break;
          case "h2": out += "\n## " + inner.trim() + "\n\n"; break;
          case "h3": out += "\n### " + inner.trim() + "\n\n"; break;
          case "h4": out += "\n#### " + inner.trim() + "\n\n"; break;
          case "p":  out += inner.trim() + "\n\n"; break;
          case "br": out += "\n"; break;
          case "strong": case "b": out += "**" + inner + "**"; break;
          case "em": case "i": out += "*" + inner + "*"; break;
          case "code": out += "`" + inner + "`"; break;
          case "pre": out += "\n```\n" + inner.trim() + "\n```\n\n"; break;
          case "blockquote":
            out += inner.trim().split("\n").map((l) => "> " + l).join("\n") + "\n\n";
            break;
          case "ul": out += "\n" + inner + "\n"; break;
          case "ol": out += "\n" + inner + "\n"; break;
          case "li": out += "- " + inner.trim() + "\n"; break;
          case "a": {
            const href = c.getAttribute("href") || "";
            out += `[${inner}](${href})`;
            break;
          }
          case "img": {
            const alt = c.getAttribute("alt") || "";
            const src = c.getAttribute("src") || "";
            out += `\n![${alt}](${src})\n`;
            break;
          }
          default: out += inner;
        }
      }
      return out;
    }
    return walk(tmp).replace(/\n{3,}/g, "\n\n").trim();
  }

  // ---- Build UI ----
  const wrap = document.createElement("div");
  wrap.setAttribute("data-13ft-reader", "1");
  const inner = document.createElement("div");
  const toolbar = document.createElement("div");
  const meta = document.createElement("div");
  const ctrls = document.createElement("div");
  const h1 = document.createElement("h1");
  const body = document.createElement("div");
  const status = document.createElement("div");

  function applyTheme() {
    const themeKey = getSetting(SETTING_KEYS.theme, "light");
    const t = THEMES[themeKey] || THEMES.light;
    const family = FAMILIES[getSetting(SETTING_KEYS.fontFamily, "serif")] || FAMILIES.serif;
    const size = parseInt(getSetting(SETTING_KEYS.fontSize, "18"), 10) || 18;

    wrap.style.cssText = [
      "all: initial",
      "position: fixed", "inset: 0", "z-index: 2147483647",
      `background: ${t.bg}`, `color: ${t.text}`,
      "overflow-y: auto", "padding: 4em 2em"
    ].join(";");
    inner.style.cssText = [
      "max-width: 720px", "margin: 0 auto",
      `font-family: ${family}`,
      `font-size: ${size}px`, "line-height: 1.7", `color: ${t.text}`
    ].join(";");
    toolbar.style.cssText = [
      "display: flex", "justify-content: space-between", "align-items: center",
      "gap: 1em", "margin-bottom: 2em",
      "font-family: system-ui, sans-serif", "font-size: 12px"
    ].join(";");
    meta.style.cssText = `color: ${t.text}; opacity: 0.7;`;
    h1.style.cssText = `font-size: ${size + 14}px; font-weight: 700; line-height: 1.25; margin: 0 0 .8em; color: ${t.text};`;
    status.style.cssText = `color: ${t.text}; opacity: 0.6; font-family: system-ui, sans-serif; font-size: 11px; margin-top: 2em; text-align: center;`;
  }

  applyTheme();

  meta.textContent = "13ft reader · " + (article.byline || article.siteName || location.hostname);

  // ---- Control buttons ----
  function btn(label, title, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    if (title) b.title = title;
    b.style.cssText = [
      "border: 1px solid currentColor",
      "background: transparent", "color: inherit", "opacity: 0.8",
      "padding: 4px 10px", "border-radius: 4px", "cursor: pointer",
      "font: inherit", "font-size: 11px", "margin-left: 4px"
    ].join(";");
    b.addEventListener("click", onClick);
    return b;
  }

  // Markdown export
  ctrls.appendChild(btn("MD", "Copy as Markdown", () => {
    const md = `# ${article.title}\n\n` +
      (article.byline ? `_${article.byline}_\n\n` : "") +
      htmlToMarkdown(article.content);
    navigator.clipboard.writeText(md)
      .then(() => { status.textContent = "Markdown copied to clipboard"; })
      .catch(() => { status.textContent = "Copy failed"; });
  }));

  // Audio TTS
  let utterance = null;
  ctrls.appendChild(btn("Listen", "Read aloud (Web Speech API)", () => {
    if ("speechSynthesis" in window) {
      if (utterance && speechSynthesis.speaking) {
        speechSynthesis.cancel();
        status.textContent = "Stopped.";
        return;
      }
      const text = (article.title || "") + ". " + (body.innerText || "").slice(0, 32000);
      utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = 1.0;
      speechSynthesis.speak(utterance);
      status.textContent = "Reading aloud — click again to stop.";
    } else {
      status.textContent = "Speech synthesis not available.";
    }
  }));

  // Font-size controls
  ctrls.appendChild(btn("A−", "Decrease font size", () => {
    const cur = parseInt(getSetting(SETTING_KEYS.fontSize, "18"), 10);
    const next = Math.max(12, cur - 2);
    setSetting(SETTING_KEYS.fontSize, String(next));
    applyTheme();
  }));
  ctrls.appendChild(btn("A+", "Increase font size", () => {
    const cur = parseInt(getSetting(SETTING_KEYS.fontSize, "18"), 10);
    const next = Math.min(28, cur + 2);
    setSetting(SETTING_KEYS.fontSize, String(next));
    applyTheme();
  }));

  // Font-family toggle
  ctrls.appendChild(btn("Aa", "Toggle serif / sans", () => {
    const cur = getSetting(SETTING_KEYS.fontFamily, "serif");
    setSetting(SETTING_KEYS.fontFamily, cur === "serif" ? "sans" : "serif");
    applyTheme();
  }));

  // Theme toggle
  ctrls.appendChild(btn("◐", "Cycle theme: light → sepia → dark", () => {
    const cur = getSetting(SETTING_KEYS.theme, "light");
    const next = cur === "light" ? "sepia" : cur === "sepia" ? "dark" : "light";
    setSetting(SETTING_KEYS.theme, next);
    applyTheme();
  }));

  // Send-to: Pocket
  ctrls.appendChild(btn("Pocket", "Save to Pocket", () => {
    window.open(
      "https://getpocket.com/save?url=" + encodeURIComponent(location.href) +
      "&title=" + encodeURIComponent(article.title || ""),
      "_blank"
    );
  }));

  // Close
  ctrls.appendChild(btn("✕", "Close (Esc)", () => wrap.remove()));

  document.addEventListener("keydown", function onEsc(e) {
    if (e.key === "Escape") {
      wrap.remove();
      if ("speechSynthesis" in window) speechSynthesis.cancel();
      document.removeEventListener("keydown", onEsc);
    }
  });

  toolbar.appendChild(meta);
  toolbar.appendChild(ctrls);

  h1.textContent = article.title || "";

  body.innerHTML = article.content;
  body.querySelectorAll("script").forEach((el) => el.remove());
  body.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) {
      if (a.name.toLowerCase().startsWith("on")) el.removeAttribute(a.name);
    }
  });
  body.querySelectorAll("img").forEach((img) => {
    img.style.cssText = "max-width:100%; height:auto; margin:1em 0;";
  });

  inner.appendChild(toolbar);
  if (article.title) inner.appendChild(h1);
  inner.appendChild(body);
  inner.appendChild(status);
  wrap.appendChild(inner);
  document.documentElement.appendChild(wrap);
})();
