// 13ft LLM completer — runs in an extension page, loads WebLLM
// from CDN, runs Phi-3 inference locally to summarize what an
// article is probably about based on its visible teaser + URL.
//
// The page is opened via chrome.tabs.create with two query params:
//   ?url=<failed-article-url>
//   &teaser=<urlencoded-visible-teaser-text>
// Or fetches via chrome.runtime.sendMessage if those aren't set.

const $ = (id) => document.getElementById(id);

const params = new URLSearchParams(location.search);
const articleUrl = params.get("url") || "";
const articleTeaser = params.get("teaser") || "";

$("url").textContent = articleUrl || "(no URL provided)";
$("teaser").textContent = articleTeaser
  ? articleTeaser
  : "(no teaser observed — paste the snippet below)";

// If no teaser provided, render an editable textarea.
if (!articleTeaser) {
  const ta = document.createElement("textarea");
  ta.placeholder = "Paste any visible snippet of the article here…";
  ta.style.cssText = "width:100%; min-height:120px; padding:0.5em; font:inherit;";
  $("teaser").innerHTML = "";
  $("teaser").appendChild(ta);
  $("teaser").style.fontStyle = "normal";
  ta.addEventListener("input", () => { window.__teaserText = ta.value; });
  window.__teaserText = "";
}

let engine = null;
let modelLoaded = false;

function showStatus(msg, kind = "info") {
  const s = $("status");
  s.style.display = "block";
  s.textContent = msg;
  if (kind === "ok") {
    s.style.background = "#d8f5d8";
    s.style.borderColor = "#a0d0a0";
    s.style.color = "#0a4a0a";
  } else if (kind === "error") {
    s.style.background = "#ffe5e5";
    s.style.borderColor = "#ffaaaa";
    s.style.color = "#7a0000";
  } else {
    s.style.background = "#fff8e1";
    s.style.borderColor = "#ffe082";
    s.style.color = "#6b5500";
  }
}

$("loadBtn").addEventListener("click", async () => {
  $("loadBtn").disabled = true;
  $("loadBtn").textContent = "Loading…";
  $("progress").style.display = "block";
  showStatus("Loading WebLLM library + Phi-3 weights. First-time load is " +
             "1-2 GB; your browser caches it for next time.");

  try {
    // WebLLM is shipped as an ES module on jsDelivr / esm.run.
    // We use the latest pinned version.
    const webllm = await import(
      "https://esm.run/@mlc-ai/web-llm@0.2.79"
    );
    const initProgressCallback = (report) => {
      const pct = Math.round((report.progress || 0) * 100);
      $("progressBar").style.width = pct + "%";
      $("loadBtn").textContent = `Loading… ${pct}%`;
      if (report.text) showStatus(report.text);
    };
    // Phi-3 mini, 4-bit quantized — good summary quality, ~1.5 GB.
    engine = await webllm.CreateMLCEngine(
      "Phi-3-mini-4k-instruct-q4f16_1-MLC",
      { initProgressCallback }
    );
    modelLoaded = true;
    $("loadBtn").textContent = "Loaded ✓";
    $("genBtn").disabled = false;
    showStatus("Model ready. Click Generate to summarize.", "ok");
  } catch (e) {
    showStatus("Load failed: " + (e.message || e), "error");
    $("loadBtn").textContent = "Retry load";
    $("loadBtn").disabled = false;
  }
});

$("genBtn").addEventListener("click", async () => {
  if (!modelLoaded || !engine) return;
  $("genBtn").disabled = true;
  $("genBtn").textContent = "Generating…";
  $("summary").textContent = "";
  showStatus("Running inference on your local GPU/CPU…");

  const teaser = articleTeaser || (window.__teaserText || "").trim();
  const prompt =
    "You are a news article summarizer. The user couldn't access the full " +
    "article (paywalled). Based ONLY on the teaser text and URL provided, " +
    "give a careful, hedged 2-3 paragraph description of what the article " +
    "is probably about. Be honest about uncertainty — if the teaser is " +
    "thin, say so. Don't fabricate facts.\n\n" +
    `URL: ${articleUrl}\n\n` +
    `Teaser: ${teaser || "(no teaser available — only the URL above)"}\n\n` +
    "Description:";

  try {
    const reply = await engine.chat.completions.create({
      messages: [{ role: "user", content: prompt }],
      temperature: 0.5,
      max_tokens: 350,
      stream: true
    });
    for await (const chunk of reply) {
      const delta = chunk.choices[0]?.delta?.content || "";
      $("summary").textContent += delta;
    }
    showStatus("Done.", "ok");
  } catch (e) {
    showStatus("Inference failed: " + (e.message || e), "error");
  }
  $("genBtn").disabled = false;
  $("genBtn").textContent = "Generate summary";
});
