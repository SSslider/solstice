"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let state = { health: null, profile: null, moodboard: null, moodboardImage: "", visualBrief: null, attached: null, busy: "", error: "", notice: "", domain: "", url: "", clientSlug: "" };
	function esc(value) { return String(value === undefined || value === null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
	function effective(value) { return value && typeof value === "object" && !Array.isArray(value) ? value.effective ?? value.value ?? "" : value ?? ""; }
	function colors(profile) {
		return Object.entries(profile && profile.palette || {}).map(([name, value]) => ({ name, color: String(effective(value) || "") })).filter((x) => /^#[0-9a-f]{3,8}$/i.test(x.color)).slice(0, 8);
	}
	function healthCard() {
		const h = state.health;
		const online = h && h.status === "ok";
		return `<section class="health ${online ? "online" : "offline"}"><div><small>LIVE ENGINE</small><h2>${online ? "Brand‑DNA מחובר" : "Brand‑DNA לא זמין"}</h2><p>${online ? `127.0.0.1:8794 · v${esc(h.version || "?")} · ${h.firecrawl_configured ? "Firecrawl מחובר" : "website fallback גלוי"}` : "הטאב לא עובד על mock. יש להחזיר את השירות לפני חילוץ או צירוף."}</p></div><div class="health-actions"><span>${online ? "● ONLINE" : "● OFFLINE"}</span><button id="health">בדיקת health</button></div></section>`;
	}
	function profileCard() {
		const p = state.profile;
		if (!p) return `<section class="empty"><span>01</span><h2>הזן URL כדי לחלץ Brand DNA אמיתי</h2><p>הפרופיל, הפלטה והטיפוגרפיה יגיעו ישירות מהמנוע המקומי.</p></section>`;
		const palette = colors(p);
		const typography = p.typography || {};
		const warnings = p.extraction && p.extraction.warnings || [];
		return `<section class="profile"><div class="section-head"><div><small>IDENTITY PROFILE</small><h2>${esc(effective(p.name) || p.domain)}</h2><p>${esc(p.domain)} · ${esc(p.extraction && p.extraction.provider || "unknown source")}</p></div><span class="scheme">${esc(effective(p.color_scheme) || "—")}</span></div>
			<div class="palette">${palette.map((x) => `<div><i style="background:${esc(x.color)}"></i><strong>${esc(x.name)}</strong><code>${esc(x.color)}</code></div>`).join("") || "<p>לא נמצאו צבעים תקינים.</p>"}</div>
			<div class="type-grid"><div><small>PRIMARY</small><strong>${esc(effective(typography.primary) || "—")}</strong></div><div><small>HEADINGS</small><strong>${esc(effective(typography.heading) || "—")}</strong></div><div><small>BODY</small><strong>${esc(effective(typography.body) || "—")}</strong></div></div>
			${warnings.length ? `<div class="warning">${warnings.map(esc).join(" · ")}</div>` : ""}
			<div class="actions"><button id="moodboard">טען moodboard</button><button id="recrawl">חילוץ מחדש</button><button class="primary" id="attach">צרף DNA מאושר לפרויקט</button></div></section>`;
	}
	function moodboardCard() {
		const m = state.moodboard;
		return `<section class="module"><div class="section-head"><div><small>MOODBOARD</small><h2>כיוון חזותי מבוקר</h2></div>${m ? `<span class="score ${m.passed ? "pass" : "fail"}">${Number(m.score || 0)}/100</span>` : ""}</div>${state.moodboardImage ? `<img class="board" src="${state.moodboardImage}" alt="Brand DNA moodboard">` : `<div class="module-empty">${m ? "מטא־דאטה נטענה, אך אין PNG מאושר." : "Moodboard יוצג רק אם עבר critic gate במנוע."}</div>`}${m && m.issues && m.issues.length ? `<ul>${m.issues.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : ""}</section>`;
	}
	function briefCard() {
		const b = state.visualBrief;
		const rules = b && b.rules || [];
		return `<section class="module"><div class="section-head"><div><small>VISUAL BRIEF</small><h2>חוקים מבוססי ראיות</h2></div>${b ? `<span class="evidence">${Number(b.evidence_count || 0)} evidence</span>` : ""}</div><div class="brief-form"><input id="clientSlug" dir="ltr" value="${esc(state.clientSlug)}" placeholder="kobi-barber"><button id="brief">טען visual brief</button></div>${b ? `<div class="rules">${rules.slice(0, 8).map((rule) => `<article><strong>${esc(rule.metric)}</strong><p>${esc(effective(rule.verdict))}</p><small>${Number(rule.verdict && rule.verdict.evidence_count || 0)} signals${rule.verdict && rule.verdict.is_fallback ? " · advisory" : ""}</small></article>`).join("")}</div><details><summary>Prompt directive</summary><pre>${esc(b.prompt_directive || "")}</pre></details>` : `<div class="module-empty">הבריף נטען לפי client slug קיים במנוע; חוסר נתונים מוצג כשגיאה, לא כטיוטת UI.</div>`}</section>`;
	}
	function statusStrip() {
		if (!state.busy && !state.error && !state.notice) return "";
		return `<div class="status ${state.error ? "error" : state.busy ? "busy" : "ok"}">${esc(state.error || state.busy || state.notice)}</div>`;
	}
	function attachedCard() {
		if (!state.attached) return "";
		return `<section class="attached"><span>✓ PROJECT SOURCE OF TRUTH</span><strong>.solstice/brand-dna.json</strong><code>${esc(state.attached.sha256 || "")}</code><small>${Number(state.attached.bytes || 0).toLocaleString()} bytes · ${esc(state.attached.approved_at || "")}</small></section>`;
	}
	function render() {
		app.innerHTML = `<header><div><small>SOLSTICE · CONNECTED INTELLIGENCE</small><h1>Brand‑DNA</h1><p>חילוץ מותג חי, ביקורת חזותית וצירוף snapshot מאושר לפרויקט.</p></div><div class="engine-mark">DNA<br><b>0.4</b></div></header>${healthCard()}<section class="extract"><div><small>EXTRACT FROM SOURCE</small><h2>URL → פרופיל מותג</h2></div><div class="extract-form"><input id="url" dir="ltr" value="${esc(state.url)}" placeholder="https://example.com"><button class="primary" id="extract">חלץ Brand DNA</button></div></section>${statusStrip()}${attachedCard()}${profileCard()}<div class="modules">${moodboardCard()}${briefCard()}</div>`;
		bind();
	}
	function send(type, extra) { state.error = ""; state.notice = ""; state.busy = type === "health" ? "בודק את השירות…" : "מתקשר עם Brand‑DNA…"; render(); vscode.postMessage({ type, ...(extra || {}) }); }
	function bind() {
		document.getElementById("health").onclick = () => send("health");
		document.getElementById("extract").onclick = () => { const url = document.getElementById("url").value.trim(); state.url = url; send("extract", { url }); };
		const recrawl = document.getElementById("recrawl"); if (recrawl) recrawl.onclick = () => send("recrawl", { domain: state.profile.domain });
		const moodboard = document.getElementById("moodboard"); if (moodboard) moodboard.onclick = () => send("moodboard", { domain: state.profile.domain });
		const attach = document.getElementById("attach"); if (attach) attach.onclick = () => send("attach");
		document.getElementById("brief").onclick = () => { const clientSlug = document.getElementById("clientSlug").value.trim(); state.clientSlug = clientSlug; send("visualBrief", { clientSlug }); };
	}
	window.addEventListener("message", (event) => {
		const data = event.data || {};
		if (data.type === "state") state = { ...state, ...data.state, busy: "" };
		else if (data.type === "error") state = { ...state, busy: "", error: data.message || "Brand-DNA request failed" };
		else if (data.type === "notice") state = { ...state, busy: "", notice: data.message || "" };
		render();
	});
	render(); vscode.postMessage({ type: "ready" });
})();
