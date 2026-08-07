"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let state = { board: null, endpoint: "", connectedAt: "", busy: true, error: "" };
	function esc(value) { return String(value === undefined || value === null ? "" : value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
	function count(label, value) { return `<div class="metric"><span>${esc(label)}</span><strong>${Number(value || 0).toLocaleString()}</strong></div>`; }
	function card(business) {
		const verticals = Array.isArray(business.verticals) ? business.verticals : [];
		return `<article class="business"><div class="business-top"><span class="kind">${esc(business.kind || business.kindKey || "BUSINESS")}</span><span class="status ${esc(business.configStatus || "unknown")}">● ${esc(business.configStatus || "unknown")}</span></div><h2>${esc(business.name || business.slug)}</h2><p class="slug">${esc(business.slug || business.id)}</p><div class="tags">${verticals.map((item) => `<span>${esc(item)}</span>`).join("")}</div><div class="counts">${count("אירועים", business.events)}${count("חיבורים", business.connections)}${count("קשרים", business.relationships)}</div></article>`;
	}
	function render() {
		const businesses = state.board && Array.isArray(state.board.businesses) ? state.board.businesses : [];
		app.innerHTML = `<header><div><small>SOLSTICE · LIVE BUSINESS OS</small><h1>Foundation</h1><p>אותו לוח עסקים חי שמשרת את Atrium ו־Vega — עכשיו כמשטח נפרד ונייטיבי בסולסטיס.</p></div><button id="refresh" ${state.busy ? "disabled" : ""}>${state.busy ? "טוען…" : "רענון חי"}</button></header>${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}<section class="connection ${businesses.length ? "online" : "pending"}"><div><span class="pulse"></span><strong>${businesses.length ? "FOUNDATION CONNECTED" : "CONNECTING"}</strong></div><code>${esc(state.endpoint || "Tailscale endpoint")}</code><small>${state.connectedAt ? `עודכן ${esc(new Date(state.connectedAt).toLocaleString("he-IL"))}` : "ממתין לשרת"}</small></section><section class="summary"><div><small>VL-1 BOARD</small><h2>${businesses.length} עסקים חיים</h2></div>${count("אירועים", businesses.reduce((sum, item) => sum + Number(item.events || 0), 0))}${count("חיבורים", businesses.reduce((sum, item) => sum + Number(item.connections || 0), 0))}${count("קשרים", businesses.reduce((sum, item) => sum + Number(item.relationships || 0), 0))}</section><main>${businesses.length ? businesses.map(card).join("") : `<div class="empty"><span>F</span><h2>${state.error ? "Foundation לא זמין" : "טוען את הלוח החי…"}</h2><p>${state.error ? "בדוק Tailscale ומפתח גישה; אין fallback לנתוני mock." : "הנתונים מגיעים ישירות מ־/api/foundation/businesses."}</p></div>`}</main>`;
		document.getElementById("refresh").onclick = () => { state.busy = true; state.error = ""; render(); vscode.postMessage({ type: "refresh" }); };
	}
	window.addEventListener("message", (event) => {
		const data = event.data || {};
		if (data.type === "state") state = { ...state, ...data.state, busy: false, error: "" };
		else if (data.type === "error") state = { ...state, busy: false, error: data.message || "Foundation request failed" };
		render();
	});
	render();
	vscode.postMessage({ type: "ready" });
})();
