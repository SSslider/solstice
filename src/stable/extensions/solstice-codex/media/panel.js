"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	let authMethod;            // undefined = unknown, null = signed out, string = signed in
	let busy = false;
	let model = "";
	const items = new Map();   // itemId -> { el, type, text }

	// ---------- skeleton ----------
	app.innerHTML = `
		<div id="header">
			<div id="status"><span id="dot" class="dot"></span><span id="model"></span></div>
			<div id="quota" title=""></div>
		</div>
		<div id="messages"></div>
		<div id="composer">
			<textarea id="input" rows="3" placeholder="Describe a task for the agent…"></textarea>
			<div id="composerBar">
				<span id="hint">Enter to send · Shift+Enter for newline</span>
				<button id="stopBtn" class="btn danger hidden">Stop</button>
				<button id="sendBtn" class="btn primary">Send</button>
			</div>
		</div>
		<div id="loginOverlay" class="hidden">
			<div class="loginCard">
				<div class="loginLogo">☀️</div>
				<h2>Solstice Agent</h2>
				<p>Build with GPT-5.5 using your ChatGPT subscription.</p>
				<button id="loginBtn" class="btn primary big">Sign in with ChatGPT</button>
				<p id="loginNote" class="muted"></p>
			</div>
		</div>`;

	const messagesEl = document.getElementById("messages");
	const inputEl = document.getElementById("input");
	const sendBtn = document.getElementById("sendBtn");
	const stopBtn = document.getElementById("stopBtn");
	const dotEl = document.getElementById("dot");
	const modelEl = document.getElementById("model");
	const quotaEl = document.getElementById("quota");
	const overlayEl = document.getElementById("loginOverlay");
	const loginNoteEl = document.getElementById("loginNote");

	document.getElementById("loginBtn").addEventListener("click", () => {
		loginNoteEl.textContent = "Complete the sign-in in your browser…";
		vscode.postMessage({ type: "login" });
	});
	sendBtn.addEventListener("click", send);
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
	});

	function send() {
		const text = inputEl.value.trim();
		if (!text || busy) return;
		inputEl.value = "";
		addUserMessage(text);
		setBusy(true);
		vscode.postMessage({ type: "send", text });
	}

	let busyEl = null;
	let busyLabelEl = null;
	let busyClockEl = null;
	let busyStart = 0;
	let busyTimer = null;
	function setBusy(b) {
		busy = b;
		dotEl.className = "dot " + (b ? "busy" : "idle");
		sendBtn.disabled = b;
		stopBtn.classList.toggle("hidden", !b);
		if (b && !busyEl) {
			busyEl = el("div");
			busyEl.id = "busyLine";
			busyLabelEl = el("span", "busyLabel", "Working…");
			busyClockEl = el("span", "busyClock", "0:00");
			busyEl.append(el("span", "bd"), el("span", "bd"), el("span", "bd"), busyLabelEl, busyClockEl);
			messagesEl.appendChild(busyEl);
			busyStart = Date.now();
			busyTimer = setInterval(() => {
				const s = Math.floor((Date.now() - busyStart) / 1000);
				busyClockEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
			}, 1000);
		} else if (!b && busyEl) {
			clearInterval(busyTimer);
			busyTimer = null;
			busyEl.remove();
			busyEl = null;
			busyLabelEl = null;
			busyClockEl = null;
		}
		scroll();
	}

	function setActivity(label) {
		if (busyLabelEl) busyLabelEl.textContent = label || "Working…";
	}

	function activityFor(item) {
		if (item.type === "reasoning") return "Thinking…";
		if (item.type === "commandExecution") {
			const c = String(item.command || "").split("\n")[0];
			return "Running: " + (c.length > 64 ? c.slice(0, 64) + "…" : c);
		}
		if (item.type === "fileChange") return "Editing files…";
		if (item.type === "mcpToolCall") return "Tool: " + mcpName(item);
		if (item.type === "agentMessage") return "Writing…";
		return null;
	}

	function scroll() {
		// keep the busy indicator pinned under the newest item
		if (busyEl && busyEl.parentNode) messagesEl.appendChild(busyEl);
		messagesEl.scrollTop = messagesEl.scrollHeight;
	}

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function addUserMessage(text) {
		const m = el("div", "msg user");
		m.appendChild(el("div", "bubble", text));
		messagesEl.appendChild(m);
		scroll();
	}

	function sysLine(text, cls) {
		const m = el("div", "sys " + (cls || ""), text);
		messagesEl.appendChild(m);
		scroll();
		return m;
	}

	// ---------- item rendering ----------
	function startItem(item) {
		if (items.has(item.id)) return items.get(item.id);
		let entry;
		if (item.type === "agentMessage") {
			const wrap = el("div", "msg agent");
			const body = el("div", "bubble mdtext", item.text || "");
			wrap.appendChild(body);
			messagesEl.appendChild(wrap);
			entry = { el: body, type: item.type, text: item.text || "" };
		} else if (item.type === "reasoning") {
			const d = el("details", "reasoning");
			d.appendChild(el("summary", "", "Thinking…"));
			const body = el("div", "reasonText", "");
			d.appendChild(body);
			messagesEl.appendChild(d);
			entry = { el: body, type: item.type, text: "", root: d };
		} else if (item.type === "commandExecution") {
			const card = el("div", "card cmd");
			const title = el("div", "cardTitle");
			title.appendChild(el("span", "spin"));
			title.appendChild(el("span", "stateTxt", "Running command"));
			card.appendChild(title);
			card.appendChild(el("div", "cmdLine", "$ " + (item.command || "")));
			const out = el("pre", "cmdOut", "");
			card.appendChild(out);
			messagesEl.appendChild(card);
			entry = { el: out, type: item.type, text: "", root: card };
		} else if (item.type === "fileChange") {
			const card = el("div", "card file");
			card.appendChild(el("div", "cardTitle", "✎ Editing files"));
			const body = el("div", "fileList", "");
			card.appendChild(body);
			messagesEl.appendChild(card);
			entry = { el: body, type: item.type, text: "", root: card };
		} else if (item.type === "mcpToolCall") {
			const card = el("div", "card mcp");
			const title = el("div", "cardTitle");
			title.appendChild(el("span", "spin"));
			title.appendChild(el("span", "stateTxt", "MCP tool: " + mcpName(item)));
			card.appendChild(title);
			const out = el("pre", "cmdOut", "");
			card.appendChild(out);
			messagesEl.appendChild(card);
			entry = { el: out, type: item.type, text: "", root: card };
		} else if (item.type === "plan") {
			const card = el("div", "card plan");
			card.appendChild(el("div", "cardTitle", "Plan"));
			const body = el("div", "mdtext", item.text || "");
			card.appendChild(body);
			messagesEl.appendChild(card);
			entry = { el: body, type: item.type, text: item.text || "" };
		} else {
			return null;
		}
		items.set(item.id, entry);
		scroll();
		return entry;
	}

	function appendDelta(itemId, delta, type) {
		let entry = items.get(itemId);
		if (!entry) entry = startItem({ id: itemId, type });
		if (!entry) return;
		entry.text += delta;
		entry.el.textContent = entry.text;
		scroll();
	}

	function completeItem(item) {
		let entry = items.get(item.id);
		if (!entry) {
			// item finished without a start/delta we rendered — render final state
			if (item.type === "agentMessage" && item.text) {
				entry = startItem(item);
				if (entry) {
					entry.el.textContent = "";
					entry.el.appendChild(window.mdRender(item.text));
				}
			}
			return;
		}
		if (item.type === "agentMessage" && item.text) {
			entry.text = item.text;
			entry.el.textContent = "";
			entry.el.appendChild(window.mdRender(item.text));
		}
		if (item.type === "reasoning" && entry.root) {
			entry.root.classList.add("done");
			entry.root.querySelector("summary").textContent = "Thought";
			if (!entry.text) entry.root.classList.add("hidden");
		}
		if (item.type === "commandExecution" && entry.root) {
			const ok = item.exitCode === 0 || item.exitCode === null;
			entry.root.classList.add(ok ? "ok" : "fail");
			const state = entry.root.querySelector(".stateTxt");
			if (state) state.textContent = ok ? "Command finished" : `Command failed (exit ${item.exitCode})`;
			if (item.aggregatedOutput) {
				entry.el.textContent = String(item.aggregatedOutput).split("\n").slice(-12).join("\n");
			}
		}
		if (item.type === "mcpToolCall" && entry.root) {
			const ok = item.status !== "failed";
			entry.root.classList.add(ok ? "ok" : "fail");
			const state = entry.root.querySelector(".stateTxt");
			if (state) state.textContent = (ok ? "MCP tool finished: " : "MCP tool failed: ") + mcpName(item);
			const txt = mcpResultText(item);
			if (txt) entry.el.textContent = txt.split("\n").slice(-8).join("\n");
		}
		if (item.type === "fileChange") {
			const changes = item.changes || [];
			entry.el.textContent = changes.map((c) => (c.path || c.file || "")).filter(Boolean).join("\n") || entry.text;
			if (entry.root) entry.root.classList.add("ok");
		}
		scroll();
	}

	function mcpName(item) {
		return (item.server ? item.server + "/" : "") + (item.tool || item.name || "");
	}

	function mcpResultText(item) {
		const r = item.result;
		if (r && Array.isArray(r.content)) return r.content.map((c) => c.text || "").filter(Boolean).join("\n");
		if (typeof r === "string") return r;
		return "";
	}

	// ---------- approvals ----------
	function approvalCard(key, method, params) {
		const card = el("div", "card approval");
		const isFile = method.indexOf("fileChange") !== -1 || method === "applyPatchApproval";
		const isMcp = method.indexOf("elicitation") !== -1;
		card.appendChild(el("div", "cardTitle", isMcp ? "⚠️ Agent wants to use an MCP tool" : isFile ? "⚠️ Agent wants to edit files" : "⚠️ Agent wants to run a command"));
		if (isMcp && params && params.serverName) card.appendChild(el("div", "cmdLine", "🔌 " + params.serverName));
		if (params && params.command) card.appendChild(el("div", "cmdLine", "$ " + params.command));
		if (params && params.reason) card.appendChild(el("div", "muted", params.reason));
		const bar = el("div", "btnBar");
		const mk = (label, decision, cls) => {
			const b = el("button", "btn " + cls, label);
			b.addEventListener("click", () => {
				vscode.postMessage({ type: "approval", key, decision });
				card.classList.add("decided");
				bar.replaceWith(el("div", "muted", decision === "decline" ? "Denied" : "Approved"));
			});
			return b;
		};
		bar.appendChild(mk("Approve", "accept", "primary"));
		bar.appendChild(mk("Approve for session", "acceptForSession", ""));
		bar.appendChild(mk("Deny", "decline", "danger"));
		card.appendChild(bar);
		messagesEl.appendChild(card);
		scroll();
	}

	// ---------- quota ----------
	function renderQuota(rl) {
		if (!rl || !rl.primary) { quotaEl.textContent = ""; return; }
		const used = Math.round(rl.primary.usedPercent);
		const hrs = rl.primary.windowDurationMins ? Math.round(rl.primary.windowDurationMins / 60) : null;
		quotaEl.innerHTML = "";
		const bar = el("div", "qbar");
		const fill = el("div", "qfill" + (used > 85 ? " hot" : ""));
		fill.style.width = Math.min(100, used) + "%";
		bar.appendChild(fill);
		quotaEl.appendChild(bar);
		quotaEl.appendChild(el("span", "qtext", used + "%" + (hrs ? " / " + hrs + "h" : "")));
		quotaEl.title = "ChatGPT plan usage" +
			(rl.secondary ? " · weekly " + Math.round(rl.secondary.usedPercent) + "%" : "");
	}

	// ---------- message routing ----------
	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "auth":
				authMethod = msg.authMethod;
				overlayEl.classList.toggle("hidden", !!authMethod);
				if (authMethod) loginNoteEl.textContent = "";
				dotEl.className = "dot " + (authMethod ? "idle" : "");
				break;
			case "loginPending":
				loginNoteEl.textContent = "Waiting for browser sign-in…";
				break;
			case "thread":
				model = msg.model || "";
				modelEl.textContent = model;
				break;
			case "reset":
				messagesEl.innerHTML = "";
				items.clear();
				setBusy(false);
				break;
			case "fatal":
				sysLine(msg.message, "error");
				setBusy(false);
				break;
			case "status":
				if (msg.connected === false) { sysLine("Agent disconnected — " + (msg.detail || ""), "error"); setBusy(false); }
				break;
			case "approvalRequest":
				approvalCard(msg.key, msg.method, msg.params);
				break;
			case "injectPrompt":
				inputEl.value = msg.text;
				send();
				break;
			case "notification":
				handleNotification(msg.method, msg.params);
				break;
		}
	});

	function handleNotification(method, params) {
		switch (method) {
			case "turn/started": setBusy(true); break;
			case "turn/completed": setBusy(false); break;
			case "item/started": startItem(params.item); setActivity(activityFor(params.item)); break;
			case "item/completed": completeItem(params.item); setActivity(null); break;
			case "item/agentMessage/delta": appendDelta(params.itemId, params.delta, "agentMessage"); break;
			case "item/reasoning/textDelta":
			case "item/reasoning/summaryTextDelta": appendDelta(params.itemId, params.delta, "reasoning"); break;
			case "item/commandExecution/outputDelta": appendDelta(params.itemId, params.delta, "commandExecution"); break;
			case "account/rateLimits/updated": renderQuota(params.rateLimits); break;
			case "error": sysLine((params.error && params.error.message) || "Agent error", "error"); break;
		}
	}

	vscode.postMessage({ type: "ready" });
})();
