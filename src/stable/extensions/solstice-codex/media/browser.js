"use strict";
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  app.innerHTML = `
    <div id="bar">
      <span id="dot"></span>
      <span id="act"></span>
      <span id="url" title="">ממתין לסוכן…</span>
    </div>
    <div id="stage">
      <div id="empty">
        <div class="eGlyph">🌐</div>
        <div class="eTitle">דפדפן הסוכן</div>
        <div class="eSub">כשפליקס חוקר אתרים, מצלם או סורק — תראו כאן את הדפים בזמן אמת, כמו ב-Antigravity.</div>
      </div>
      <img id="shot" alt="" />
    </div>
    <div id="histWrap"><div id="histTitle">היסטוריית גלישה</div><div id="history"></div></div>`;
  const dotEl = document.getElementById("dot");
  const actEl = document.getElementById("act");
  const urlEl = document.getElementById("url");
  const shotEl = document.getElementById("shot");
  const emptyEl = document.getElementById("empty");
  const histEl = document.getElementById("history");
  const ACT = { shot: "📸 מצלם", read: "📖 קורא", crawl: "🕸 סורק", search: "🔎 מחפש" };
  let liveTimer = null;
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.type !== "page") return;
    urlEl.textContent = m.url || "";
    urlEl.title = m.url || "";
    actEl.textContent = ACT[m.action] || m.action || "";
    dotEl.classList.add("live");
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => dotEl.classList.remove("live"), 2000);
    if (m.shot) {
      emptyEl.style.display = "none";
      shotEl.style.display = "block";
      shotEl.src = m.shot + (m.shot.indexOf("?") >= 0 ? "&" : "?") + "t=" + m.time;
    }
    const h = document.createElement("div");
    h.className = "hItem";
    h.textContent = (ACT[m.action] || "") + "  " + (m.url || "");
    histEl.prepend(h);
    while (histEl.children.length > 30) histEl.removeChild(histEl.lastChild);
  });
  vscode.postMessage({ type: "ready" });
})();
