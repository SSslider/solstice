"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let items = [];
	let diagnostics = null;
	let diagnosticsMessage = "";
	let learning = { mode: "gated-active", drafts: [] };
	let learningMessage = "";
	let install = { status: "idle", url: "", message: "", preview: null, candidates: [] };
	function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
	function skillCards() {
		const skills = items.filter((x) => x.kind !== "lesson");
		const lessons = items.filter((x) => x.kind === "lesson");
		return `<header><div><small>FELIX MEMORY</small><h1>🧠 Skills</h1><p>${skills.length} skills · ${lessons.length} lessons</p></div><button id="refresh">↻ רענן</button></header>` +
			diagnosticsHtml() +
			learningHtml() +
			installerHtml() +
			`<main>${items.map((x) => `<article class="${x.kind === "lesson" ? "lesson" : ""}"><div class="row"><span class="kind">${x.kind === "lesson" ? "לקח" : "SKILL"}</span><span class="uses">${Number(x.uses || 0)} שליפות</span></div><h2>${esc(x.name)}</h2>${x.kind !== "lesson" ? `<div class="level"><strong>Lv.${Number(x.level || 1)} · ${esc(x.title || "Foundation")}</strong><span>${Number(x.xp || 0)} XP</span></div><div class="xp" title="${Number(x.progress || 0)}%"><i style="width:${Math.max(0, Math.min(100, Number(x.progress || 0)))}%"></i></div><div class="next">${x.nextXp ? `${Number(x.nextXp) - Number(x.xp || 0)} XP לשלב הבא` : "רמה מקסימלית"}</div>` : ""}<div class="tags">${(x.tags || []).map((t) => `<span>${esc(t)}</span>`).join("")}</div><p>${esc(x.preview)}</p><footer>v${esc(x.version || 1)} · ${esc(x.updatedAt || "")}</footer></article>`).join("") || '<div class="empty">עדיין אין skills שמורים.</div>'}</main>`;
	}
	function learningHtml() {
		const drafts = learning.drafts || [];
		const pending = drafts.filter((draft) => draft.status === "DRAFT");
		const decided = drafts.filter((draft) => draft.status !== "DRAFT");
		const message = learningMessage ? `<div class="learning-message">${esc(learningMessage)}</div>` : "";
		return `<section class="learning"><div class="learning-head"><div><small>OUTCOME LEARNING · GATED ACTIVE</small><h2>Felix לומד מתוצאה מאומתת</h2><p>למידה נכנסת לפעולה רק אחרי אות הצלחה חיצוני עם SHA. שליפה או “Done” אינם למידה. כל רשומה חייבת <code>does_not_apply</code>; כשל activation נשאר כטיוטה גלויה שאפשר לנסות שוב או לדחות.</p></div><span class="active-mode">ACTIVE · ${pending.length} need attention</span></div>${message}<div class="drafts">${pending.map((draft) => `<article class="draft"><div class="row"><span class="kind">${esc(draft.level)}</span><code>${esc(draft.id)}</code></div><h3>${esc(draft.title)}</h3><p class="claim">${esc(draft.claim)}</p><div class="hierarchy">${[draft.hierarchy && draft.hierarchy.principle, draft.hierarchy && draft.hierarchy.capability, draft.hierarchy && draft.hierarchy.vertical, draft.hierarchy && draft.hierarchy.client].filter(Boolean).map((x) => `<span>${esc(x)}</span>`).join(" → ")}</div><details open><summary>מתי לא להחיל</summary><ul>${(draft.does_not_apply || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details><div class="signal"><strong>${esc(draft.success_signal && draft.success_signal.type)}</strong><code>${esc(String(draft.success_signal && draft.success_signal.sha256 || "").slice(0, 16))}</code><small>${esc(draft.success_signal && draft.success_signal.evidence)}</small></div><div class="draft-actions"><button data-reject="${esc(draft.id)}">דחה</button><button class="primary" data-approve="${esc(draft.id)}">נסה activation</button></div></article>`).join("") || `<div class="learning-empty">אין רשומות שמצריכות טיפול. למידה פעילה נוצרת רק מתוצאה חיצונית מאומתת.</div>`}</div>${decided.length ? `<details class="history" open><summary>${decided.length} למידות והחלטות</summary><div>${decided.slice(-8).reverse().map((draft) => `<span>${esc(draft.title)} · ${esc(draft.status)}</span>`).join("")}</div></details>` : ""}</section>`;
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
		for (const button of document.querySelectorAll("[data-approve]")) button.onclick = () => vscode.postMessage({ type: "approveLearning", id: button.dataset.approve });
		for (const button of document.querySelectorAll("[data-reject]")) button.onclick = () => vscode.postMessage({ type: "rejectLearning", id: button.dataset.reject });
	}
	function render() { app.innerHTML = skillCards(); bind(); }
	window.addEventListener("message", (event) => {
		const data = event.data || {};
		if (data.type === "skills") { items = data.items || []; diagnostics = data.diagnostics || null; learning = data.learning || { mode: "gated-active", drafts: [] }; }
		else if (data.type === "diagnosticsExported") diagnosticsMessage = `הדיאגנוסטיקה יוצאה אל ${data.path}`;
		else if (data.type === "diagnosticsError") diagnosticsMessage = `ייצוא נכשל: ${data.message || "unknown error"}`;
		else if (data.type === "repairDone") diagnosticsMessage = data.backup ? `ScrollWorld תוקן; העותק הקודם נשמר ב־${data.backup}` : "ScrollWorld תוקן ואומת.";
		else if (data.type === "installBusy") { install.status = "busy"; install.message = data.message || "עובד…"; }
		else if (data.type === "skillSelection") { install.status = "idle"; install.message = "בחר SKILL.md אחד מתוך ה־repository."; install.candidates = data.candidates || []; install.preview = null; install.url = data.sourceUrl || install.url; }
		else if (data.type === "installPreview") { install.status = "preview"; install.message = "המקור נבדק. עיין בפרטים ואשר התקנה."; install.preview = data; install.candidates = []; }
		else if (data.type === "installDone") { install = { status: "done", url: "", message: `הותקן ${data.name} בזמן ריצה — בלי build נוסף.`, preview: null, candidates: [] }; }
		else if (data.type === "installCancelled") { install.status = "idle"; install.message = "ההתקנה בוטלה; לא נכתב דבר."; }
		else if (data.type === "installError") { install.status = "error"; install.message = data.message || "ההתקנה נכשלה."; install.preview = null; }
		else if (data.type === "learningDecision") learningMessage = data.message || "החלטת הלמידה נשמרה.";
		else if (data.type === "learningError") learningMessage = `שגיאת למידה: ${data.message || "unknown"}`;
		render();
	});
	render(); vscode.postMessage({ type: "ready" });
})();
