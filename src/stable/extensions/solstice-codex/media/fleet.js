"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let agents = [];
	let activeId = null;
	const threads = new Map(); // agentId -> [{who:'me'|'them'|'sys', text, ts}]

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

	function shell() {
		app.innerHTML = "";
		const wrap = el("div", "fleet");

		const roster = el("div", "roster");
		const rh = el("div", "rosterHead");
		rh.appendChild(el("span", "rMark", "☀"));
		const rt = el("div", "rTitle", "Fleet");
		rt.appendChild(el("small", "", "Your agents, inside Solstice"));
		rh.appendChild(rt);
		roster.appendChild(rh);
		for (const a of agents) roster.appendChild(agentRow(a));
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
		row.addEventListener("click", () => { activeId = a.id; shell(); });
		return row;
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
		setTimeout(() => { msgs.scrollTop = msgs.scrollHeight; ta.focus(); }, 0);
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
		msgs.appendChild(bubble(m));
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
			case "sent":
				appendMsg(msg.agent, msg.ok
					? { who: "sys", text: "✓ Delivered to " + (agentById(msg.agent) || {}).name + "'s inbox", ts: msg.ts }
					: { who: "sys", text: "⚠ Could not deliver: " + (msg.error || "unknown"), ts: Date.now() });
				break;
			case "reply":
				appendMsg(msg.agent, { who: "them", text: msg.text, ts: msg.ts });
				break;
			case "liveTask":
				showLive(msg.from, msg.task);
				break;
		}
	});

	vscode.postMessage({ type: "ready" });
})();
