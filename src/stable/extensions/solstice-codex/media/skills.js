"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let items = [];
	let install = { status: "idle", url: "", message: "", preview: null, candidates: [] };
	function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
	function skillCards() {
		const skills = items.filter((x) => x.kind !== "lesson");
		const lessons = items.filter((x) => x.kind === "lesson");
		return `<header><div><small>FELIX MEMORY</small><h1>🧠 Skills</h1><p>${skills.length} skills · ${lessons.length} lessons</p></div><button id="refresh">↻ רענן</button></header>` +
			installerHtml() +
			`<main>${items.map((x) => `<article class="${x.kind === "lesson" ? "lesson" : ""}"><div class="row"><span class="kind">${x.kind === "lesson" ? "לקח" : "SKILL"}</span><span class="uses">${Number(x.uses || 0)} שימושים</span></div><h2>${esc(x.name)}</h2>${x.kind !== "lesson" ? `<div class="level"><strong>Lv.${Number(x.level || 1)} · ${esc(x.title || "Foundation")}</strong><span>${Number(x.xp || 0)} XP</span></div><div class="xp" title="${Number(x.progress || 0)}%"><i style="width:${Math.max(0, Math.min(100, Number(x.progress || 0)))}%"></i></div><div class="next">${x.nextXp ? `${Number(x.nextXp) - Number(x.xp || 0)} XP לשלב הבא` : "רמה מקסימלית"}</div>` : ""}<div class="tags">${(x.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div><p>${esc(x.preview)}</p><footer>v${esc(x.version || 1)} · ${esc(x.updatedAt || "")}</footer></article>`).join("") || '<div class="empty">עדיין אין skills שמורים.</div>'}</main>`;
	}
	function installerHtml() {
		const disabled = install.status === "busy" ? " disabled" : "";
		let detail = "";
		if (install.candidates.length) {
			detail = `<div class="install-preview"><strong>נמצאו כמה skills</strong><select id="skillPath">${install.candidates.map((x) => `<option value="${esc(x)}">${esc(x)}</option>`).join("")}</select><button id="selectSkill">בדוק את הנבחר</button></div>`;
		} else if (install.preview) {
			const p = install.preview;
			detail = `<div class="install-preview"><div class="preview-head"><div><small>PREVIEW · NO CODE EXECUTED</small><h3>${esc(p.name)}</h3></div><code>${esc(String(p.commit || "").slice(0, 12))}</code></div><dl><dt>מקור</dt><dd>${esc(p.sourceUrl)}</dd><dt>Skill</dt><dd>${esc(p.skillPath)}</dd><dt>קבצים</dt><dd>${Number(p.fileCount || 0)} · ${Number(p.totalBytes || 0).toLocaleString()} bytes</dd><dt>דרישות</dt><dd>${esc((p.requirements || []).join(", ") || "ללא")}</dd></dl><details><summary>מלאי קבצים</summary><pre>${(p.files || []).map((f) => `${esc(f.path)}  ${Number(f.bytes || 0)}`).join("\n")}</pre></details><button class="primary" id="confirmInstall">אשר התקנה</button></div>`;
		}
		const status = install.message ? `<div class="install-status ${install.status}">${esc(install.message)}</div>` : "";
		return `<section class="installer"><div><small>RUNTIME INSTALLER</small><h2>הוסף skill מ־GitHub</h2><p>HTTPS בלבד · clone ללא checkout · בלי hooks, shell או scripts · preview ואישור לפני כתיבה.</p></div><div class="install-form"><input id="repoUrl" type="url" dir="ltr" placeholder="https://github.com/owner/repo" value="${esc(install.url)}"${disabled}><button class="primary" id="previewInstall"${disabled}>בדוק לפני התקנה</button></div>${status}${detail}</section>`;
	}
	function bind() {
		document.getElementById("refresh").onclick = () => vscode.postMessage({ type: "refresh" });
		document.getElementById("previewInstall").onclick = () => {
			const input = document.getElementById("repoUrl");
			install = { status: "busy", url: input.value.trim(), message: "בודק repository…", preview: null, candidates: [] };
			render();
			vscode.postMessage({ type: "previewInstall", url: install.url });
		};
		const select = document.getElementById("selectSkill");
		if (select) select.onclick = () => {
			const skillPath = document.getElementById("skillPath").value;
			install.status = "busy"; install.message = "בודק את ה־skill הנבחר…"; render();
			vscode.postMessage({ type: "previewInstall", url: install.url, skillPath });
		};
		const confirm = document.getElementById("confirmInstall");
		if (confirm) confirm.onclick = () => vscode.postMessage({ type: "confirmInstall", id: install.preview.id });
	}
	function render() { app.innerHTML = skillCards(); bind(); }
	window.addEventListener("message", (event) => {
		const data = event.data || {};
		if (data.type === "skills") items = data.items || [];
		else if (data.type === "installBusy") { install.status = "busy"; install.message = data.message || "עובד…"; }
		else if (data.type === "skillSelection") { install.status = "idle"; install.message = "בחר SKILL.md אחד מתוך ה־repository."; install.candidates = data.candidates || []; install.preview = null; install.url = data.sourceUrl || install.url; }
		else if (data.type === "installPreview") { install.status = "preview"; install.message = "המקור נבדק. עיין בפרטים ואשר התקנה."; install.preview = data; install.candidates = []; }
		else if (data.type === "installDone") { install = { status: "done", url: "", message: `הותקן ${data.name} בזמן ריצה — בלי build נוסף.`, preview: null, candidates: [] }; }
		else if (data.type === "installCancelled") { install.status = "idle"; install.message = "ההתקנה בוטלה; לא נכתב דבר."; }
		else if (data.type === "installError") { install.status = "error"; install.message = data.message || "ההתקנה נכשלה."; install.preview = null; }
		render();
	});
	render(); vscode.postMessage({ type: "ready" });
})();
