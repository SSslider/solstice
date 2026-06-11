"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	let authMethod;
	let threads = [];
	let selectedId = null;
	let activeTurnId = null;
	let pendingSelect = null;       // thread to auto-select once it appears
	let pendingPrompt = null;       // prompt to send once thread created (dev hook)
	const live = new Map();         // itemId -> { el, type, text, root }

	app.innerHTML = `
		<div id="cols">
			<div id="inbox">
				<div class="colHead">
					<span>Threads</span>
					<button id="newBtn" class="btn primary small">+ New</button>
				</div>
				<div id="threadList"></div>
			</div>
			<div id="work">
				<div class="colHead">
					<span id="workTitle">Agent Manager</span>
					<span id="quota"></span>
				</div>
				<div id="messages"><div class="empty">Select a thread or start a new one.</div></div>
				<div id="composer">
					<textarea id="input" rows="3" placeholder="Describe a task — or steer the running turn…"></textarea>
					<div id="composerBar">
						<span id="hint">Enter to send · Shift+Enter for newline</span>
						<button id="stopBtn" class="btn danger hidden">Stop</button>
						<button id="sendBtn" class="btn primary">Send</button>
					</div>
				</div>
			</div>
			<div id="artifacts">
				<div class="colHead"><span>Artifacts</span></div>
				<div id="planCard" class="art hidden">
					<div class="artTitle">Plan</div>
					<div id="planBody"></div>
				</div>
				<div id="diffCard" class="art hidden">
					<div class="artTitle">Changes</div>
					<div id="diffStat"></div>
					<button id="diffBtn" class="btn small">Open diff in editor</button>
				</div>
				<div id="wtCard" class="art hidden">
					<div class="artTitle">Walkthrough</div>
					<div id="wtBody"></div>
				</div>
				<div id="noArt" class="empty">Plan, diffs and walkthrough of the selected thread appear here.</div>
			</div>
		</div>
		<div id="loginOverlay" class="hidden">
			<div class="loginCard">
				<div class="loginLogo">☀️</div>
				<h2>Solstice Agent Manager</h2>
				<button id="loginBtn" class="btn primary big">Sign in with ChatGPT</button>
			</div>
		</div>`;

	const $ = (id) => document.getElementById(id);
	const messagesEl = $("messages"), inputEl = $("input"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");
	const threadListEl = $("threadList"), quotaEl = $("quota"), workTitleEl = $("workTitle");
	const planCard = $("planCard"), planBody = $("planBody"), diffCard = $("diffCard"), diffStat = $("diffStat"), noArt = $("noArt");
	const wtCard = $("wtCard"), wtBody = $("wtBody");
	let walk = null; // current-turn walkthrough: {commands:[], files:Set, message:""}

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}
	function scroll() { messagesEl.scrollTop = messagesEl.scrollHeight; }

	// ---------- inbox ----------
	const STATUS_LABEL = { active: "running", idle: "idle", systemError: "error", notLoaded: "" };
	function renderThreads() {
		threadListEl.innerHTML = "";
		if (!threads.length) {
			threadListEl.appendChild(el("div", "empty", "No threads yet."));
			return;
		}
		for (const t of threads) {
			const row = el("div", "threadRow" + (t.id === selectedId ? " sel" : ""));
			const dot = el("span", "tdot " + (t.status || ""));
			row.appendChild(dot);
			const txt = el("div", "tprev", (t.preview || "(new thread)").split("\n")[0].slice(0, 80));
			row.appendChild(txt);
			const st = STATUS_LABEL[t.status];
			if (st) row.appendChild(el("span", "tstatus " + t.status, st));
			const x = el("button", "tarch", "✕");
			x.title = "Archive thread";
			x.addEventListener("click", (e) => {
				e.stopPropagation();
				vscode.postMessage({ type: "archiveThread", threadId: t.id });
				if (selectedId === t.id) clearWork();
			});
			row.appendChild(x);
			row.addEventListener("click", () => selectThread(t.id));
			threadListEl.appendChild(row);
		}
	}

	function selectThread(id) {
		selectedId = id;
		renderThreads();
		messagesEl.innerHTML = "";
		messagesEl.appendChild(el("div", "empty", "Loading thread…"));
		vscode.postMessage({ type: "selectThread", threadId: id });
	}

	function clearWork() {
		selectedId = null;
		activeTurnId = null;
		live.clear();
		messagesEl.innerHTML = "";
		messagesEl.appendChild(el("div", "empty", "Select a thread or start a new one."));
		planCard.classList.add("hidden");
		diffCard.classList.add("hidden");
		resetWalkthrough();
		noArt.classList.remove("hidden");
		setBusy(false);
	}

	// ---------- composer ----------
	$("newBtn").addEventListener("click", () => vscode.postMessage({ type: "newThread" }));
	$("loginBtn").addEventListener("click", () => vscode.postMessage({ type: "login" }));
	$("diffBtn").addEventListener("click", () => vscode.postMessage({ type: "openDiff", threadId: selectedId }));
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "interrupt", threadId: selectedId }));
	sendBtn.addEventListener("click", send);
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
	});

	function send() {
		const text = inputEl.value.trim();
		if (!text) return;
		if (!selectedId) {
			pendingPrompt = text;
			vscode.postMessage({ type: "newThread" });
			inputEl.value = "";
			return;
		}
		inputEl.value = "";
		// no local echo — the server replays the user message as an item/started
		if (activeTurnId) {
			vscode.postMessage({ type: "steer", threadId: selectedId, text });
		} else {
			setBusy(true);
			vscode.postMessage({ type: "send", threadId: selectedId, text });
		}
	}

	function setBusy(b) {
		stopBtn.classList.toggle("hidden", !b);
		sendBtn.textContent = b ? "Steer" : "Send";
	}

	// ---------- item rendering (shared by history + live) ----------
	function userText(content) {
		if (typeof content === "string") return content;
		if (Array.isArray(content)) {
			return content.map((c) => (c && (c.text || c.url || "")) || "").filter(Boolean).join("\n");
		}
		return "";
	}

	function addUserMessage(text) {
		const m = el("div", "msg user");
		m.appendChild(el("div", "bubble", text));
		messagesEl.appendChild(m);
		scroll();
	}

	function renderCompleteItem(item) {
		switch (item.type) {
			case "userMessage": addUserMessage(userText(item.content)); return;
			case "agentMessage": {
				const m = el("div", "msg agent");
				const b = el("div", "bubble mdtext");
				b.appendChild(window.mdRender(item.text || ""));
				m.appendChild(b);
				messagesEl.appendChild(m);
				return;
			}
			case "reasoning": {
				const txt = Array.isArray(item.summary) ? item.summary.join("\n") : (item.summary || "");
				if (!txt) return;
				const d = el("details", "reasoning");
				d.appendChild(el("summary", "", "Thought"));
				d.appendChild(el("div", "reasonText", txt));
				messagesEl.appendChild(d);
				return;
			}
			case "commandExecution": {
				const card = el("div", "card cmd " + (item.exitCode === 0 || item.exitCode === null || item.exitCode === undefined ? "ok" : "fail"));
				card.appendChild(el("div", "cmdLine", "$ " + (item.command || "")));
				if (item.aggregatedOutput) {
					card.appendChild(el("pre", "cmdOut", String(item.aggregatedOutput).split("\n").slice(-12).join("\n")));
				}
				messagesEl.appendChild(card);
				return;
			}
			case "fileChange": {
				const card = el("div", "card file ok");
				card.appendChild(el("div", "cardTitle", "✎ Files changed"));
				const paths = (item.changes || []).map((c) => (c.path || c.file || "")).filter(Boolean).join("\n");
				card.appendChild(el("div", "fileList", paths));
				messagesEl.appendChild(card);
				return;
			}
			case "plan": {
				const card = el("div", "card plan");
				card.appendChild(el("div", "cardTitle", "Plan"));
				card.appendChild(el("div", "mdtext", item.text || ""));
				messagesEl.appendChild(card);
				return;
			}
		}
	}

	// live streaming (same shape as the sidebar panel)
	function startItem(item) {
		if (live.has(item.id)) return live.get(item.id);
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
		} else if (item.type === "userMessage") {
			addUserMessage(userText(item.content));
			return null;
		} else {
			return null;
		}
		live.set(item.id, entry);
		scroll();
		return entry;
	}

	function appendDelta(itemId, delta, type) {
		let entry = live.get(itemId);
		if (!entry) entry = startItem({ id: itemId, type });
		if (!entry) return;
		entry.text += delta;
		entry.el.textContent = entry.text;
		scroll();
	}

	function completeItem(item) {
		trackForWalkthrough(item);
		const entry = live.get(item.id);
		if (!entry) {
			if (item.type === "agentMessage" && item.text) renderCompleteItem(item);
			scroll();
			return;
		}
		if (item.type === "agentMessage" && item.text) {
			entry.text = item.text;
			entry.el.textContent = "";
			entry.el.appendChild(window.mdRender(item.text));
		}
		if (item.type === "reasoning" && entry.root) {
			entry.root.querySelector("summary").textContent = "Thought";
			if (!entry.text) entry.root.classList.add("hidden");
		}
		if (item.type === "commandExecution" && entry.root) {
			const ok = item.exitCode === 0 || item.exitCode === null;
			entry.root.classList.add(ok ? "ok" : "fail");
			if (item.aggregatedOutput) {
				entry.el.textContent = String(item.aggregatedOutput).split("\n").slice(-12).join("\n");
			}
		}
		if (item.type === "fileChange") {
			const changes = item.changes || [];
			entry.el.textContent = changes.map((c) => (c.path || c.file || "")).filter(Boolean).join("\n") || entry.text;
			if (entry.root) entry.root.classList.add("ok");
		}
		scroll();
	}

	// ---------- artifacts ----------
	function renderPlan(plan) {
		if (!plan || !plan.length) { planCard.classList.add("hidden"); updateNoArt(); return; }
		planBody.innerHTML = "";
		for (const s of plan) {
			const row = el("div", "planStep " + (s.status || ""));
			const mark = s.status === "completed" ? "✓" : s.status === "inProgress" ? "▸" : "○";
			row.appendChild(el("span", "pmark", mark));
			row.appendChild(el("span", "ptext", s.step || ""));
			planBody.appendChild(row);
		}
		planCard.classList.remove("hidden");
		updateNoArt();
	}

	function renderDiff(diff) {
		if (!diff) { diffCard.classList.add("hidden"); updateNoArt(); return; }
		const files = [];
		let add = 0, del = 0;
		for (const line of diff.split("\n")) {
			if (line.startsWith("diff --git")) {
				const m = line.match(/ b\/(.+)$/);
				if (m) files.push(m[1]);
			} else if (line.startsWith("+") && !line.startsWith("+++")) add++;
			else if (line.startsWith("-") && !line.startsWith("---")) del++;
		}
		diffStat.innerHTML = "";
		diffStat.appendChild(el("div", "dsum", `${files.length} file${files.length === 1 ? "" : "s"} · +${add} −${del}`));
		for (const f of files.slice(0, 12)) diffStat.appendChild(el("div", "dfile", f));
		diffCard.classList.remove("hidden");
		updateNoArt();
	}

	function updateNoArt() {
		const any = !planCard.classList.contains("hidden") || !diffCard.classList.contains("hidden") || !wtCard.classList.contains("hidden");
		noArt.classList.toggle("hidden", any);
	}

	// ---------- walkthrough ----------
	function trackForWalkthrough(item) {
		if (!walk || !item) return;
		if (item.type === "commandExecution") {
			walk.commands.push({ command: item.command || "", exitCode: item.exitCode });
		} else if (item.type === "fileChange") {
			for (const c of item.changes || []) {
				const p = c.path || c.file;
				if (p) walk.files.add(p);
			}
		} else if (item.type === "agentMessage" && item.text) {
			walk.message = item.text;
		}
	}

	function resetWalkthrough() {
		walk = null;
		wtCard.classList.add("hidden");
		updateNoArt();
	}

	function renderWalkthrough() {
		if (!walk || (!walk.commands.length && !walk.files.size && !walk.message)) { resetWalkthrough(); return; }
		wtBody.innerHTML = "";
		if (walk.files.size) {
			wtBody.appendChild(el("div", "wtSection", "Files"));
			for (const f of [...walk.files].slice(0, 10)) {
				const base = f.split("/").pop();
				wtBody.appendChild(el("div", "wtFile", "✎ " + base));
			}
		}
		if (walk.commands.length) {
			wtBody.appendChild(el("div", "wtSection", "Commands"));
			for (const c of walk.commands.slice(0, 8)) {
				const ok = c.exitCode === 0 || c.exitCode === null || c.exitCode === undefined;
				const row = el("div", "wtCmd " + (ok ? "ok" : "fail"));
				row.appendChild(el("span", "wtMark", ok ? "✓" : "✗"));
				row.appendChild(el("span", "wtCmdText", c.command.replace(/^\/bin\/bash -lc /, "").slice(0, 80)));
				wtBody.appendChild(row);
			}
		}
		if (walk.message) {
			wtBody.appendChild(el("div", "wtSection", "Summary"));
			const s = el("div", "wtMsg");
			s.appendChild(window.mdRender(walk.message.length > 400 ? walk.message.slice(0, 400) + "…" : walk.message));
			wtBody.appendChild(s);
		}
		wtCard.classList.remove("hidden");
		updateNoArt();
	}

	// ---------- approvals ----------
	function approvalCard(key, method, params) {
		const card = el("div", "card approval");
		const isFile = method.indexOf("fileChange") !== -1 || method === "applyPatchApproval";
		card.appendChild(el("div", "cardTitle", isFile ? "⚠️ Agent wants to edit files" : "⚠️ Agent wants to run a command"));
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
		quotaEl.textContent = "quota " + used + "%";
		quotaEl.className = used > 85 ? "hot" : "";
	}

	// ---------- routing ----------
	window.addEventListener("message", (event) => {
		const msg = event.data;
		switch (msg.type) {
			case "auth":
				authMethod = msg.authMethod;
				$("loginOverlay").classList.toggle("hidden", !!authMethod);
				break;
			case "threads":
				threads = msg.threads || [];
				if (pendingSelect && threads.some((t) => t.id === pendingSelect)) {
					const id = pendingSelect;
					pendingSelect = null;
					selectThread(id);
				} else {
					renderThreads();
				}
				break;
			case "threadCreated":
				selectedId = msg.threadId;
				activeTurnId = null;
				live.clear();
				messagesEl.innerHTML = "";
				renderPlan(null);
				renderDiff("");
				resetWalkthrough();
				pendingSelect = null;
				renderThreads();
				if (pendingPrompt) {
					const t = pendingPrompt;
					pendingPrompt = null;
					setBusy(true);
					vscode.postMessage({ type: "send", threadId: selectedId, text: t });
				}
				break;
			case "threadHistory": {
				const th = msg.thread || {};
				live.clear();
				messagesEl.innerHTML = "";
				workTitleEl.textContent = (th.preview || "Thread").split("\n")[0].slice(0, 60);
				for (const turn of th.turns || []) {
					for (const item of turn.items || []) renderCompleteItem(item);
				}
				activeTurnId = msg.activeTurnId || null;
				setBusy(!!activeTurnId);
				renderPlan(msg.plan);
				renderDiff(msg.diff);
				resetWalkthrough();
				scroll();
				break;
			}
			case "approvalRequest":
				if (!msg.params || !msg.params.threadId || msg.params.threadId === selectedId) {
					approvalCard(msg.key, msg.method, msg.params);
				}
				break;
			case "fatal": {
				const m = el("div", "sys error", msg.message);
				messagesEl.appendChild(m);
				setBusy(false);
				break;
			}
			case "status":
				if (msg.connected === false) {
					messagesEl.appendChild(el("div", "sys error", "Agent disconnected — " + (msg.detail || "")));
					setBusy(false);
				}
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
		const tid = params && params.threadId;
		const mine = tid && tid === selectedId;
		switch (method) {
			case "turn/started":
				if (mine) {
					activeTurnId = params.turn && params.turn.id;
					setBusy(true);
					walk = { commands: [], files: new Set(), message: "" };
					wtCard.classList.add("hidden");
					updateNoArt();
				}
				break;
			case "turn/completed":
				if (mine) { activeTurnId = null; setBusy(false); renderWalkthrough(); }
				break;
			case "item/started": if (mine) startItem(params.item); break;
			case "item/completed": if (mine) completeItem(params.item); break;
			case "item/agentMessage/delta": if (mine) appendDelta(params.itemId, params.delta, "agentMessage"); break;
			case "item/reasoning/textDelta":
			case "item/reasoning/summaryTextDelta": if (mine) appendDelta(params.itemId, params.delta, "reasoning"); break;
			case "item/commandExecution/outputDelta": if (mine) appendDelta(params.itemId, params.delta, "commandExecution"); break;
			case "turn/plan/updated": if (mine) renderPlan(params.plan); break;
			case "turn/diff/updated": if (mine) renderDiff(params.diff); break;
			case "account/rateLimits/updated": renderQuota(params.rateLimits); break;
			case "error": if (mine || !tid) messagesEl.appendChild(el("div", "sys error", (params.error && params.error.message) || "Agent error")); break;
		}
	}

	vscode.postMessage({ type: "ready" });
})();
