"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	let authMethod;            // undefined = unknown, null = signed out, string = signed in
	let busy = false;
	let model = "";
	const AUTONOMY_LABELS = { supervised: "Supervised", "auto-edit": "Auto-edit", autonomous: "Autonomous" };
	const items = new Map();   // itemId -> { el, type, text }

	// ---------- skeleton ----------
	app.innerHTML = `
		<div id="header">
			<div id="brand">
				<span class="brandMark">☀</span>
				<div class="brandText">
					<div class="brandName">Solstice <span id="status"><span id="dot" class="dot"></span></span></div>
					<div class="brandModel" id="brandModel">—</div>
				</div>
			</div>
			<div id="quota" title=""></div>
		</div>
		<div id="messages"></div>
		<div id="composer">
			<textarea id="input" rows="3" placeholder="Describe a task for the agent…"></textarea>
			<div id="composerBar">
				<button id="modelBtn" class="pickBtn" title="Select agent model">⌬ <span id="model">—</span> <span class="caret">▾</span></button>
				<div id="buildMode" class="buildMode" title="מה בונים? אתר אינטרנט או אפליקציה">
					<button id="modeSite" class="modeOpt active" data-mode="site">🌐 אתר</button>
					<button id="modeApp" class="modeOpt" data-mode="app">📱 אפליקציה</button>
				</div>
				<button id="scaffoldBtn" class="pickBtn hidden" title="צור שלד אפליקציה PWA — ריבוי מסכים, ניווט תחתון, מותקנת">✦ שלד אפליקציה</button>
				<span id="tokChip" class="tokChip hidden" title=""></span>
				<button id="autonomyBtn" class="pickBtn" title="Set agent autonomy">🛡 <span id="autonomy">Supervised</span> <span class="caret">▾</span></button>
				<span id="hint">Enter to send</span>
				<button id="stopBtn" class="btn danger hidden">Stop</button>
				<button id="micBtn" class="btn mic" title="Record a voice message (Groq Whisper)" aria-label="Record voice">🎤</button>
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
	const brandModelEl = document.getElementById("brandModel");
	const modelBtn = document.getElementById("modelBtn");
	const autonomyEl = document.getElementById("autonomy");
	const autonomyBtn = document.getElementById("autonomyBtn");
	const quotaEl = document.getElementById("quota");
	const tokChipEl = document.getElementById("tokChip");
	const overlayEl = document.getElementById("loginOverlay");
	const loginNoteEl = document.getElementById("loginNote");

	// ---- build mode toggle (Website ⟷ App) ----
	let buildMode = "site";
	const modeSiteEl = document.getElementById("modeSite");
	const modeAppEl = document.getElementById("modeApp");
	const scaffoldBtn = document.getElementById("scaffoldBtn");
	function setBuildMode(mode, notify) {
		buildMode = mode === "app" ? "app" : "site";
		modeSiteEl.classList.toggle("active", buildMode === "site");
		modeAppEl.classList.toggle("active", buildMode === "app");
		if (scaffoldBtn) scaffoldBtn.classList.toggle("hidden", buildMode !== "app");
		inputEl.placeholder = buildMode === "app"
			? "תאר אפליקציה לבנות (מובייל-first, מסכים, ניווט)…"
			: "Describe a task for the agent…";
		if (notify) vscode.postMessage({ type: "buildMode", mode: buildMode });
	}
	modeSiteEl.addEventListener("click", () => setBuildMode("site", true));
	modeAppEl.addEventListener("click", () => setBuildMode("app", true));
	if (scaffoldBtn) scaffoldBtn.addEventListener("click", () => vscode.postMessage({ type: "scaffoldApp" }));

	function fmtTok(n) {
		n = Number(n || 0);
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
		return String(n);
	}
	function renderTokens(m) {
		const inT = Number(m.inT || 0), outT = Number(m.outT || 0), total = inT + outT;
		if (!total) { tokChipEl.classList.add("hidden"); return; }
		const approx = m.exact ? "" : "≈";
		tokChipEl.textContent = "◆ " + approx + fmtTok(total) + " tok";
		tokChipEl.title = (m.model || model || "Agent") + " · session " + approx + fmtTok(total) +
			" tokens (in " + fmtTok(inT) + " / out " + fmtTok(outT) + ")";
		tokChipEl.classList.remove("hidden");
	}

	// ---------- visual selection (click-to-edit from the preview) ----------
	let pendingPick = null;
	const composerEl = document.getElementById("composer");
	const steerBar = el("div", "steerBar hidden");
	const pickBar = el("div", "pickBar hidden");
	composerEl.insertBefore(steerBar, inputEl);
	composerEl.insertBefore(pickBar, inputEl);

	function pickLabel(p) {
		return (p.tag || "element") + (p.id ? "#" + p.id : "") +
			(p.classes ? " ." + String(p.classes).split(" ")[0] : "");
	}
	function pickPrefix(p) {
		let attrs = "<" + (p.tag || "");
		if (p.id) attrs += ' id="' + p.id + '"';
		if (p.classes) attrs += ' class="' + p.classes + '"';
		attrs += ">";
		let s = "[Selected element in the live preview: " + attrs;
		if (p.pathDesc) s += " inside " + p.pathDesc;
		if (p.src) s += ', src="' + p.src + '"';
		if (p.text) s += ', text: "' + p.text + '"';
		return s + "] — apply the change below to THIS element only.";
	}
	function showPick(p) {
		pendingPick = p;
		pickBar.innerHTML = "";
		pickBar.appendChild(el("span", "pickIcon", "🎯"));
		pickBar.appendChild(el("span", "pickTxt", pickLabel(p)));
		const x = el("button", "pickX", "✕");
		x.addEventListener("click", clearPick);
		pickBar.appendChild(x);
		pickBar.classList.remove("hidden");
		inputEl.placeholder = "Tell the agent what to change about this element…";
		inputEl.focus();
	}
	function clearPick() {
		pendingPick = null;
		pickBar.classList.add("hidden");
		pickBar.innerHTML = "";
		updatePlaceholder();
	}
	function renderSteerQueued(count) {
		if (!count) { steerBar.classList.add("hidden"); steerBar.textContent = ""; return; }
		steerBar.textContent = "↪ " + count + " steering message" + (count > 1 ? "s" : "") +
			" queued — applies right after the current step";
		steerBar.classList.remove("hidden");
	}
	function updatePlaceholder() {
		if (pendingPick) return;
		inputEl.placeholder = busy ? "Steer the agent — redirect or add a task…" : "Describe a task for the agent…";
	}

	// ---------- inline model picker (opens upward from the composer) ----------
	let modelChoices = [];
	let currentModelKey = "";
	const modelMenuEl = el("div", "pickMenu hidden");
	modelMenuEl.id = "modelMenu";
	document.getElementById("composer").appendChild(modelMenuEl);

	function renderModelMenu() {
		modelMenuEl.innerHTML = "";
		for (const c of modelChoices) {
			const row = el("div", "pickItem" + (c.key === currentModelKey ? " active" : ""));
			row.appendChild(el("span", "pickCheck", c.key === currentModelKey ? "✓" : ""));
			const txt = el("div", "pickText");
			txt.appendChild(el("div", "pickLabel", c.label));
			if (c.description) txt.appendChild(el("div", "pickDesc", c.description));
			row.appendChild(txt);
			row.addEventListener("click", (e) => {
				e.stopPropagation();
				closeModelMenu();
				if (c.key !== currentModelKey) vscode.postMessage({ type: "setModel", key: c.key });
			});
			modelMenuEl.appendChild(row);
		}
	}
	function openModelMenu() {
		if (!modelChoices.length) { vscode.postMessage({ type: "selectModel" }); return; }
		renderModelMenu();
		modelMenuEl.classList.remove("hidden");
		modelBtn.classList.add("open");
	}
	function closeModelMenu() {
		modelMenuEl.classList.add("hidden");
		modelBtn.classList.remove("open");
	}
	function toggleModelMenu() {
		if (modelMenuEl.classList.contains("hidden")) openModelMenu(); else closeModelMenu();
	}
	document.addEventListener("click", () => closeModelMenu());
	document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModelMenu(); });

	document.getElementById("loginBtn").addEventListener("click", () => {
		loginNoteEl.textContent = "Complete the sign-in in your browser…";
		vscode.postMessage({ type: "login" });
	});
	sendBtn.addEventListener("click", send);
	modelBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleModelMenu(); });
	autonomyBtn.addEventListener("click", () => vscode.postMessage({ type: "selectAutonomy" }));
	stopBtn.addEventListener("click", () => vscode.postMessage({ type: "interrupt" }));

	// ---------- voice dictation (mic → Groq Whisper) ----------
	const micBtn = document.getElementById("micBtn");
	let mediaRecorder = null, audioChunks = [], micStream = null, recording = false;
	function resetMic() {
		micBtn.classList.remove("recording", "transcribing");
		micBtn.disabled = false;
		micBtn.textContent = "🎤";
		micBtn.title = "Record a voice message (Groq Whisper)";
	}
	function bytesToBase64(bytes) {
		let bin = ""; const chunk = 0x8000;
		for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
		return btoa(bin);
	}
	async function startRecording() {
		if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { sysLine("Microphone not available in this view.", "error"); return; }
		try { micStream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
		catch (e) { sysLine("Microphone blocked — " + ((e && e.message) || e), "error"); return; }
		audioChunks = [];
		const mime = (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/webm;codecs=opus")) ? "audio/webm;codecs=opus"
			: (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported("audio/ogg;codecs=opus")) ? "audio/ogg;codecs=opus" : "";
		try { mediaRecorder = mime ? new MediaRecorder(micStream, { mimeType: mime }) : new MediaRecorder(micStream); }
		catch (e) { sysLine("Recorder unavailable — " + ((e && e.message) || e), "error"); stopTracks(); return; }
		mediaRecorder.addEventListener("dataavailable", (e) => { if (e.data && e.data.size) audioChunks.push(e.data); });
		mediaRecorder.addEventListener("stop", onRecordingStop);
		mediaRecorder.start();
		recording = true;
		micBtn.classList.add("recording");
		micBtn.textContent = "⏺";
		micBtn.title = "Stop & transcribe";
	}
	function stopTracks() { if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; } }
	function stopRecording() {
		recording = false;
		micBtn.classList.remove("recording");
		if (mediaRecorder && mediaRecorder.state !== "inactive") mediaRecorder.stop();
	}
	async function onRecordingStop() {
		const type = (mediaRecorder && mediaRecorder.mimeType) || "audio/webm";
		stopTracks();
		const blob = new Blob(audioChunks, { type });
		audioChunks = [];
		if (!blob.size) { resetMic(); return; }
		micBtn.classList.add("transcribing");
		micBtn.disabled = true;
		micBtn.textContent = "⋯";
		micBtn.title = "Transcribing…";
		const buf = await blob.arrayBuffer();
		vscode.postMessage({ type: "transcribe", audio: bytesToBase64(new Uint8Array(buf)), mime: blob.type });
	}
	micBtn.addEventListener("click", () => {
		if (micBtn.disabled) return;
		if (recording) stopRecording(); else startRecording();
	});
	inputEl.addEventListener("keydown", (e) => {
		if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
	});

	function send() {
		const shown = inputEl.value.trim();
		if (!shown) return;
		const steering = busy;            // a turn is already running → steer it
		const pick = pendingPick;
		const text = pick ? pickPrefix(pick) + "\n" + shown : shown;
		inputEl.value = "";
		addUserMessage(shown, { steer: steering, pick });
		clearPick();
		if (steering) {
			vscode.postMessage({ type: "steer", text });
		} else {
			setBusy(true);
			vscode.postMessage({ type: "send", text });
		}
	}

	const SPIN_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
	const IDLE_VERBS = ["Thinking", "Planning", "Exploring", "Reasoning", "Synthesizing", "Crafting", "Weighing options", "Connecting dots"];
	let busyEl = null;
	let busyGlyphEl = null;
	let busyLabelEl = null;
	let busyCountEl = null;
	let busyClockEl = null;
	let busyStart = 0;
	let busyTimer = null;
	let spinTimer = null;
	let spinFrame = 0;
	let verbIdx = 0;
	let explicitActivity = null;
	let actionCount = 0;
	function setBusy(b) {
		busy = b;
		dotEl.className = "dot " + (b ? "busy" : "idle");
		sendBtn.disabled = false;        // stays usable while busy so the user can steer
		sendBtn.textContent = b ? "Steer" : "Send";
		stopBtn.classList.toggle("hidden", !b);
		updatePlaceholder();
		if (b && !busyEl) {
			actionCount = 0;
			explicitActivity = null;
			busyEl = el("div");
			busyEl.id = "busyLine";
			busyGlyphEl = el("span", "busyGlyph", SPIN_FRAMES[0]);
			busyLabelEl = el("span", "busyLabel", "Thinking…");
			busyCountEl = el("span", "busyCount", "");
			busyClockEl = el("span", "busyClock", "0:00");
			busyEl.append(busyGlyphEl, busyLabelEl, busyCountEl, busyClockEl);
			messagesEl.appendChild(busyEl);
			busyStart = Date.now();
			busyTimer = setInterval(() => {
				const s = Math.floor((Date.now() - busyStart) / 1000);
				busyClockEl.textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
				// no explicit tool activity → rotate whimsical thinking verbs (Claude Code style)
				if (!explicitActivity && s > 0 && s % 4 === 0) {
					verbIdx = (verbIdx + 1) % IDLE_VERBS.length;
					busyLabelEl.textContent = IDLE_VERBS[verbIdx] + "…";
				}
			}, 1000);
			spinTimer = setInterval(() => {
				spinFrame = (spinFrame + 1) % SPIN_FRAMES.length;
				if (busyGlyphEl) busyGlyphEl.textContent = SPIN_FRAMES[spinFrame];
			}, 90);
		} else if (!b && busyEl) {
			clearInterval(busyTimer);
			clearInterval(spinTimer);
			busyTimer = spinTimer = null;
			busyEl.remove();
			busyEl = null;
			busyGlyphEl = busyLabelEl = busyCountEl = busyClockEl = null;
		}
		if (!b) haltRunningCards();
		scroll();
	}

	function setActivity(label) {
		explicitActivity = label || null;
		if (busyLabelEl) busyLabelEl.textContent = label || (IDLE_VERBS[verbIdx] + "…");
		if (busyCountEl && actionCount > 0) busyCountEl.textContent = "· " + actionCount + (actionCount === 1 ? " step" : " steps");
	}

	function activityFor(item) {
		if (item.type === "reasoning") return "Thinking…";
		if (item.type === "agentMessage") return "Writing…";
		if (TOOL_TYPES.has(item.type)) {
			const h = toolHead(item);
			return trunc(h.verb + (h.arg ? " " + h.arg : ""), 72);
		}
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

	function addUserMessage(text, opts) {
		opts = opts || {};
		const m = el("div", "msg user");
		if (opts.pick) m.appendChild(el("div", "pickChip", "🎯 " + pickLabel(opts.pick)));
		const bubble = el("div", "bubble" + (opts.steer ? " steerMsg" : ""));
		if (opts.steer) bubble.appendChild(el("span", "steerTag", "↪ "));
		bubble.appendChild(document.createTextNode(text));
		m.appendChild(bubble);
		messagesEl.appendChild(m);
		scroll();
	}

	function sysLine(text, cls) {
		const m = el("div", "sys " + (cls || ""), text);
		messagesEl.appendChild(m);
		scroll();
		return m;
	}

	// ---------- Claude-Code-style tool cards ----------
	// Every tool action the agent takes renders as a compact monospace card:
	//   ⏺ Verb argument                     3s
	//     ⎿ one-line result (click head to expand full output)
	const TOOL_TYPES = new Set([
		"commandExecution", "fileChange", "mcpToolCall", "webSearch",
		"dynamicToolCall", "collabAgentToolCall", "imageGeneration", "imageView",
		"enteredReviewMode", "exitedReviewMode", "contextCompaction",
	]);
	const runningCards = new Set();
	let tickTimer = null;
	function ensureTick() {
		if (tickTimer) return;
		tickTimer = setInterval(() => {
			if (!runningCards.size) { clearInterval(tickTimer); tickTimer = null; return; }
			for (const e of runningCards) e.timeEl.textContent = Math.floor((Date.now() - e.t0) / 1000) + "s";
		}, 1000);
	}

	function firstLine(s) { return String(s || "").split("\n")[0]; }
	function trunc(s, n) { s = String(s || ""); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
	function stripShell(c) {
		let s = Array.isArray(c) ? c.join(" ") : String(c || "");
		return s.replace(/^\s*(\/bin\/|\/usr\/bin\/)?(ba|z|da)?sh\s+-l?c\s+/, "")
			.replace(/^(['"])([\s\S]*)\1$/, "$2");
	}
	function relPath(p) {
		const s = String(p || "").replace(/\\/g, "/");
		if (!/^([A-Za-z]:)?\//.test(s)) return s;
		const parts = s.split("/").filter(Boolean);
		return parts.length > 3 ? parts.slice(-3).join("/") : parts.join("/");
	}
	function diffStats(diff) {
		let add = 0, del = 0;
		for (const l of String(diff || "").split("\n")) {
			if (l[0] === "+" && !l.startsWith("+++")) add++;
			else if (l[0] === "-" && !l.startsWith("---")) del++;
		}
		return { add, del };
	}
	function fileChangeHead(changes) {
		const ch = Array.isArray(changes) ? changes : [];
		if (!ch.length) return { verb: "Edit", arg: "files…" };
		const kind = ch[0].kind && ch[0].kind.type;
		const verb = ch.length > 1 ? "Edit" : kind === "add" ? "Write" : kind === "delete" ? "Delete" : "Edit";
		let arg = relPath(ch[0].path || ch[0].file);
		const st = diffStats(ch[0].diff);
		if (st.add || st.del) arg += ` (+${st.add} -${st.del})`;
		if (ch.length > 1) arg += ` · +${ch.length - 1} more`;
		return { verb, arg };
	}
	function toolHead(item) {
		switch (item.type) {
			case "commandExecution": {
				const acts = Array.isArray(item.commandActions) ? item.commandActions : [];
				const a = (acts.length === 1 && acts[0]) || {};
				if (a.type === "read") return { verb: "Read", arg: relPath(a.path) || trunc(stripShell(a.command), 96) };
				if (a.type === "search") {
					const q = a.query ? `"${a.query}"` : "";
					const where = a.path ? relPath(a.path) : "";
					return { verb: "Search", arg: (q && where ? q + " in " + where : q || where) || trunc(stripShell(a.command), 96) };
				}
				if (a.type === "listFiles") return { verb: "List", arg: relPath(a.path) || "." };
				return { verb: "Bash", arg: trunc(firstLine(stripShell(item.command)), 96) };
			}
			case "fileChange": return fileChangeHead(item.changes);
			case "webSearch": {
				const act = item.action || {};
				if (act.type === "openPage") return { verb: "Open", arg: trunc(act.url || "", 96) };
				if (act.type === "findInPage") return { verb: "Find", arg: trunc((act.pattern ? `"${act.pattern}" in ` : "") + (act.url || ""), 96) };
				const q = (Array.isArray(act.queries) && act.queries[0]) || act.query || item.query;
				return { verb: "Search", arg: q ? `"${trunc(q, 90)}"` : "web" };
			}
			case "mcpToolCall": return { verb: "Tool", arg: mcpName(item) };
			case "dynamicToolCall": return { verb: "Tool", arg: (item.namespace ? item.namespace + "/" : "") + (item.tool || "") };
			case "collabAgentToolCall": return { verb: "Agent", arg: trunc((item.tool || "") + (item.prompt ? " · " + firstLine(item.prompt) : ""), 96) };
			case "imageGeneration": return { verb: "Image", arg: trunc(item.revisedPrompt || (item.savedPath ? relPath(item.savedPath) : "generating…"), 96) };
			case "imageView": return { verb: "View", arg: relPath(item.path) };
			case "enteredReviewMode": return { verb: "Review", arg: "entering review mode" };
			case "exitedReviewMode": return { verb: "Review", arg: "review finished" };
			case "contextCompaction": return { verb: "Compact", arg: "compressing context" };
			default: return { verb: item.type || "Tool", arg: "" };
		}
	}

	function makeToolCard(item) {
		const head = toolHead(item);
		const root = el("div", "tc running");
		const headEl = el("div", "tcHead");
		const verbEl = el("span", "tcVerb", head.verb);
		const argEl = el("span", "tcArg", head.arg || "");
		const timeEl = el("span", "tcTime", "0s");
		headEl.append(el("span", "tcDot", "⏺"), verbEl, argEl, timeEl);
		const resEl = el("div", "tcRes hidden");
		const resTxtEl = el("span", "tcResTxt", "");
		resEl.append(el("span", "tcElbow", "⎿"), resTxtEl);
		const outWrap = el("div", "tcOut");
		const outPre = el("pre", "", "");
		outWrap.appendChild(outPre);
		root.append(headEl, resEl, outWrap);
		messagesEl.appendChild(root);
		const entry = {
			el: outPre, root, verbEl, argEl, timeEl, resEl, resTxtEl, outWrap, outPre,
			type: item.type, text: "", t0: Date.now(), done: false, changes: item.changes || null,
		};
		headEl.addEventListener("click", () => {
			if (!root.classList.contains("expandable")) return;
			root.classList.toggle("open");
			if (root.classList.contains("open")) outWrap.scrollTop = outWrap.scrollHeight;
		});
		runningCards.add(entry);
		ensureTick();
		return entry;
	}

	function setHead(entry, head) {
		entry.verbEl.textContent = head.verb;
		entry.argEl.textContent = head.arg || "";
	}

	// render a generated/viewed image inline under its tool card; clicking it asks
	// the extension to open the file in the center editor (mirrors PLAN.md behaviour)
	function addInlineImage(entry, item) {
		const src = item.webUri;
		if (!src || entry.imgDone) return;
		entry.imgDone = true;
		const fig = el("div", "tcImg");
		const img = document.createElement("img");
		img.src = src;
		img.alt = item.revisedPrompt || "generated image";
		img.loading = "lazy";
		img.addEventListener("click", () => vscode.postMessage({
			type: "openImage", path: item.absPath || item.savedPath || item.path,
		}));
		fig.appendChild(img);
		entry.root.appendChild(fig);
		entry.root.classList.add("hasImg");
		scroll();
	}

	function setRes(entry, text, live) {
		entry.resTxtEl.textContent = text || "";
		entry.resEl.classList.toggle("hidden", !text);
		entry.resEl.classList.toggle("live", !!live);
	}

	function appendOut(entry, delta) {
		entry.text += delta;
		if (entry.text.length > 200000) entry.text = entry.text.slice(-150000);
		entry.outPre.textContent = entry.text;
		entry.root.classList.add("expandable");
		// while running and collapsed, mirror the latest output line as a live tail
		if (!entry.done) {
			const lines = entry.text.split("\n");
			for (let i = lines.length - 1; i >= 0; i--) {
				if (lines[i].trim()) { setRes(entry, trunc(lines[i].trim(), 140), true); break; }
			}
		}
		if (entry.root.classList.contains("open")) entry.outWrap.scrollTop = entry.outWrap.scrollHeight;
	}

	function renderChangesInto(entry) {
		const ch = Array.isArray(entry.changes) ? entry.changes : [];
		entry.outPre.textContent = "";
		let any = false;
		for (const c of ch) {
			if (!c || !c.diff) continue;
			any = true;
			entry.outPre.appendChild(el("div", "dl lh", relPath(c.path || c.file)));
			for (const ln of String(c.diff).split("\n").slice(0, 400)) {
				const cls = ln[0] === "+" ? "la" : ln[0] === "-" ? "ld" : /^@@/.test(ln) ? "lh" : "lc";
				entry.outPre.appendChild(el("div", "dl " + cls, ln));
			}
		}
		if (any) entry.root.classList.add("expandable");
	}

	function fileChangeTotals(changes) {
		let add = 0, del = 0;
		for (const c of changes || []) { const s = diffStats(c && c.diff); add += s.add; del += s.del; }
		return { add, del };
	}

	function updateFileCard(entry, changes) {
		if (Array.isArray(changes) && changes.length) entry.changes = changes;
		setHead(entry, fileChangeHead(entry.changes));
		renderChangesInto(entry);
		const ch = Array.isArray(entry.changes) ? entry.changes : [];
		if (ch.length > 1) {
			const t = fileChangeTotals(ch);
			setRes(entry, `${ch.length} files · +${t.add} -${t.del}`, !entry.done);
		}
	}

	function finishToolCard(entry, item, ok, resText) {
		entry.done = true;
		runningCards.delete(entry);
		entry.root.classList.remove("running");
		entry.root.classList.add(ok ? "ok" : "fail");
		const ms = item && typeof item.durationMs === "number" ? item.durationMs : Date.now() - entry.t0;
		const secs = ms / 1000;
		entry.timeEl.textContent = secs >= 10 ? Math.round(secs) + "s" : secs >= 0.05 ? secs.toFixed(1) + "s" : "";
		setRes(entry, resText, false);
	}

	// a turn ended (or was interrupted) with cards still spinning — freeze them
	function haltRunningCards() {
		for (const e of [...runningCards]) {
			e.done = true;
			runningCards.delete(e);
			e.root.classList.remove("running");
			e.root.classList.add("halt");
			e.timeEl.textContent = "";
		}
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
			d.open = true;
			d.appendChild(el("summary", "", "✻ Thinking…"));
			const body = el("div", "reasonText", "");
			d.appendChild(body);
			messagesEl.appendChild(d);
			entry = { el: body, type: item.type, text: "", root: d, t0: Date.now() };
		} else if (TOOL_TYPES.has(item.type)) {
			entry = makeToolCard(item);
			actionCount++;
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
		if (TOOL_TYPES.has(entry.type)) {
			appendOut(entry, delta);
			scroll();
			return;
		}
		entry.text += delta;
		entry.el.textContent = entry.text;
		entry.el.scrollTop = entry.el.scrollHeight;
		scroll();
	}

	// ---------- live plan timeline ----------
	let planCard = null;
	// icon per inferred step category so the timeline reads at a glance
	function planGlyph(s) {
		const t = (s.group || "") + " " + (s.step || "");
		if (/research|analy|deconstruct|explore|inspect|study|חקר|ניתוח/i.test(t)) return "🔎";
		if (/design|layout|style|theme|visual|ui|עיצוב/i.test(t)) return "🎨";
		if (/build|implement|code|develop|create|write|בנייה|בניית/i.test(t)) return "🛠";
		if (/test|verify|qa|check|review|אימות|בדיקה/i.test(t)) return "🧪";
		if (/deploy|ship|publish|release|פריסה/i.test(t)) return "🚀";
		return "◆";
	}
	function planMark(status) {
		return status === "completed" ? "✓" : status === "inProgress" ? "" : "";
	}
	function renderPlan(plan) {
		if (!Array.isArray(plan) || !plan.length) return;
		if (!planCard || !planCard.parentNode) {
			planCard = el("div", "card planCard");
			messagesEl.appendChild(planCard);
		}
		planCard.innerHTML = "";

		const total = plan.length;
		const done = plan.filter((s) => s.status === "completed").length;
		const current = plan.find((s) => s.status === "inProgress");
		const pct = Math.round((done / total) * 100);

		// header: title + animated progress ring + count
		const head = el("div", "planHead");
		const ring = el("div", "planRing");
		ring.style.background = "conic-gradient(var(--sol-accent,#f59e0b) " + pct + "%, var(--sol-line,#3a3a3a) 0)";
		ring.appendChild(el("span", "planRingTxt", pct + "%"));
		head.appendChild(ring);
		const ht = el("div", "planHeadText");
		ht.appendChild(el("div", "planTitleMain", "Plan"));
		ht.appendChild(el("div", "planSub", current ? current.step : (done === total ? "All steps complete" : "")));
		head.appendChild(ht);
		head.appendChild(el("span", "planCount", done + "/" + total));
		planCard.appendChild(head);

		// vertical timeline
		const tl = el("div", "planTL");
		let curGroup = null;
		for (const s of plan) {
			if (s.group && s.group !== curGroup) {
				curGroup = s.group;
				tl.appendChild(el("div", "planGroup", curGroup));
			}
			const st = s.status || "pending";
			const node = el("div", "tlStep tl--" + st);
			const rail = el("div", "tlRail");
			const dot = el("div", "tlDot");
			dot.textContent = st === "completed" ? "✓" : planGlyph(s);
			if (st === "inProgress") dot.classList.add("tlDot--pulse");
			rail.appendChild(dot);
			node.appendChild(rail);
			const body = el("div", "tlBody");
			body.appendChild(el("div", "tlTitle", s.step || ""));
			if (s.detail) body.appendChild(el("div", "tlDetail", s.detail));
			if (Array.isArray(s.substeps) && s.substeps.length) {
				const subDone = s.substeps.filter((x) => x.status === "completed").length;
				const subs = el("div", "tlSubs");
				for (const sub of s.substeps) {
					const sr = el("div", "tlSub tl--" + (sub.status || "pending"));
					sr.appendChild(el("span", "tlSubMark", sub.status === "completed" ? "✓" : sub.status === "inProgress" ? "▸" : "·"));
					sr.appendChild(el("span", "tlSubTxt", sub.step || ""));
					subs.appendChild(sr);
				}
				const cap = el("div", "tlSubCap", subDone + "/" + s.substeps.length);
				body.appendChild(cap);
				body.appendChild(subs);
			}
			node.appendChild(body);
			tl.appendChild(node);
		}
		planCard.appendChild(tl);
		scroll();
	}

	// ---------- live changes (diff) card ----------
	let diffCard = null;
	function parseDiff(text) {
		const files = [];
		let cur = null;
		for (const line of String(text || "").split("\n")) {
			const head = line.match(/^\+\+\+ (?:b\/)?(.+)$/);
			if (head) {
				// successive edits to the same file arrive as separate sections — merge them
				cur = files.find((f) => f.path === head[1]);
				if (!cur) {
					cur = { path: head[1], add: 0, del: 0, lines: [] };
					files.push(cur);
				}
				continue;
			}
			if (/^(--- |diff --git |index |new file|deleted file)/.test(line)) continue;
			if (!cur) continue;
			if (line[0] === "+") cur.add++;
			else if (line[0] === "-") cur.del++;
			cur.lines.push(line);
		}
		return files.filter((f) => f.lines.length);
	}

	function renderDiff(diffText) {
		const files = parseDiff(diffText);
		if (!files.length) return;
		const openPaths = new Set(
			diffCard ? Array.from(diffCard.querySelectorAll("details.diffFile[open]")).map((d) => d.getAttribute("data-path")) : []
		);
		if (!diffCard || !diffCard.parentNode) diffCard = el("div", "card diffCard");
		// keep the aggregate Changes card pinned after the latest activity
		messagesEl.appendChild(diffCard);
		diffCard.innerHTML = "";
		const totalAdd = files.reduce((n, f) => n + f.add, 0);
		const totalDel = files.reduce((n, f) => n + f.del, 0);
		const title = el("div", "cardTitle diffTitle");
		title.appendChild(el("span", "", "⛬ Changes"));
		const stat = el("span", "diffTot");
		stat.appendChild(el("span", "dAdd", "+" + totalAdd));
		stat.appendChild(el("span", "dDel", "−" + totalDel));
		title.appendChild(stat);
		diffCard.appendChild(title);
		for (const f of files) {
			const d = el("details", "diffFile");
			d.setAttribute("data-path", f.path);
			if (openPaths.has(f.path)) d.open = true;
			const sum = el("summary", "diffSum");
			sum.appendChild(el("span", "dName", f.path));
			const s = el("span", "dStat");
			if (f.add) s.appendChild(el("span", "dAdd", "+" + f.add));
			if (f.del) s.appendChild(el("span", "dDel", "−" + f.del));
			sum.appendChild(s);
			d.appendChild(sum);
			const body = el("pre", "diffBody");
			for (const ln of f.lines.slice(0, 400)) {
				const cls = ln[0] === "+" ? "la" : ln[0] === "-" ? "ld" : /^@@/.test(ln) ? "lh" : "lc";
				body.appendChild(el("div", "dl " + cls, ln));
			}
			d.appendChild(body);
			diffCard.appendChild(d);
		}
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
				return;
			}
			// tool event with no begin/end pair — render a single completed card
			if (TOOL_TYPES.has(item.type)) entry = startItem(item);
			if (!entry) return;
		}
		if (item.type === "agentMessage" && item.text) {
			entry.text = item.text;
			entry.el.textContent = "";
			entry.el.appendChild(window.mdRender(item.text));
		}
		if (item.type === "reasoning" && entry.root) {
			entry.root.classList.add("done");
			entry.root.open = false;
			const secs = entry.t0 ? Math.max(1, Math.round((Date.now() - entry.t0) / 1000)) : 0;
			entry.root.querySelector("summary").textContent = secs ? `✻ Thought for ${secs}s` : "✻ Thought";
			if (!entry.text) entry.root.classList.add("hidden");
		}
		if (item.type === "commandExecution") {
			const code = item.exitCode;
			const declined = item.status === "declined";
			const ok = !declined && item.status !== "failed" && (code === 0 || code === null || code === undefined);
			if (item.command) setHead(entry, toolHead(item));
			if (item.aggregatedOutput && String(item.aggregatedOutput).length > entry.text.length) {
				entry.text = "";
				appendOut(entry, String(item.aggregatedOutput));
			}
			const outLines = entry.text.split("\n").filter((l) => l.trim());
			const ms = typeof item.durationMs === "number" ? item.durationMs : Date.now() - entry.t0;
			let res;
			if (declined) res = "declined";
			else if (ok) {
				res = outLines.length
					? outLines.length + (outLines.length === 1 ? " line" : " lines")
					: `exit ${code == null ? 0 : code} in ${(ms / 1000).toFixed(1)}s`;
			} else {
				const lastErr = outLines.length ? outLines[outLines.length - 1] : "failed";
				res = trunc(lastErr, 140) + (code != null ? ` (exit ${code})` : "");
			}
			finishToolCard(entry, item, ok, res);
		}
		if (item.type === "fileChange") {
			updateFileCard(entry, item.changes);
			const declined = item.status === "declined";
			const ok = !declined && item.status !== "failed";
			const ch = Array.isArray(entry.changes) ? entry.changes : [];
			let res = "";
			if (declined) res = "declined";
			else if (!ok) res = "patch failed";
			else if (ch.length === 1) {
				const s = diffStats(ch[0].diff);
				res = (s.add || s.del) ? `+${s.add} -${s.del}` : relPath(ch[0].path || ch[0].file);
			} else if (ch.length > 1) {
				const t = fileChangeTotals(ch);
				res = `${ch.length} files · +${t.add} -${t.del}`;
			}
			finishToolCard(entry, item, ok, res);
		}
		if (item.type === "mcpToolCall" || item.type === "dynamicToolCall" || item.type === "collabAgentToolCall") {
			const ok = item.status !== "failed" && item.success !== false && !item.error;
			const txt = mcpResultText(item);
			if (txt) { entry.text = ""; appendOut(entry, txt); }
			const res = ok
				? (txt ? trunc(firstLine(txt), 140) : "done")
				: trunc(firstLine((item.error && (item.error.message || item.error)) || txt || "failed"), 140);
			finishToolCard(entry, item, ok, res);
		}
		if (item.type === "webSearch") {
			setHead(entry, toolHead(item));
			const act = item.action || {};
			const extra = Array.isArray(act.queries) && act.queries.length > 1
				? act.queries.slice(1).map((q) => `"${q}"`).join(" · ") : "";
			finishToolCard(entry, item, true, extra);
		}
		if (item.type === "imageGeneration") {
			const ok = item.status !== "failed";
			setHead(entry, toolHead(item));
			finishToolCard(entry, item, ok, ok ? (item.savedPath ? relPath(item.savedPath) : "") : "generation failed");
			if (ok) addInlineImage(entry, item);
		}
		if (item.type === "imageView") {
			finishToolCard(entry, item, true, "");
			addInlineImage(entry, item);
		}
		if (item.type === "enteredReviewMode" ||
			item.type === "exitedReviewMode" || item.type === "contextCompaction") {
			finishToolCard(entry, item, true, "");
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
				modelEl.textContent = model || "—";
				if (brandModelEl) brandModelEl.textContent = model || "Solstice Agent";
				break;
			case "models":
				modelChoices = Array.isArray(msg.list) ? msg.list : [];
				currentModelKey = msg.current || "";
				if (!modelMenuEl.classList.contains("hidden")) renderModelMenu();
				break;
			case "autonomy":
				autonomyEl.textContent = AUTONOMY_LABELS[msg.level] || "Supervised";
				autonomyBtn.classList.toggle("trusted", msg.level === "autonomous");
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
			case "systemNote":
				sysLine(String(msg.text || ""), msg.level || "info");
				break;
			case "elementSelected":
				showPick(msg.pick);
				break;
			case "steerQueued":
				renderSteerQueued(msg.count);
				break;
			case "notification":
				handleNotification(msg.method, msg.params);
				break;
			case "transcribed": {
				resetMic();
				const t = String(msg.text || "").trim();
				if (!t) { sysLine("No speech detected.", "error"); break; }
				inputEl.value = inputEl.value ? (inputEl.value.replace(/\s*$/, "") + " " + t) : t;
				inputEl.focus();
				try { inputEl.dispatchEvent(new Event("input")); } catch (e) {}
				break;
			}
			case "transcribeError":
				resetMic();
				sysLine("Transcription failed — " + (msg.message || "unknown error"), "error");
				break;
			case "tokens":
				renderTokens(msg);
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
			case "item/fileChange/patchUpdated": {
				const e = items.get(params.itemId);
				if (e && e.type === "fileChange" && !e.done) { updateFileCard(e, params.changes); scroll(); }
				break;
			}
			case "item/mcpToolCall/progress": {
				const e = items.get(params.itemId);
				if (e && TOOL_TYPES.has(e.type) && !e.done) setRes(e, trunc(params.message || "", 140), true);
				break;
			}
			case "turn/plan/updated": renderPlan(params.plan); break;
			case "turn/diff/updated": renderDiff(params.diff); break;
			case "account/rateLimits/updated": renderQuota(params.rateLimits); break;
			case "error": sysLine((params.error && params.error.message) || "Agent error", "error"); break;
		}
	}

	// ---------- welcome / quick-start ----------
	// First-run hero in the empty chat: brand + tappable starters that pre-fill the
	// composer (and set build mode) so a new user has an obvious next step. Cleared
	// automatically the moment any real message/card lands in the thread.
	const QUICK_STARTS = [
		{ glyph: "🌐", mode: "site", title: "אתר נחיתה", sub: "דף שיווקי מודרני", prompt: "בנה דף נחיתה פרימיום ומודרני עבור __ (תאר את העסק). היררכיה ברורה, hero מרשים, קריאה לפעולה, ורספונסיבי." },
		{ glyph: "📱", mode: "app", title: "אפליקציה", sub: "מובייל-first, ריבוי מסכים", prompt: "בנה אפליקציה מובייל-first עם ריבוי מסכים וניווט תחתון עבור __ (תאר את הרעיון). התחל משלד האפליקציה." },
		{ glyph: "🎨", mode: "site", title: "שכפול עיצוב", sub: "מאתר ייחוס", prompt: "שכפל את העיצוב והחוויה של האתר __ (הדבק קישור) ברמת פיקסל — פריסה, טיפוגרפיה, צבעים, אנימציות." },
		{ glyph: "🛠", mode: "site", title: "תקן / שפר", sub: "על הפרויקט הפתוח", prompt: "עבור על הפרויקט הפתוח, אתר באגים ובעיות UX, ותקן אותם תוך הסבר קצר על כל תיקון." },
	];
	function renderWelcome() {
		if (messagesEl.querySelector(".welcome") || messagesEl.children.length) return;
		const w = el("div", "welcome");
		const hero = el("div", "wHero");
		hero.appendChild(el("span", "wMark", "☀"));
		const ht = el("div", "wHeroText");
		ht.appendChild(el("div", "wTitle", "ברוך הבא ל-Solstice"));
		ht.appendChild(el("div", "wSub", "תאר מה לבנות — האתר או האפליקציה ייבנו מולך בזמן אמת."));
		hero.appendChild(ht);
		w.appendChild(hero);
		const grid = el("div", "wGrid");
		for (const q of QUICK_STARTS) {
			const c = el("button", "wCard");
			c.appendChild(el("span", "wCardGlyph", q.glyph));
			const tx = el("div", "wCardText");
			tx.appendChild(el("div", "wCardTitle", q.title));
			tx.appendChild(el("div", "wCardSub", q.sub));
			c.appendChild(tx);
			c.addEventListener("click", () => {
				try { setBuildMode(q.mode, true); } catch (e) {}
				inputEl.value = q.prompt;
				try { inputEl.dispatchEvent(new Event("input")); } catch (e) {}
				inputEl.focus();
				const pos = q.prompt.indexOf("__");
				if (pos >= 0) { try { inputEl.setSelectionRange(pos, pos + 2); } catch (e) {} }
			});
			grid.appendChild(c);
		}
		w.appendChild(grid);
		messagesEl.appendChild(w);
	}
	// drop the welcome as soon as a real bubble/card joins the thread
	new MutationObserver(() => {
		const w = messagesEl.querySelector(".welcome");
		if (w && messagesEl.children.length > 1) w.remove();
	}).observe(messagesEl, { childList: true });
	renderWelcome();

	vscode.postMessage({ type: "ready" });
})();
