"use strict";
const vscode = require("vscode");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { CodexClient, resolveCodexBinary } = require("./codexClient");
const { PreviewServer, detectDevServerUrl, hasFramework } = require("./preview");
const { GrokProvider, GROK_MODELS } = require("./grok");
const { ClaudeProvider, CLAUDE_LABEL } = require("./claude");
const { FleetBridge } = require("./fleetBridge");

// Subdirs that live alongside agent build workspaces but are not projects.
const GALLERY_SKIP_DIRS = new Set([
	"node_modules", "userdata", "exthost-logs",
	"VSCode-linux-x64", "VSCode-darwin-arm64", "VSCode-win32-x64",
]);

const SIDEBAR_FORWARDED = new Set([
	"thread/started",
	"turn/started",
	"turn/completed",
	"turn/plan/updated",
	"item/started",
	"item/completed",
	"item/agentMessage/delta",
	"item/reasoning/textDelta",
	"item/reasoning/summaryTextDelta",
	"item/commandExecution/outputDelta",
	"item/fileChange/patchUpdated",
	"item/mcpToolCall/progress",
	"account/rateLimits/updated",
	"turn/diff/updated",
	"error",
]);

const MANAGER_FORWARDED = new Set([
	...SIDEBAR_FORWARDED,
	"thread/status/changed",
	"thread/name/updated",
]);

const APPROVAL_METHODS = new Set([
	"item/commandExecution/requestApproval",
	"item/fileChange/requestApproval",
	"item/permissions/requestApproval",
	"execCommandApproval",
	"applyPatchApproval",
]);

function workspaceCwd() {
	const f = vscode.workspace.workspaceFolders;
	return f && f[0] ? f[0].uri.fsPath : undefined;
}

// roots a webview may load files from: bundled media + the workspace + the
// codex image output dir, so generated images render inline in the agent panel
function webviewResourceRoots(extensionUri) {
	const roots = [vscode.Uri.joinPath(extensionUri, "media")];
	const ws = vscode.workspace.workspaceFolders;
	if (ws) for (const f of ws) roots.push(f.uri);
	try { roots.push(vscode.Uri.file(path.join(os.homedir(), ".codex", "generated_images"))); } catch { }
	return roots;
}

class AgentController {
	constructor(context) {
		this.context = context;
		this.client = null;
		this.threadId = null;          // the sidebar's active thread
		this.lastDiff = "";
		this.webview = null;           // sidebar webview
		this.manager = null;           // manager panel webview
		this.threads = new Map();      // threadId -> {id, preview, status, activeTurnId, plan, diff, updatedAt}
		this.loaded = new Set();       // threadIds resumed/started in this server process
		this.pendingApprovals = new Map(); // approvalKey -> resolve(decision)
		this.terminal = null;          // integrated terminal spawned from the panel
		this.preview = null;
		this.previewUrl = "";
		this.previewPanel = null;      // device-frame live preview webview (center column)
		this.previewKind = "site";     // "site" | "app" — drives default device frame
		this.buildMode = "site";       // "site" | "app" — user-selected build intent (composer toggle)
		this.previewBuildTimer = null;
		this.grok = null;
		this.claude = null;
		this.grokWatcher = null;
		this.grokChanged = null;
		this.fallbackPrompted = false;
		this.steerQueue = [];          // grok/claude: mid-turn messages queued as next-priority follow-up
		this.fleetBridges = new Map(); // agentId -> { ws:FleetBridge, status:"connecting"|"online"|"offline" }
		this.watch = new Map();        // agentId -> { state, text, ts, alerted } — stuck-loop watchdog
		this.watchTimer = null;
		this.live = new Map();         // key -> liveness rec (progress-aware). "_builder" = local Solstice build
		this.activeFleetAgent = null;  // fleet agent the live build is attributed to
		this.output = vscode.window.createOutputChannel("Solstice Agent");
	}

	// ---- stuck-agent watchdog ----------------------------------------------
	// Busy states that can hang (e.g. "Exploring…" looping for hours with no
	// file write). Terminal/idle states clear the watch entry.
	watchdogConfig() {
		const c = vscode.workspace.getConfiguration("solstice.watchdog");
		return {
			enabled: c.get("enabled", true),
			stuckMs: Math.max(60000, (c.get("stuckMinutes", 6) || 6) * 60000),
		};
	}
	noteWatch(agentId, state) {
		const busy = state === "working" || state === "exploring" || state === "thinking"
			|| state === "connecting" || state === "dispatch" || state === "planning";
		if (!busy) { this.watch.delete(agentId); return; }
		const prev = this.watch.get(agentId);
		// fresh busy event = real progress: reset the clock and the alert latch
		this.watch.set(agentId, { state, ts: Date.now(), alerted: false, prevState: prev ? prev.state : null });
	}
	startWatchdog() {
		if (this.watchTimer) return;
		this.watchTimer = setInterval(() => {
			try { this.tickLiveness(); } catch { }
			const cfg = this.watchdogConfig();
			if (!cfg.enabled) return;
			const now = Date.now();
			for (const [agentId, w] of this.watch) {
				if (w.alerted) continue;
				if (now - w.ts < cfg.stuckMs) continue;
				w.alerted = true;
				const mins = Math.round((now - w.ts) / 60000);
				this.emitStuck(agentId, w.state, mins);
			}
		}, 15000);
		this.watchTimer.unref && this.watchTimer.unref();
	}
	emitStuck(agentId, state, mins) {
		const label = `נתקע ב-"${state}" כבר ${mins} דק׳ ללא התקדמות`;
		try { this.output.appendLine(`[watchdog] ${agentId}: ${label}`); } catch { }
		if (this.fleetPanel) {
			this.fleetPanel.webview.postMessage({ type: "stuck", agent: agentId, state, mins, ts: Date.now() });
			this.fleetPanel.webview.postMessage({ type: "activity", agent: agentId, state: "stuck", text: label, ts: Date.now() });
		}
		const name = (this.fleetAgents().find((a) => a.id === agentId) || {}).name || agentId;
		vscode.window.showWarningMessage(`⚠️ ${name} ${label}`, "פתח Fleet", "נקה תקיעה").then((pick) => {
			if (pick === "פתח Fleet" && this.fleetPanel) { this.fleetPanel.reveal(vscode.ViewColumn.One); this.fleetPanel.webview.postMessage({ type: "focusAgent", agent: agentId }); }
			else if (pick === "נקה תקיעה") { this.watch.delete(agentId); if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "stuckCleared", agent: agentId }); }
		}, () => { });
	}

	// ---- liveness (layered, progress-aware) --------------------------------
	// The watchdog above resets on ANY busy event, so a self-refreshing
	// "working…" animation can mask a hung turn for hours. Liveness instead
	// tracks DISTINCT progress signals — only real output (tokens / stream
	// deltas / file & tool events) counts as alive. A busy state with no strong
	// signal degrades: alive → quiet → stalled. On stall we recover by RESUME
	// (drain queued steers / nudge), never a blind wall-clock restart.
	livenessConfig() {
		const c = vscode.workspace.getConfiguration("solstice.liveness");
		return {
			enabled: c.get("enabled", true),
			freshMs: Math.max(10000, (c.get("freshSeconds", 90) || 90) * 1000),
			stallMs: Math.max(60000, (c.get("stallSeconds", 300) || 300) * 1000),
		};
	}
	liveRec(key) {
		let r = this.live.get(key);
		if (!r) { r = { sig: { state: 0, stream: 0, tool: 0, token: 0 }, busySince: 0, layer: "idle", alerted: false, lastTokenTotal: 0, queued: 0 }; this.live.set(key, r); }
		return r;
	}
	// kind: "state" (weak) | "stream" | "tool" | "token" (strong = real output)
	notePulse(key, kind, meta) {
		const r = this.liveRec(key);
		r.sig[kind] = Date.now();
		if (kind === "token" && meta && meta.total != null) r.lastTokenTotal = meta.total;
		if (kind !== "state") r.alerted = false; // real progress clears the stall latch
	}
	markBusy(key, busy) {
		const r = this.liveRec(key);
		if (busy) { if (!r.busySince) r.busySince = Date.now(); }
		else { r.busySince = 0; r.layer = "idle"; r.alerted = false; }
	}
	lastStrong(r) { return Math.max(r.sig.token, r.sig.tool, r.sig.stream); }
	livenessInfo(key) {
		const r = this.live.get(key);
		if (!r || !r.busySince) return { layer: "idle", sinceMs: 0, kind: null, queued: r ? r.queued : 0 };
		const cfg = this.livenessConfig();
		const now = Date.now();
		const strong = this.lastStrong(r);
		const since = now - (strong || r.busySince);
		let layer = since < cfg.freshMs ? "alive" : since < cfg.stallMs ? "quiet" : "stalled";
		const kind = strong === r.sig.token ? "token" : strong === r.sig.tool ? "tool" : strong === r.sig.stream ? "stream" : null;
		return { layer, sinceMs: since, kind, queued: r.queued, tokens: r.lastTokenTotal };
	}
	// The fleet agent the live build is attributed to in the Fleet panel.
	builderAgent() { return this.activeFleetAgent || "jasper"; }
	tickLiveness() {
		const cfg = this.livenessConfig();
		if (!cfg.enabled) return;
		for (const [key] of this.live) {
			const info = this.livenessInfo(key);
			const agent = key === "_builder" ? this.builderAgent() : key;
			if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "liveness", agent, ...info, ts: Date.now() });
			const r = this.live.get(key);
			if (info.layer === "stalled" && r && !r.alerted) {
				r.alerted = true;
				this.emitStall(agent, info);
			}
		}
	}
	emitStall(agent, info) {
		const mins = Math.round(info.sinceMs / 60000);
		const q = info.queued || 0;
		const name = (this.fleetAgents().find((a) => a.id === agent) || {}).name || agent;
		const label = `אין פלט אמיתי ${mins} דק׳` + (q ? ` · ${q} הודעות ממתינות` : "");
		try { this.output.appendLine(`[liveness] ${agent}: stalled — ${label}`); } catch { }
		if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "activity", agent, state: "stuck", text: "🔴 " + label, ts: Date.now() });
		const actions = q ? ["המשך (resume)", "פתח Fleet"] : ["פתח Fleet"];
		vscode.window.showWarningMessage(`🔴 ${name}: ${label}`, ...actions).then((pick) => {
			if (pick === "המשך (resume)") this.resumeBuilder();
			else if (pick === "פתח Fleet" && this.fleetPanel) { this.fleetPanel.reveal(vscode.ViewColumn.One); this.fleetPanel.webview.postMessage({ type: "focusAgent", agent }); }
		}, () => { });
	}
	// Recovery-by-resume: a stalled turn never emits turn/completed, so its
	// queued steers would sit forever (the reported bug). Force-drain them and
	// nudge the agent instead of killing the process.
	resumeBuilder() {
		const r = this.live.get("_builder");
		if (r) { r.alerted = false; r.sig.state = Date.now(); }
		if (this.steerQueue.length) { this.forceDrainSteer(); return; }
		// nothing queued — interrupt the hung turn so the CLI frees up
		this.interrupt(this.threadId).catch(() => { });
	}
	forceDrainSteer() {
		if (!this.steerQueue.length) return;
		const text = this.steerQueue.join("\n\n");
		this.steerQueue = [];
		const r = this.live.get("_builder"); if (r) r.queued = 0;
		this.post({ type: "steerQueued", count: 0 });
		this.interrupt(this.threadId)
			.catch(() => { })
			.then(() => this.send(text))
			.catch((e) => this.output.append(`\n[resume drain] ${e && e.message || e}\n`));
	}

	// Detect whether the workspace is an app (device-frame defaults to phone) or
	// a marketing site (defaults to full screen). Looks for app stacks.
	detectPreviewKind() {
		const root = workspaceCwd();
		if (!root) return "site";
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
			const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
			if (deps.expo || deps["react-native"]) return "app";
			// PWA / app-shell signals
			if (deps.next && (fs.existsSync(path.join(root, "public", "manifest.json")) ||
				fs.existsSync(path.join(root, "public", "manifest.webmanifest")) ||
				fs.existsSync(path.join(root, "app", "manifest.ts")))) return "app";
		} catch { }
		return "site";
	}

	defaultDevice() { return (this.buildMode === "app" || this.previewKind === "app") ? "iphone" : "desktop"; }

	// User-selected build intent from the composer toggle. App mode also primes the
	// preview to open in a phone frame and injects app-specific build guidance.
	setBuildMode(mode) {
		this.buildMode = mode === "app" ? "app" : "site";
		this.previewKind = this.buildMode;
		if (this.previewPanel && this.previewReady && this.previewUrl) {
			this.postPreview({ type: "load", url: this.previewUrl, device: this.defaultDevice() });
		}
	}

	// Extra guidance appended to the build preamble when the user is in App mode,
	// so a "build an app" request yields a real mobile-first installable app
	// (screens + navigation + manifest) rather than a marketing website.
	appModeGuidance() {
		if (this.buildMode !== "app") return "";
		return [
			"",
			"## BUILD MODE: APP (not a marketing website)",
			"The user is building an APPLICATION, not a landing/marketing site. Design accordingly:",
			"- Mobile-first: target a phone viewport (~390px) first; the live preview opens in a phone frame.",
			"- App shell: persistent navigation (top app bar and/or bottom tab bar), multiple SCREENS/routes, not one long scroll page.",
			"- Real interaction & state: working navigation between screens, lists/detail views, forms, and local state (use localStorage or a store).",
			"- Touch ergonomics: ≥44px tap targets, thumb-reachable primary actions, no hover-only affordances.",
			"- Installable PWA: include a web app manifest (name, icons, theme/background color, display: standalone) and a basic service worker so it can be added to the home screen.",
			"- Prefer an SPA stack (Vite + React/Router) unless told otherwise; keep it runnable with `npm run dev`.",
			"- Treat each screen as a deliverable: build the navigation skeleton first, then fill screens so the preview is always interactive.",
			"- A runnable PWA app-shell scaffold (index.html + app.js hash-router + bottom tab bar + manifest + service worker + data.js mock store) may already exist in the workspace (Solstice's 'Scaffold App Shell'). If so, BUILD ON IT — add screens/routes and flesh out the existing tabs rather than starting a single-page site from scratch.",
			"- Data layer: read/write app data through `window.DB` (data.js) — a seeded localStorage CRUD store. Build lists/detail screens off it; swap it for a real backend later. Every write surfaces live in Solstice's State inspector.",
			"- Solstice's live preview gives you app tooling: a phone/tablet/desktop device switcher, a 'מסכים' screens-flow map (reads your hash routes / data-route screens), and a 'State' inspector (live localStorage). Use hash routes (#/screen) and localStorage so these light up.",
		].join("\n");
	}

	// ---- PWA app-shell scaffold --------------------------------------------
	// App mode's tangible distinctiveness: generate a REAL, runnable multi-screen
	// PWA app shell (no build step — plain HTML/CSS/JS so it runs straight in the
	// phone-frame preview) instead of a one-page marketing site. The build agent
	// then fleshes out each screen. Files are written only if absent so we never
	// clobber the user's work.
	appShellFiles() {
		const manifest = JSON.stringify({
			name: "Solstice App", short_name: "App", start_url: "./index.html",
			display: "standalone", background_color: "#0f0f12", theme_color: "#f59e0b",
			icons: [{ src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }],
		}, null, 2);
		const icon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><rect width="512" height="512" rx="112" fill="#0f0f12"/><circle cx="256" cy="256" r="120" fill="none" stroke="#f59e0b" stroke-width="28"/><circle cx="256" cy="256" r="44" fill="#f59e0b"/></svg>\n`;
		const indexHtml = `<!doctype html>
<html lang="he" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="theme-color" content="#f59e0b" />
<link rel="manifest" href="manifest.webmanifest" />
<link rel="icon" href="icon.svg" />
<link rel="stylesheet" href="app.css" />
<title>Solstice App</title>
</head>
<body>
  <div class="appbar"><button class="appbar-back" id="back" hidden>‹</button><h1 id="title">בית</h1></div>
  <main id="screen" class="screen"></main>
  <nav class="tabbar">
    <a href="#/" class="tab" data-route="/"><span class="tab-ico">⌂</span><span>בית</span></a>
    <a href="#/explore" class="tab" data-route="/explore"><span class="tab-ico">⌕</span><span>גלה</span></a>
    <a href="#/profile" class="tab" data-route="/profile"><span class="tab-ico">◑</span><span>פרופיל</span></a>
  </nav>
  <script src="data.js"></script>
  <script src="app.js"></script>
</body>
</html>
`;
		const appCss = `:root{ --bg:#0f0f12; --surface:#1a1a1f; --line:#2a2a31; --fg:#ececf0; --muted:#9a9aa4; --accent:#f59e0b; --accent2:#fb7a3c; }
*{ box-sizing:border-box; -webkit-tap-highlight-color:transparent; }
html,body{ margin:0; height:100%; background:var(--bg); color:var(--fg); font-family:system-ui,-apple-system,"Segoe UI",sans-serif; }
body{ display:flex; flex-direction:column; min-height:100vh; }
.appbar{ position:sticky; top:0; z-index:5; display:flex; align-items:center; gap:8px; padding:max(12px,env(safe-area-inset-top)) 16px 12px; background:linear-gradient(180deg,rgba(245,158,11,.12),transparent), var(--bg); border-bottom:1px solid var(--line); }
.appbar h1{ font-size:19px; font-weight:700; margin:0; letter-spacing:-.3px; }
.appbar-back{ appearance:none; border:none; background:transparent; color:var(--accent); font-size:26px; line-height:1; padding:0 4px; cursor:pointer; }
.screen{ flex:1; padding:18px 16px 96px; overflow-y:auto; animation:screen-in .28s cubic-bezier(.2,.7,.3,1); }
@keyframes screen-in{ from{ opacity:0; transform:translateY(10px); } }
.card{ background:var(--surface); border:1px solid var(--line); border-radius:16px; padding:16px; margin-bottom:14px; }
.hero{ background:linear-gradient(150deg,var(--accent2),var(--accent)); color:#1a1206; border:none; }
.hero h2{ margin:0 0 4px; font-size:22px; } .hero p{ margin:0; opacity:.85; font-size:13px; }
.btn{ appearance:none; border:none; border-radius:12px; padding:13px 16px; font-size:15px; font-weight:600; width:100%; cursor:pointer; background:linear-gradient(150deg,var(--accent2),var(--accent)); color:#1a1206; }
.btn.ghost{ background:var(--surface); color:var(--fg); border:1px solid var(--line); }
.row{ display:flex; align-items:center; gap:12px; padding:13px 0; border-bottom:1px solid var(--line); }
.row:last-child{ border-bottom:none; }
.row .ico{ width:40px; height:40px; border-radius:11px; display:grid; place-items:center; background:rgba(245,158,11,.14); color:var(--accent); font-size:18px; flex:none; }
.row .meta{ flex:1; min-width:0; } .row .meta b{ display:block; font-size:14px; } .row .meta small{ color:var(--muted); font-size:12px; }
.muted{ color:var(--muted); font-size:13px; line-height:1.6; }
.count{ font-size:44px; font-weight:800; letter-spacing:-1px; text-align:center; margin:8px 0; }
.tabbar{ position:fixed; bottom:0; left:0; right:0; z-index:6; display:flex; background:rgba(20,20,24,.92); backdrop-filter:blur(12px); border-top:1px solid var(--line); padding-bottom:env(safe-area-inset-bottom); }
.tab{ flex:1; display:flex; flex-direction:column; align-items:center; gap:3px; padding:9px 0 11px; text-decoration:none; color:var(--muted); font-size:10.5px; font-weight:600; }
.tab-ico{ font-size:20px; line-height:1; }
.tab.active{ color:var(--accent); }
`;
		const appJs = `"use strict";
// Tiny hash router + 3 screens. No build step, no deps — runs straight in the
// Solstice phone-frame preview. The build agent fills these screens out.
(function(){
  const screenEl = document.getElementById("screen");
  const titleEl = document.getElementById("title");
  const backEl = document.getElementById("back");
  const tabs = [...document.querySelectorAll(".tab")];
  const store = { get k(){ return Number(localStorage.getItem("count")||0); }, set k(v){ localStorage.setItem("count", v); } };

  const screens = {
    "/": { title: "בית", render(){ return \`
      <section class="card hero"><h2>ברוך הבא 👋</h2><p>שלד אפליקציה — ריבוי מסכים, ניווט תחתון, מותקנת.</p></section>
      <section class="card"><div class="muted">מונה דמו ששומר ב-localStorage:</div><div class="count" id="cnt">\${store.k}</div>
        <button class="btn" id="inc">הוסף +1</button></section>
      <section class="card"><div class="row"><div class="ico">⚡</div><div class="meta"><b>מהיר</b><small>נטען מיידית, עובד אופליין</small></div></div>
        <div class="row"><div class="ico">📲</div><div class="meta"><b>מותקנת</b><small>הוסף למסך הבית כאפליקציה</small></div></div></section>\`; },
      after(){ const c=document.getElementById("cnt"); document.getElementById("inc").onclick=()=>{ store.k=store.k+1; c.textContent=store.k; }; } },
    "/explore": { title: "גלה", render(){
      var items = (window.DB ? DB.all() : []);
      var rows = items.map(function(it){ return \`<div class="row" data-id="\${it.id}">
        <div class="ico" style="\${it.done?'background:rgba(52,211,153,.16);color:#34d399':''}">\${it.done?'✓':'○'}</div>
        <div class="meta"><b>\${it.title}</b><small>\${it.note||''}</small></div></div>\`; }).join("");
      return \`<section class="card"><div class="muted">רשימה חיה משכבת ה-data (\${items.length} פריטים, נשמרים ב-localStorage):</div></section>
      <section class="card" id="list">\${rows || '<div class="muted">אין פריטים</div>'}</section>
      <section class="card"><button class="btn" id="add">הוסף פריט +</button>
        <button class="btn ghost" id="reset" style="margin-top:10px">אפס נתונים</button></section>\`; },
      after(){
        var list = document.getElementById("list");
        list.querySelectorAll(".row").forEach(function(r){ r.onclick=function(){ DB.toggle(r.dataset.id); route(); }; });
        document.getElementById("add").onclick=function(){ DB.add({ title:"פריט חדש", note:"נוצר עכשיו", done:false }); route(); };
        document.getElementById("reset").onclick=function(){ DB.reset(); route(); };
      } },
    "/profile": { title: "פרופיל", render(){ return \`
      <section class="card"><div class="row"><div class="ico">🙂</div><div class="meta"><b>המשתמש שלך</b><small>guest@solstice.app</small></div></div></section>
      <section class="card"><button class="btn ghost" id="reset">אפס מונה</button></section>\`; },
      after(){ document.getElementById("reset").onclick=()=>{ store.k=0; location.hash="#/"; }; } },
  };

  function route(){
    const path = (location.hash.replace(/^#/, "") || "/");
    const s = screens[path] || screens["/"];
    titleEl.textContent = s.title;
    screenEl.innerHTML = s.render();
    if (s.after) s.after();
    backEl.hidden = path === "/";
    tabs.forEach(t => t.classList.toggle("active", t.dataset.route === path));
    screenEl.scrollTop = 0;
  }
  backEl.onclick = () => history.length > 1 ? history.back() : (location.hash = "#/");
  window.addEventListener("hashchange", route);
  route();

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(()=>{});
})();
`;
		const dataJs = `"use strict";
// Mock data layer — the app-vs-site distinction made tangible. A real app needs
// DATA and CRUD; a marketing site doesn't. Seed records + a tiny store persisted
// to localStorage, with a clean API the build agent swaps for a real backend
// (fetch/Supabase/Firebase) later. Lists/detail screens read from window.DB, and
// every write shows up live in Solstice's State inspector.
(function () {
  const KEY = "app.items";
  const SEED = [
    { id: 1, title: "להתחיל פרויקט", note: "מסך ראשון של האפליקציה", done: false },
    { id: 2, title: "לעצב מסכים", note: "ניווט תחתון + מעבר חלק", done: false },
    { id: 3, title: "לחבר נתונים", note: "שכבת data עם שמירה מקומית", done: true },
  ];
  function load() { try { const v = JSON.parse(localStorage.getItem(KEY)); return Array.isArray(v) ? v : SEED.slice(); } catch (e) { return SEED.slice(); } }
  function save(items) { try { localStorage.setItem(KEY, JSON.stringify(items)); } catch (e) {} }
  window.DB = {
    all() { return load(); },
    get(id) { return load().find((x) => String(x.id) === String(id)); },
    add(item) { const items = load(); item.id = Date.now(); items.unshift(item); save(items); return item; },
    update(id, patch) { save(load().map((x) => String(x.id) === String(id) ? Object.assign({}, x, patch) : x)); },
    toggle(id) { save(load().map((x) => String(x.id) === String(id) ? Object.assign({}, x, { done: !x.done }) : x)); },
    remove(id) { save(load().filter((x) => String(x.id) !== String(id))); },
    reset() { try { localStorage.removeItem(KEY); } catch (e) {} },
  };
})();
`;
		const swJs = `// Minimal offline-first service worker for the app shell.
const CACHE = "solstice-app-v1";
const ASSETS = ["./", "index.html", "app.css", "app.js", "data.js", "manifest.webmanifest", "icon.svg"];
self.addEventListener("install", (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())); });
self.addEventListener("activate", (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", (e) => {
  if (e.request.method !== "GET") return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
    const copy = res.clone(); caches.open(CACHE).then((c) => c.put(e.request, copy)); return res;
  }).catch(() => caches.match("index.html"))));
});
`;
		return {
			"index.html": indexHtml,
			"app.css": appCss,
			"app.js": appJs,
			"data.js": dataJs,
			"sw.js": swJs,
			"manifest.webmanifest": manifest,
			"icon.svg": icon,
		};
	}

	// Write the app-shell scaffold into `root`, never clobbering existing files.
	// Returns { written:[...], skipped:[...] }.
	scaffoldAppShell(root) {
		const files = this.appShellFiles();
		const written = [], skipped = [];
		for (const [rel, content] of Object.entries(files)) {
			const abs = path.join(root, rel);
			if (fs.existsSync(abs)) { skipped.push(rel); continue; }
			try { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content, "utf8"); written.push(rel); }
			catch { skipped.push(rel); }
		}
		return { written, skipped };
	}

	// Generate the app shell into the open workspace, switch to App mode, and open
	// the phone-frame preview so the user immediately sees a runnable app.
	async scaffoldAppIntoWorkspace() {
		const root = workspaceCwd();
		if (!root) { vscode.window.showWarningMessage("פתח תיקייה כדי ליצור שלד אפליקציה."); return; }
		const { written, skipped } = this.scaffoldAppShell(root);
		this.setBuildMode("app");
		if (written.length) {
			this.post({ type: "systemNote", text: "📱 נוצר שלד אפליקציה (PWA): " + written.join(", ") + (skipped.length ? " · דילגתי על קיימים: " + skipped.join(", ") : "") });
			vscode.window.showInformationMessage("שלד אפליקציה נוצר — " + written.length + " קבצים. פותח תצוגה…");
			setTimeout(() => this.openPreview("").catch(() => { }), 400);
		} else {
			vscode.window.showInformationMessage("כל קבצי שלד האפליקציה כבר קיימים — לא נכתב כלום.");
		}
		return { written, skipped };
	}

	async openPreview(explicitUrl) {
		let url = explicitUrl || "";
		if (!url) {
			const root = workspaceCwd();
			if (!root) { vscode.window.showWarningMessage("Open a folder to preview."); return; }
			// Prefer a live dev server (Vite/Next/CRA the agent started) — a bundled
			// app can't run as flat files. Fall back to the static server only for
			// plain-HTML projects.
			url = await detectDevServerUrl(root).catch(() => null);
			if (!url) {
				if (!this.preview) this.preview = new PreviewServer(root, {
					onSelect: (pick) => this.post({ type: "elementSelected", pick }),
				});
				const port = await this.preview.ensure();
				let rel = "index.html";
				if (!fs.existsSync(path.join(root, rel))) {
					const found = await vscode.workspace.findFiles("**/*.html", "**/node_modules/**", 1);
					if (found.length) rel = vscode.workspace.asRelativePath(found[0]);
				}
				url = `http://127.0.0.1:${port}/${rel}`;
			}
		}
		this.previewUrl = url;
		this.previewKind = this.detectPreviewKind();
		this.openPreviewPanel(url, this.defaultDevice());
		this.fleetFlow("preview", { url });
	}

	// First previewable file → auto-open the center preview (regression fix: this
	// used to fire only on plain .html). For framework projects we poll briefly
	// for the agent's dev server and open the moment it's reachable; for plain
	// HTML we open the static server right away.
	ensurePreviewSoon() {
		if (this.previewUrl || this._previewWatch) return;
		const root = workspaceCwd();
		if (!root) return;
		const framework = hasFramework(root);
		let elapsed = 0;
		const STEP = 2500, MAX = 60000;
		const tick = async () => {
			if (this.previewUrl) { this.stopPreviewWatch(); return; }
			const dev = await detectDevServerUrl(root).catch(() => null);
			if (dev) { this.stopPreviewWatch(); await this.openPreview(dev).catch(() => { }); return; }
			// no dev server yet: plain-HTML projects can open the static server
			// immediately; framework projects wait (a static serve would render a
			// broken, un-bundled page).
			if (!framework) { this.stopPreviewWatch(); await this.openPreview("").catch(() => { }); return; }
			elapsed += STEP;
			if (elapsed >= MAX) this.stopPreviewWatch();
		};
		this._previewWatch = setInterval(tick, STEP);
		tick();
	}

	stopPreviewWatch() {
		if (this._previewWatch) { clearInterval(this._previewWatch); this._previewWatch = null; }
	}

	// Create/reveal the device-frame preview webview in the center column and
	// point it at the live URL.
	openPreviewPanel(url, device) {
		if (!this.previewPanel) {
			this.previewPanel = vscode.window.createWebviewPanel(
				"solstice.preview",
				"🔎 Live Preview",
				{ viewColumn: vscode.ViewColumn.Two, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
				}
			);
			this.previewPanel.webview.html = previewHtml(this.previewPanel.webview, this.context.extensionUri);
			this.previewReady = false;
			this.previewPanel.webview.onDidReceiveMessage((m) => {
				if (m.type === "ready") {
					this.previewReady = true;
					if (this.previewUrl) this.postPreview({ type: "load", url: this.previewUrl, device: this.defaultDevice() });
				} else if (m.type === "device") {
					this.previewKind = (m.device === "desktop") ? "site" : "app";
				} else if (m.type === "openExternal" && m.url) {
					vscode.env.openExternal(vscode.Uri.parse(m.url)).then(undefined, () => { });
				}
			});
			this.previewPanel.onDidDispose(() => { this.previewPanel = null; this.previewReady = false; });
		} else {
			this.previewPanel.reveal(vscode.ViewColumn.Two, true);
		}
		if (this.previewReady) this.postPreview({ type: "load", url, device });
	}

	postPreview(msg) {
		if (this.previewPanel) this.previewPanel.webview.postMessage(msg);
	}

	refreshPreview() {
		if (!this.previewUrl || !this.previewPanel) return;
		// pulse the "building" shimmer + reload the iframe so the agent's edits
		// stream into the frame like an image rendering in.
		this.postPreview({ type: "reload", holdMs: 900 });
	}

	writePlanFile(th) {
		const root = workspaceCwd();
		if (!root || !th || !Array.isArray(th.plan) || !th.plan.length) return;
		const dir = path.join(root, ".solstice");
		try { fs.mkdirSync(dir, { recursive: true }); } catch { return; }
		const marks = { completed: "[x]", inProgress: "[~]", pending: "[ ]" };
		const lines = th.plan.map((s, i) =>
			`${i + 1}. ${marks[s.status] || "[ ]"} ${s.step}${s.status === "inProgress" ? "   ← current" : ""}`);
		const title = (th.preview || "").split("\n")[0].slice(0, 80);
		const text = `# Agent Plan\n\n${title ? "_" + title + "_\n\n" : ""}${lines.join("\n")}\n`;
		if (text === this.lastPlanFileText) return;
		this.lastPlanFileText = text;
		const file = path.join(dir, "PLAN.md");
		try { fs.writeFileSync(file, text); } catch { return; }
		// PLAN.md stays on disk as an artifact, but we no longer open it as raw
		// markdown — the visual plan webview (openPlanPanel) owns the center view.
	}

	onFilesChanged(item) {
		const root = workspaceCwd();
		const paths = (item.changes || []).map((c) => c.path || c.file).filter(Boolean);
		// research/plan docs have dedicated views — never open their raw editors over them
		const skip = /(^|[\\/])(RESEARCH|DECONSTRUCT)\.md$|[\\/]\.solstice[\\/]/;
		for (const p of paths.filter((p) => !skip.test(p)).slice(0, 3)) {
			const abs = path.isAbsolute(p) ? p : path.join(root || "", p);
			let stat;
			try { stat = fs.statSync(abs); } catch { continue; }
			if (!stat.isFile() || stat.size > 1500000) continue;
			vscode.window.showTextDocument(vscode.Uri.file(abs), {
				viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
			}).then(undefined, () => { });
		}
		// first previewable file the agent writes → auto-open the live preview
		// (html for static sites; jsx/tsx/vue/svelte/astro for bundled apps)
		if (!this.previewUrl && paths.some((p) => /\.(html?|jsx?|tsx?|vue|svelte|astro)$/i.test(p))) {
			this.ensurePreviewSoon();
			return;
		}
		this.refreshPreview();
	}

	// resolve an image item's saved location to an absolute path on disk
	imageAbsPath(item) {
		const p = item && (item.savedPath || item.path);
		if (!p) return null;
		if (path.isAbsolute(p)) return p;
		const root = workspaceCwd();
		return root ? path.join(root, p) : p;
	}

	// attach a webview-loadable URI to an image item so the panel can render it inline
	withImageUri(item, webview) {
		const abs = this.imageAbsPath(item);
		if (!abs || !webview) return item;
		try { if (!fs.existsSync(abs)) return item; } catch { return item; }
		return {
			...item,
			absPath: abs,
			webUri: webview.asWebviewUri(vscode.Uri.file(abs)).toString(),
		};
	}

	// open a generated image in the center editor (image preview), like PLAN.md
	openImage(p) {
		const abs = p && (path.isAbsolute(p) ? p : path.join(workspaceCwd() || "", p));
		if (!abs) return;
		try { if (!fs.statSync(abs).isFile()) return; } catch { return; }
		vscode.commands.executeCommand("vscode.open", vscode.Uri.file(abs), {
			viewColumn: vscode.ViewColumn.One, preview: true, preserveFocus: true,
		}).then(undefined, () => { });
	}

	// Voice dictation: webview records mic audio → Groq Whisper → text back into the composer.
	// Same engine as the fleet's Telegram dictation (whisper-large-v3, Hebrew-first).
	async transcribeVoice(b64, mime) {
		try {
			const key = String(this.cfg().get("groqApiKey") || process.env.GROQ_API_KEY || "").trim();
			if (!key) {
				this.post({ type: "transcribeError", message: "Voice needs a Groq key — set solstice.codex.groqApiKey (or GROQ_API_KEY)." });
				return;
			}
			const bytes = Buffer.from(String(b64 || ""), "base64");
			if (!bytes.length) { this.post({ type: "transcribeError", message: "empty recording" }); return; }
			const ext = mime && mime.includes("ogg") ? "ogg" : "webm";
			const lang = String(this.cfg().get("dictationLanguage") || "he").trim() || "he";
			const form = new FormData();
			form.append("file", new Blob([bytes], { type: mime || "audio/webm" }), "voice." + ext);
			form.append("model", "whisper-large-v3");
			if (lang && lang !== "auto") form.append("language", lang);
			const res = await fetch("https://api.groq.com/openai/v1/audio/transcriptions", {
				method: "POST",
				headers: { Authorization: "Bearer " + key },
				body: form,
			});
			if (!res.ok) {
				const t = await res.text().catch(() => "");
				this.post({ type: "transcribeError", message: "Groq " + res.status + " " + t.slice(0, 200) });
				return;
			}
			const data = await res.json();
			this.post({ type: "transcribed", text: String((data && data.text) || "").trim() });
		} catch (e) {
			this.post({ type: "transcribeError", message: String((e && e.message) || e) });
		}
	}

	// spawn (or reveal) an integrated terminal in the workspace root — opens in the
	// bottom panel by default; the user can drag it anywhere (editor area / sides)
	openTerminal() {
		const cwd = workspaceCwd();
		let term = this.terminal;
		if (!term || term.exitStatus !== undefined) {
			term = vscode.window.createTerminal({
				name: "Solstice", cwd, iconPath: new vscode.ThemeIcon("flame"),
				location: vscode.TerminalLocation.Panel,
			});
			this.terminal = term;
		}
		term.show(false);
		return term;
	}

	cfg() {
		return vscode.workspace.getConfiguration("solstice.codex");
	}

	// Per-window settings (model, autonomy) are stored at Workspace scope when a
	// folder is open, so each Solstice window can run a different model on its own
	// project in parallel. With no workspace open we fall back to Global.
	cfgTarget() {
		return vscode.workspace.workspaceFolders
			? vscode.ConfigurationTarget.Workspace
			: vscode.ConfigurationTarget.Global;
	}

	claudeAllowed() {
		return this.cfg().get("allowClaude") === true;
	}

	autonomyLevel() {
		// Legacy approvalPolicy="never" means "never prompt" → full autonomy.
		if (this.cfg().get("approvalPolicy") === "never") return "autonomous";
		const lvl = this.cfg().get("autonomy") || "supervised";
		return ["supervised", "auto-edit", "autonomous"].includes(lvl) ? lvl : "supervised";
	}

	// Decide whether an approval request can be auto-accepted without prompting,
	// based on the autonomy level and the action category derived from the method.
	shouldAutoApprove(method, elicitation) {
		const level = this.autonomyLevel();
		if (level === "autonomous") return true;
		if (level === "auto-edit") {
			// auto-edit trusts file writes/reads; still asks for shell commands and
			// external/MCP tool calls (the riskier, side-effecting categories).
			const isEdit = /fileChange/.test(method) || method === "applyPatchApproval";
			return isEdit && !elicitation;
		}
		return false; // supervised: ask for everything
	}

	providerKey() {
		const k = this.cfg().get("provider") || "composer-2.5";
		// Claude is gated: never run it unless explicitly opted in. A stale
		// provider="claude" setting falls back to the safe default instead.
		if (k === "claude" && !this.claudeAllowed()) return "gpt-5.5";
		return k;
	}

	designElevationOn() {
		return this.cfg().get("designElevation") === true;
	}

	// Premium design playbook — only injected when Design Elevation is ON (optional layer).
	designPlaybook() {
		if (!this.designElevationOn()) return "";
		try {
			return fs.readFileSync(path.join(this.context.extensionPath, "prompts", "design-playbook.md"), "utf8");
		} catch { return ""; }
	}

	async toggleDesignElevation() {
		const on = !this.designElevationOn();
		await this.cfg().update("designElevation", on, vscode.ConfigurationTarget.Global);
		vscode.window.showInformationMessage(
			on
				? "Solstice Design Elevation: ON — premium design playbook will guide the next build."
				: "Solstice Design Elevation: OFF — plain build (no design playbook)."
		);
	}

	providerLabel() {
		const k = this.providerKey();
		if (k === "claude") return CLAUDE_LABEL;
		return k === "gpt-5.5" ? "gpt-5.5" : (GROK_MODELS[k] ? GROK_MODELS[k].label : k);
	}

	// Single source of truth for the model list — shared by the command-palette
	// quick-pick and the inline picker rendered at the bottom of the chat panel.
	modelChoices() {
		const items = [
			{ key: "gpt-5.5", label: "GPT-5.5 (Codex)", description: "ChatGPT subscription — full agent: plans, approvals, image gen" },
			{ key: "grok-build", label: "Grok 4.3 Build", description: "grok CLI — agentic fallback when Codex quota runs out" },
			{ key: "composer-2.5", label: "Composer 2.5 Fast", description: "grok CLI — fast builder" },
		];
		// Claude only appears as a choice when explicitly opted in.
		if (this.claudeAllowed()) {
			items.splice(1, 0, { key: "claude", label: "Claude Code", description: "claude CLI — opt-in via solstice.codex.allowClaude" });
		}
		return items;
	}

	async selectModel() {
		const cur = this.providerKey();
		const items = this.modelChoices().map((it) => (it.key === cur ? { ...it, label: "$(check) " + it.label } : it));
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "Solstice agent model" });
		if (!pick) return;
		await this.cfg().update("provider", pick.key, this.cfgTarget());
		this.applyProviderToWebviews();
	}

	// Inline picker (bottom of chat panel) → set the model directly, no quick-pick.
	async setModel(key) {
		if (!key || !this.modelChoices().some((it) => it.key === key)) return;
		await this.cfg().update("provider", key, this.cfgTarget());
		this.applyProviderToWebviews();
	}

	async selectAutonomy() {
		const cur = this.autonomyLevel();
		const items = [
			{ key: "supervised", label: "Supervised", description: "Ask before every edit, command, and tool call" },
			{ key: "auto-edit", label: "Auto-edit", description: "Apply edits automatically — ask before shell commands & tools" },
			{ key: "autonomous", label: "Autonomous", description: "I trust the agent — approve everything, never interrupt" },
		];
		items.forEach((it, i) => { if (it.key === cur) items[i] = { ...it, label: "$(check) " + it.label }; });
		const pick = await vscode.window.showQuickPick(items, { placeHolder: "Solstice agent autonomy" });
		if (!pick) return;
		// Clear the legacy "never" escape hatch so the autonomy setting is authoritative.
		if (this.cfg().get("approvalPolicy") === "never" && pick.key !== "autonomous") {
			await this.cfg().update("approvalPolicy", "on-request", this.cfgTarget());
		}
		await this.cfg().update("autonomy", pick.key, this.cfgTarget());
		this.applyAutonomyToWebviews();
	}

	applyAutonomyToWebviews() {
		const msg = { type: "autonomy", level: this.autonomyLevel() };
		this.post(msg);
		this.postManager(msg);
	}

	applyProviderToWebviews() {
		const mt = { type: "thread", model: this.providerLabel() };
		this.post(mt);
		this.postManager(mt);
		const models = { type: "models", list: this.modelChoices(), current: this.providerKey() };
		this.post(models);
		this.postManager(models);
		if (this.providerKey() !== "gpt-5.5") {
			const auth = { type: "auth", authMethod: this.providerKey() === "claude" ? "claude-cli" : "grok-cli" };
			this.post(auth);
			this.postManager(auth);
		} else {
			this.refreshAccount().catch(() => { });
			this.refreshAccount("manager").catch(() => { });
		}
	}

	suggestFallback() {
		if (this.fallbackPrompted) return;
		this.fallbackPrompted = true;
		const choices = ["Grok 4.3 Build", "Composer 2.5 Fast", "Stay"];
		if (this.claudeAllowed()) choices.unshift("Claude Code");
		vscode.window.showWarningMessage(
			"Codex (GPT-5.5) hit its usage limit. Switch the Solstice agent to a fallback model?",
			...choices
		).then(async (pick) => {
			const key = pick === "Claude Code" ? "claude" : pick === "Grok 4.3 Build" ? "grok-build" : pick === "Composer 2.5 Fast" ? "composer-2.5" : null;
			if (!key) return;
			await this.cfg().update("provider", key, this.cfgTarget());
			this.applyProviderToWebviews();
		});
	}

	startGrokWatcher() {
		if (this.grokWatcher) return;
		this.grokChanged = new Set();
		const track = (uri) => {
			const p = uri.fsPath;
			// grok has no plan tool — it maintains .solstice/PLAN.md per the preamble;
			// bridge it into turn/plan/updated so the panel shows a live checklist
			if (/[\\/]\.solstice[\\/]PLAN\.md$/.test(p)) { this.emitGrokPlan(p); return; }
			if (/[\\/](node_modules|\.git|\.solstice|\.next|dist)([\\/]|$)/.test(p)) return;
			this.grokChanged.add(p);
		};
		const w = vscode.workspace.createFileSystemWatcher("**/*");
		w.onDidCreate(track);
		w.onDidChange(track);
		this.grokWatcher = w;
	}

	emitGrokPlan(file) {
		let text;
		try { text = fs.readFileSync(file, "utf8"); } catch { return; }
		if (text === this.lastPlanFileText) return;
		this.lastPlanFileText = text;
		const plan = this.parseRichPlan(text);
		if (plan.length) {
			this.onNotification("turn/plan/updated", { threadId: this.grok ? this.grok.threadId : undefined, plan });
		}
	}

	// Parse .solstice/PLAN.md into a rich, hierarchical plan model the panel can
	// render as a visual timeline. Supports:
	//   ## Group heading            -> groups steps into phases
	//   1. [~] Step  ← current      -> top-level step (numbered or bulleted)
	//       - [ ] sub-step          -> nested checklist under the previous step
	//       _italic detail line_    -> short description attached to a step
	// Falls back gracefully to a flat list when none of that structure exists.
	parseRichPlan(text) {
		const STEP_RE = /^(\s*)(?:\d+\.|[-*])\s*\[( |x|X|~)\]\s*(.+)$/;
		const HEAD_RE = /^\s*#{1,4}\s+(.+?)\s*#*$/;
		const status = (c) => (/x/i.test(c) ? "completed" : c === "~" ? "inProgress" : "pending");
		const clean = (s) => s.replace(/\s*←\s*current\s*$/i, "").replace(/`/g, "").trim();
		const plan = [];
		let group = "";
		let last = null;        // last top-level step (to attach sub-steps/detail)
		let baseIndent = null;  // indent width of top-level steps
		for (const raw of String(text || "").split("\n")) {
			const h = raw.match(HEAD_RE);
			if (h && !STEP_RE.test(raw)) { group = clean(h[1]); continue; }
			const m = raw.match(STEP_RE);
			if (m) {
				const indent = m[1].replace(/\t/g, "    ").length;
				if (baseIndent === null) baseIndent = indent;
				const item = { status: status(m[2]), step: clean(m[3]) };
				if (indent > baseIndent && last) {
					(last.substeps || (last.substeps = [])).push(item);
				} else {
					if (group) item.group = group;
					plan.push(item);
					last = item;
				}
				continue;
			}
			// italic/quote line right after a step becomes its detail
			const d = raw.match(/^\s*[_>]\s*(.+?)_?\s*$/);
			if (d && last && !last.detail) last.detail = clean(d[1]);
		}
		return plan;
	}

	flushGrokChanges() {
		const changed = this.grokChanged ? [...this.grokChanged] : [];
		this.grokChanged = new Set();
		if (!changed.length) return;
		const item = {
			id: "gfc" + Date.now().toString(36),
			type: "fileChange",
			changes: changed.map((p) => ({ path: p })),
		};
		this.onNotification("item/completed", { threadId: this.grok ? this.grok.threadId : undefined, item });
	}

	grokPreamble() {
		const browseJs = path.join(this.context.extensionPath, "tools", "browse.js");
		const node = process.execPath;
		const shot = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const dom = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" dom <url>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" dom <url>`;
		const playbook = this.designPlaybook();
		return [
			"You are the Solstice IDE agent. Work directly on files in this workspace.",
			"Capabilities beyond your normal tools (run these as shell commands):",
			`- Screenshot any website: ${shot}`,
			`- Read any website's rendered HTML: ${dom}`,
			`- Sample frames from a video on any page (case-study scroll videos, domain-locked Vimeo embeds): ${shot.replace(" shot <url> <out.png>", ' videoframes <url> <outPrefix> [frames] [referrer]')}`,
			"- You cannot view images yourself. To study a screenshot or any image, subcontract vision to codex:",
			'  codex exec --skip-git-repo-check -i <image.png> "Describe this design in exhaustive detail: layout, every section top-to-bottom, colors (hex if possible), typography, imagery style, spacing, mood."',
			"  Always do this for every reference screenshot before designing, and for your own verification screenshots before declaring done.",
			"- Generate images by subcontracting to codex (it has an image generation tool):",
			'  codex exec --skip-git-repo-check --full-auto "Use your image generation tool to create: <detailed description>. Then copy the EXACT file you just generated (by its precise filename from ~/.codex/generated_images/ — never the most recent file, other jobs may write there concurrently) into <workspace>/public/images/<descriptive-name>.png"',
			"  Verify the file exists in the workspace afterwards, and view it with codex vision to confirm it shows the right subject before using it.",
			"- For multi-step builds, write a structured plan to .solstice/PLAN.md and keep it updated live — the IDE renders it as a visual timeline. Use this shape: group steps under `## Phase name` headings; each step is `1. [ ] Step title`; add an optional one-line `_short detail_` under a step; nest concrete sub-tasks as indented `   - [ ] sub-task`. Mark progress as you go: `[x]` done, `[~]` current, `[ ]` pending. Keep titles short and outcome-oriented.",
			"- When deconstructing / analyzing / researching a design, website, or app: maintain DECONSTRUCT.md (or RESEARCH.md) in the workspace root and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end. The IDE renders this file live to the user as a research dashboard. Include as you go: what you examined so far, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, techniques you detected (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed the frames/screenshots you examine as images with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			this.appModeGuidance(),
			playbook ? "\n" + playbook : "",
		].join("\n");
	}

	claudePreamble() {
		const browseJs = path.join(this.context.extensionPath, "tools", "browse.js");
		const node = process.execPath;
		const shot = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const dom = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" dom <url>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" dom <url>`;
		const playbook = this.designPlaybook();
		return [
			"You are the Solstice IDE agent. Work directly on files in this workspace.",
			"Capabilities beyond your normal tools (run these as shell commands):",
			`- Screenshot any website: ${shot}`,
			`- Read any website's rendered HTML: ${dom}`,
			`- Sample frames from a video on any page (case-study scroll videos, domain-locked Vimeo embeds): ${shot.replace(" shot <url> <out.png>", ' videoframes <url> <outPrefix> [frames] [referrer]')}`,
			"- You CAN view images: open any screenshot/reference image with your Read tool and study it in exhaustive detail (layout, sections, colors with hex, typography, imagery style, spacing, mood). Always do this for every reference screenshot before designing, and for your own verification screenshots before declaring done.",
			"- Generate images by subcontracting to codex (it has an image generation tool):",
			'  codex exec --skip-git-repo-check --full-auto "Use your image generation tool to create: <detailed description>. Then copy the EXACT file you just generated (by its precise filename from ~/.codex/generated_images/ — never the most recent file, other jobs may write there concurrently) into <workspace>/public/images/<descriptive-name>.png"',
			"  Verify the file exists in the workspace afterwards, and view it with your Read tool to confirm it shows the right subject before using it.",
			"- For multi-step builds, use your todo/plan tool and keep step statuses updated as you work — the IDE renders it as a live checklist.",
			"- When deconstructing / analyzing / researching a design, website, or app: maintain DECONSTRUCT.md (or RESEARCH.md) in the workspace root and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end. The IDE renders this file live to the user as a research dashboard. Include as you go: what you examined so far, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, techniques you detected (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed the frames/screenshots you examine as images with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			this.appModeGuidance(),
			playbook ? "\n" + playbook : "",
		].join("\n");
	}

	async sendClaude(text) {
		if (!this.claudeAllowed()) {
			vscode.window.showWarningMessage("Solstice: Claude is disabled. Set solstice.codex.allowClaude to true to enable it.");
			return;
		}
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		if (!this.claude) {
			this.claude = new ClaudeProvider({
				cwd,
				bin: this.cfg().get("claudePath") || undefined,
				permissionMode: this.cfg().get("claudePermissionMode") || undefined,
				log: (s) => this.output.append(s),
				notify: (m, p) => this.onNotification(m, p),
			});
			this.threadId = this.claude.threadId;
			const th = this.upsertThread({ id: this.threadId });
			th.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		await this.claude.send(text, this.claudePreamble());
	}

	async sendGrok(text) {
		const cwd = workspaceCwd();
		if (!cwd) { vscode.window.showWarningMessage("Solstice: open a folder first."); return; }
		if (!this.grok) {
			this.grok = new GrokProvider({
				cwd,
				log: (s) => this.output.append(s),
				notify: (m, p) => this.onNotification(m, p),
			});
			this.threadId = this.grok.threadId;
			const th = this.upsertThread({ id: this.threadId });
			th.preview = text;
			this.post({ type: "thread", threadId: this.threadId, model: this.providerLabel() });
		}
		this.startGrokWatcher();
		await this.grok.send(this.providerKey(), text, this.grokPreamble());
		this.flushGrokChanges();
	}

	post(msg) {
		if (this.webview) this.webview.postMessage(msg);
	}

	postManager(msg) {
		if (this.manager) this.manager.postMessage(msg);
	}

	upsertThread(t) {
		if (!t || !t.id) return null;
		const cur = this.threads.get(t.id) || { id: t.id, status: "idle", activeTurnId: null, plan: null, diff: "" };
		if (t.preview !== undefined) cur.preview = t.preview;
		if (t.updatedAt !== undefined) cur.updatedAt = t.updatedAt;
		if (t.status && t.status.type) cur.status = t.status.type;
		this.threads.set(t.id, cur);
		return cur;
	}

	threadList() {
		return [...this.threads.values()].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
	}

	pushThreads() {
		this.postManager({ type: "threads", threads: this.threadList() });
	}

	async ensureClient() {
		if (this.client && this.client.running) return this.client;
		const binPath = resolveCodexBinary(this.context.extensionPath, this.cfg().get("path"));
		this.client = new CodexClient({
			binPath,
			codexHome: this.cfg().get("home") || undefined,
			log: (s) => this.output.append(s),
			onExit: (code) => {
				this.threadId = null;
				this.loaded.clear();
				this.post({ type: "status", connected: false, detail: `codex exited (${code})` });
				this.postManager({ type: "status", connected: false, detail: `codex exited (${code})` });
			},
			onNotification: (method, params) => this.onNotification(method, params),
			onServerRequest: (method, params) => this.handleServerRequest(method, params),
		});
		try {
			this.client.start();
			let clientVersion = "0.0.0";
			try { clientVersion = (this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version) || clientVersion; } catch { }
			await this.client.request("initialize", {
				clientInfo: { name: "solstice", title: "Solstice", version: clientVersion },
				capabilities: null,
			});
			this.client.notify("initialized", {});
		} catch (e) {
			this.client = null;
			throw new Error(`Could not start codex app-server (${binPath}): ${e.message}`);
		}
		return this.client;
	}

	onNotification(method, params) {
		const tid = params && params.threadId;
		// ---- liveness pulses: classify every notification as a progress signal.
		// Streaming deltas + tool/file events = real output (strong); plain state
		// changes = weak. Lets livenessInfo() tell "really working" from "fake busy".
		if (typeof method === "string") {
			if (/delta|textDelta|outputDelta/i.test(method)) this.notePulse("_builder", "stream");
			else if (method === "item/completed" && params && params.item &&
				(params.item.type === "fileChange" || params.item.type === "commandExecution" || params.item.type === "mcpToolCall")) this.notePulse("_builder", "tool");
		}
		// keep the thread registry live
		if (method === "thread/started" && params.thread) {
			this.upsertThread(params.thread);
			this.loaded.add(params.thread.id);
			this.pushThreads();
		} else if (method === "thread/status/changed" && tid) {
			const th = this.upsertThread({ id: tid });
			th.status = (params.status && params.status.type) || "idle";
			this.pushThreads();
		} else if (method === "thread/name/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			if (params.name) th.preview = params.name;
			this.pushThreads();
		} else if (method === "turn/started" && tid) {
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = params.turn && params.turn.id;
			th.status = "active";
			th.updatedAt = Date.now() / 1000;
			this.planFileOpened = false;
			if (tid === this.threadId) { this.markBusy("_builder", true); this.notePulse("_builder", "state"); this.postPreview({ type: "building", on: true }); this.fleetFlow("building"); }
			this.pushThreads();
		} else if (method === "turn/completed" && tid) {
			const th = this.upsertThread({ id: tid });
			th.activeTurnId = null;
			th.status = "idle";
			if (tid === this.threadId) { this.markBusy("_builder", false); this.postPreview({ type: "building", on: false }); this.fleetFlow("done"); }
			this.pushThreads();
			if (tid === this.threadId) this.drainSteerQueue();
		} else if (method === "turn/diff/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.diff = params.diff || "";
			if (tid === this.threadId) this.lastDiff = th.diff;
		} else if (method === "turn/plan/updated" && tid) {
			const th = this.upsertThread({ id: tid });
			th.plan = params.plan || null;
			this.writePlanFile(th);
			this.pushPlanPanel(th);
		}
		if (method === "usage" && params && params.total) {
			this.recordTokenUsage(params);
		}
		if (method === "item/completed" && params.item && params.item.type === "fileChange") {
			this.onFilesChanged(params.item);
		}
		const isImageItem = method === "item/completed" && params.item &&
			(params.item.type === "imageGeneration" || params.item.type === "imageView") &&
			params.item.status !== "failed";
		if (isImageItem) this.openImage(this.imageAbsPath(params.item));
		if (method === "error" && params && params.error &&
			/usage limit|rate limit/i.test(params.error.message || "") && this.providerKey() === "gpt-5.5") {
			this.suggestFallback();
		}
		if (SIDEBAR_FORWARDED.has(method) && (!tid || tid === this.threadId)) {
			const p = isImageItem ? { ...params, item: this.withImageUri(params.item, this.webview) } : params;
			this.post({ type: "notification", method, params: p });
		}
		if (MANAGER_FORWARDED.has(method)) {
			const p = isImageItem ? { ...params, item: this.withImageUri(params.item, this.manager) } : params;
			this.postManager({ type: "notification", method, params: p });
		}
	}

	handleServerRequest(method, params) {
		const elicitation = method === "mcpServer/elicitation/request";
		// any */requestApproval (commandExecution/fileChange/permissions/…) or MCP elicitation
		if (!APPROVAL_METHODS.has(method) && !elicitation && !/\/requestApproval$/.test(method)) {
			throw new Error(`unsupported server request: ${method}`);
		}
		// three response vocabularies: legacy {decision: approved|denied},
		// item/*/requestApproval {decision: accept|decline},
		// MCP elicitation {action: accept|decline}
		const legacy = method === "execCommandApproval" || method === "applyPatchApproval";
		const map = legacy
			? { accept: "approved", acceptForSession: "approved_for_session", decline: "denied" }
			: { accept: "accept", acceptForSession: "acceptForSession", decline: "decline" };
		const toResult = (decision) => elicitation
			? { action: decision === "decline" ? "decline" : "accept" }
			: { decision: map[decision] || map.decline };
		// Autonomy gate: depending on the selected autonomy level (and the legacy
		// approvalPolicy "never" escape hatch) some action categories are
		// auto-approved without interrupting the user.
		if (this.shouldAutoApprove(method, elicitation)) {
			return Promise.resolve(toResult("accept"));
		}
		return new Promise((resolve) => {
			const key = crypto.randomUUID();
			this.pendingApprovals.set(key, resolve);
			const tid = params && params.threadId;
			if (!tid || tid === this.threadId) this.post({ type: "approvalRequest", key, method, params });
			this.postManager({ type: "approvalRequest", key, method, params });
			// headless E2E hook (xvfb, no pointer): approve after the card rendered
			if (process.env.SOLSTICE_AGENT_DEV_AUTOAPPROVE) {
				setTimeout(() => this.resolveApproval(key, "accept"), 8000);
			}
		}).then(toResult);
	}

	resolveApproval(key, decision) {
		const resolve = this.pendingApprovals.get(key);
		if (resolve) {
			this.pendingApprovals.delete(key);
			resolve(decision);
		}
	}

	async refreshAccount(target) {
		if (this.providerKey() !== "gpt-5.5") {
			// grok/claude CLI auth lives in the CLI itself — no codex login flow needed
			const method = this.providerKey() === "claude" ? "claude-cli" : "grok-cli";
			const msg = { type: "auth", authMethod: method };
			const mt = { type: "thread", model: this.providerLabel() };
			if (target === "manager") { this.postManager(msg); this.postManager(mt); }
			else { this.post(msg); this.post(mt); }
			return { authMethod: method };
		}
		const client = await this.ensureClient();
		const auth = await client.request("getAuthStatus", {});
		const msg = { type: "auth", authMethod: auth.authMethod };
		if (target === "manager") this.postManager(msg); else this.post(msg);
		if (auth.authMethod) {
			client.request("account/rateLimits/read", undefined)
				.then((r) => {
					const n = { type: "notification", method: "account/rateLimits/updated", params: r };
					this.post(n);
					this.postManager(n);
				})
				.catch(() => { });
		}
		return auth;
	}

	async login() {
		const client = await this.ensureClient();
		const res = await client.request("account/login/start", { type: "chatgpt" });
		if (res.authUrl) {
			this.post({ type: "loginPending" });
			this.postManager({ type: "loginPending" });
			vscode.env.openExternal(vscode.Uri.parse(res.authUrl));
			const onDone = (method) => {
				if (method === "account/login/completed" || method === "account/updated") {
					this.refreshAccount().catch(() => { });
					this.refreshAccount("manager").catch(() => { });
				}
			};
			// account/login/completed isn't in the forwarded set; hook the raw stream once
			const prev = client.opts.onNotification;
			client.opts.onNotification = (method, params) => {
				onDone(method);
				prev(method, params);
			};
		}
	}

	developerInstructions() {
		const browseJs = path.join(this.context.extensionPath, "tools", "browse.js");
		const node = process.execPath;
		const run = process.platform === "win32"
			? `cmd /c "set ELECTRON_RUN_AS_NODE=1&& ""${node}"" ""${browseJs}"" shot <url> <out.png>"`
			: `ELECTRON_RUN_AS_NODE=1 "${node}" "${browseJs}" shot <url> <out.png>`;
		const playbook = this.designPlaybook();
		return [
			"You are the Solstice IDE agent. Capabilities beyond your normal tools:",
			`- Web browsing: take a screenshot of any website with: ${run}`,
			"  (replace mode 'shot' with 'dom' to dump the rendered HTML to stdout, or with 'videoframes <url> <outPrefix> [frames] [referrer]' to sample frames from a video on the page — e.g. case-study scroll videos in domain-locked Vimeo embeds).",
			"  After taking a screenshot, ALWAYS open it with your view_image tool to study layout, colors, typography and content. Use this whenever the user asks to inspect, analyze or imitate a website or design (e.g. Behance/Dribbble references).",
			"- Image generation: you can generate images; afterwards copy the generated file from your image output directory into the workspace with a proper name and reference it from the site.",
			"- For any multi-step build task, first create a plan with your plan tool and keep step statuses updated as you work.",
			"- When deconstructing / analyzing / researching a design, website, or app: maintain DECONSTRUCT.md (or RESEARCH.md) in the workspace root and UPDATE IT INCREMENTALLY after EVERY finding — never only at the end. The IDE renders this file live to the user as a research dashboard. Include as you go: what you examined so far, frame/screen classification tables, color tokens (hex), typography, section-by-section breakdown, techniques you detected (stack, animation libraries, layout tricks), and your build decisions. Use markdown tables and checklists. Embed the frames/screenshots you examine as images with workspace-relative paths (e.g. ![frame 2](.solstice/frames/frame02.png)) — the dashboard renders them as thumbnails, including inside table cells.",
			"- Prefer modern stacks when asked (Next.js, three.js, react-three-fiber); install dependencies as needed.",
			this.appModeGuidance(),
			playbook ? "\n" + playbook : "",
		].join("\n");
	}

	async startThread() {
		const client = await this.ensureClient();
		const th = await client.request("thread/start", {
			cwd: workspaceCwd(),
			model: this.cfg().get("model") || undefined,
			approvalPolicy: this.cfg().get("approvalPolicy"),
			sandbox: this.cfg().get("sandbox"),
			developerInstructions: this.developerInstructions(),
		});
		const id = th.thread && th.thread.id;
		if (id) {
			this.loaded.add(id);
			this.upsertThread(th.thread);
			this.pushThreads();
		}
		return { id, model: th.model };
	}

	async ensureRunnable(threadId) {
		const client = await this.ensureClient();
		if (!this.loaded.has(threadId)) {
			await client.request("thread/resume", {
				threadId,
				approvalPolicy: this.cfg().get("approvalPolicy"),
				sandbox: this.cfg().get("sandbox"),
			});
			this.loaded.add(threadId);
		}
	}

	async startTurn(threadId, text) {
		const client = await this.ensureClient();
		await this.ensureRunnable(threadId);
		const th = this.upsertThread({ id: threadId });
		if (!th.preview) {
			th.preview = text;
			this.pushThreads();
		}
		await client.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	// sidebar send: lazily creates the sidebar thread
	async send(text) {
		const provider = this.providerKey();
		// A spawned-CLI turn (grok/claude) is already running: never let send()
		// reject ("a turn is already running") and silently drop the prompt —
		// route it to the steer queue so it drains into the next turn.
		if (provider !== "gpt-5.5") {
			const prov = provider === "claude" ? this.claude : this.grok;
			if (prov && prov.busy) return this.steer(this.threadId, text);
		}
		if (provider === "claude") return this.sendClaude(text);
		if (provider !== "gpt-5.5") return this.sendGrok(text);
		if (!this.threadId) {
			const { id, model } = await this.startThread();
			this.threadId = id;
			this.lastDiff = "";
			this.post({ type: "thread", threadId: this.threadId, model });
		}
		await this.startTurn(this.threadId, text);
	}

	async steer(threadId, text) {
		const provider = this.providerKey();
		// grok / claude run as spawned CLIs with no native mid-turn injection.
		// While they're busy, queue the steer and drain it into a follow-up turn
		// the moment the current turn completes (re-prioritised next).
		if (provider !== "gpt-5.5") {
			const prov = provider === "claude" ? this.claude : this.grok;
			if (prov && prov.busy) {
				this.steerQueue.push(text);
				const r = this.liveRec("_builder"); r.queued = this.steerQueue.length;
				this.post({ type: "steerQueued", count: this.steerQueue.length });
				return;
			}
			// not actually busy — treat as a normal message
			await this.send(text);
			return;
		}
		// codex: inject straight into the running turn
		const client = await this.ensureClient();
		const th = this.threads.get(threadId);
		if (!th || !th.activeTurnId) {
			// no active turn — fall back to a normal turn
			await this.startTurn(threadId, text);
			return;
		}
		await client.request("turn/steer", {
			threadId,
			expectedTurnId: th.activeTurnId,
			input: [{ type: "text", text, text_elements: [] }],
		});
	}

	// grok/claude: after a turn finishes, fold any queued steers into one
	// follow-up turn so the agent picks them up as the next priority.
	drainSteerQueue() {
		if (!this.steerQueue.length) return;
		const text = this.steerQueue.join("\n\n");
		this.steerQueue = [];
		const r = this.live.get("_builder"); if (r) r.queued = 0;
		this.post({ type: "steerQueued", count: 0 });
		this.send(text).catch((e) => this.output.append(`\n[steer drain] ${e && e.message || e}\n`));
	}

	async interrupt(threadId) {
		if (this.claude && this.claude.busy && (!threadId || threadId === this.claude.threadId)) {
			this.claude.interrupt();
			return;
		}
		if (this.grok && this.grok.busy && (!threadId || threadId === this.grok.threadId)) {
			this.grok.interrupt();
			return;
		}
		const tid = threadId || this.threadId;
		if (this.client && this.client.running && tid) {
			await this.client.request("turn/interrupt", { threadId: tid }).catch(() => { });
		}
	}

	async listThreads() {
		const client = await this.ensureClient();
		const res = await client.request("thread/list", { cwd: workspaceCwd() }).catch(() => null);
		if (res && Array.isArray(res.data)) {
			for (const t of res.data) this.upsertThread(t);
		}
		this.pushThreads();
	}

	async readThread(threadId) {
		const client = await this.ensureClient();
		const res = await client.request("thread/read", { threadId, includeTurns: true });
		const th = this.threads.get(threadId);
		this.postManager({
			type: "threadHistory",
			thread: res.thread,
			plan: th ? th.plan : null,
			diff: th ? th.diff : "",
			activeTurnId: th ? th.activeTurnId : null,
		});
	}

	async archiveThread(threadId) {
		const client = await this.ensureClient();
		await client.request("thread/archive", { threadId }).catch(() => { });
		this.threads.delete(threadId);
		this.loaded.delete(threadId);
		if (this.threadId === threadId) this.threadId = null;
		this.pushThreads();
	}

	newThread() {
		this.threadId = null;
		this.lastDiff = "";
		// drop the claude session so the next send starts a fresh conversation
		if (this.claude && !this.claude.busy) this.claude = null;
		this.post({ type: "reset" });
	}

	async showDiff(threadId) {
		const th = threadId ? this.threads.get(threadId) : null;
		const diff = (th && th.diff) || this.lastDiff;
		if (!diff) {
			vscode.window.showInformationMessage("Solstice: no diff for the current turn yet.");
			return;
		}
		const doc = await vscode.workspace.openTextDocument({ content: diff, language: "diff" });
		await vscode.window.showTextDocument(doc, { preview: true });
	}

	async signOut() {
		const client = await this.ensureClient();
		await client.request("account/logout", undefined).catch(() => { });
		this.post({ type: "auth", authMethod: null });
		this.postManager({ type: "auth", authMethod: null });
	}

	// ---- live research dashboard (main editor area) ----
	// The agent maintains DECONSTRUCT.md / RESEARCH.md incrementally while it
	// deconstructs a reference; we render it live as a styled dashboard.
	showResearch(uri) {
		const p = uri.fsPath;
		if (/[\\/](node_modules|\.git|\.next|dist)([\\/]|$)/.test(p)) return;
		this.researchFile = p;
		clearTimeout(this.researchDebounce);
		this.researchDebounce = setTimeout(() => this.pushResearch(), 250);
	}

	pushResearch() {
		if (!this.researchFile) return;
		let text;
		try { text = fs.readFileSync(this.researchFile, "utf8"); } catch { return; }
		try { this.openResearchPanel(); } catch (e) { this.output.append("research panel: " + e.message + "\n"); return; }
		this.researchPanel.webview.postMessage({
			type: "doc",
			name: path.basename(this.researchFile),
			text,
			time: Date.now(),
			base: this.researchPanel.webview.asWebviewUri(vscode.Uri.file(path.dirname(this.researchFile))).toString(),
		});
		// keep the dashboard foreground while research findings stream in
		this.researchPanel.reveal(vscode.ViewColumn.One, true);
	}

	openResearchPanel() {
		if (!this.researchPanel) {
			this.researchPanel = vscode.window.createWebviewPanel(
				"solstice.research",
				"🔬 Agent Research",
				{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [
						vscode.Uri.joinPath(this.context.extensionUri, "media"),
						...(workspaceCwd() ? [vscode.Uri.file(workspaceCwd())] : []),
					],
				}
			);
			this.researchPanel.webview.html = mediaHtml(this.researchPanel.webview, this.context.extensionUri, "research.js", "research.css");
			this.researchPanel.webview.onDidReceiveMessage((m) => { if (m.type === "ready") this.pushResearch(); });
			this.researchPanel.onDidDispose(() => { this.researchPanel = null; });
		}
	}

	// ---- center-editor plan view (high-quality visual decomposition) -------
	// When the agent decomposes a build into steps, render them as a graphical
	// timeline in the main editor column — the same rich shape as the side
	// panel, scaled up. Mirrors openResearchPanel.
	openPlanPanel() {
		if (!this.planPanel) {
			this.planPanel = vscode.window.createWebviewPanel(
				"solstice.plan",
				"🗺 Agent Plan",
				{ viewColumn: vscode.ViewColumn.One, preserveFocus: true },
				{
					enableScripts: true,
					retainContextWhenHidden: true,
					localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
				}
			);
			this.planPanel.webview.html = mediaHtml(this.planPanel.webview, this.context.extensionUri, "plan.js", "plan.css");
			this.planPanel.webview.onDidReceiveMessage((m) => { if (m.type === "ready") this.pushPlanPanel(); });
			this.planPanel.onDidDispose(() => { this.planPanel = null; });
		}
	}

	pushPlanPanel(th) {
		th = th || this.planThread;
		if (!th || !Array.isArray(th.plan) || !th.plan.length) return;
		this.planThread = th;
		try { this.openPlanPanel(); } catch (e) { this.output.append("plan panel: " + e.message + "\n"); return; }
		const title = (th.preview || "").split("\n")[0].slice(0, 100);
		this.planPanel.webview.postMessage({ type: "plan", plan: th.plan, title, time: Date.now() });
		this.planPanel.reveal(vscode.ViewColumn.One, true);
	}

	// ---- projects gallery (home view inside Solstice) ----
	// Roots the gallery scans for projects agents built on this server.
	galleryRoots() {
		const home = os.homedir();
		const roots = [];
		const cfg = (this.cfg().get("projectsDir") || "").trim();
		if (cfg) roots.push(cfg);
		// Defaults: deploy targets + the live workspaces agents build into
		// (Jasper/fleet bridge → solstice-bridge-work), so in-progress agent
		// builds show up too — same roots the server gallery scans.
		roots.push(
			path.join(home, "solstice-deploys"),
			path.join(home, "solstice-bridge-work"),
			path.join(home, "solstice-bridge-keep"),
			path.join(home, "Projects"),
		);
		return roots
			.filter((d, i) => roots.indexOf(d) === i)
			.filter((d) => { try { return fs.statSync(d).isDirectory(); } catch { return false; } });
	}

	// Find a representative preview image inside a project (best-effort).
	projectPreview(dir) {
		const candidates = [
			".solstice/preview.png", "public/og.png", "public/og.jpg",
			"public/images/hero.png", "public/images/hero.jpg",
			"public/preview.png", "preview.png", "screenshot.png",
		];
		for (const rel of candidates) {
			const abs = path.join(dir, rel);
			try { if (fs.statSync(abs).isFile()) return abs; } catch { }
		}
		// otherwise: first image under public/images
		const imgDir = path.join(dir, "public", "images");
		try {
			const f = fs.readdirSync(imgDir).find((n) => /\.(png|jpe?g|webp)$/i.test(n));
			if (f) return path.join(imgDir, f);
		} catch { }
		return null;
	}

	detectStack(dir) {
		let pkg = null;
		try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { }
		const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
		const tags = [];
		if (deps.next) tags.push("Next.js");
		else if (deps.vite) tags.push("Vite");
		if (deps.react) tags.push("React");
		if (deps.three || deps["@react-three/fiber"]) tags.push("three.js");
		if (deps.gsap || deps["framer-motion"]) tags.push("Motion");
		if (deps.tailwindcss) tags.push("Tailwind");
		if (!tags.length) {
			try { if (fs.statSync(path.join(dir, "index.html")).isFile()) tags.push("Static"); } catch { }
		}
		return { pkg, tags };
	}

	scanProjects(webview) {
		const out = [];
		const seen = new Set();
		for (const root of this.galleryRoots()) {
			let names;
			try { names = fs.readdirSync(root); } catch { continue; }
			for (const name of names) {
				if (name.startsWith(".") || GALLERY_SKIP_DIRS.has(name)) continue;
				const dir = path.join(root, name);
				if (seen.has(dir)) continue;
				let st;
				try { st = fs.statSync(dir); } catch { continue; }
				if (!st.isDirectory()) continue;
				const isProject = ["package.json", "index.html", ".git", ".solstice"]
					.some((m) => { try { return fs.existsSync(path.join(dir, m)); } catch { return false; } });
				if (!isProject) continue;
				seen.add(dir);
				const { pkg, tags } = this.detectStack(dir);
				const preview = this.projectPreview(dir);
				out.push({
					name: (pkg && pkg.name) || name,
					dir,
					description: (pkg && pkg.description) || "",
					tags,
					updatedAt: st.mtimeMs,
					preview: preview && webview ? webview.asWebviewUri(vscode.Uri.file(preview)).toString() : null,
					agent: this.projectAgent(dir),
				});
			}
		}
		out.sort((a, b) => b.updatedAt - a.updatedAt);
		return out;
	}

	// ---- project ↔ agent ownership (Batch 3) -------------------------------
	projectAgentsKey() { return "solstice.fleet.projectAgents"; }
	loadProjectAgents() {
		try { return this.context.globalState.get(this.projectAgentsKey()) || {}; } catch { return {}; }
	}
	setProjectAgent(dir, agentId) {
		const d = String(dir || ""); if (!d) return;
		const all = this.loadProjectAgents();
		if (agentId) all[d] = String(agentId); else delete all[d];
		try { this.context.globalState.update(this.projectAgentsKey(), all); } catch { }
	}
	// {id,name,glyph} for an assigned agent, or null.
	projectAgent(dir) {
		const id = this.loadProjectAgents()[String(dir || "")];
		if (!id) return null;
		const a = this.fleetAgents().find((x) => x.id === id);
		return a ? { id: a.id, name: a.name, glyph: a.glyph } : { id, name: id, glyph: "◆" };
	}

	openProjectFolder(dir, newWindow) {
		if (!dir) return;
		try { if (!fs.statSync(dir).isDirectory()) return; } catch { return; }
		vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(dir), { forceNewWindow: !!newWindow })
			.then(undefined, () => { });
	}

	// ---- Solstice → Atrium client handoff ----------------------------------
	// Hand a finished Solstice build to a client's Atrium folder, where the rest
	// of that client's deliverables live. Writes a handoff.json manifest always
	// (the durable record) and copies the build when the source is on the same
	// filesystem as the clients dir (IDE + fleet share the disk).
	atriumClientsDir() {
		const cfg = (this.cfg().get("atrium.clientsDir") || "").trim();
		if (cfg) return cfg;
		const guess = path.join(os.homedir(), "Julius-cc-x", "agents", "atrium", "output");
		try { if (fs.statSync(guess).isDirectory()) return guess; } catch { }
		return guess;
	}

	// Existing client folders (skip sector templates `_x` and dotfiles).
	listAtriumClients() {
		const root = this.atriumClientsDir();
		let names;
		try { names = fs.readdirSync(root); } catch { return []; }
		return names.filter((n) => {
			if (n.startsWith(".") || n.startsWith("_")) return false;
			try { return fs.statSync(path.join(root, n)).isDirectory(); } catch { return false; }
		}).sort();
	}

	// Recursive copy that skips heavy / regenerable dirs.
	copyTree(src, dst) {
		const SKIP = new Set(["node_modules", ".next", ".git", "dist", ".turbo", ".cache"]);
		fs.mkdirSync(dst, { recursive: true });
		for (const name of fs.readdirSync(src)) {
			if (SKIP.has(name)) continue;
			const s = path.join(src, name), d = path.join(dst, name);
			let st; try { st = fs.statSync(s); } catch { continue; }
			if (st.isDirectory()) this.copyTree(s, d);
			else { try { fs.copyFileSync(s, d); } catch { } }
		}
	}

	// Is a handed-off project a web app (vs. a marketing site)? Drives the future
	// conditional "אפליקציה" tab on the Atrium client card — only builds where an
	// app was produced advertise kind:"app".
	projectKind(project) {
		const tags = ((project && project.tags) || []).join(" ").toLowerCase();
		if (/\bapp\b|pwa|expo|react-native|אפליקצי/.test(tags)) return "app";
		const dir = project && project.dir;
		if (dir && !(project.remote)) {
			try {
				if (fs.existsSync(path.join(dir, "manifest.webmanifest")) ||
					fs.existsSync(path.join(dir, "public", "manifest.json")) ||
					fs.existsSync(path.join(dir, "public", "manifest.webmanifest"))) return "app";
				const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
				const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
				if (deps.expo || deps["react-native"]) return "app";
			} catch { }
		}
		if (this.buildMode === "app") return "app";
		return "site";
	}

	// Returns { dest, copied, manifest } or throws. Writes the per-build handoff
	// manifest AND maintains a per-client `solstice/builds.json` index — the
	// contract the Atrium client card reads to list builds, deep-link the live
	// URL, and (when kind === "app") light up the app tab.
	handoffToClient(project, client) {
		const name = String((project && (project.name)) || "site").replace(/[^\w.-]+/g, "-");
		const cl = String(client || "").replace(/[^\w.-]+/g, "-");
		if (!cl) throw new Error("no client");
		const clientRoot = path.join(this.atriumClientsDir(), cl, "solstice");
		const dest = path.join(clientRoot, name);
		fs.mkdirSync(dest, { recursive: true });
		let copied = false;
		const srcDir = project && project.dir;
		if (srcDir && !(project.remote)) {
			try { if (fs.statSync(srcDir).isDirectory()) { this.copyTree(srcDir, path.join(dest, "build")); copied = true; } } catch { }
		}
		const kind = this.projectKind(project);
		const slug = name.toLowerCase();
		const manifest = {
			project: name,
			slug,
			client: cl,
			kind,                       // "site" | "app" — drives the Atrium app tab
			source: srcDir || null,
			remote: !!(project && project.remote),
			liveUrl: (project && (project.openUrl || project.liveUrl)) || null,
			thumbnail: (project && project.preview) || null,
			stack: (project && project.tags) || [],
			agent: (project && project.agent && project.agent.id) || null,
			provider: this.providerLabel ? this.providerLabel() : "Composer 2.5",
			copiedBuild: copied,
			handedOffAt: new Date().toISOString(),
		};
		try { fs.writeFileSync(path.join(dest, "handoff.json"), JSON.stringify(manifest, null, 2)); } catch { }
		// merge into the per-client builds index (newest first, dedup by slug)
		try {
			const idxPath = path.join(clientRoot, "builds.json");
			let builds = [];
			try { const v = JSON.parse(fs.readFileSync(idxPath, "utf8")); if (Array.isArray(v)) builds = v; } catch { }
			builds = builds.filter((b) => b && b.slug !== slug);
			builds.unshift({ slug, project: name, kind, liveUrl: manifest.liveUrl, thumbnail: manifest.thumbnail, agent: manifest.agent, handedOffAt: manifest.handedOffAt, path: dest });
			fs.mkdirSync(clientRoot, { recursive: true });
			fs.writeFileSync(idxPath, JSON.stringify(builds, null, 2));
		} catch { }
		return { dest, copied, manifest };
	}

	// Deep-link to a client's card in Atrium, if a base URL is configured. We do
	// NOT guess routes — only open when `solstice.atrium.baseUrl` is set.
	atriumClientUrl(client) {
		const base = (this.cfg().get("atrium.baseUrl") || "").trim().replace(/\/+$/, "");
		if (!base) return null;
		return base + "/clients/" + encodeURIComponent(String(client || "").toLowerCase());
	}

	// ---- Fleet (talk to Orion/Jasper/Asher from inside Solstice) ----
	// Primary transport is a live WebSocket straight to the agent's brain
	// (SolsticeBridgeChannel on the server, reached over Tailscale). Bridges are
	// declared in the `solstice.fleet.bridges` setting; the shared token comes
	// from `solstice.fleet.token` or ~/.solstice/fleet-token. Agents with no
	// bridge fall back to the legacy file-drop inbox (only works when the IDE and
	// the fleet share a filesystem).
	// Human-readable Solstice version for the status bar / Fleet badge. Prefer the
	// running product version (baked at build time from release_version) so the
	// badge tracks the IDE release; fall back to this extension's own version.
	versionLabel() {
		try {
			const pj = JSON.parse(fs.readFileSync(path.join(vscode.env.appRoot, "product.json"), "utf8"));
			if (pj && pj.version) return "v" + pj.version;
		} catch { }
		let ext = "";
		try { ext = (this.context.extension && this.context.extension.packageJSON && this.context.extension.packageJSON.version) || ""; } catch { }
		return ext ? ("v" + ext) : "";
	}
	versionTooltip() {
		const ext = this.versionLabel() || "?";
		let base = "";
		try { base = vscode.version || ""; } catch { }
		return "Solstice " + ext + (base ? ("  ·  base " + base) : "");
	}

	fleetCfg() {
		return vscode.workspace.getConfiguration("solstice.fleet");
	}

	fleetToken() {
		const fromCfg = String(this.fleetCfg().get("token") || "").trim();
		if (fromCfg) return fromCfg;
		try { return fs.readFileSync(path.join(os.homedir(), ".solstice", "fleet-token"), "utf8").trim(); } catch { return ""; }
	}

	// Declared WebSocket bridges, keyed by agent id.
	fleetBridgeConfigs() {
		const raw = this.fleetCfg().get("bridges");
		const list = Array.isArray(raw) ? raw : [];
		const map = new Map();
		for (const b of list) {
			if (b && b.id && b.wsUrl) map.set(String(b.id), b);
		}
		return map;
	}

	fleetDir() {
		const cfg = (this.cfg().get("fleetDir") || "").trim();
		if (cfg) return cfg;
		const guess = path.join(os.homedir(), "Julius-cc-x", "agents");
		try { if (fs.statSync(guess).isDirectory()) return guess; } catch { }
		return guess;
	}

	fleetRepliesDir() {
		return path.join(os.homedir(), ".solstice", "fleet-replies");
	}

	fleetHidden() {
		const raw = this.fleetCfg().get("hidden");
		return new Set(Array.isArray(raw) ? raw.map(String) : []);
	}

	fleetAgents() {
		const roster = [
			{ id: "orion", name: "Orion", role: "CTO · architecture & planning", glyph: "◆", model: "Opus" },
			{ id: "jasper", name: "Jasper", role: "Web production · sites & landing pages", glyph: "❖", model: "GPT-5.5" },
			{ id: "asher", name: "Asher", role: "Systems · CRMs, software, bigger builds", glyph: "▲", model: "Composer 2.5" },
		];
		const bridges = this.fleetBridgeConfigs();
		const base = this.fleetDir();
		// surface every configured agent not already in the static roster — both live
		// bridge agents (with wsUrl) and plain manually-added ones (without).
		const rawList = Array.isArray(this.fleetCfg().get("bridges")) ? this.fleetCfg().get("bridges") : [];
		for (const b of rawList) {
			if (b && b.id && !roster.some((a) => a.id === String(b.id))) {
				roster.push({ id: String(b.id), name: b.name || b.id, role: b.role || "Fleet agent", glyph: b.glyph || "◆", model: b.model || "" });
			}
		}
		const hidden = this.fleetHidden();
		const visible = roster.filter((a) => !hidden.has(a.id));
		for (const a of visible) {
			a.removable = true;
			const b = bridges.get(a.id);
			if (b) {
				a.bridge = true;
				if (b.name) a.name = b.name;
				if (b.role) a.role = b.role;
				if (b.glyph) a.glyph = b.glyph;
				if (b.model) a.model = b.model;
				const st = this.fleetBridges.get(a.id);
				// reflect the real socket state: only a live hello flips us to "online".
				a.status = st ? st.status : "idle";
				a.present = a.status === "online";
			} else {
				a.status = "local";
				a.present = (() => { try { return fs.statSync(path.join(base, a.id)).isDirectory(); } catch { return false; } })();
			}
		}
		return visible;
	}

	// Lazily open (and cache) the WebSocket to one agent's brain. Frames are
	// forwarded to the Fleet webview so the chat renders live.
	ensureFleetBridge(agentId) {
		const id = String(agentId || "");
		const existing = this.fleetBridges.get(id);
		if (existing && existing.ws && existing.ws.connected) return existing.ws;
		if (existing && existing.ws && !existing.ws.connected && existing.status === "connecting") return existing.ws;
		const cfg = this.fleetBridgeConfigs().get(id);
		if (!cfg) return null;
		const token = cfg.token || this.fleetToken();
		const ws = new FleetBridge(cfg.wsUrl, { token, log: (s) => this.output.append("[fleet:" + id + "] " + s) });
		const rec = { ws, status: "connecting" };
		this.fleetBridges.set(id, rec);
		const post = (m) => { if (this.fleetPanel) this.fleetPanel.webview.postMessage(m); };
		const agentName = () => { const a = this.fleetAgents().find((x) => x.id === id); return a ? a.name : id; };
		ws.on("open", () => { rec.status = "connecting"; this.postFleetActivity(id, "connecting", "מתחבר…"); });
		ws.on("frame", (f) => {
			if (f.type === "hello") {
				rec.status = "online";
				post({ type: "roster", agents: this.fleetAgents() });
				this.postFleetActivity(id, "online", "מחובר");
			} else if (f.type === "push") {
				post({ type: "reply", agent: id, text: String(f.text || ""), ts: Date.now(), kind: "progress" });
				this.postFleetActivity(id, "working", String(f.text || "עובד…").split("\n")[0].slice(0, 80));
			} else if (f.type === "reply") {
				const ts = Date.now();
				post({ type: "reply", agent: id, text: String(f.text || ""), ts });
				this.appendFleetThread(id, { who: "them", text: String(f.text || ""), ts });
				this.postFleetActivity(id, "replied", "ענה");
				this.notifyFleetReply(id, agentName(), String(f.text || ""));
			} else if (f.type === "action") {
				// agent-driven IDE action (see runFleetAction); echo to the activity feed too
				this.runFleetAction(id, f).catch(() => { });
			} else if (f.type === "error") {
				post({ type: "fleetError", agent: id, error: String(f.error || "agent error") });
				this.postFleetActivity(id, "error", String(f.error || "שגיאה").slice(0, 80));
			}
		});
		ws.on("error", (e) => {
			rec.status = "offline";
			post({ type: "fleetError", agent: id, error: e.message });
			post({ type: "roster", agents: this.fleetAgents() });
			this.postFleetActivity(id, "offline", "מנותק");
		});
		ws.on("close", () => {
			rec.status = "offline";
			this.fleetBridges.delete(id);
			post({ type: "roster", agents: this.fleetAgents() });
			this.postFleetActivity(id, "offline", "מנותק");
		});
		ws.connect();
		return ws;
	}

	closeFleetBridges() {
		for (const rec of this.fleetBridges.values()) { try { rec.ws.close(); } catch { } }
		this.fleetBridges.clear();
	}

	// ---- live activity feed -------------------------------------------------
	// Broadcast a single activity event to the Fleet webview's activity rail.
	postFleetActivity(agentId, state, text) {
		this.noteWatch(agentId, state);
		if (!this.fleetPanel) return;
		this.fleetPanel.webview.postMessage({ type: "activity", agent: agentId, state, text: String(text || ""), ts: Date.now() });
	}

	// ---- fleet → Solstice handoff pipeline ---------------------------------
	// Drive the visual workflow (You → Agent → Solstice → Preview) in the Fleet
	// webview from REAL lifecycle signals, never timers. Stages:
	//   dispatch  — a fleet agent dropped a build task into the Solstice inbox
	//   building  — the Solstice builder started a turn
	//   preview   — the live preview opened in the center column
	//   done      — the builder turn completed
	// We only emit building/preview/done while a dispatch flow is active, so a
	// plain in-panel turn (no fleet handoff) doesn't fake a pipeline.
	fleetFlow(stage, extra) {
		if (stage === "dispatch") this._flowActive = true;
		else if (!this._flowActive) return;
		// Round-trip the lifecycle back to the dispatching agent (Phase 1).
		// "dispatch" already reports "started" from the build handler, so map
		// building/preview/done here.
		if (stage === "building") this.sendBuildStatus("building");
		else if (stage === "preview") this.sendBuildStatus("preview", { previewUrl: this.previewUrl || (extra && extra.url) || "" });
		else if (stage === "done") this.sendBuildStatus("done", { previewUrl: this.previewUrl || "" });
		if (!this.fleetPanel) {
			if (stage === "done") { this._flowActive = false; this._activeBuild = null; }
			return;
		}
		const from = (extra && extra.from) || this.builderAgent();
		this.fleetPanel.webview.postMessage({ type: "flowStage", stage, from, ts: Date.now(), ...(extra || {}) });
		if (stage === "done") { this._flowActive = false; this._activeBuild = null; }
	}

	// Report a build lifecycle frame back to the agent that dispatched it, over
	// the same fleet bridge WS. No-op for in-panel builds (no _activeBuild).
	sendBuildStatus(phase, extra) {
		const b = this._activeBuild;
		if (!b || !b.agentId || !b.taskId) return;
		const rec = this.fleetBridges.get(b.agentId);
		if (!rec || !rec.ws) return;
		const frame = { type: "build_status", taskId: b.taskId, phase: String(phase || "") };
		const ex = extra || {};
		for (const k of ["previewUrl", "deployUrl", "diffStat", "text", "error"]) {
			if (ex[k]) frame[k] = ex[k];
		}
		try { rec.ws.send(frame); } catch (e) { this.output.append("[build_status] " + (e && e.message || e) + "\n"); }
	}

	// ---- xAI/Grok token meter ----------------------------------------------
	// Surfaces session token usage (real if the CLI reports it, else an
	// estimate) in the status bar + Fleet, so heavy Composer 2.5 builds don't
	// silently drain the xAI plan.
	fmtTokens(n) {
		n = Number(n || 0);
		if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
		if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + "k";
		return String(n);
	}
	recordTokenUsage(params) {
		const t = params.total || {};
		this.tokenTotal = { in: Number(t.in || 0), out: Number(t.out || 0), exact: !!params.exact };
		const total = this.tokenTotal.in + this.tokenTotal.out;
		// real model output = a strong liveness signal
		this.notePulse("_builder", "token", { total });
		const modelLabel = (params.model && params.model.label) || this.providerLabel();
		if (!this.tokenStatus) {
			try { this.tokenStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 999); this.tokenStatus.command = "solstice.agent.openFleet"; } catch { }
		}
		if (this.tokenStatus) {
			this.tokenStatus.text = "$(symbol-numeric) " + this.fmtTokens(total) + " tok";
			this.tokenStatus.tooltip = `${modelLabel} · session ${params.exact ? "" : "≈"}${this.fmtTokens(total)} tokens (in ${this.fmtTokens(this.tokenTotal.in)} / out ${this.fmtTokens(this.tokenTotal.out)})`;
			this.tokenStatus.show();
		}
		if (this.fleetPanel) {
			this.fleetPanel.webview.postMessage({ type: "tokens", inT: this.tokenTotal.in, outT: this.tokenTotal.out, exact: !!params.exact, model: modelLabel });
		}
		// also surface in the chat panel, right next to the model picker
		this.post({ type: "tokens", inT: this.tokenTotal.in, outT: this.tokenTotal.out, exact: !!params.exact, model: modelLabel });
	}

	// ---- desktop notifications ---------------------------------------------
	// Toast when an agent finishes a turn while its thread isn't in the foreground.
	notifyFleetReply(agentId, name, text) {
		const preview = String(text || "").replace(/\s+/g, " ").trim().slice(0, 90);
		vscode.window.showInformationMessage(`${name}: ${preview || "ענה"}`, "פתח Fleet").then((pick) => {
			if (pick && this.fleetPanel) {
				this.fleetPanel.reveal(vscode.ViewColumn.One);
				this.fleetPanel.webview.postMessage({ type: "focusAgent", agent: agentId });
			}
		}, () => { });
	}

	// ---- chat history persistence ------------------------------------------
	fleetThreadsKey() { return "solstice.fleet.threads"; }
	loadFleetThreads() {
		try { return this.context.globalState.get(this.fleetThreadsKey()) || {}; } catch { return {}; }
	}
	appendFleetThread(agentId, msg) {
		const id = String(agentId || ""); if (!id || !msg) return;
		const all = this.loadFleetThreads();
		const list = Array.isArray(all[id]) ? all[id] : [];
		list.push(msg);
		// cap stored history per agent so globalState stays small
		all[id] = list.slice(-200);
		try { this.context.globalState.update(this.fleetThreadsKey(), all); } catch { }
	}
	clearFleetThread(agentId) {
		const id = String(agentId || ""); if (!id) return;
		const all = this.loadFleetThreads();
		delete all[id];
		try { this.context.globalState.update(this.fleetThreadsKey(), all); } catch { }
	}

	// ---- agent-driven IDE actions (Batch 2) --------------------------------
	// An agent brain can push {type:"action", action, ...} frames to actually
	// drive the editor: open/edit files, run a terminal command, dispatch a
	// sub-task to a peer agent, etc. Mutating actions pass through an inline
	// approval gate rendered in the Fleet webview before they run.
	async runFleetAction(agentId, f) {
		const action = String(f && f.action || "").trim().toLowerCase();
		if (!action) return;
		const name = (() => { const a = this.fleetAgents().find((x) => x.id === agentId); return a ? a.name : agentId; })();
		try {
			if (action === "open") {
				const uri = this.resolveWorkspacePath(f.path);
				if (!uri) return this.postFleetActivity(agentId, "error", "נתיב לא חוקי");
				this.postFleetActivity(agentId, "working", "פותח " + this.relPath(uri));
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: true, viewColumn: vscode.ViewColumn.Beside });
				return;
			}
			if (action === "write" || action === "edit") {
				const uri = this.resolveWorkspacePath(f.path);
				if (!uri) return this.postFleetActivity(agentId, "error", "נתיב לא חוקי");
				const rel = this.relPath(uri);
				const ok = await this.requestFleetApproval(agentId, name, "edit", rel, "כתיבה לקובץ " + rel);
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחתה כתיבה ל-" + rel);
				this.postFleetActivity(agentId, "working", "כותב " + rel);
				await this.writeWorkspaceFile(uri, String(f.content || ""));
				const doc = await vscode.workspace.openTextDocument(uri);
				await vscode.window.showTextDocument(doc, { preview: false, viewColumn: vscode.ViewColumn.Beside });
				this.postFleetActivity(agentId, "replied", "עודכן " + rel);
				return;
			}
			if (action === "run" || action === "terminal") {
				const cmd = String(f.command || "").trim();
				if (!cmd) return;
				const ok = await this.requestFleetApproval(agentId, name, "run", cmd, "הרצת פקודה: " + cmd);
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחתה פקודה");
				this.postFleetActivity(agentId, "working", "מריץ: " + cmd.slice(0, 60));
				this.runFleetTerminal(name, cmd, f.cwd);
				return;
			}
			if (action === "dispatch") {
				const to = String(f.to || "").trim();
				const text = String(f.text || "").trim();
				if (!to || !text) return;
				const toName = (() => { const a = this.fleetAgents().find((x) => x.id === to); return a ? a.name : to; })();
				const ok = await this.requestFleetApproval(agentId, name, "dispatch", to, name + " → " + toName + ": " + text.slice(0, 80));
				if (!ok) return this.postFleetActivity(agentId, "idle", "נדחה שיגור ל-" + toName);
				this.postFleetActivity(agentId, "working", "משגר ל-" + toName + ": " + text.slice(0, 50));
				const res = this.sendToFleet(to, text);
				this.appendFleetThread(to, { who: "me", text: "[מ-" + name + "] " + text, ts: Date.now() });
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "reply", agent: to, text: "↳ משימה מ-" + name + ": " + text, ts: Date.now(), kind: "dispatch" });
				if (res.live) this.postFleetActivity(to, "working", "קיבל משימה מ-" + name);
				return;
			}
			if (action === "build" || action === "prompt" || action === "inject") {
				// a fleet agent hands a build task to the IDE's own builder (grok/codex).
				// mirrors the inbox-watcher inject path so WS dispatch == file-drop dispatch:
				// focus panel, light the live flow, and feed the task as a builder prompt.
				const task = String(f.text || f.task || "").trim();
				if (!task) return;
				// Round-trip: remember who dispatched + the taskId so fleetFlow can
				// report lifecycle + the live preview/deploy URL back over the bridge.
				const taskId = String(f.taskId || "").trim();
				this._activeBuild = taskId ? { agentId, taskId } : null;
				await vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
				this.activeFleetAgent = agentId;
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "liveTask", from: agentId, task });
				this.fleetFlow("dispatch", { from: agentId, task });
				this.sendBuildStatus("started", { text: task.slice(0, 120) });
				this.postFleetActivity(agentId, "working", "משגר בנייה ל-Solstice: " + task.slice(0, 50));
				const text = `\u{1f4e5} \u05de\u05e9\u05d9\u05de\u05d4 \u05de-${name} (\u05e6\u05d9 \u05d4\u05e1\u05d5\u05db\u05e0\u05d9\u05dd):\n\n${task}`;
				// show the exact prompt the agent is writing into the Solstice builder
				if (this.fleetPanel) this.fleetPanel.webview.postMessage({ type: "flowGuidance", from: agentId, prompt: text });
				setTimeout(() => this.post({ type: "injectPrompt", text }), 1200);
				return;
			}
			// unknown action — just echo it
			this.postFleetActivity(agentId, "working", "פעולה ב-IDE: " + action);
		} catch (e) {
			this.postFleetActivity(agentId, "error", String(e && e.message || e).slice(0, 80));
		}
	}

	// Resolve an agent-supplied path to a Uri inside the workspace; reject escapes.
	resolveWorkspacePath(p) {
		const raw = String(p || "").trim();
		if (!raw) return null;
		const roots = vscode.workspace.workspaceFolders || [];
		if (!roots.length) return null;
		const root = roots[0].uri.fsPath;
		const abs = path.isAbsolute(raw) ? raw : path.join(root, raw);
		const norm = path.normalize(abs);
		if (norm !== root && !norm.startsWith(root + path.sep)) return null;
		return vscode.Uri.file(norm);
	}
	relPath(uri) {
		try { return vscode.workspace.asRelativePath(uri, false); } catch { return uri.fsPath; }
	}
	async writeWorkspaceFile(uri, content) {
		const dir = vscode.Uri.file(path.dirname(uri.fsPath));
		try { await vscode.workspace.fs.createDirectory(dir); } catch { }
		await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
	}
	runFleetTerminal(name, cmd, cwd) {
		const key = "Fleet · " + name;
		let term = (vscode.window.terminals || []).find((t) => t.name === key);
		if (!term) {
			const opts = { name: key };
			const roots = vscode.workspace.workspaceFolders || [];
			if (cwd) opts.cwd = cwd; else if (roots.length) opts.cwd = roots[0].uri.fsPath;
			term = vscode.window.createTerminal(opts);
		}
		term.show(true);
		term.sendText(cmd, true);
	}

	// ---- inline approval gate ----------------------------------------------
	// Posts an approval card to the Fleet webview and resolves when the user
	// clicks אשר/דחה. Falls back to auto-approve only if no panel is open.
	requestFleetApproval(agentId, name, kind, detail, label) {
		if (!this.fleetApprovals) this.fleetApprovals = new Map();
		if (!this.fleetPanel) return Promise.resolve(true);
		const key = "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
		return new Promise((resolve) => {
			let done = false;
			const finish = (v) => { if (done) return; done = true; this.fleetApprovals.delete(key); resolve(v); };
			this.fleetApprovals.set(key, finish);
			this.fleetPanel.webview.postMessage({ type: "approval", key, agent: agentId, name, kind, detail: String(detail || ""), label: String(label || ""), ts: Date.now() });
			// safety timeout: auto-deny after 2 min so an agent never hangs forever
			setTimeout(() => finish(false), 120000);
		});
	}
	resolveFleetApproval(key, decision) {
		if (!this.fleetApprovals) return;
		const fn = this.fleetApprovals.get(String(key || ""));
		if (fn) fn(decision === "approve" || decision === true);
	}

	// ---- editor context → agent --------------------------------------------
	// Grab the active editor's file + selection and feed it to an agent as a
	// context-tagged message, so the agent "sees" what the user is looking at.
	sendEditorContext(agentId) {
		const ed = vscode.window.activeTextEditor;
		if (!ed) return { ok: false, error: "אין עורך פעיל" };
		const rel = this.relPath(ed.document.uri);
		const sel = ed.selection;
		const hasSel = sel && !sel.isEmpty;
		const body = hasSel ? ed.document.getText(sel) : ed.document.getText();
		const range = hasSel ? ` (שורות ${sel.start.line + 1}-${sel.end.line + 1})` : "";
		const lang = ed.document.languageId || "";
		const clipped = body.length > 6000 ? body.slice(0, 6000) + "\n… (קוצר)" : body;
		const text = `קונטקסט מהעורך — ${rel}${range}:\n\`\`\`${lang}\n${clipped}\n\`\`\``;
		const res = this.sendToFleet(agentId, text);
		if (res.ok) {
			this.appendFleetThread(agentId, { who: "me", text: "📎 " + rel + range, ts: Date.now() });
			this.postFleetActivity(agentId, "working", "קיבל קונטקסט: " + rel);
		}
		return { ok: res.ok, error: res.error, rel, range };
	}

	// Manually add an agent to the Fleet roster. A wsUrl makes it a live bridge
	// agent; without one it is a plain (file-drop) roster entry.
	async addFleetAgent(agent) {
		const id = String((agent && agent.id) || "").trim().toLowerCase().replace(/[^a-z0-9_-]/g, "");
		if (!id) return { ok: false, error: "missing id" };
		const entry = {
			id,
			name: String(agent.name || id).trim(),
			role: String(agent.role || "Fleet agent").trim(),
			glyph: String(agent.glyph || "◆").trim().slice(0, 2) || "◆",
			model: String(agent.model || "").trim(),
		};
		const wsUrl = String(agent.wsUrl || "").trim();
		if (wsUrl) entry.wsUrl = wsUrl;
		if (agent.token) entry.token = String(agent.token).trim();
		const cfg = this.fleetCfg();
		const list = Array.isArray(cfg.get("bridges")) ? cfg.get("bridges").slice() : [];
		const i = list.findIndex((b) => b && String(b.id) === id);
		// bridges config only stores live-socket agents; file-drop agents need a wsUrl-less marker too
		if (i >= 0) list[i] = entry; else list.push(entry);
		await cfg.update("bridges", list, vscode.ConfigurationTarget.Global);
		// un-hide if it was previously removed
		const hidden = (Array.isArray(cfg.get("hidden")) ? cfg.get("hidden") : []).filter((h) => String(h) !== id);
		await cfg.update("hidden", hidden, vscode.ConfigurationTarget.Global);
		return { ok: true, id };
	}

	async removeFleetAgent(agentId) {
		const id = String(agentId || "").trim();
		if (!id) return { ok: false, error: "missing id" };
		const cfg = this.fleetCfg();
		const list = (Array.isArray(cfg.get("bridges")) ? cfg.get("bridges") : []).filter((b) => b && String(b.id) !== id);
		await cfg.update("bridges", list, vscode.ConfigurationTarget.Global);
		// built-in agents have no bridge entry; record them as hidden so they drop off the roster
		const hidden = new Set((Array.isArray(cfg.get("hidden")) ? cfg.get("hidden") : []).map(String));
		hidden.add(id);
		await cfg.update("hidden", Array.from(hidden), vscode.ConfigurationTarget.Global);
		const rec = this.fleetBridges.get(id);
		if (rec) { try { rec.ws.close(); } catch { } this.fleetBridges.delete(id); }
		return { ok: true, id };
	}

	sendToFleet(agentId, text) {
		const id = String(agentId || "").trim();
		const body = String(text || "").trim();
		if (!id || !body) return { ok: false, error: "empty" };

		// Preferred path: live WebSocket to the agent's brain.
		if (this.fleetBridgeConfigs().has(id)) {
			const ws = this.ensureFleetBridge(id);
			if (!ws) return { ok: false, error: "bridge not configured" };
			const reqId = "s" + Date.now().toString(36);
			const sendNow = () => ws.send({ type: "message", id: reqId, text: body });
			try {
				if (ws.connected) sendNow();
				else ws.once("frame", (f) => { if (f.type === "hello") { try { sendNow(); } catch { } } });
			} catch (e) { return { ok: false, error: e.message }; }
			return { ok: true, ts: Date.now(), live: true };
		}

		// Fallback: legacy file-drop inbox (same-filesystem only).
		const inbox = path.join(this.fleetDir(), id, "inbox");
		try { fs.mkdirSync(inbox, { recursive: true }); } catch (e) { return { ok: false, error: e.message }; }
		const now = new Date();
		const stamp = now.toISOString().replace(/[:.]/g, "-");
		const job = {
			from: "solstice-ide",
			kind: "task",
			task_id: "solstice-" + Date.now().toString(36),
			title: body.split("\n")[0].slice(0, 80),
			body,
			created_at: now.toISOString(),
		};
		const file = path.join(inbox, stamp + "_solstice.json");
		try { fs.writeFileSync(file, JSON.stringify(job, null, 2)); } catch (e) { return { ok: false, error: e.message }; }
		return { ok: true, ts: now.getTime() };
	}

	// drain new reply files for an agent (file-drop fallback only); each is {agent, text, ts}
	scanFleetReplies(agentId) {
		const dir = path.join(this.fleetRepliesDir(), agentId);
		const done = path.join(dir, "seen");
		const out = [];
		let files;
		try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort(); } catch { return out; }
		try { fs.mkdirSync(done, { recursive: true }); } catch { }
		for (const f of files) {
			const p = path.join(dir, f);
			let msg;
			try { msg = JSON.parse(fs.readFileSync(p, "utf8")); } catch { continue; }
			out.push({ text: String(msg.text || msg.body || ""), ts: msg.ts || Date.now() });
			try { fs.renameSync(p, path.join(done, Date.now() + "-" + f)); } catch { }
		}
		return out;
	}

	dispose() {
		for (const resolve of this.pendingApprovals.values()) resolve("abort");
		this.pendingApprovals.clear();
		clearTimeout(this.researchDebounce);
		if (this.researchPanel) this.researchPanel.dispose();
		if (this.galleryPanel) this.galleryPanel.dispose();
		if (this.preview) this.preview.dispose();
		if (this.grokWatcher) this.grokWatcher.dispose();
		if (this.grok) this.grok.interrupt();
		if (this.claude) this.claude.interrupt();
		if (this.client) this.client.stop();
		this.closeFleetBridges();
	}
}

// Preview panel HTML. Unlike mediaHtml, its CSP must allow an <iframe> to load
// the local preview server / dev server (http://127.0.0.1:*), so the agent's
// site/app renders live inside the device frame.
function previewHtml(webview, extensionUri) {
	const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
	const nonce = crypto.randomUUID().replace(/-/g, "");
	const frameSrc = "http://127.0.0.1:* http://localhost:* https:";
	return `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:; frame-src ${frameSrc};">
<link rel="stylesheet" href="${media("preview.css")}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("preview.js")}"></script>
</body>
</html>`;
}

function mediaHtml(webview, extensionUri, scriptFile, styleFile) {
	const media = (f) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", f));
	const nonce = crypto.randomUUID().replace(/-/g, "");
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}'; font-src ${webview.cspSource}; img-src ${webview.cspSource} https: data:;">
<link rel="stylesheet" href="${media(styleFile)}">
</head>
<body>
<div id="app"></div>
<script nonce="${nonce}" src="${media("md.js")}"></script>
<script nonce="${nonce}" src="${media(scriptFile)}"></script>
</body>
</html>`;
}

class AgentViewProvider {
	constructor(controller, extensionUri) {
		this.controller = controller;
		this.extensionUri = extensionUri;
	}

	resolveWebviewView(view) {
		this.controller.webview = view.webview;
		view.webview.options = {
			enableScripts: true,
			localResourceRoots: webviewResourceRoots(this.extensionUri),
		};
		view.webview.html = mediaHtml(view.webview, this.extensionUri, "panel.js", "panel.css");
		view.webview.onDidReceiveMessage(async (msg) => {
			try {
				switch (msg.type) {
					case "ready":
						await this.controller.refreshAccount();
						this.controller.applyAutonomyToWebviews();
						this.controller.applyProviderToWebviews();
						break;
					case "send": await this.controller.send(msg.text); break;
						case "steer": await this.controller.steer(this.controller.threadId, msg.text); break;
					case "login": await this.controller.login(); break;
					case "approval": this.controller.resolveApproval(msg.key, msg.decision); break;
					case "interrupt": await this.controller.interrupt(); break;
					case "newThread": this.controller.newThread(); break;
					case "showDiff": await this.controller.showDiff(); break;
					case "selectModel": await this.controller.selectModel(); break;
					case "setModel": await this.controller.setModel(msg.key); break;
					case "selectAutonomy": await this.controller.selectAutonomy(); break;
					case "openImage": this.controller.openImage(msg.path); break;
					case "transcribe": await this.controller.transcribeVoice(msg.audio, msg.mime); break;
						case "buildMode": this.controller.setBuildMode(msg.mode); break;
						case "scaffoldApp": await this.controller.scaffoldAppIntoWorkspace(); break;
				}
			} catch (e) {
				this.controller.post({ type: "fatal", message: String(e && e.message || e) });
			}
		});
		view.onDidDispose(() => {
			if (this.controller.webview === view.webview) this.controller.webview = null;
		});
	}
}

let managerPanel = null;

function openManager(controller, extensionUri) {
	if (managerPanel) {
		managerPanel.reveal();
		return;
	}
	managerPanel = vscode.window.createWebviewPanel(
		"solstice.agentManager",
		"Agent Manager",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: webviewResourceRoots(extensionUri),
		}
	);
	controller.manager = managerPanel.webview;
	managerPanel.webview.html = mediaHtml(managerPanel.webview, extensionUri, "manager.js", "manager.css");
	managerPanel.webview.onDidReceiveMessage(async (msg) => {
		try {
			switch (msg.type) {
				case "ready":
					await controller.refreshAccount("manager");
					await controller.listThreads();
					break;
				case "listThreads": await controller.listThreads(); break;
				case "selectThread": await controller.readThread(msg.threadId); break;
				case "newThread": {
					const { id } = await controller.startThread();
					if (id) controller.postManager({ type: "threadCreated", threadId: id });
					break;
				}
				case "send": await controller.startTurn(msg.threadId, msg.text); break;
				case "steer": await controller.steer(msg.threadId, msg.text); break;
				case "interrupt": await controller.interrupt(msg.threadId); break;
				case "approval": controller.resolveApproval(msg.key, msg.decision); break;
				case "openDiff": await controller.showDiff(msg.threadId); break;
				case "openPreview": await controller.openPreview(""); break;
				case "archiveThread": await controller.archiveThread(msg.threadId); break;
				case "setModel": await controller.setModel(msg.key); break;
				case "selectModel": await controller.selectModel(); break;
				case "login": await controller.login(); break;
			}
		} catch (e) {
			controller.postManager({ type: "fatal", message: String(e && e.message || e) });
		}
	});
	managerPanel.onDidDispose(() => {
		if (controller.manager === managerPanel.webview) controller.manager = null;
		managerPanel = null;
	});
}

let galleryPanel = null;

// Fetch a URL with the host's Node http(s) stack (webview CSP blocks remote
// fetch/img, so listing + previews are pulled here and handed to the webview).
function httpGet(url, { binary = false, timeout = 8000 } = {}) {
	return new Promise((resolve, reject) => {
		let mod;
		try { mod = require(url.startsWith("https:") ? "https" : "http"); } catch (e) { reject(e); return; }
		const req = mod.get(url, (res) => {
			if (res.statusCode && res.statusCode >= 400) { res.resume(); reject(new Error("HTTP " + res.statusCode)); return; }
			const chunks = [];
			res.on("data", (c) => chunks.push(c));
			res.on("end", () => {
				const buf = Buffer.concat(chunks);
				resolve(binary ? { buf, contentType: res.headers["content-type"] || "" } : buf.toString("utf8"));
			});
		});
		req.on("error", reject);
		req.setTimeout(timeout, () => req.destroy(new Error("timeout")));
	});
}

// Pull the project list from the remote gallery server and inline each preview
// as a data URI so the webview can render it under its strict CSP.
async function fetchServerProjects(serverUrl) {
	const base = serverUrl.replace(/\/+$/, "");
	const list = JSON.parse(await httpGet(`${base}/api/projects`));
	if (!Array.isArray(list)) return [];
	const out = [];
	for (const p of list) {
		let preview = null;
		if (p.hasPreview) {
			try {
				const { buf, contentType } = await httpGet(`${base}/preview/${encodeURIComponent(p.slug)}`, { binary: true });
				if (buf.length <= 4 * 1024 * 1024) preview = `data:${contentType || "image/png"};base64,${buf.toString("base64")}`;
			} catch { /* preview optional */ }
		}
		out.push({
			name: p.name, description: p.description || "", tags: p.tags || [],
			updatedAt: p.updatedAt, preview, remote: true, slug: p.slug,
			openUrl: `${base}/p/${encodeURIComponent(p.slug)}/`,
			zipUrl: `${base}/zip/${encodeURIComponent(p.slug)}`,
		});
	}
	return out;
}

// Pick (or create) a client folder, then hand the project off into it.
async function handoffProjectToClient(controller, project) {
	if (!project) return;
	const clients = controller.listAtriumClients();
	const NEW = "➕ לקוח חדש…";
	const items = [...clients.map((c) => ({ label: c })), { label: NEW }];
	const pick = await vscode.window.showQuickPick(items, {
		placeHolder: "מסור את \"" + (project.name || "הפרויקט") + "\" לתיקיית לקוח ב-Atrium",
	});
	if (!pick) return;
	let client = pick.label;
	if (client === NEW) {
		client = (await vscode.window.showInputBox({ prompt: "שם הלקוח החדש (תיקייה ב-Atrium)", validateInput: (v) => v && v.trim() ? null : "נדרש שם" })) || "";
		client = client.trim();
		if (!client) return;
	}
	try {
		const { dest, copied, manifest } = controller.handoffToClient(project, client);
		openAtriumHandoffPanel(controller, { manifest, dest, copied, atriumUrl: controller.atriumClientUrl(client) });
	} catch (e) {
		vscode.window.showErrorMessage("מסירה נכשלה: " + String(e && e.message || e));
	}
}

// Visual confirmation of a Solstice → Atrium client handoff: the Build → Atrium →
// Client flow, the written manifest contract, and quick actions.
let atriumHandoffPanel = null;
function openAtriumHandoffPanel(controller, result) {
	if (!atriumHandoffPanel) {
		atriumHandoffPanel = vscode.window.createWebviewPanel(
			"solstice.atrium", "🗂 מסירה ל-Atrium",
			{ viewColumn: vscode.ViewColumn.One, preserveFocus: false },
			{ enableScripts: true, retainContextWhenHidden: true,
			  localResourceRoots: [vscode.Uri.joinPath(controller.context.extensionUri, "media")] }
		);
		atriumHandoffPanel.webview.html = mediaHtml(atriumHandoffPanel.webview, controller.context.extensionUri, "atrium.js", "atrium.css");
		atriumHandoffPanel.webview.onDidReceiveMessage((m) => {
			if (m.type === "ready") atriumHandoffPanel.webview.postMessage({ type: "handoff", ...result });
			else if (m.type === "openFolder" && m.path) vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(m.path)).then(undefined, () => { });
			else if (m.type === "openAtrium" && m.url) vscode.env.openExternal(vscode.Uri.parse(m.url)).then(undefined, () => { });
		});
		atriumHandoffPanel.onDidDispose(() => { atriumHandoffPanel = null; });
	} else {
		atriumHandoffPanel.reveal(vscode.ViewColumn.One);
	}
	atriumHandoffPanel.webview.postMessage({ type: "handoff", ...result });
}

// Pull a server-built (remote) project down to a folder on Thomas's PC as a
// .zip. Local projects already live on disk, so for those we just reveal the
// folder. Remote ones are fetched from the gallery server's /zip endpoint.
async function downloadProjectToPC(controller, project) {
	if (!project) return;
	const name = String(project.name || project.slug || "project").replace(/[^\w.-]+/g, "-");
	if (!project.remote) {
		if (project.dir) vscode.commands.executeCommand("revealFileInOS", vscode.Uri.file(project.dir)).then(undefined, () => { });
		else vscode.window.showWarningMessage("אין נתיב מקומי לפרויקט.");
		return;
	}
	if (!project.zipUrl) { vscode.window.showErrorMessage("אין קישור הורדה לפרויקט המרוחק."); return; }
	const target = await vscode.window.showSaveDialog({
		defaultUri: vscode.Uri.file(path.join(os.homedir(), name + ".zip")),
		filters: { "Zip archive": ["zip"] },
		saveLabel: "הורד ל-PC",
	});
	if (!target) return;
	await vscode.window.withProgress(
		{ location: vscode.ProgressLocation.Notification, title: "מוריד את " + name + " ל-PC…" },
		async () => {
			try {
				const { buf } = await httpGet(project.zipUrl, { binary: true, timeout: 60000 });
				fs.writeFileSync(target.fsPath, buf);
				const reveal = "פתח בתיקייה";
				const choice = await vscode.window.showInformationMessage(
					"הורד: " + target.fsPath + "  (" + Math.max(1, Math.round(buf.length / 1024)) + "KB)", reveal);
				if (choice === reveal) vscode.commands.executeCommand("revealFileInOS", target).then(undefined, () => { });
			} catch (e) {
				vscode.window.showErrorMessage("הורדה נכשלה: " + String(e && e.message || e));
			}
		}
	);
}

function openGallery(controller, extensionUri) {
	if (galleryPanel) { galleryPanel.reveal(vscode.ViewColumn.One); return; }
	const roots = controller.galleryRoots().map((d) => vscode.Uri.file(d));
	galleryPanel = vscode.window.createWebviewPanel(
		"solstice.gallery",
		"Projects",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media"), ...roots],
		}
	);
	controller.galleryPanel = galleryPanel;
	const roster = () => controller.fleetAgents().map((a) => ({ id: a.id, name: a.name, glyph: a.glyph }));
	const pushProjects = async () => {
		galleryPanel.webview.postMessage({ type: "agents", agents: roster() });
		const serverUrl = (controller.cfg().get("galleryServerUrl") || "").trim();
		if (serverUrl) {
			try {
				const projects = await fetchServerProjects(serverUrl);
				for (const p of projects) if (p && p.dir) p.agent = controller.projectAgent(p.dir);
				galleryPanel.webview.postMessage({ type: "projects", projects });
				return;
			} catch (e) {
				// Server unreachable — fall back to local scan so the panel still works.
				galleryPanel.webview.postMessage({ type: "serverError", message: String(e && e.message || e) });
			}
		}
		galleryPanel.webview.postMessage({ type: "projects", projects: controller.scanProjects(galleryPanel.webview) });
	};
	galleryPanel.webview.html = mediaHtml(galleryPanel.webview, extensionUri, "gallery.js", "gallery.css");
	galleryPanel.webview.onDidReceiveMessage((msg) => {
		switch (msg.type) {
			case "ready": pushProjects(); break;
			case "refresh": pushProjects(); break;
			case "openProject": controller.openProjectFolder(msg.dir, msg.newWindow); break;
			case "openRemote":
				if (msg.url) vscode.commands.executeCommand("simpleBrowser.api.open", vscode.Uri.parse(msg.url),
					{ viewColumn: vscode.ViewColumn.Two }).then(undefined, () => vscode.commands.executeCommand("simpleBrowser.show", msg.url));
				break;
			case "newProject": vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { }); break;
			case "openConnectors": openConnectors(controller, extensionUri); break;
			case "assignAgent":
				controller.setProjectAgent(msg.dir, msg.agent);
				pushProjects();
				break;
			case "openInFleet": {
				openFleet(controller, extensionUri);
				if (controller.fleetPanel) {
					controller.fleetPanel.reveal(vscode.ViewColumn.One);
					controller.fleetPanel.webview.postMessage({ type: "focusAgent", agent: msg.agent });
					if (msg.dir) {
						const name = String(msg.dir).split(/[\\/]/).pop();
						controller.fleetPanel.webview.postMessage({ type: "reply", agent: msg.agent, kind: "progress", text: "📂 פרויקט פעיל: " + name, ts: Date.now() });
					}
				}
				break;
			}
			case "handoffClient": handoffProjectToClient(controller, msg.project); break;
			case "downloadProject": downloadProjectToPC(controller, msg.project); break;
		}
	});
	galleryPanel.onDidDispose(() => {
		if (controller.galleryPanel === galleryPanel) controller.galleryPanel = null;
		galleryPanel = null;
	});
}

let connectorsPanel = null;

// Built-in connector catalog. UI/config only — the actual integration is gated
// on Thomas providing each provider's secret token (env/setting), so a click
// just records "requested" until a token lands.
const CONNECTOR_CATALOG = [
	{ id: "vercel", name: "Vercel", glyph: "▲", blurb: "פריסת אתרים ואפליקציות בלחיצה", tokenKey: "VERCEL_TOKEN" },
	{ id: "github", name: "GitHub", glyph: "❮❯", blurb: "דחיפת קוד הפרויקט לריפו", tokenKey: "GITHUB_TOKEN" },
	{ id: "email", name: "Email (SMTP/Resend)", glyph: "✉", blurb: "שליחת מיילים מפרויקטים", tokenKey: "EMAIL_API_KEY" },
];

function connectorState(controller) {
	const req = controller.context.globalState.get("solstice.fleet.connectorsRequested") || {};
	return CONNECTOR_CATALOG.map((c) => {
		const hasToken = !!String(process.env[c.tokenKey] || controller.cfg().get("connector." + c.id + "Token") || "").trim();
		return { ...c, status: hasToken ? "connected" : (req[c.id] ? "requested" : "disconnected") };
	});
}

function openConnectors(controller, extensionUri) {
	if (connectorsPanel) { connectorsPanel.reveal(vscode.ViewColumn.One); return; }
	connectorsPanel = vscode.window.createWebviewPanel(
		"solstice.connectors",
		"Connectors",
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri) }
	);
	connectorsPanel.webview.html = mediaHtml(connectorsPanel.webview, extensionUri, "connectors.js", "connectors.css");
	const push = () => connectorsPanel.webview.postMessage({ type: "connectors", connectors: connectorState(controller) });
	connectorsPanel.webview.onDidReceiveMessage((msg) => {
		switch (msg.type) {
			case "ready": push(); break;
			case "connect": {
				const req = controller.context.globalState.get("solstice.fleet.connectorsRequested") || {};
				req[msg.id] = Date.now();
				controller.context.globalState.update("solstice.fleet.connectorsRequested", req);
				const c = CONNECTOR_CATALOG.find((x) => x.id === msg.id);
				vscode.window.showInformationMessage(`חיבור ${c ? c.name : msg.id} ממתין ל-${c ? c.tokenKey : "token"} מ-Thomas.`);
				push();
				break;
			}
		}
	});
	connectorsPanel.onDidDispose(() => { connectorsPanel = null; });
}

let workflowPanel = null;

function openWorkflow(controller, extensionUri) {
	if (workflowPanel) { workflowPanel.reveal(vscode.ViewColumn.One); return; }
	workflowPanel = vscode.window.createWebviewPanel(
		"solstice.workflow",
		"How Solstice works",
		vscode.ViewColumn.One,
		{ enableScripts: true, retainContextWhenHidden: true, localResourceRoots: webviewResourceRoots(extensionUri) }
	);
	workflowPanel.webview.html = mediaHtml(workflowPanel.webview, extensionUri, "workflow.js", "workflow.css");
	const push = () => {
		const agents = controller.fleetAgents().map((a) => ({ id: a.id, name: a.name, glyph: a.glyph, model: a.model || "" }));
		workflowPanel.webview.postMessage({ type: "model", provider: controller.providerLabel(), version: controller.versionLabel(), agents });
	};
	workflowPanel.webview.onDidReceiveMessage((msg) => { if (msg.type === "ready") push(); });
	workflowPanel.onDidDispose(() => { workflowPanel = null; });
}

let fleetPanel = null;

function openFleet(controller, extensionUri) {
	if (fleetPanel) { fleetPanel.reveal(vscode.ViewColumn.One); return; }
	fleetPanel = vscode.window.createWebviewPanel(
		"solstice.fleet",
		"Fleet",
		vscode.ViewColumn.One,
		{
			enableScripts: true,
			retainContextWhenHidden: true,
			localResourceRoots: [vscode.Uri.joinPath(extensionUri, "media")],
		}
	);
	controller.fleetPanel = fleetPanel;
	fleetPanel.webview.html = mediaHtml(fleetPanel.webview, extensionUri, "fleet.js", "fleet.css");
	let pollTimer = null;
	const poll = () => {
		// WS bridges push replies live; only file-drop agents need polling.
		for (const a of controller.fleetAgents()) {
			if (a.bridge) continue;
			const replies = controller.scanFleetReplies(a.id);
			for (const r of replies) fleetPanel.webview.postMessage({ type: "reply", agent: a.id, text: r.text, ts: r.ts });
		}
	};
	fleetPanel.webview.onDidReceiveMessage((msg) => {
		switch (msg.type) {
			case "ready":
				fleetPanel.webview.postMessage({ type: "version", text: controller.versionLabel(), tip: controller.versionTooltip() });
				fleetPanel.webview.postMessage({ type: "roster", agents: controller.fleetAgents() });
				fleetPanel.webview.postMessage({ type: "history", threads: controller.loadFleetThreads() });
				// warm every live bridge so the roster reflects real online state, not a guess
				for (const a of controller.fleetAgents()) {
					if (controller.fleetBridgeConfigs().has(a.id)) controller.ensureFleetBridge(a.id);
				}
				if (!pollTimer) pollTimer = setInterval(poll, 2000);
				break;
			case "select":
				// warm the socket as soon as the user opens an agent's thread
				controller.activeFleetAgent = msg.agent;
				if (controller.fleetBridgeConfigs().has(msg.agent)) controller.ensureFleetBridge(msg.agent);
				break;
			case "resumeAgent":
				controller.resumeBuilder();
				break;
			case "send": {
				controller.appendFleetThread(msg.agent, { who: "me", text: msg.text, ts: Date.now() });
				const res = controller.sendToFleet(msg.agent, msg.text);
				if (res.live) controller.postFleetActivity(msg.agent, "working", "חושב…");
				fleetPanel.webview.postMessage({ type: "sent", agent: msg.agent, ok: res.ok, ts: res.ts, error: res.error, live: res.live });
				break;
			}
			case "clearThread":
				controller.clearFleetThread(msg.agent);
				break;
			case "approval":
				controller.resolveFleetApproval(msg.key, msg.decision);
				break;
			case "sendContext": {
				const res = controller.sendEditorContext(msg.agent);
				fleetPanel.webview.postMessage({ type: "contextSent", agent: msg.agent, ok: res.ok, error: res.error, rel: res.rel, range: res.range });
				break;
			}
			case "addAgent":
				controller.addFleetAgent(msg.agent || {}).then((res) => {
					fleetPanel.webview.postMessage({ type: "rosterUpdate", agents: controller.fleetAgents(), select: res.ok ? res.id : null, error: res.error });
				});
				break;
			case "removeAgent":
				controller.removeFleetAgent(msg.id).then(() => {
					fleetPanel.webview.postMessage({ type: "rosterUpdate", agents: controller.fleetAgents() });
				});
				break;
			case "openAgentPanel":
				vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
				break;
			case "clearStuck":
				controller.watch.delete(msg.agent);
				break;
		}
	});
	fleetPanel.onDidDispose(() => {
		if (pollTimer) clearInterval(pollTimer);
		if (controller.fleetPanel === fleetPanel) controller.fleetPanel = null;
		fleetPanel = null;
	});
}

function activate(context) {
	const controller = new AgentController(context);
	context.subscriptions.push(controller);
	const provider = new AgentViewProvider(controller, context.extensionUri);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider("solstice.agentPanel", provider, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
		vscode.commands.registerCommand("solstice.agent.newThread", () => controller.newThread()),
		vscode.commands.registerCommand("solstice.agent.showDiff", () => controller.showDiff()),
		vscode.commands.registerCommand("solstice.agent.signOut", () => controller.signOut()),
		vscode.commands.registerCommand("solstice.agent.openManager", () => openManager(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openPreview", (url) => controller.openPreview(typeof url === "string" ? url : "")),
		vscode.commands.registerCommand("solstice.agent.scaffoldApp", () => controller.scaffoldAppIntoWorkspace()),
		vscode.commands.registerCommand("solstice.agent.selectModel", () => controller.selectModel()),
		vscode.commands.registerCommand("solstice.agent.selectAutonomy", () => controller.selectAutonomy()),
		vscode.commands.registerCommand("solstice.agent.toggleDesignElevation", () => controller.toggleDesignElevation()),
		vscode.commands.registerCommand("solstice.agent.openTerminal", () => controller.openTerminal()),
		vscode.commands.registerCommand("solstice.agent.openGallery", () => openGallery(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openConnectors", () => openConnectors(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openWorkflow", () => openWorkflow(controller, context.extensionUri)),
		vscode.commands.registerCommand("solstice.agent.openFleet", () => openFleet(controller, context.extensionUri))
	);
	// Always-visible Solstice version badge (bottom status bar) → opens Fleet on click.
	try {
		const verItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 1000);
		verItem.text = "$(sparkle) Solstice " + (controller.versionLabel() || "");
		verItem.tooltip = controller.versionTooltip();
		verItem.command = "solstice.agent.openFleet";
		verItem.show();
		context.subscriptions.push(verItem);
	} catch { }
	// stuck-agent watchdog: warn when an agent loops in a busy state (e.g.
	// "Exploring…") past the threshold with no fresh progress event.
	controller.startWatchdog();
	context.subscriptions.push({ dispose: () => { if (controller.watchTimer) { clearInterval(controller.watchTimer); controller.watchTimer = null; } } });
	// live research dashboard: render DECONSTRUCT.md / RESEARCH.md as the agent writes it
	// (no brace glob — filter by basename; grok writes from outside the editor)
	const researchWatcher = vscode.workspace.createFileSystemWatcher("**/*.md");
	const onResearchFile = (u) => {
		if (/^(DECONSTRUCT|RESEARCH)\.md$/.test(path.basename(u.fsPath))) controller.showResearch(u);
	};
	researchWatcher.onDidCreate(onResearchFile);
	researchWatcher.onDidChange(onResearchFile);
	context.subscriptions.push(researchWatcher);
	// fleet bridge: external agents (Orion/Jasper/Niko) drop a task JSON into the
	// inbox dir (relayed from Telegram or written directly); we focus the panel,
	// inject the task as a prompt, and archive the file so it runs exactly once.
	// We poll with Node fs rather than vscode.createFileSystemWatcher because the
	// inbox lives OUTSIDE the workspace, where VS Code watchers don't fire.
	const inboxDir = process.env.SOLSTICE_AGENT_INBOX || path.join(os.homedir(), ".solstice", "agent-inbox");
	const inboxDone = path.join(inboxDir, "processed");
	try { fs.mkdirSync(inboxDone, { recursive: true }); } catch { }
	let inboxBusy = false;
	const handleInboxTask = async (p) => {
		let job;
		try { job = JSON.parse(fs.readFileSync(p, "utf8")); } catch { return; }
		const from = String(job.from || "fleet");
		const task = String(job.task || job.text || "").trim();
		// archive first so a slow agent turn can't cause the same task to fire twice
		try { fs.renameSync(p, path.join(inboxDone, Date.now() + "-" + path.basename(p))); } catch { }
		if (!task) return;
		await vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { });
		const text = `\u{1f4e5} \u05de\u05e9\u05d9\u05de\u05d4 \u05de-${from} (\u05e6\u05d9 \u05d4\u05e1\u05d5\u05db\u05e0\u05d9\u05dd):\n\n${task}`;
		// light up the Fleet panel: a fleet agent just dispatched a build to Solstice
		controller.activeFleetAgent = from;
		if (controller.fleetPanel) {
			controller.fleetPanel.webview.postMessage({ type: "liveTask", from, task });
			controller.fleetPanel.webview.postMessage({ type: "flowGuidance", from, prompt: text });
		}
		controller.fleetFlow("dispatch", { from, task });
		setTimeout(() => controller.post({ type: "injectPrompt", text }), 1200);
	};
	const scanInbox = async () => {
		if (inboxBusy) return;
		inboxBusy = true;
		try {
			const files = fs.readdirSync(inboxDir).filter((f) => f.endsWith(".json")).sort();
			for (const f of files) await handleInboxTask(path.join(inboxDir, f));
		} catch { } finally { inboxBusy = false; }
	};
	const inboxTimer = setInterval(scanInbox, 1500);
	setTimeout(scanInbox, 1000); // catch tasks dropped before the panel armed
	context.subscriptions.push({ dispose: () => clearInterval(inboxTimer) });
	// chat lives in the secondary side bar (right of the editor); reveal it on first run
	if (!context.globalState.get("solstice.revealedAgentPanel")) {
		context.globalState.update("solstice.revealedAgentPanel", true);
		setTimeout(() => vscode.commands.executeCommand("solstice.agentPanel.focus").then(undefined, () => { }), 1500);
	}
	// with no folder open, show the Projects gallery as the home view
	if (!vscode.workspace.workspaceFolders) {
		setTimeout(() => openGallery(controller, context.extensionUri), 900);
	}
	// headless E2E hooks (xvfb, no pointer)
	if (process.env.SOLSTICE_AGENT_DEV_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agentPanel.focus");
			setTimeout(() => controller.post({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_PROMPT }), 5000);
		}, 5000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_PREVIEW) {
		setTimeout(() => vscode.commands.executeCommand("solstice.agent.openPreview").then(undefined, () => { }),
			Number(process.env.SOLSTICE_AGENT_DEV_PREVIEW) * 1000 || 60000);
	}
	if (process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT) {
		setTimeout(async () => {
			await vscode.commands.executeCommand("solstice.agent.openManager");
			setTimeout(() => controller.postManager({ type: "injectPrompt", text: process.env.SOLSTICE_AGENT_DEV_MANAGER_PROMPT }), 5000);
		}, 5000);
	}
}

function deactivate() { }

module.exports = { activate, deactivate };
