"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let agents = [];
	let activeId = null;
	const threads = new Map(); // agentId -> [{who:'me'|'them'|'sys', text, ts}]
	const working = new Set(); // agentIds awaiting a live brain reply

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}
	function time(ts) {
		const d = new Date(ts || Date.now());
		return d.getHours() + ":" + String(d.getMinutes()).padStart(2, "0");
	}
	function agentById(id) { return agents.find((a) => a.id === id); }
	function thread(id) { if (!threads.has(id)) threads.set(id, []); return threads.get(id); }

	let addingAgent = false;

	function shell() {
		app.innerHTML = "";
		const wrap = el("div", "fleet");

		const roster = el("div", "roster");
		const rh = el("div", "rosterHead");
		rh.appendChild(el("span", "rMark", "☀"));
		const rt = el("div", "rTitle", "Fleet");
		rt.appendChild(el("small", "", agents.length + " agents · inside Solstice"));
		rh.appendChild(rt);
		roster.appendChild(rh);
		const list = el("div", "rosterList");
		for (const a of agents) list.appendChild(agentRow(a));
		roster.appendChild(list);
		roster.appendChild(addAgentBlock());
		wrap.appendChild(roster);

		wrap.appendChild(chatPane());
		app.appendChild(wrap);
	}

	function agentRow(a) {
		const row = el("div", "agent" + (a.id === activeId ? " active" : ""));
		row.appendChild(el("span", "aGlyph", a.glyph));
		const meta = el("div", "aMeta");
		const name = el("div", "aName");
		name.appendChild(el("span", "", a.name));
		name.appendChild(el("span", "aDot" + (a.present ? "" : " off")));
		meta.appendChild(name);
		meta.appendChild(el("div", "aRole", a.role));
		meta.appendChild(el("div", "aModel", a.model));
		row.appendChild(meta);
		if (a.removable !== false) {
			const x = el("button", "aRemove", "×");
			x.title = "Remove " + a.name;
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				if (activeId === a.id) activeId = null;
				vscode.postMessage({ type: "removeAgent", id: a.id });
			});
			row.appendChild(x);
		}
		row.addEventListener("click", () => { activeId = a.id; vscode.postMessage({ type: "select", agent: a.id }); shell(); });
		return row;
	}

	function addAgentBlock() {
		const box = el("div", "addBox");
		if (!addingAgent) {
			const btn = el("button", "addBtn");
			btn.append(el("span", "addPlus", "+"), document.createTextNode("Add agent"));
			btn.addEventListener("click", () => { addingAgent = true; shell(); });
			box.appendChild(btn);
			return box;
		}
		const form = el("div", "addForm");
		const fields = [
			["id", "id (e.g. niko)", ""],
			["name", "Display name", ""],
			["role", "Role", ""],
			["glyph", "Glyph", "◆"],
			["model", "Model", ""],
			["wsUrl", "Live bridge ws:// URL (optional)", ""],
		];
		const inputs = {};
		for (const [key, ph, def] of fields) {
			const inp = document.createElement("input");
			inp.className = "addInput";
			inp.placeholder = ph;
			if (def) inp.value = def;
			inputs[key] = inp;
			form.appendChild(inp);
		}
		const actions = el("div", "addActions");
		const save = el("button", "addSave", "Add");
		save.addEventListener("click", () => {
			const agent = {};
			for (const k of Object.keys(inputs)) agent[k] = inputs[k].value.trim();
			if (!agent.id) { inputs.id.focus(); return; }
			vscode.postMessage({ type: "addAgent", agent });
			addingAgent = false;
		});
		const cancel = el("button", "addCancel", "Cancel");
		cancel.addEventListener("click", () => { addingAgent = false; shell(); });
		actions.append(save, cancel);
		form.appendChild(actions);
		box.appendChild(form);
		setTimeout(() => inputs.id.focus(), 0);
		return box;
	}

	function renderWorking() {
		const msgs = document.getElementById("msgs");
		if (!msgs) return;
		let w = document.getElementById("working");
		if (working.has(activeId)) {
			if (!w) {
				w = el("div", "row them");
				w.id = "working";
				const b = el("div", "bubble workingDots");
				b.append(el("span", "dot"), el("span", "dot"), el("span", "dot"));
				w.appendChild(b);
				msgs.appendChild(w);
			}
			msgs.scrollTop = msgs.scrollHeight;
		} else if (w) {
			w.remove();
		}
	}

	function chatPane() {
		const chat = el("div", "chat");
		const a = agentById(activeId);
		if (!a) {
			const e = el("div", "emptyChat");
			e.appendChild(el("div", "big", "❖"));
			e.appendChild(el("h3", "", "Pick an agent"));
			e.appendChild(el("div", "", "Talk to Orion, Jasper or Asher — hand them a task and watch it run live in Solstice."));
			chat.appendChild(e);
			return chat;
		}
		const head = el("div", "chatHead");
		head.appendChild(el("span", "aGlyph", a.glyph));
		const ht = el("div");
		ht.appendChild(el("div", "chatHeadName", a.name));
		ht.appendChild(el("div", "chatHeadRole", a.role + " · " + a.model));
		head.appendChild(ht);
		chat.appendChild(head);

		const banner = el("div", "liveBanner");
		banner.id = "liveBanner";
		banner.appendChild(el("span", "livePulse"));
		const bt = el("span", "");
		bt.id = "liveBannerText";
		banner.appendChild(bt);
		const open = el("span", "liveOpen", "Watch live →");
		open.addEventListener("click", () => vscode.postMessage({ type: "openAgentPanel" }));
		banner.appendChild(open);
		chat.appendChild(banner);

		const msgs = el("div", "msgs");
		msgs.id = "msgs";
		const t = thread(a.id);
		if (!t.length) {
			const e = el("div", "emptyChat");
			e.appendChild(el("div", "big", a.glyph));
			e.appendChild(el("h3", "", "Message " + a.name));
			e.appendChild(el("div", "", a.id === "jasper"
				? "e.g. “Build a premium landing page for a dental clinic” — Jasper dispatches it to Solstice and it runs here live."
				: "Give a task or ask a question. Replies appear here."));
			msgs.appendChild(e);
		} else {
			for (const m of t) msgs.appendChild(bubble(m));
		}
		chat.appendChild(msgs);

		const composer = el("div", "composer");
		const ta = document.createElement("textarea");
		ta.id = "fleetInput";
		ta.rows = 1;
		ta.placeholder = "Message " + a.name + "…";
		ta.addEventListener("keydown", (e) => {
			if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); doSend(); }
		});
		const btn = el("button", "sendBtn", "Send");
		btn.addEventListener("click", doSend);
		composer.append(ta, btn);
		chat.appendChild(composer);
		setTimeout(() => { renderWorking(); msgs.scrollTop = msgs.scrollHeight; ta.focus(); }, 0);
		return chat;
	}

	function bubble(m) {
		const row = el("div", "row " + (m.who === "me" ? "me" : m.who === "sys" ? "sys" : "them"));
		const b = el("div", "bubble");
		b.appendChild(document.createTextNode(m.text));
		if (m.who !== "sys") b.appendChild(el("div", "bTime", time(m.ts)));
		row.appendChild(b);
		return row;
	}

	function appendMsg(id, m) {
		thread(id).push(m);
		if (id !== activeId) return;
		const msgs = document.getElementById("msgs");
		if (!msgs) return;
		const empty = msgs.querySelector(".emptyChat");
		if (empty) empty.remove();
		const w = document.getElementById("working");
		if (w) w.remove();              // keep the typing indicator below the newest bubble
		msgs.appendChild(bubble(m));
		renderWorking();
		msgs.scrollTop = msgs.scrollHeight;
	}

	function doSend() {
		const ta = document.getElementById("fleetInput");
		if (!ta || !activeId) return;
		const text = ta.value.trim();
		if (!text) return;
		ta.value = "";
		appendMsg(activeId, { who: "me", text, ts: Date.now() });
		vscode.postMessage({ type: "send", agent: activeId, text });
	}

	function showLive(from, task) {
		const banner = document.getElementById("liveBanner");
		const txt = document.getElementById("liveBannerText");
		if (!banner || !txt) return;
		txt.innerHTML = "<b>" + (from || "Fleet") + "</b> dispatched a build — running live in Solstice now";
		banner.classList.add("show");
	}

	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "roster":
				agents = Array.isArray(msg.agents) ? msg.agents : [];
				if (!activeId && agents.length) activeId = (agents.find((a) => a.id === "jasper") || agents[0]).id;
				shell();
				break;
			case "rosterUpdate":
				agents = Array.isArray(msg.agents) ? msg.agents : [];
				if (msg.select) activeId = msg.select;
				if (!agents.some((a) => a.id === activeId)) activeId = agents.length ? agents[0].id : null;
				addingAgent = false;
				shell();
				break;
			case "sent":
				if (!msg.ok) {
					working.delete(msg.agent);
					appendMsg(msg.agent, { who: "sys", text: "⚠ Could not reach " + ((agentById(msg.agent) || {}).name || msg.agent) + ": " + (msg.error || "unknown"), ts: Date.now() });
				} else if (msg.live) {
					working.add(msg.agent);          // live brain is now thinking
					if (msg.agent === activeId) renderWorking();
				} else {
					appendMsg(msg.agent, { who: "sys", text: "✓ Delivered to " + (agentById(msg.agent) || {}).name + "'s inbox", ts: msg.ts });
				}
				break;
			case "reply":
				working.delete(msg.agent);
				appendMsg(msg.agent, msg.kind === "progress"
					? { who: "sys", text: msg.text, ts: msg.ts }
					: { who: "them", text: msg.text, ts: msg.ts });
				break;
			case "fleetError":
				working.delete(msg.agent);
				appendMsg(msg.agent, { who: "sys", text: "⚠ " + (msg.error || "agent error"), ts: Date.now() });
				break;
			case "liveTask":
				showLive(msg.from, msg.task);
				break;
		}
	});

	vscode.postMessage({ type: "ready" });
})();
