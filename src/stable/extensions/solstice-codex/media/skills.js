"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let items = [];
	let diagnostics = null;
	let diagnosticsMessage = "";
	let install = { status: "idle", url: "", message: "", preview: null, candidates: [] };
	function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
	function skillCards() {
		const skills = items.filter((x) => x.kind !== "lesson");
		const lessons = items.filter((x) => x.kind === "lesson");
		return `<header><div><small>FELIX MEMORY</small><h1>🧠 Skills</h1><p>${skills.length} skills · ${lessons.length} lessons</p></div><button id="refresh">↻ רענן</button></header>` +
			diagnosticsHtml() +
			installerHtml() +
			`<main>${items.map((x) => `<article class="${x.kind === "lesson" ? "lesson" : ""}"><div class="row"><span class="kind">${x.kind === "lesson" ? "לקח" : "SKILL"}</span><span class="uses">${Number(x.uses || 0)} שימושים</span></div><h2>${esc(x.name)}</h2>${x.kind !== "lesson" ? `<div class="level"><strong>Lv.${Number(x.level || 1)} · ${esc(x.title || "Foundation")}</strong><span>${Number(x.xp || 0)} XP</span></div><div class="xp" title="${Number(x.progress || 0)}%"><i style="width:${Math.max(0, Math.min(100, Number(x.progress || 0)))}%"></i></div><div class="next">${x.nextXp ? `${Number(x.nextXp) - Number(x.xp || 0)} XP לשלב הבא` : "רמה מקסימלית"}</div>` : ""}<div class="tags">${(x.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div><p>${esc(x.preview)}</p><footer>v${esc(x.version || 1)} · ${esc(x.updatedAt || "")}</footer></article>`).join("") || '<div class="empty">עדיין אין skills שמורים.</div>'}</main>`;
	}
	function diagnosticsHtml() {
		if (!diagnostics) return `<section class="runtime error"><strong>Runtime diagnostics unavailable</strong><p>Felix has not returned storage health yet.</p></section>`;
		const runtime = diagnostics.runtime || {};
		const build = diagnostics.build || {};
		const list = diagnostics.list || {};
		const route = diagnostics.selectedRoute || {};
		const vertical = diagnostics.verticalRoute || {};
		const prompt = diagnostics.prompt || {};
		const status = runtime.status || (list.ok ? "unknown" : "runtime-error");
		const healthy = status === "healthy" && list.ok && Number(list.count || 0) > 0;
		const label = healthy ? "Healthy" : status.replace(/-/g, " ");
		const selected = (route.selected || []).map((item) => item.name).join(", ") || "No route selected in this session";
		const buildProof = build.sourceCommit && !String(build.sourceCommit).startsWith("unavailable")
			? String(build.sourceCommit).slice(0, 12)
			: `bundle ${String(build.extensionBundleSha256 || "").slice(0, 12) || "unavailable"}`;
		const message = diagnosticsMessage ? `<div class="runtime-message">${esc(diagnosticsMessage)}</div>` : "";
		return `<section class="runtime ${healthy ? "healthy" : "error"}">
			<div class="runtime-head"><div><small>FELIX RUNTIME DIAGNOSTICS</small><h2>Bundled ↔ Runtime</h2></div><span class="health">${esc(label)}</span></div>
			<div class="runtime-grid">
				<div><span>Build</span><strong>${esc(build.productVersion || "unknown")}</strong><code>${esc(buildProof)}</code></div>
				<div><span>Bundled ScrollWorld</span><strong>${runtime.bundled && runtime.bundled.valid ? "valid" : "invalid"}</strong><code>${esc(String(runtime.bundled && runtime.bundled.fingerprint || "").slice(0, 12))}</code></div>
				<div><span>Runtime ScrollWorld</span><strong>${runtime.runtime && runtime.runtime.valid ? "valid" : "invalid"}</strong><code>${esc(String(runtime.runtime && runtime.runtime.fingerprint || "").slice(0, 12))}</code></div>
				<div><span>Runtime list</span><strong>${Number(list.count || 0)} skills</strong><code>${list.ok ? "list ok" : esc(list.error || "list failed")}</code></div>
			</div>
			<div class="runtime-detail"><span>Active storage</span><code>${esc(diagnostics.storage && diagnostics.storage.skillsPath || "unavailable")}</code></div>
			<div class="runtime-detail"><span>Last route</span><strong>${esc(selected)}${route.exclusive ? " · exclusive" : ""}</strong></div>
			<div class="runtime-detail"><span>Last vertical</span><strong>${esc((vertical.selected || []).join(", ") || vertical.reason || "No vertical evaluated in this session")}</strong></div>
			<div class="runtime-detail"><span>Final prompt proof</span><code>${prompt.finalPromptBytes ? `${Number(prompt.finalPromptBytes).toLocaleString()} bytes · ${esc(String(prompt.finalPromptSha256 || "").slice(0, 12))}` : "No prompt dispatched in this session"}</code></div>
			${!healthy ? `<div class="runtime-alert">The runtime skill state is incomplete or unverifiable. Repair it before relying on ScrollWorld.</div>` : ""}
			${message}
			<div class="runtime-actions"><button id="exportDiagnostics">ייצא diagnostics</button><button class="primary" id="repairScrollWorld">תקן ScrollWorld</button></div>
		</section>`;
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
		const exportButton = document.getElementById("exportDiagnostics");
		if (exportButton) exportButton.onclick = () => { diagnosticsMessage = "פותח בחירת יעד לייצוא…"; render(); vscode.postMessage({ type: "exportDiagnostics" }); };
		const repairButton = document.getElementById("repairScrollWorld");
		if (repairButton) repairButton.onclick = () => vscode.postMessage({ type: "repairScrollWorld" });
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
		if (data.type === "skills") { items = data.items || []; diagnostics = data.diagnostics || null; }
		else if (data.type === "diagnosticsExported") diagnosticsMessage = `הדיאגנוסטיקה יוצאה אל ${data.path}`;
		else if (data.type === "diagnosticsError") diagnosticsMessage = `ייצוא נכשל: ${data.message || "unknown error"}`;
		else if (data.type === "repairDone") diagnosticsMessage = data.backup ? `ScrollWorld תוקן; העותק הקודם נשמר ב־${data.backup}` : "ScrollWorld תוקן ואומת.";
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
