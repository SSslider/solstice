"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let projects = [];
	let fleetAgents = [];

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function relTime(ms) {
		const s = Math.floor((Date.now() - ms) / 1000);
		if (s < 60) return "just now";
		const m = Math.floor(s / 60); if (m < 60) return m + "m ago";
		const h = Math.floor(m / 60); if (h < 24) return h + "h ago";
		const d = Math.floor(h / 24); if (d < 30) return d + "d ago";
		const mo = Math.floor(d / 30); return mo + "mo ago";
	}

	function render() {
		app.innerHTML = "";

		const head = el("div", "galHead");
		const tw = el("div", "galTitleWrap");
		tw.appendChild(el("span", "galMark", "☀"));
		const tt = el("div");
		tt.appendChild(el("div", "galTitle", "Projects"));
		const sub = el("div", "galSub");
		sub.innerHTML = projects.length
			? `<b>${projects.length}</b> project${projects.length === 1 ? "" : "s"} built on this server`
			: "No projects yet — build one with the agent";
		tt.appendChild(sub);
		tw.appendChild(tt);
		head.appendChild(tw);

		const actions = el("div", "galActions");
		const refresh = el("button", "gBtn", "");
		refresh.innerHTML = "↻ Refresh";
		refresh.addEventListener("click", () => vscode.postMessage({ type: "refresh" }));
		const conn = el("button", "gBtn", "");
		conn.innerHTML = "🔌 Connectors";
		conn.addEventListener("click", () => vscode.postMessage({ type: "openConnectors" }));
		const nb = el("button", "gBtn primary", "");
		nb.innerHTML = "✦ New build";
		nb.addEventListener("click", () => vscode.postMessage({ type: "newProject" }));
		actions.append(refresh, conn, nb);
		head.appendChild(actions);
		app.appendChild(head);

		if (!projects.length) {
			const e = el("div", "empty");
			e.appendChild(el("div", "big", "☀"));
			e.appendChild(el("h3", "", "Your gallery is empty"));
			e.appendChild(el("div", "", "Ask the Solstice agent to build a site or app — finished projects show up here."));
			app.appendChild(e);
			return;
		}

		const grid = el("div", "grid");
		for (const p of projects) grid.appendChild(card(p));
		app.appendChild(grid);
	}

	function card(p) {
		const c = el("div", "pcard");
		c.title = p.dir;

		const thumb = el("div", "pthumb");
		if (p.preview) {
			const img = document.createElement("img");
			img.src = p.preview; img.alt = p.name; img.loading = "lazy";
			thumb.appendChild(img);
		} else {
			thumb.classList.add("placeholder");
			thumb.appendChild(el("div", "pInitial", (p.name || "?").trim().charAt(0).toUpperCase()));
		}
		const hint = el("div", "openHint");
		hint.appendChild(el("span", "", p.remote ? "Open live site" : "Open in Solstice"));
		thumb.appendChild(hint);
		c.appendChild(thumb);

		const body = el("div", "pbody");
		body.appendChild(el("div", "pname", p.name));
		if (p.description) body.appendChild(el("div", "pdesc", p.description));
		const meta = el("div", "pmeta");
		for (const t of (p.tags || []).slice(0, 3)) meta.appendChild(el("span", "chip", t));
		meta.appendChild(el("span", "ptime", relTime(p.updatedAt)));
		body.appendChild(meta);
		body.appendChild(ownerRow(p));
		c.appendChild(body);

		c.addEventListener("click", (e) => {
			if (p.remote) vscode.postMessage({ type: "openRemote", url: p.openUrl });
			else vscode.postMessage({ type: "openProject", dir: p.dir, newWindow: e.metaKey || e.ctrlKey });
		});
		return c;
	}

	// Project ↔ agent ownership row: who owns it + assign + open-in-Fleet.
	function ownerRow(p) {
		const row = el("div", "owner");
		const stop = (e) => e.stopPropagation();
		if (p.agent) {
			const badge = el("button", "ownerBadge", "");
			badge.append(el("span", "ownerGlyph", p.agent.glyph || "◆"), document.createTextNode(p.agent.name));
			badge.title = "פתח את " + p.agent.name + " ב-Fleet";
			badge.addEventListener("click", (e) => { stop(e); vscode.postMessage({ type: "openInFleet", agent: p.agent.id, dir: p.dir }); });
			row.appendChild(badge);
		} else {
			row.appendChild(el("span", "ownerNone", "ללא סוכן"));
		}
		const sel = document.createElement("select");
		sel.className = "ownerSel";
		const none = document.createElement("option");
		none.value = ""; none.textContent = p.agent ? "שנה סוכן…" : "שייך לסוכן…";
		sel.appendChild(none);
		for (const a of fleetAgents) {
			const o = document.createElement("option");
			o.value = a.id; o.textContent = a.glyph + " " + a.name;
			if (p.agent && p.agent.id === a.id) o.selected = true;
			sel.appendChild(o);
		}
		sel.addEventListener("click", stop);
		sel.addEventListener("change", (e) => { stop(e); vscode.postMessage({ type: "assignAgent", dir: p.dir, agent: sel.value }); });
		row.appendChild(sel);

		const handoff = el("button", "ownerHandoff", "");
		handoff.innerHTML = "↗ מסור ללקוח";
		handoff.title = "מסור את הבילד לתיקיית לקוח ב-Atrium";
		handoff.addEventListener("click", (e) => {
			stop(e);
			vscode.postMessage({
				type: "handoffClient",
				project: { name: p.name, dir: p.dir, remote: !!p.remote, openUrl: p.openUrl, tags: p.tags, agent: p.agent },
			});
		});
		row.appendChild(handoff);
		return row;
	}

	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (msg.type === "agents") { fleetAgents = Array.isArray(msg.agents) ? msg.agents : []; }
		else if (msg.type === "projects") { projects = Array.isArray(msg.projects) ? msg.projects : []; render(); }
		else if (msg.type === "serverError") {
			const note = el("div", "galErr", "Gallery server unreachable (" + (msg.message || "error") + ") — showing local projects.");
			app.prepend(note);
		}
	});

	render();
	vscode.postMessage({ type: "ready" });
})();
