"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let projects = [];

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
		const nb = el("button", "gBtn primary", "");
		nb.innerHTML = "✦ New build";
		nb.addEventListener("click", () => vscode.postMessage({ type: "newProject" }));
		actions.append(refresh, nb);
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
		hint.appendChild(el("span", "", "Open in Solstice"));
		thumb.appendChild(hint);
		c.appendChild(thumb);

		const body = el("div", "pbody");
		body.appendChild(el("div", "pname", p.name));
		if (p.description) body.appendChild(el("div", "pdesc", p.description));
		const meta = el("div", "pmeta");
		for (const t of (p.tags || []).slice(0, 3)) meta.appendChild(el("span", "chip", t));
		meta.appendChild(el("span", "ptime", relTime(p.updatedAt)));
		body.appendChild(meta);
		c.appendChild(body);

		c.addEventListener("click", (e) => {
			vscode.postMessage({ type: "openProject", dir: p.dir, newWindow: e.metaKey || e.ctrlKey });
		});
		return c;
	}

	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (msg.type === "projects") { projects = Array.isArray(msg.projects) ? msg.projects : []; render(); }
	});

	render();
	vscode.postMessage({ type: "ready" });
})();
