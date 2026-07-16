"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	let authMethod;
	let threads = [];
	let managerTasks = [];
	let managerLimit = 2;
	let devServers = [];
	let devServerIdleTimeoutMs = 0;
	let selectedId = null;
	let selectedTaskId = null;
	let pendingMergeReview = null;
	let activeTurnId = null;
	let pendingSelect = null;       // thread to auto-select once it appears
	let pendingPrompt = null;       // prompt to send once thread created (dev hook)
	const live = new Map();         // itemId -> { el, type, text, root }

	app.innerHTML = `
		<div id="cols">
			<div id="inbox">
				<div class="colHead">
					<span>Manager View</span>
					<button id="newBtn" class="btn primary small">+ Build</button>
				</div>
				<div id="taskSummary" class="taskSummary"></div>
				<div id="devServersCard" class="devServersCard">
					<div class="devServersHead"><span>Running servers</span><button id="closeAllServersBtn" class="btn danger small">Close all</button></div>
					<div id="devServersList" class="devServersList"></div>
				</div>
				<div id="taskBoard"></div>
				<div class="subHead">Other threads</div>
				<div id="threadList"></div>
			</div>
			<div id="work">
				<div class="colHead">
					<span id="workTitle">Agent Manager</span>
					<span id="quota"></span>
				</div>
				<div id="taskTabs"></div>
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
					<div class="btnBar">
						<button id="diffBtn" class="btn small">Open diff in editor</button>
						<button id="previewBtn" class="btn small">Preview site</button>
					</div>
				</div>
				<div id="taskPreviewCard" class="art hidden">
					<div class="artTitle">Live preview</div>
					<iframe id="taskPreview" title="Selected build preview"></iframe>
				</div>
				<div id="mergeReviewCard" class="art hidden">
					<div class="artTitle">Merge review</div>
					<div id="mergeReviewMeta" class="muted"></div>
					<pre id="mergeReviewPatch"></pre>
					<div class="btnBar">
						<button id="confirmMergeBtn" class="btn primary small">Apply reviewed diff</button>
						<button id="cancelMergeBtn" class="btn small">Cancel</button>
					</div>
				</div>
				<div id="wtCard" class="art hidden">
					<div class="artTitle">Walkthrough</div>
					<div id="wtBody"></div>
				</div>
				<div id="buildArtifactsCard" class="art hidden">
					<div class="artTitle">Build evidence</div>
					<div id="buildArtifacts"></div>
				</div>
				<div id="noArt" class="empty">Plan, diffs and walkthrough of the selected thread appear here.</div>
			</div>
		</div>
		<div id="loginOverlay" class="hidden">
			<div class="loginCard">
				<div class="loginLogo">☀️</div>
				<h2>Felix Manager</h2>
				<button id="loginBtn" class="btn primary big">Sign in with ChatGPT</button>
			</div>
		</div>`;

	const $ = (id) => document.getElementById(id);
	const messagesEl = $("messages"), inputEl = $("input"), sendBtn = $("sendBtn"), stopBtn = $("stopBtn");
	const threadListEl = $("threadList"), taskBoardEl = $("taskBoard"), taskTabsEl = $("taskTabs"), taskSummaryEl = $("taskSummary"), quotaEl = $("quota"), workTitleEl = $("workTitle");
	const planCard = $("planCard"), planBody = $("planBody"), diffCard = $("diffCard"), diffStat = $("diffStat"), noArt = $("noArt");
	const wtCard = $("wtCard"), wtBody = $("wtBody");
	const buildArtifactsCard = $("buildArtifactsCard"), buildArtifacts = $("buildArtifacts");
	const taskPreviewCard = $("taskPreviewCard"), taskPreview = $("taskPreview"), mergeReviewCard = $("mergeReviewCard"), mergeReviewPatch = $("mergeReviewPatch"), mergeReviewMeta = $("mergeReviewMeta");
	const devServersCard = $("devServersCard"), devServersList = $("devServersList"), closeAllServersBtn = $("closeAllServersBtn");
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
		const taskThreads = new Set(managerTasks.map((task) => task.threadId).filter(Boolean));
		const otherThreads = threads.filter((thread) => !taskThreads.has(thread.id));
		if (!otherThreads.length) {
			threadListEl.appendChild(el("div", "empty", "No other threads."));
			return;
		}
		for (const t of otherThreads) {
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

	const TASK_LABEL = {
		creating: "Creating", idle: "Ready", running: "Running", awaiting_approval: "Needs approval",
		ready_review: "Review", merged: "Merged", error: "Error", missing: "Missing", removed: "Removed",
	};
	function selectedTask() {
		return managerTasks.find((task) => task.id === selectedTaskId || task.threadId === selectedId) || null;
	}
	function selectManagerTask(task) {
		selectedTaskId = task.id;
		if (task.threadId) selectThread(task.threadId);
		else renderManagerTasks();
	}
	function renderTaskTabs() {
		taskTabsEl.innerHTML = "";
		managerTasks.filter((task) => !["removed"].includes(task.status)).forEach((task, index) => {
			const tab = el("button", "taskTab" + (task.id === selectedTaskId || task.threadId === selectedId ? " sel" : ""));
			tab.appendChild(el("span", "tdot " + (task.status === "running" ? "active" : task.status === "error" ? "systemError" : "idle")));
			tab.appendChild(el("span", "taskTabName", task.label || `Agent ${index + 1}`));
			tab.appendChild(el("span", "taskTabPhase", TASK_LABEL[task.status] || task.status));
			tab.addEventListener("click", () => selectManagerTask(task));
			taskTabsEl.appendChild(tab);
		});
	}
	function renderSelectedTaskArtifacts() {
		const task = selectedTask();
		if (!task) { taskPreviewCard.classList.add("hidden"); return; }
		selectedTaskId = task.id;
		if (task.plan && task.plan.length) renderPlan(task.plan);
		if (task.previewUrl) {
			taskPreviewCard.classList.remove("hidden");
			if (taskPreview.dataset.url !== task.previewUrl) { taskPreview.dataset.url = task.previewUrl; taskPreview.src = task.previewUrl; }
		} else taskPreviewCard.classList.add("hidden");
		updateNoArt();
	}
	function renderManagerTasks() {
		taskBoardEl.innerHTML = "";
		const active = managerTasks.filter((task) => ["creating", "idle", "running", "awaiting_approval", "ready_review"].includes(task.status)).length;
		taskSummaryEl.textContent = `${active}/${managerLimit} slots · isolated worktrees`;
		for (const task of managerTasks) {
			const card = el("div", "taskCard " + (task.status || "") + (task.threadId === selectedId ? " sel" : ""));
			const top = el("div", "taskTop");
			top.appendChild(el("span", "tdot " + (task.status === "running" ? "active" : task.status === "error" ? "systemError" : "idle")));
			top.appendChild(el("span", "taskName", task.label || task.id));
			top.appendChild(el("span", "taskStatus", TASK_LABEL[task.status] || task.status));
			card.appendChild(top);
			card.appendChild(el("div", "taskMeta", `${task.phase || "workspace"} · ${task.changedFiles || 0} changed`));
			if (task.diffStat) card.appendChild(el("div", "taskDiff", task.diffStat.split("\n").slice(-1)[0]));
			const actions = el("div", "taskActions");
			if (task.threadId) {
				const open = el("button", "btn small", "Open");
				open.addEventListener("click", () => selectManagerTask(task));
				actions.appendChild(open);
				const preview = el("button", "btn small", "Preview");
				preview.addEventListener("click", () => vscode.postMessage({ type: "openManagerTaskPreview", taskId: task.id }));
				actions.appendChild(preview);
			}
			if (task.status === "running" || task.status === "awaiting_approval") {
				const stop = el("button", "btn danger small", "Stop");
				stop.addEventListener("click", () => vscode.postMessage({ type: "interrupt", threadId: task.threadId }));
				actions.appendChild(stop);
			}
			if (["idle", "ready_review"].includes(task.status)) {
				const inspect = el("button", "btn small", "Refresh diff");
				inspect.addEventListener("click", () => vscode.postMessage({ type: "inspectManagerTask", taskId: task.id }));
				actions.appendChild(inspect);
			}
			if (task.status === "ready_review" && (task.changedFiles || 0) > 0) {
				const merge = el("button", "btn primary small", "Review merge diff");
				merge.addEventListener("click", () => { selectManagerTask(task); vscode.postMessage({ type: "reviewManagerTask", taskId: task.id }); });
				actions.appendChild(merge);
			}
			card.appendChild(actions);
			card.addEventListener("click", (event) => { if (!event.target.closest("button")) selectManagerTask(task); });
			taskBoardEl.appendChild(card);
		}
		if (!managerTasks.length) taskBoardEl.appendChild(el("div", "empty", "Start up to two isolated builds."));
		renderTaskTabs();
		renderSelectedTaskArtifacts();
		renderThreads();
	}

	function renderDevServers() {
		devServersList.innerHTML = "";
		devServersCard.classList.toggle("emptyServers", !devServers.length);
		closeAllServersBtn.disabled = !devServers.length;
		if (!devServers.length) {
			devServersList.appendChild(el("div", "serverEmpty", "No Solstice-owned preview servers."));
			return;
		}
		for (const server of devServers) {
			const row = el("div", "serverRow");
			const main = el("div", "serverMain");
			main.appendChild(el("span", "serverDot"));
			main.appendChild(el("span", "serverProject", (server.root || server.id || "server").split(/[\\/]/).filter(Boolean).pop()));
			main.appendChild(el("span", "serverPort", `:${server.port || "—"}`));
			row.appendChild(main);
			const idleMinutes = server.idleDeadlineAt ? Math.max(0, Math.ceil((server.idleDeadlineAt - Date.now()) / 60000)) : null;
			row.appendChild(el("div", "serverMeta", `PID ${server.pid || "—"} · ${server.scope}${idleMinutes == null ? "" : ` · closes in ${idleMinutes}m`}`));
			const stop = el("button", "serverStop", "Stop");
			stop.addEventListener("click", () => vscode.postMessage({ type: "stopDevServer", id: server.id }));
			row.appendChild(stop);
			devServersList.appendChild(row);
		}
	}

	function selectThread(id) {
		selectedId = id;
		const task = managerTasks.find((row) => row.threadId === id);
		if (task) selectedTaskId = task.id;
		renderManagerTasks();
		messagesEl.innerHTML = "";
		messagesEl.appendChild(el("div", "empty", "Loading thread…"));
		vscode.postMessage({ type: "selectThread", threadId: id });
	}

	function clearWork() {
		selectedId = null;
		selectedTaskId = null;
		activeTurnId = null;
		live.clear();
		messagesEl.innerHTML = "";
		messagesEl.appendChild(el("div", "empty", "Select a thread or start a new one."));
		planCard.classList.add("hidden");
		diffCard.classList.add("hidden");
		resetWalkthrough();
		noArt.classList.remove("hidden");
		taskPreviewCard.classList.add("hidden");
		mergeReviewCard.classList.add("hidden");
		setBusy(false);
	}

	// ---------- composer ----------
	$("newBtn").addEventListener("click", () => {
		const prompt = window.prompt("Describe the build task");
		if (!prompt || !prompt.trim()) return;
		vscode.postMessage({ type: "createManagerTask", label: prompt.trim().split("\n")[0].slice(0, 80), prompt: prompt.trim() });
	});
	$("loginBtn").addEventListener("click", () => vscode.postMessage({ type: "login" }));
	$("diffBtn").addEventListener("click", () => vscode.postMessage({ type: "openDiff", threadId: selectedId }));
	$("previewBtn").addEventListener("click", () => vscode.postMessage({ type: "openPreview" }));
	closeAllServersBtn.addEventListener("click", () => vscode.postMessage({ type: "closeAllDevServers" }));
	$("confirmMergeBtn").addEventListener("click", () => {
		if (!pendingMergeReview) return;
		vscode.postMessage({ type: "mergeManagerTask", taskId: pendingMergeReview.taskId, patchHash: pendingMergeReview.patchHash });
		$("confirmMergeBtn").disabled = true;
	});
	$("cancelMergeBtn").addEventListener("click", () => { pendingMergeReview = null; mergeReviewCard.classList.add("hidden"); updateNoArt(); });
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
				const d = el("details", "reasoning done");
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
		if (item.type === "fileChange") {
			const changes = item.changes || [];
			entry.el.textContent = changes.map((c) => (c.path || c.file || "")).filter(Boolean).join("\n") || entry.text;
			if (entry.root) entry.root.classList.add("ok");
		}
		if (item.type === "mcpToolCall" && entry.root) {
			const ok = item.status !== "failed";
			entry.root.classList.add(ok ? "ok" : "fail");
			const state = entry.root.querySelector(".stateTxt");
			if (state) state.textContent = (ok ? "MCP tool finished: " : "MCP tool failed: ") + mcpName(item);
			const txt = mcpResultText(item);
			if (txt) entry.el.textContent = txt.split("\n").slice(-8).join("\n");
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
		const any = !planCard.classList.contains("hidden") || !diffCard.classList.contains("hidden") || !wtCard.classList.contains("hidden") || !buildArtifactsCard.classList.contains("hidden") || !taskPreviewCard.classList.contains("hidden") || !mergeReviewCard.classList.contains("hidden");
		noArt.classList.toggle("hidden", any);
	}

	function renderArtifactPackages(items) {
		buildArtifacts.innerHTML = "";
		for (const item of (items || []).slice(0, 8)) {
			const card = el("article", "artifactPackage");
			if (item.thumbnailUri) {
				const image = el("img", "artifactThumb");
				image.src = item.thumbnailUri;
				image.alt = `Browser evidence for ${item.taskId || "build"}`;
				card.appendChild(image);
			}
			card.appendChild(el("strong", "artifactTask", item.taskId || "build"));
			const qualityMeta = item.quality ? `${item.quality.score || 0}/100 ${item.quality.grade || ""}` : "";
			const replicaMeta = item.replica ? `replica ${item.replica.score || 0}/${item.replica.targetScore || 80}` : "";
			const meta = [qualityMeta, replicaMeta, `gate round ${item.selfCheckRound || "?"}`].filter(Boolean).join(" · ");
			card.appendChild(el("div", "artifactMeta", meta));
			if (item.recordingUri) {
				const video = el("video", "artifactVideo");
				video.src = item.recordingUri;
				video.controls = true;
				video.muted = true;
				video.preload = "metadata";
				card.appendChild(video);
			}
			const actions = el("div", "btnBar");
			const open = el("button", "btn small", "Open package");
			open.addEventListener("click", () => vscode.postMessage({ type: "openArtifactPackage", path: item.path }));
			actions.appendChild(open);
			const guide = el("button", "btn small", "How to test");
			guide.addEventListener("click", () => vscode.postMessage({ type: "openArtifactFile", path: item.path, file: item.markdown || "WALKTHROUGH.md" }));
			actions.appendChild(guide);
			card.appendChild(actions);
			buildArtifacts.appendChild(card);
		}
		buildArtifactsCard.classList.toggle("hidden", !(items || []).length);
		updateNoArt();
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
		const isMcp = method.indexOf("elicitation") !== -1;
		const isCredit = !!(params && params.creditGate);
		card.appendChild(el("div", "cardTitle", isCredit ? "⚠️ Credit gate: approve video/3D generation" : isMcp ? "⚠️ Agent wants to use an MCP tool" : isFile ? "⚠️ Agent wants to edit files" : "⚠️ Agent wants to run a command"));
		if (isCredit) {
			const gate = params.creditGate;
			card.appendChild(el("div", "muted", gate.reason || "Thomas approval is required before continuing."));
			card.appendChild(el("div", "cmdLine", `מה ייווצר: ${gate.creation || "נכס מדיה בתשלום"}`));
			card.appendChild(el("div", "cmdLine", `ספק: ${gate.provider || "ספק חיצוני"}`));
			card.appendChild(el("div", "cmdLine", `הערכת קרדיטים: ${gate.creditEstimate || "לא ידועה מראש"}`));
			if (gate.detail) card.appendChild(el("div", "muted", gate.detail));
		}
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
		if (!isCredit && !(params && params.oneShotOnly)) bar.appendChild(mk("Approve for session", "acceptForSession", ""));
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
			case "managerTasks":
				managerTasks = msg.tasks || [];
				managerLimit = msg.limit || 2;
				renderManagerTasks();
				break;
			case "devServers":
				devServers = msg.servers || [];
				devServerIdleTimeoutMs = msg.idleTimeoutMs || 0;
				devServersCard.title = devServerIdleTimeoutMs ? `Automatic idle cleanup after ${Math.round(devServerIdleTimeoutMs / 60000)} minutes` : "";
				renderDevServers();
				break;
			case "artifactPackages":
				renderArtifactPackages(msg.artifacts || []);
				break;
			case "managerPreview": {
				const task = managerTasks.find((row) => row.id === msg.taskId);
				if (task) task.previewUrl = msg.url;
				if (msg.taskId === selectedTaskId) renderSelectedTaskArtifacts();
				break;
			}
			case "managerMergeReview":
				pendingMergeReview = { taskId: msg.taskId, patchHash: msg.patchHash };
				mergeReviewMeta.textContent = `${msg.patchBytes || 0} bytes · SHA-256 ${String(msg.patchHash || "").slice(0, 12)}… · git apply --check runs again on merge`;
				mergeReviewPatch.textContent = msg.patch || "";
				$("confirmMergeBtn").disabled = false;
				mergeReviewCard.classList.remove("hidden");
				updateNoArt();
				break;
			case "managerMerged":
				pendingMergeReview = null;
				mergeReviewCard.classList.add("hidden");
				updateNoArt();
				break;
			case "managerTaskCreated":
				if (msg.task && msg.task.threadId) selectThread(msg.task.threadId);
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
