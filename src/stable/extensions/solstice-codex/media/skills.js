"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); }
	function render(items) {
		const skills = (items || []).filter((x) => x.kind !== "lesson");
		const lessons = (items || []).filter((x) => x.kind === "lesson");
		app.innerHTML = `<header><div><small>FELIX MEMORY</small><h1>🧠 Skills</h1><p>${skills.length} skills · ${lessons.length} lessons</p></div><button id="refresh">↻ רענן</button></header><main>${(items || []).map((x) => `<article class="${x.kind === "lesson" ? "lesson" : ""}"><div class="row"><span class="kind">${x.kind === "lesson" ? "לקח" : "SKILL"}</span><span class="uses">${Number(x.uses || 0)} שימושים</span></div><h2>${esc(x.name)}</h2>${x.kind !== "lesson" ? `<div class="level"><strong>Lv.${Number(x.level || 1)} · ${esc(x.title || "Foundation")}</strong><span>${Number(x.xp || 0)} XP</span></div><div class="xp" title="${Number(x.progress || 0)}%"><i style="width:${Math.max(0, Math.min(100, Number(x.progress || 0)))}%"></i></div><div class="next">${x.nextXp ? `${Number(x.nextXp) - Number(x.xp || 0)} XP לשלב הבא` : "רמה מקסימלית"}</div>` : ""}<div class="tags">${(x.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div><p>${esc(x.preview)}</p><footer>v${esc(x.version || 1)} · ${esc(x.updatedAt || "")}</footer></article>`).join("") || '<div class="empty">עדיין אין skills שמורים.</div>'}</main>`;
		document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
	}
	window.addEventListener("message", (event) => { if (event.data && event.data.type === "skills") render(event.data.items); });
	render([]); vscode.postMessage({ type: "ready" });
})();
