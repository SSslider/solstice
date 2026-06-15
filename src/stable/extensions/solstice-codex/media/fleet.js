"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let agents = [];
	let activeId = null;
	const threads = new Map(); // agentId -> [{who:'me'|'them'|'sys', text, ts}]
	const working = new Set(); // agentIds awaiting a live brain reply
	const activity = [];       // [{agent, state, text, ts}] newest last, capped
	const liveState = new Map(); // agentId -> {state, text, ts} latest per agent
	let pendingApprovals = []; // [{key, agent, name, kind, detail, label, ts}] inline gates
	let buildVersion = { text: "", tip: "" }; // Solstice version badge

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

	// ---- status helpers -----------------------------------------------------
	const STATE_LABEL = {
		online: "מחובר", connecting: "מתחבר…", working: "עובד…",
		replied: "ענה", offline: "מנותק", error: "שגיאה", idle: "ממתין", local: "מקומי",
		exploring: "חוקר…", thinking: "חושב…", planning: "מתכנן…", stuck: "תקוע",
	};
	const stuckAgents = new Map(); // agentId -> {state, mins}
	const liveness = new Map(); // agentId -> {layer, sinceMs, kind, queued, tokens}
	const LIVE_LABEL = { alive: "חי — פלט זורם", quiet: "שקט — אין פלט", stalled: "תקוע — אין פלט אמיתי", idle: "" };
	const LIVE_KIND = { token: "טוקנים", tool: "קבצים/כלים", stream: "טקסט" };
	function agoLabel(ms) {
		const s = Math.round((ms || 0) / 1000);
		if (s < 60) return s + "ש׳";
		const m = Math.round(s / 60); return m + " דק׳";
	}
	function livenessStrip(a) {
		const lv = liveness.get(a.id);
		if (!lv || lv.layer === "idle") return null;
		const strip = el("div", "live live--" + lv.layer);
		strip.appendChild(el("span", "liveDot"));
		const txt = lv.layer === "alive" && lv.kind
			? LIVE_LABEL.alive + " · " + (LIVE_KIND[lv.kind] || "") + " לפני " + agoLabel(lv.sinceMs)
			: (LIVE_LABEL[lv.layer] || lv.layer) + " " + agoLabel(lv.sinceMs);
		strip.appendChild(el("span", "liveTxt", txt));
		if (lv.queued > 0) {
			const q = el("span", "liveQueued", "↪ " + lv.queued + " ממתינות");
			strip.appendChild(q);
		}
		if (lv.layer === "stalled") {
			const r = el("button", "liveResume", "המשך");
			r.title = "שחרר את התור התקוע והמשך";
			r.addEventListener("click", (e) => { e.stopPropagation(); vscode.postMessage({ type: "resumeAgent", agent: a.id }); });
			strip.appendChild(r);
		}
		return strip;
	}
	let tokenMeter = { in: 0, out: 0, total: 0, exact: false, model: "" };
	function fmtTok(n) {
		n = Number(n || 0);
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
		return String(n);
	}
	function tokenMeterRow() {
		const row = el("div", "tokMeter");
		row.title = (tokenMeter.model ? tokenMeter.model + " · " : "") + "session " + (tokenMeter.exact ? "" : "≈")
			+ fmtTok(tokenMeter.total) + " tokens (in " + fmtTok(tokenMeter.in) + " / out " + fmtTok(tokenMeter.out) + ")";
		const lab = el("div", "tokLab");
		lab.appendChild(el("span", "tokIcon", "⊟"));
		lab.appendChild(el("span", "", "xAI tokens · session"));
		lab.appendChild(el("span", "tokVal", (tokenMeter.exact ? "" : "≈") + fmtTok(tokenMeter.total)));
		row.appendChild(lab);
		const bar = el("div", "tokBar");
		const inPct = tokenMeter.total ? Math.round((tokenMeter.in / tokenMeter.total) * 100) : 0;
		const segIn = el("div", "tokSeg tokSeg--in"); segIn.style.width = inPct + "%";
		const segOut = el("div", "tokSeg tokSeg--out"); segOut.style.width = (100 - inPct) + "%";
		bar.appendChild(segIn); bar.appendChild(segOut);
		row.appendChild(bar);
		const leg = el("div", "tokLeg");
		leg.appendChild(el("span", "tokLegIn", "in " + fmtTok(tokenMeter.in)));
		leg.appendChild(el("span", "tokLegOut", "out " + fmtTok(tokenMeter.out)));
		row.appendChild(leg);
		return row;
	}
	function statusClass(a) {
		const ls = liveState.get(a.id);
		if (ls && ls.state) return ls.state;
		return a.status || (a.present ? "online" : "offline");
	}
	function statusText(a) {
		const ls = liveState.get(a.id);
		if (ls && ls.state === "working") return ls.text || "עובד…";
		const st = statusClass(a);
		return STATE_LABEL[st] || st;
	}

	function shell() {
		app.innerHTML = "";
		const wrap = el("div", "fleet");

		const roster = el("div", "roster");
		const rh = el("div", "rosterHead");
		rh.appendChild(el("span", "rMark", "☀"));
		const rt = el("div", "rTitle", "Fleet");
		const online = agents.filter((a) => statusClass(a) === "online").length;
		rt.appendChild(el("small", "", agents.length + " agents · " + online + " online"));
		rh.appendChild(rt);
		if (buildVersion.text) {
			const ver = el("span", "rVer", buildVersion.text);
			ver.title = buildVersion.tip || ("Solstice " + buildVersion.text);
			rh.appendChild(ver);
		}
		roster.appendChild(rh);
		if (tokenMeter.total > 0) roster.appendChild(tokenMeterRow());
		const list = el("div", "rosterList");
		for (const a of agents) list.appendChild(agentRow(a));
		roster.appendChild(list);
		roster.appendChild(addAgentBlock());
		wrap.appendChild(roster);

		wrap.appendChild(chatPane());
		wrap.appendChild(activityPane());
		app.appendChild(wrap);
	}

	function agentRow(a) {
		const stk = stuckAgents.get(a.id);
		const row = el("div", "agent" + (a.id === activeId ? " active" : "") + (stk ? " agent--stuck" : ""));
		row.appendChild(el("span", "aGlyph", a.glyph));
		const meta = el("div", "aMeta");
		const name = el("div", "aName");
		name.appendChild(el("span", "", a.name));
		const dot = el("span", "aDot aDot--" + statusClass(a));
		if (statusClass(a) === "working" || statusClass(a) === "connecting") dot.classList.add("aDot--pulse");
		name.appendChild(dot);
		meta.appendChild(name);
		meta.appendChild(el("div", "aRole", a.role));
		if (stk) {
			const warn = el("div", "aStuck");
			warn.appendChild(el("span", "aStuckIcon", "⚠"));
			warn.appendChild(el("span", "", "תקוע ב-\"" + stk.state + "\" · " + stk.mins + " דק׳"));
			const nudge = el("button", "aStuckBtn", "נקה");
			nudge.addEventListener("click", (e) => { e.stopPropagation(); stuckAgents.delete(a.id); vscode.postMessage({ type: "clearStuck", agent: a.id }); shell(); });
			warn.appendChild(nudge);
			meta.appendChild(warn);
		} else {
			const sline = el("div", "aStatus aStatus--" + statusClass(a), statusText(a));
			meta.appendChild(sline);
		}
		const strip = livenessStrip(a);
		if (strip) meta.appendChild(strip);
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

	// ---- activity rail ------------------------------------------------------
	const ACT_GLYPH = {
		online: "●", connecting: "◐", working: "◆", replied: "✓",
		offline: "○", error: "⚠", idle: "·", local: "◇", dispatch: "➦",
		exploring: "◈", thinking: "✲", planning: "❑", stuck: "⚠",
	};
	function activityPane() {
		const pane = el("div", "activity");
		const h = el("div", "actHead");
		h.appendChild(el("span", "actPulse"));
		h.appendChild(el("span", "actTitle", "Live activity"));
		pane.appendChild(h);
		const feed = el("div", "actFeed");
		feed.id = "actFeed";
		if (!activity.length) {
			feed.appendChild(el("div", "actEmpty", "פעילות הסוכנים תופיע כאן בזמן אמת."));
		} else {
			for (let i = activity.length - 1; i >= 0; i--) feed.appendChild(actRow(activity[i]));
		}
		pane.appendChild(feed);
		return pane;
	}
	function actRow(ev) {
		const a = agentById(ev.agent) || { name: ev.agent, glyph: "◆" };
		const row = el("div", "actItem actItem--" + ev.state);
		row.appendChild(el("span", "actGlyph", ACT_GLYPH[ev.state] || "·"));
		const body = el("div", "actBody");
		const top = el("div", "actTop");
		top.appendChild(el("span", "actName", a.name));
		top.appendChild(el("span", "actTime", time(ev.ts)));
		body.appendChild(top);
		body.appendChild(el("div", "actText", ev.text || STATE_LABEL[ev.state] || ev.state));
		row.appendChild(body);
		return row;
	}
	function pushActivity(ev) {
		activity.push(ev);
		if (activity.length > 120) activity.splice(0, activity.length - 120);
		liveState.set(ev.agent, { state: ev.state, text: ev.text, ts: ev.ts });
		const feed = document.getElementById("actFeed");
		if (feed) {
			const empty = feed.querySelector(".actEmpty");
			if (empty) empty.remove();
			feed.insertBefore(actRow(ev), feed.firstChild);
		}
		// refresh the roster row status without a full re-render
		refreshRosterStatus(ev.agent);
	}
	function refreshRosterStatus(agentId) {
		// cheap: re-render the whole shell only if the changed agent is visible.
		// roster is small, so a targeted DOM patch keeps the chat scroll intact.
		const rows = document.querySelectorAll(".roster .agent");
		const idx = agents.findIndex((a) => a.id === agentId);
		if (idx < 0 || !rows[idx]) return;
		const a = agents[idx];
		const dot = rows[idx].querySelector(".aDot");
		const sline = rows[idx].querySelector(".aStatus");
		const cls = statusClass(a);
		if (dot) { dot.className = "aDot aDot--" + cls; if (cls === "working" || cls === "connecting") dot.classList.add("aDot--pulse"); }
		if (sline) { sline.className = "aStatus aStatus--" + cls; sline.textContent = statusText(a); }
		const head = document.querySelector(".rosterHead small");
		if (head) head.textContent = agents.length + " agents · " + agents.filter((x) => statusClass(x) === "online").length + " online";
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

	// ---- inline approval gate ----------------------------------------------
	const APPR_KIND = { edit: "✎ כתיבת קובץ", run: "⌘ הרצת פקודה", dispatch: "➦ שיגור לסוכן", open: "▣ פתיחת קובץ" };
	function approvalCard(ap) {
		const card = el("div", "apprCard apprCard--" + ap.kind);
		const top = el("div", "apprTop");
		top.appendChild(el("span", "apprKind", APPR_KIND[ap.kind] || ap.kind));
		top.appendChild(el("span", "apprName", ap.name || ap.agent));
		card.appendChild(top);
		card.appendChild(el("div", "apprLabel", ap.label || ap.detail || ""));
		const acts = el("div", "apprActs");
		const yes = el("button", "apprYes", "אשר");
		yes.addEventListener("click", () => decideApproval(ap.key, "approve"));
		const no = el("button", "apprNo", "דחה");
		no.addEventListener("click", () => decideApproval(ap.key, "deny"));
		acts.append(yes, no);
		card.appendChild(acts);
		return card;
	}
	function decideApproval(key, decision) {
		vscode.postMessage({ type: "approval", key, decision });
		pendingApprovals = pendingApprovals.filter((a) => a.key !== key);
		renderApprovals();
	}
	function renderApprovals() {
		const wrap = document.getElementById("apprWrap");
		if (!wrap) return;
		wrap.innerHTML = "";
		for (const ap of pendingApprovals) if (ap.agent === activeId) wrap.appendChild(approvalCard(ap));
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
		const ctx = el("button", "chatCtx", "📎 קונטקסט");
		ctx.title = "שלח לסוכן את הקובץ/הקטע הפעיל בעורך";
		ctx.addEventListener("click", () => vscode.postMessage({ type: "sendContext", agent: a.id }));
		head.appendChild(ctx);
		const clear = el("button", "chatClear", "נקה");
		clear.title = "נקה היסטוריה";
		clear.addEventListener("click", () => {
			threads.set(a.id, []);
			vscode.postMessage({ type: "clearThread", agent: a.id });
			shell();
		});
		head.appendChild(clear);
		chat.appendChild(head);

		const appr = el("div", "apprWrap");
		appr.id = "apprWrap";
		for (const ap of pendingApprovals) if (ap.agent === a.id) appr.appendChild(approvalCard(ap));
		chat.appendChild(appr);

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
			case "history":
				if (msg.threads && typeof msg.threads === "object") {
					for (const id of Object.keys(msg.threads)) {
						if (Array.isArray(msg.threads[id])) threads.set(id, msg.threads[id].slice());
					}
					shell();
				}
				break;
			case "activity":
				pushActivity({ agent: msg.agent, state: msg.state, text: msg.text, ts: msg.ts || Date.now() });
				if (msg.state && msg.state !== "stuck") { stuckAgents.delete(msg.agent); }
				break;
			case "liveness":
				liveness.set(msg.agent, { layer: String(msg.layer || "idle"), sinceMs: Number(msg.sinceMs || 0), kind: msg.kind || null, queued: Number(msg.queued || 0), tokens: Number(msg.tokens || 0) });
				shell();
				break;
			case "stuck":
				stuckAgents.set(msg.agent, { state: String(msg.state || "busy"), mins: Number(msg.mins || 0) });
				shell();
				break;
			case "stuckCleared":
				stuckAgents.delete(msg.agent);
				shell();
				break;
			case "tokens":
				tokenMeter = { in: Number(msg.inT || 0), out: Number(msg.outT || 0), total: Number(msg.inT || 0) + Number(msg.outT || 0), exact: !!msg.exact, model: String(msg.model || "") };
				shell();
				break;
			case "version":
				buildVersion = { text: String(msg.text || ""), tip: String(msg.tip || "") };
				if (agents.length) shell();
				break;
			case "focusAgent":
				if (msg.agent) { activeId = msg.agent; shell(); }
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
			case "approval":
				pendingApprovals.push({ key: msg.key, agent: msg.agent, name: msg.name, kind: msg.kind, detail: msg.detail, label: msg.label, ts: msg.ts });
				if (msg.agent === activeId) renderApprovals();
				else { activeId = msg.agent; shell(); }
				break;
			case "contextSent":
				if (msg.ok) appendMsg(msg.agent, { who: "sys", text: "📎 נשלח קונטקסט: " + (msg.rel || "") + (msg.range || ""), ts: Date.now() });
				else appendMsg(msg.agent, { who: "sys", text: "⚠ " + (msg.error || "לא ניתן לשלוח קונטקסט"), ts: Date.now() });
				break;
		}
	});

	vscode.postMessage({ type: "ready" });
})();
