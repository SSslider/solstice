"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let state = {
		board: null, endpoint: "", connectedAt: "", busy: true, detailBusy: false,
		selectedBusiness: null, error: "", connected: false, saving: false, pendingSlug: "",
	};

	const drafts = new Map();
	const imageDialog = document.createElement("dialog");
	imageDialog.className = "image-viewer";
	imageDialog.setAttribute("aria-label", "תצוגת תמונה");
	imageDialog.innerHTML = '<button type="button" class="back" aria-label="סגור תמונה">סגור ×</button><figure><img alt=""><figcaption></figcaption></figure><p role="status" hidden>לא ניתן לטעון את התמונה.</p>';
	document.body.appendChild(imageDialog);
	let imageOrigin = null;
	imageDialog.querySelector("button").onclick = () => imageDialog.close();
	imageDialog.onclick = (event) => { if (event.target === imageDialog) imageDialog.close(); };
	imageDialog.addEventListener("close", () => {
		const origin = imageOrigin;
		imageOrigin = null;
		imageDialog.querySelector("img").removeAttribute("src");
		const trigger = origin && [...app.querySelectorAll('[data-action="view-image"]')].find((button) => button.querySelector("img").getAttribute("src") === origin.src && button.querySelector("img").alt === origin.alt);
		if (trigger) trigger.focus();
	});
	function viewImage(button) {
		const source = button.querySelector("img");
		if (!source) return;
		imageOrigin = { src: source.getAttribute("src"), alt: source.alt };
		const image = imageDialog.querySelector("img"), error = imageDialog.querySelector('[role="status"]');
		error.hidden = true; image.hidden = false;
		image.onerror = () => { image.hidden = true; error.hidden = false; };
		image.alt = source.alt;
		imageDialog.querySelector("figcaption").textContent = source.alt;
		image.src = imageOrigin.src;
		imageDialog.showModal();
	}

	function esc(value) {
		return String(value === undefined || value === null ? "" : value)
			.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
	}
	function list(value) { return Array.isArray(value) ? value : []; }
	function object(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
	function number(value) { return Number(value || 0).toLocaleString("he-IL"); }
	function date(value) {
		if (!value) return "—";
		const parsed = new Date(String(value).replace(" ", "T"));
		return Number.isNaN(parsed.getTime()) ? esc(value) : esc(parsed.toLocaleString("he-IL"));
	}
	function metric(label, value, hint = "") {
		return `<div class="metric"><span>${esc(label)}</span><strong>${esc(value)}</strong>${hint ? `<small>${esc(hint)}</small>` : ""}</div>`;
	}
	function pills(values, empty = "לא הוגדר") {
		const items = list(values).filter((value) => value !== undefined && value !== null && value !== "");
		return items.length ? `<div class="pills">${items.map((value) => `<span>${esc(value)}</span>`).join("")}</div>` : `<span class="muted">${esc(empty)}</span>`;
	}
	function payload(value) {
		const entries = Object.entries(object(value));
		if (!entries.length) return `<span class="muted">ללא payload</span>`;
		return `<dl class="payload">${entries.map(([key, item]) => {
			const display = item && typeof item === "object" ? JSON.stringify(item) : String(item === null ? "—" : item);
			return `<div><dt>${esc(key)}</dt><dd>${esc(display)}</dd></div>`;
		}).join("")}</dl>`;
	}

	function businessCard(business) {
		const verticals = list(business.verticals);
		return `<button type="button" class="business" data-action="show-business" data-slug="${esc(business.slug || business.id)}">
			<div class="business-top"><span class="kind">${esc(business.kind || business.kindKey || "BUSINESS")}</span><span class="status ${esc(business.configStatus || "unknown")}">● ${esc(business.configStatus || "unknown")}</span></div>
			<h2>${esc(business.name || business.slug)}</h2><p class="slug">${esc(business.slug || business.id)}</p>
			${pills(verticals)}
			<div class="counts">${metric("אירועים", number(business.events))}${metric("חיבורים", number(business.connections))}${metric("קשרים", number(business.relationships))}</div>
			<span class="enter">פתח Command Center <b>←</b></span>
		</button>`;
	}

	function renderBoard() {
		const businesses = state.board ? list(state.board.businesses) : [];
		return `<header class="app-header"><div><small>SOLSTICE · LIVE BUSINESS OS</small><h1>Foundation</h1><p>לוח העסקים החי — לחץ על עסק כדי לפתוח את כל החיבורים, המחקר, הסגל והפעילות.</p></div><button class="action" data-action="refresh" ${state.busy ? "disabled" : ""}>${state.busy ? "טוען…" : "רענון"}</button></header>
			${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
			<section class="connection ${state.connected ? "online" : state.busy ? "pending" : "offline"}" role="status"><div><span class="pulse"></span><strong>${state.connected ? "FOUNDATION CONNECTED" : state.busy ? "CONNECTING" : "FOUNDATION OFFLINE"}</strong></div><span>${state.connected ? "הנתונים נטענו מהשרת" : state.board ? "מוצגים נתונים מהעדכון האחרון" : "אין חיבור מאומת לשרת"}</span><small>${state.connectedAt ? `עדכון מוצלח אחרון: ${date(state.connectedAt)}` : "ממתין לשרת"}</small></section>
			${state.detailBusy ? `<p role="status">פותח את העסק… <button class="back" data-action="back">ביטול</button></p>` : ""}
			<section class="summary"><div><small>VL-1 BOARD</small><h2>${state.board ? `${businesses.length} עסקים${state.connected ? "" : " · טרם רועננו"}` : "הנתונים טרם נטענו"}</h2></div>${metric("אירועים", state.board ? number(businesses.reduce((sum, item) => sum + Number(item.events || 0), 0)) : "—")}${metric("חיבורים", state.board ? number(businesses.reduce((sum, item) => sum + Number(item.connections || 0), 0)) : "—")}${metric("קשרים", state.board ? number(businesses.reduce((sum, item) => sum + Number(item.relationships || 0), 0)) : "—")}</section>
			<main class="board-grid">${businesses.length ? businesses.map(businessCard).join("") : `<div class="empty"><span>F</span><h2>${state.error ? "Foundation לא זמין" : state.board ? "אין עסקים להצגה" : "טוען את הלוח החי…"}</h2><p>${state.error ? "בדוק Tailscale והרשאות גישה; אין fallback לנתוני mock." : state.board ? "החיבור הצליח. עדיין אין עסקים בחשבון הזה." : "הנתונים מגיעים ישירות מ־/api/foundation/businesses."}</p></div>`}</main>`;
	}

	function influencersPanel(domain) {
		const influencers = list(domain.influencers);
		if (!influencers.length) return "";
		return `<section class="panel panel-wide"><div class="panel-head"><div><small>AI Influencers</small><h2>סגל המשפיענים</h2></div><span class="panel-count">${influencers.length}</span></div>
			<div class="influencers">${influencers.map((person) => `<article class="influencer">
				<div class="portrait">${person.baseImageUrl ? `<button type="button" class="image-trigger" data-action="view-image" aria-label="הגדל תמונה: ${esc(person.name)}"><img src="${esc(person.baseImageUrl)}" alt="${esc(person.name)}"></button>` : `<span>${esc(String(person.name || "?").slice(0, 1))}</span>`}<i class="state-dot ${esc(person.status || "unknown")}"></i></div>
				<div class="person-copy"><h3>${esc(person.name || "ללא שם")}</h3><p>${esc(person.status || "unknown")} · ${person.approved ? "מאושר לסגל" : "ממתין לאישור"}</p><div>${pills([`${number(person.sceneCount)} סצנות`, person.elementId ? `element ${String(person.elementId).slice(0, 8)}` : "ללא element"])}</div></div>
			</article>`).join("")}</div>
		</section>`;
	}

	function connectionsPanel(connections) {
		return `<section class="panel"><div class="panel-head"><div><small>PROVIDERS</small><h2>חיבורים</h2></div><span class="panel-count">${connections.length}</span></div>
			${connections.length ? `<div class="table-wrap"><table><thead><tr><th>ספק</th><th>תפקיד</th><th>סטטוס</th><th>יכולות</th><th>אימות אחרון</th></tr></thead><tbody>${connections.map((connection) => `<tr><td><strong>${esc(connection.provider || "—")}</strong><small class="mono">${esc(connection.connectionRef || connection.id || "")}</small></td><td>${esc(connection.role || "—")}</td><td><span class="badge ${esc(connection.status || "unknown")}">${esc(connection.status || "unknown")}</span>${connection.lastError ? `<small class="danger">${esc(connection.lastError)}</small>` : ""}</td><td>${pills(connection.capabilities)}</td><td>${date(connection.lastVerifiedAt)}</td></tr>`).join("")}</tbody></table></div>` : `<div class="panel-empty">אין חיבורים מוגדרים.</div>`}
		</section>`;
	}

	function domainPanel(domain) {
		const catalog = object(domain.catalog);
		const moodboard = object(domain.moodboard);
		const channels = list(domain.channels);
		const pipelines = list(domain.pipelines);
		const gates = list(domain.qualityGates);
		const engineLinks = list(domain.engineLinks);
		return `<section class="panel"><div class="panel-head"><div><small>OPERATING MODEL</small><h2>קטלוג, Moodboard וצינורות</h2></div><span class="panel-count">${esc(domain.kindKey || "domain")}</span></div>
			<div class="domain-grid">
				<div class="domain-card"><h3>קטלוג</h3><label>מוצרים</label>${pills(catalog.productTypes)}<label>דומיינים</label>${pills(catalog.domains)}<label>אזורים</label>${pills(catalog.regions)}<label>מצב אספקה</label>${pills(catalog.supplyModes)}${catalog.skuPattern ? `<p class="mono-line">${esc(catalog.skuPattern)}</p>` : ""}</div>
				<div class="domain-card"><h3>Moodboard</h3>${Object.keys(moodboard).length ? payload(moodboard) : `<p class="muted">אין moodboard מחובר לעסק הזה עדיין.</p>`}<h3 class="subhead">ערוצי עבודה</h3>${channels.length ? channels.map((item) => `<div class="compact-row"><span><b>${esc(item.key)}</b> · ${esc(item.role || "")}</span><span class="badge ${item.enabled ? "active" : "planned"}">${item.enabled ? "enabled" : "disabled"}</span></div>`).join("") : `<span class="muted">אין ערוצים</span>`}</div>
				<div class="domain-card"><h3>צינורות</h3>${pipelines.length ? pipelines.map((item) => `<div class="compact-row"><span class="mono">${esc(item.template || item.name || "pipeline")}</span><span class="badge ${item.enabled === false ? "planned" : "active"}">${item.enabled === false ? "off" : "active"}</span></div>`).join("") : `<span class="muted">אין pipelines</span>`}<h3 class="subhead">Quality gates</h3>${gates.length ? gates.map((gate) => `<div class="gate"><b>${esc(gate.key)}</b><span>${esc(gate.authority || "")}</span>${pills(gate.checks)}</div>`).join("") : `<span class="muted">אין gates</span>`}</div>
				<div class="domain-card"><h3>משטחים</h3>${engineLinks.length ? engineLinks.map((link) => `<div class="compact-row"><span><b>${esc(link.label)}</b><small>${esc(link.note || "")}</small></span><span class="mono">${esc(link.href || "")}</span></div>`).join("") : `<span class="muted">אין קישורי מנוע</span>`}<h3 class="subhead">Feature flags</h3>${payload(domain.featureFlags)}</div>
			</div>
		</section>`;
	}

	function relationshipsPanel(relationships) {
		return `<section class="panel relationship-panel"><div class="panel-head"><div><small>BUSINESS GRAPH</small><h2>קשרים</h2></div><span class="panel-count">${relationships.length}</span></div>
			${relationships.length ? `<div class="relationships">${relationships.map((relationship) => `<article><span class="relation-arrow">${relationship.direction === "out" ? "←" : "→"}</span><div><h3>${esc(relationship.peerName || relationship.peerSlug)}</h3><p>${esc(relationship.relation || "relationship")} · ${esc(relationship.status || "unknown")}</p><small class="mono">${esc(relationship.peerSlug || relationship.peerId || "")}</small></div></article>`).join("")}</div>` : `<div class="panel-empty">אין קשרים עסקיים רשומים.</div>`}
		</section>`;
	}

	function eventsPanel(events) {
		const research = events.filter((event) => /research|analysis|crawl|source|xfield|discovery/i.test(String(event.eventType || "")));
		const rows = (items) => items.map((event) => `<article class="event"><div class="event-rail"><i></i></div><div><div class="event-top"><strong>${esc(event.eventType || "event")}</strong><time>${date(event.occurredAt)}</time></div><p>${esc(event.actorType || "actor")} · ${esc(event.actorId || "unknown")} · ${esc(event.aggregateType || "aggregate")}</p>${payload(event.payload)}</div></article>`).join("");
		return `<section class="panel panel-wide"><div class="panel-head"><div><small>RESEARCH + EVENT LEDGER</small><h2>מחקר ופעילות</h2></div><span class="panel-count">${events.length}</span></div>
			<div class="event-columns"><div><h3 class="column-title">Research nodes · ${research.length}</h3>${research.length ? rows(research) : `<div class="panel-empty compact">אין אירועי מחקר מסווגים כרגע.</div>`}</div><div><h3 class="column-title">כל האירועים · ${events.length}</h3>${events.length ? rows(events) : `<div class="panel-empty compact">אין אירועים עדיין.</div>`}</div></div>
		</section>`;
	}

	function canvasPanel(canvas) {
		const snapshot = object(canvas && canvas.snapshot);
		const nodes = list(snapshot.nodes);
		const images = nodes.filter((node) => node && (node.imageDataUri || node.imageUrl));
		return `<section class="panel panel-wide canvas-panel" data-testid="solstice-foundation-canvas">
			<div class="panel-head"><div><small>SHARED EVENT LOG · ORIGIN SOLSTICE</small><h2>קנבס קנוני משותף</h2><p>revision ${number(canvas && canvas.revision)} · ${nodes.length} חלונות · ${images.length} תמונות · אותו backend של Atrium ו־Vega</p></div><span class="canvas-live ${state.connected ? "" : "offline"}">${state.connected ? "מסונכרן" : "לא מסונכרן"}</span></div>
			<div class="canvas-compose"><input id="canvasNodeTitle" aria-label="כותרת נוד חדש" maxlength="600" value="${esc(drafts.get(state.selectedBusiness.business.slug) || "")}" placeholder="נוד חדש שיסתנכרן ל־Vega ול־Atrium"><button data-action="add-canvas-node" ${state.saving || !state.connected ? "disabled" : ""}>${state.saving ? "שומר…" : "הוסף לקנבס"}</button></div>
			<div class="canvas-grid">${nodes.length ? nodes.map((node) => `<article class="canvas-node ${node.imageDataUri ? "has-image" : ""}">
				${node.imageDataUri ? `<button type="button" class="image-trigger" data-action="view-image" aria-label="הגדל תמונה: ${esc(node.title || "Imagine asset")}"><img src="${esc(node.imageDataUri)}" alt="${esc(node.title || "Imagine asset")}"></button>` : ""}
				<div><small>${esc(node.type || node.ftype || "node")}</small><h3>${esc(node.title || node.note || "ללא כותרת")}</h3><p>${esc(node.meta || String(node.id || "").slice(0, 8))}</p></div>
			</article>`).join("") : `<div class="panel-empty">הקנבס ריק. הנוד הראשון יופיע כאן מכל אחד משלושת המשטחים.</div>`}</div>
		</section>`;
	}

	function renderDetail() {
		const detail = state.selectedBusiness;
		if (!detail) return renderBoard();
		const business = object(detail.business);
		const domain = object(detail.domain);
		const connections = list(detail.connections);
		const events = list(detail.events);
		const relationships = list(detail.relationships);
		const influencers = list(domain.influencers);
		return `<header class="detail-nav"><button class="back" data-action="back">→ כל העסקים</button><div><small>FOUNDATION COMMAND CENTER</small><span class="mono">${esc(business.slug)}</span></div><div class="nav-actions"><button data-action="refresh-detail" ${state.detailBusy ? "disabled" : ""}>${state.detailBusy ? "טוען…" : "רענן עסק"}</button>${detail.surfaceLinks && detail.surfaceLinks.atrium ? `<button class="primary" data-action="open-surface" data-href="${esc(detail.surfaceLinks.atrium)}">פתח ב־Atrium ↗</button>` : ""}</div></header>
			${state.error ? `<div class="error">${esc(state.error)}</div>` : ""}
			<section class="record-head"><div class="record-id"><span class="record-mark">${esc(String(business.name || business.slug || "F").replace(/^Foundation\s*·?\s*/, "").slice(0, 2))}</span><div><small>${esc(business.kind || domain.kindKey || "BUSINESS")}</small><h1>${esc(business.name || business.slug)}</h1>${pills(business.verticals)}</div></div><div class="record-status"><span class="badge ${esc(business.configStatus || "unknown")}">${esc(business.configStatus || "unknown")}${business.configVersion ? ` · v${esc(business.configVersion)}` : ""}</span><span>עודכן ${date(state.connectedAt)}</span></div></section>
			<section class="detail-metrics">${metric("חיבורים", number(connections.length), "providers")}${metric("אירועים", number(events.length), "ledger")}${metric("קשרים", number(relationships.length), "business graph")}${metric("משפיענים", number(influencers.length), influencers.length ? `${number(domain.approved)} מאושרים` : "לא רלוונטי")}</section>
			<main class="detail-grid">${canvasPanel(detail.canvas)}${influencersPanel(domain)}${connectionsPanel(connections)}${domainPanel(domain)}${relationshipsPanel(relationships)}${eventsPanel(events)}</main>`;
	}

	function bind() {
		const input = document.getElementById("canvasNodeTitle");
		if (input) input.oninput = () => drafts.set(state.selectedBusiness.business.slug, input.value);
		app.querySelectorAll("[data-action]").forEach((element) => {
			element.onclick = () => {
				const action = element.dataset.action;
				if (action === "view-image") {
					viewImage(element);
				} else if (action === "refresh") {
					state.busy = true; state.error = ""; render(); vscode.postMessage({ type: "refresh" });
				} else if (action === "show-business") {
					state.pendingSlug = element.dataset.slug; state.detailBusy = true; state.error = ""; render(); vscode.postMessage({ type: "show_business", slug: element.dataset.slug });
				} else if (action === "back") {
					state.selectedBusiness = null; state.detailBusy = false; state.pendingSlug = ""; state.error = ""; render(); vscode.postMessage({ type: "show_board" });
				} else if (action === "refresh-detail") {
					state.detailBusy = true; state.error = ""; render(); vscode.postMessage({ type: "show_business", slug: state.selectedBusiness.business.slug });
				} else if (action === "open-surface") {
					vscode.postMessage({ type: "open_surface", href: element.dataset.href });
				} else if (action === "add-canvas-node") {
					const input = document.getElementById("canvasNodeTitle");
					const title = String(input && input.value || "").trim();
					if (!title) return;
					element.disabled = true; state.saving = true;
					vscode.postMessage({ type: "add_canvas_node", slug: state.selectedBusiness.business.slug, title });
				}
			};
		});
	}
	function render() {
		if (!state.selectedBusiness && imageDialog.open) imageDialog.close();
		const input = document.getElementById("canvasNodeTitle");
		const focused = input && document.activeElement === input;
		const selection = focused ? [input.selectionStart, input.selectionEnd] : null;
		app.innerHTML = state.selectedBusiness ? renderDetail() : renderBoard(); bind();
		const next = document.getElementById("canvasNodeTitle");
		if (focused && next) { next.focus(); next.setSelectionRange(...selection); }
	}
	window.addEventListener("message", (event) => {
		const data = event.data || {};
		if (data.type === "state") state = { ...state, ...data.state, busy: false, connected: true, error: "" };
		else if (data.type === "detailBusy") state = { ...state, detailBusy: true, pendingSlug: data.slug, error: "" };
		else if (data.type === "detail") state = { ...state, selectedBusiness: data.detail, connectedAt: data.connectedAt || state.connectedAt, detailBusy: false, connected: true, pendingSlug: "", error: "" };
		else if (data.type === "connection") state = { ...state, connected: true, connectedAt: data.connectedAt, error: "" };
		else if (data.type === "saving") state = { ...state, saving: data.saving };
		else if (data.type === "saved") { if (drafts.get(data.slug) === data.title) drafts.delete(data.slug); }
		else if (data.type === "error") state = { ...state, busy: false, detailBusy: false, connected: false, error: data.message || "Foundation request failed" };
		render();
	});
	render();
	vscode.postMessage({ type: "ready" });
})();
