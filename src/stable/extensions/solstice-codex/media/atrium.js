"use strict";
// Solstice → Atrium handoff result panel. Shown after a build is handed off to a
// client folder: visualizes the Build → Atrium → Client flow, the written
// manifest contract (kind site/app, live URL, build copy), and offers to open
// the client folder or deep-link the client card in Atrium.
(function () {
  const vscode = acquireVsCodeApi();
  const app = document.getElementById("app");
  let data = null;

  function esc(t) { return String(t == null ? "" : t).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }

  function render() {
    if (!data) { app.innerHTML = `<div id="aWait">ממתין למסירה…</div>`; return; }
    const m = data.manifest || {};
    const isApp = m.kind === "app";
    const kindLabel = isApp ? "אפליקציה" : "אתר";
    const kindGlyph = isApp ? "📱" : "🌐";
    app.innerHTML = `
      <div id="aRoot">
        <header id="aHero">
          <div class="aKicker"><span>✓</span> נמסר ל-Atrium</div>
          <h1 id="aTitle">${esc(m.project || "build")}</h1>
          <div class="aBadges">
            <span class="aBadge aBadge--kind">${kindGlyph} ${kindLabel}</span>
            ${m.agent ? `<span class="aBadge">סוכן: ${esc(m.agent)}</span>` : ""}
            <span class="aBadge">${esc(m.provider || "")}</span>
          </div>
        </header>

        <div class="aFlow">
          <div class="aNode"><div class="aNg">☀</div><div class="aNt"><b>Solstice Build</b><small>${esc(m.slug || "")}</small></div></div>
          <div class="aArr">→</div>
          <div class="aNode"><div class="aNg">🗂</div><div class="aNt"><b>Atrium</b><small>output/${esc(m.client || "")}</small></div></div>
          <div class="aArr">→</div>
          <div class="aNode aNode--client"><div class="aNg">🙋</div><div class="aNt"><b>כרטיס לקוח</b><small>${esc(m.client || "")}</small></div></div>
        </div>

        <div class="aCard">
          <div class="aRow"><span class="aK">סוג</span><span class="aV">${kindGlyph} ${kindLabel}${isApp ? " · טאב אפליקציה יידלק בכרטיס" : ""}</span></div>
          <div class="aRow"><span class="aK">URL חי</span><span class="aV ${m.liveUrl ? "" : "muted"}">${m.liveUrl ? esc(m.liveUrl) : "—"}</span></div>
          <div class="aRow"><span class="aK">קבצי בילד</span><span class="aV">${data.copied ? "✓ הועתקו לתיקיית הלקוח" : "מניפסט בלבד (מקור מרוחק)"}</span></div>
          <div class="aRow"><span class="aK">נתיב</span><span class="aV path">${esc(data.dest || "")}</span></div>
          <div class="aRow"><span class="aK">index</span><span class="aV">builds.json עודכן — הכרטיס יציג את כל הבילדים</span></div>
        </div>

        <div class="aActions">
          <button class="aBtn aBtn--primary" id="aOpenAtrium" ${data.atriumUrl ? "" : "disabled"}>${data.atriumUrl ? "פתח כרטיס לקוח באיתריום ↗" : "פתח באיתריום (הגדר atrium.baseUrl)"}</button>
          <button class="aBtn" id="aOpenFolder">פתח תיקייה</button>
        </div>
      </div>`;

    const oa = document.getElementById("aOpenAtrium");
    if (oa && data.atriumUrl) oa.onclick = () => vscode.postMessage({ type: "openAtrium", url: data.atriumUrl });
    document.getElementById("aOpenFolder").onclick = () => vscode.postMessage({ type: "openFolder", path: data.dest });
  }

  window.addEventListener("message", (e) => {
    const msg = e.data || {};
    if (msg.type === "handoff") { data = msg; render(); }
  });

  render();
  vscode.postMessage({ type: "ready" });
})();
