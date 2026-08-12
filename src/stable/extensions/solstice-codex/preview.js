"use strict";
const http = require("http");
const net = require("net");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const MIME = {
	".html": "text/html; charset=utf-8",
	".htm": "text/html; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".json": "application/json",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".mp4": "video/mp4",
	".webm": "video/webm",
	".txt": "text/plain; charset=utf-8",
	".md": "text/plain; charset=utf-8",
};

// Path the injected selection script POSTs picked elements back to. The Simple
// Browser iframe is sandboxed (no postMessage bridge to the extension), so the
// only way to capture a click in the preview is to ship a script inside the
// served page that calls back to this same origin.
const SELECT_ENDPOINT = "/__solstice/select";

// Injected into every served HTML page: a floating "Select" toggle that, when
// armed, outlines the element under the cursor and POSTs a description of the
// clicked element back to the preview server. Mirrors the Lovable/Genesis
// click-to-edit picker, adapted to run fully inside the previewed page.
// Lovable-grade picker: overlay boxes drawn in the page (no source mutation),
// HOVER highlight (cyan) + persistent SELECTION (purple) with a labeled badge,
// a clickable ancestor BREADCRUMB to retarget the selection up/down the tree,
// and MULTI-SELECT (Cmd/Ctrl-click). "Edit" sends the selection(s) to the agent.
const SELECT_SCRIPT = `<script data-solstice-select>
(function () {
  if (window.__solsticeSelect) return;
  window.__solsticeSelect = true;
  var ENDPOINT = ${JSON.stringify(SELECT_ENDPOINT)};
  var active = false, selected = [], selBoxes = [];
  var Z = 2147483600;

  function mk(css) { var d = document.createElement("div"); d.setAttribute("data-solstice-ui", "1"); d.style.cssText = css; return d; }
  function isUI(el) { return !el || !el.closest || !!el.closest("[data-solstice-ui]"); }

  var bar = mk("position:fixed;top:12px;right:12px;z-index:" + (Z + 47) + ";display:flex;gap:6px;font:600 12px/1 ui-sans-serif,system-ui,sans-serif;");
  var btn = document.createElement("button"); btn.setAttribute("data-solstice-ui", "1");
  btn.textContent = "\u2715 Select";
  btn.style.cssText = "padding:8px 12px;border-radius:999px;border:1px solid rgba(0,0,0,.15);cursor:pointer;background:#111;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);font:inherit;";
  var editBtn = document.createElement("button"); editBtn.setAttribute("data-solstice-ui", "1");
  editBtn.textContent = "\u270f\ufe0f Edit";
  editBtn.style.cssText = "padding:8px 12px;border-radius:999px;border:none;cursor:pointer;background:#a855f7;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);font:inherit;display:none;";
  bar.appendChild(btn); bar.appendChild(editBtn);

  var hoverBox = mk("position:fixed;pointer-events:none;z-index:" + (Z + 40) + ";border:2px solid #38bdf8;border-radius:4px;display:none;box-shadow:0 0 0 1px rgba(255,255,255,.35) inset;");
  var crumb = mk("position:fixed;left:12px;bottom:12px;z-index:" + (Z + 46) + ";display:none;flex-wrap:wrap;gap:4px;max-width:82vw;font:600 11px/1 ui-monospace,monospace;");

  function describe(el) {
    var classes = (typeof el.className === "string" ? el.className : "")
      .split(/\\s+/).filter(Boolean).slice(0, 6).join(" ");
    var path = [], n = el, hops = 0;
    while (n && n.tagName && hops < 4) {
      var seg = n.tagName.toLowerCase();
      if (n.id) seg += "#" + n.id;
      path.unshift(seg); n = n.parentElement; hops++;
    }
    return {
      tag: el.tagName ? el.tagName.toLowerCase() : "",
      id: el.id || "",
      classes: classes,
      text: (el.textContent || "").trim().slice(0, 120),
      pathDesc: path.join(" > "),
      src: el.getAttribute ? (el.getAttribute("src") || "") : "",
    };
  }
  function rectOf(el) { var r = el.getBoundingClientRect(); return { l: r.left, t: r.top, w: r.width, h: r.height }; }
  function nameOf(d) { return d.tag + (d.id ? "#" + d.id : "") + (d.classes ? "." + d.classes.split(/\\s+/)[0] : ""); }

  function drawSel() {
    selBoxes.forEach(function (b) { b.remove(); }); selBoxes = [];
    selected.forEach(function (el) {
      var r = rectOf(el), d = describe(el);
      var box = mk("position:fixed;pointer-events:none;z-index:" + (Z + 41) + ";border:2px solid #a855f7;border-radius:4px;");
      box.style.left = r.l + "px"; box.style.top = r.t + "px"; box.style.width = r.w + "px"; box.style.height = r.h + "px";
      var badge = mk("position:absolute;left:-2px;top:-22px;background:#a855f7;color:#fff;padding:3px 7px;border-radius:5px 5px 5px 0;font:600 11px/1 ui-monospace,monospace;white-space:nowrap;");
      badge.textContent = nameOf(d); box.appendChild(badge);
      document.body.appendChild(box); selBoxes.push(box);
    });
    editBtn.style.display = selected.length ? "block" : "none";
    editBtn.textContent = "\u270f\ufe0f Edit" + (selected.length > 1 ? " (" + selected.length + ")" : "");
    drawCrumb();
  }
  function drawCrumb() {
    crumb.innerHTML = "";
    var el = selected[selected.length - 1];
    if (!el) { crumb.style.display = "none"; return; }
    var chain = [], n = el, hops = 0;
    while (n && n.tagName && hops < 6) { chain.unshift(n); n = n.parentElement; hops++; }
    chain.forEach(function (node, i) {
      var c = document.createElement("button"); c.setAttribute("data-solstice-ui", "1");
      c.textContent = nameOf(describe(node));
      c.style.cssText = "pointer-events:auto;cursor:pointer;border:none;color:#fff;padding:4px 7px;border-radius:5px;font:inherit;background:" + (node === el ? "#a855f7" : "rgba(20,20,30,.85)") + ";";
      c.addEventListener("click", function (ev) { ev.preventDefault(); ev.stopPropagation(); selected = [node]; drawSel(); });
      crumb.appendChild(c);
      if (i < chain.length - 1) { var s = mk("color:#9aa;align-self:center;"); s.textContent = "\u203a"; crumb.appendChild(s); }
    });
    crumb.style.display = "flex";
  }
  function clearSel() { selBoxes.forEach(function (b) { b.remove(); }); selBoxes = []; selected = []; crumb.style.display = "none"; editBtn.style.display = "none"; }
  function reposition() { if (selected.length) drawSel(); }

  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (isUI(el)) { hoverBox.style.display = "none"; return; }
    var r = rectOf(el);
    hoverBox.style.left = r.l + "px"; hoverBox.style.top = r.t + "px"; hoverBox.style.width = r.w + "px"; hoverBox.style.height = r.h + "px"; hoverBox.style.display = "block";
  }
  function onClick(e) {
    if (!active) return;
    if (isUI(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var el = e.target;
    if (e.metaKey || e.ctrlKey) { if (selected.indexOf(el) < 0) selected.push(el); }
    else selected = [el];
    drawSel();
  }
  function sendEdit() {
    if (!selected.length) return;
    var picks = selected.map(describe);
    var primary = picks[picks.length - 1];
    primary.picks = picks;
    try { fetch(ENDPOINT, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(primary) }); } catch (err) {}
    clearSel(); disarm();
  }

  function arm() {
    active = true;
    btn.textContent = "\u2713 Picking\u2026 (Esc)";
    btn.style.background = "#38bdf8"; btn.style.color = "#06231a";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition, true);
  }
  function disarm() {
    active = false; hoverBox.style.display = "none";
    btn.textContent = "\u2715 Select";
    btn.style.background = "#111"; btn.style.color = "#fff";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition, true);
  }

  btn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); if (active) disarm(); else arm(); });
  editBtn.addEventListener("click", function (e) { e.preventDefault(); e.stopPropagation(); sendEdit(); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && active) { clearSel(); disarm(); } });

  function mount() { document.body.appendChild(bar); document.body.appendChild(hoverBox); document.body.appendChild(crumb); }
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);
})();
</script>`;

// Injected alongside the selector: an app-introspection bridge that reports the
// page's screens/routes, the current route, and the live localStorage snapshot
// up to the preview webview (via window.parent.postMessage), and accepts
// commands back (navigate to a screen, edit/clear storage). This powers the
// app-mode "Screens flow" map and the "State" inspector — the tangible
// app-vs-site distinction in the live preview. Works for same-origin previews
// (the static PreviewServer and the PWA app-shell scaffold).
const BRIDGE_SCRIPT = `<script data-solstice-bridge>
(function () {
  if (window.__solsticeBridge) return;
  window.__solsticeBridge = true;

  function routes() {
    var out = [], seen = {};
    var nodes = document.querySelectorAll('a[href^="#"],[data-route]');
    for (var i = 0; i < nodes.length; i++) {
      var a = nodes[i];
      var r = a.getAttribute('data-route') || (a.getAttribute('href') || '').replace(/^#/, '');
      if (!r) r = '/';
      if (r.charAt(0) !== '/') r = '/' + r;
      if (seen[r]) continue; seen[r] = 1;
      var label = (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 22) || r;
      out.push({ route: r, label: label });
    }
    return out;
  }
  function snapshot() {
    var ls = {};
    try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); ls[k] = localStorage.getItem(k); } } catch (e) {}
    var cur = (location.hash || '').replace(/^#/, '') || '/';
    if (cur.charAt(0) !== '/') cur = '/' + cur;
    try { window.parent.postMessage({ __sol: 'bridge', routes: routes(), current: cur, storage: ls, href: location.href, title: document.title || '' }, '*'); } catch (e) {}
  }
  window.addEventListener('hashchange', snapshot);
  try {
    var _s = localStorage.setItem.bind(localStorage); localStorage.setItem = function (k, v) { _s(k, v); setTimeout(snapshot, 0); };
    var _r = localStorage.removeItem.bind(localStorage); localStorage.removeItem = function (k) { _r(k); setTimeout(snapshot, 0); };
    var _c = localStorage.clear.bind(localStorage); localStorage.clear = function () { _c(); setTimeout(snapshot, 0); };
  } catch (e) {}
  window.addEventListener('message', function (e) {
    var m = e.data || {};
    if (m.__solCmd === 'nav') { var r = String(m.route || '/'); location.hash = '#' + (r.charAt(0) === '/' ? r : '/' + r); }
    else if (m.__solCmd === 'clearStorage') { try { localStorage.clear(); } catch (e2) {} snapshot(); }
    else if (m.__solCmd === 'setItem') { try { localStorage.setItem(m.key, m.value); } catch (e2) {} snapshot(); }
    else if (m.__solCmd === 'removeItem') { try { localStorage.removeItem(m.key); } catch (e2) {} snapshot(); }
    else if (m.__solCmd === 'snapshot') { snapshot(); }
  });
  function boot() { snapshot(); setInterval(snapshot, 2500); }
  if (document.body) boot(); else document.addEventListener('DOMContentLoaded', boot);
})();
</script>`;

function injectSelect(html) {
	const payload = SELECT_SCRIPT + BRIDGE_SCRIPT;
	const idx = html.toLowerCase().lastIndexOf("</body>");
	if (idx === -1) return html + payload;
	return html.slice(0, idx) + payload + html.slice(idx);
}

// ---- dev-server detection ---------------------------------------------------
// A bundled app (Vite/Next/CRA/Astro/SvelteKit) cannot be served as flat files —
// it needs its dev server. During a build the agent runs `npm run dev`, so a dev
// server is usually already listening. We detect it and point the preview there;
// only plain-HTML projects fall back to the static PreviewServer.

const COMMON_DEV_PORTS = [5173, 3000, 4173, 5174, 8080, 4321, 3001, 8000, 5500];
const DEV_SERVER_REGISTRY = path.join(".solstice", "dev-server.json");
const WORKSPACE_PORT_MIN = 12000;
const WORKSPACE_PORT_SPAN = 2000;

function canonicalRoot(root) {
	let resolved = path.resolve(String(root || ""));
	try { resolved = fs.realpathSync.native(resolved); } catch { }
	return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function sameRoot(a, b) { return canonicalRoot(a) === canonicalRoot(b); }

function registryPath(root) { return path.join(root, DEV_SERVER_REGISTRY); }

function processIsAlive(pid) {
	if (!Number.isInteger(Number(pid)) || Number(pid) <= 0) return false;
	try { process.kill(Number(pid), 0); return true; }
	catch (error) { return !!(error && error.code === "EPERM"); }
}

function readDevServerRegistration(root) {
	try {
		const record = JSON.parse(fs.readFileSync(registryPath(root), "utf8"));
		if (!record || !sameRoot(record.root, root)) return null;
		const port = Number(record.port), pid = Number(record.pid);
		if (!Number.isInteger(port) || port < 1 || port > 65535 || !Number.isInteger(pid) || pid < 1) return null;
		return { port, pid, root: canonicalRoot(record.root), ts: String(record.ts || "") };
	} catch { return null; }
}

function writeDevServerRegistration(root, record) {
	const dir = path.join(root, ".solstice");
	fs.mkdirSync(dir, { recursive: true });
	const file = registryPath(root);
	const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
	const value = {
		port: Number(record.port),
		pid: Number(record.pid),
		root: canonicalRoot(root),
		ts: record.ts || new Date().toISOString(),
	};
	fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8");
	try { fs.renameSync(tmp, file); }
	catch {
		try { fs.unlinkSync(file); } catch { }
		fs.renameSync(tmp, file);
	}
	return value;
}

function clearDevServerRegistration(root, expectedPid) {
	const current = readDevServerRegistration(root);
	if (!current || (expectedPid && current.pid !== Number(expectedPid))) return false;
	try { fs.unlinkSync(registryPath(root)); return true; } catch { return false; }
}

function workspacePortStart(root) {
	let hash = 2166136261;
	for (const ch of canonicalRoot(root)) { hash ^= ch.charCodeAt(0); hash = Math.imul(hash, 16777619); }
	return WORKSPACE_PORT_MIN + ((hash >>> 0) % WORKSPACE_PORT_SPAN);
}

function canListen(port) {
	return new Promise((resolve) => {
		const server = net.createServer();
		server.unref();
		server.once("error", () => resolve(false));
		server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
	});
}

async function allocateWorkspacePort(root) {
	const first = workspacePortStart(root);
	for (let i = 0; i < WORKSPACE_PORT_SPAN; i++) {
		const port = WORKSPACE_PORT_MIN + ((first - WORKSPACE_PORT_MIN + i) % WORKSPACE_PORT_SPAN);
		if (await canListen(port)) return port;
	}
	return null;
}

// Does this project need a dev server (vs. plain static HTML)?
function hasFramework(root) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		if (deps.next || deps.vite || deps["react-scripts"] || deps.astro ||
			deps["@sveltejs/kit"] || deps.nuxt || deps["@vitejs/plugin-react"]) return true;
		const dev = (pkg.scripts && (pkg.scripts.dev || pkg.scripts.start)) || "";
		return /\b(vite|next|astro|nuxt|react-scripts|webpack|parcel)\b/.test(dev);
	} catch { return false; }
}

// Probe order biased toward the project's framework default port.
function portOrder(root) {
	const first = [];
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
		if (deps.next || deps.nuxt) first.push(3000);
		if (deps.vite || deps["@vitejs/plugin-react"]) first.push(5173, 4173);
		if (deps["react-scripts"]) first.push(3000);
		if (deps.astro) first.push(4321);
	} catch { }
	return [...new Set([...first, ...COMMON_DEV_PORTS])];
}

function httpProbe(port, timeout = 700) {
	return new Promise((resolve) => {
		const req = http.request({ host: "127.0.0.1", port, path: "/", method: "GET", timeout }, (res) => {
			res.resume();           // any HTTP response means something is serving
			resolve(true);
		});
		req.on("error", () => resolve(false));
		req.on("timeout", () => { req.destroy(); resolve(false); });
		req.end();
	});
}

// Returns only a dev server registered to this exact workspace. A live process
// on a familiar port is not ownership proof: another Solstice window may own it.
async function detectDevServerUrl(root, opts) {
	let registered = readDevServerRegistration(root);
	if (registered) {
		if (processIsAlive(registered.pid)) {
			if (await httpProbe(registered.port)) return `http://127.0.0.1:${registered.port}/`;
			// The registration is written at spawn time, before a cold Vite/Next boot
			// begins listening. Keep recent ownership records while startup is in flight.
			const ageMs = Date.now() - Date.parse(registered.ts || "");
			if (Number.isFinite(ageMs) && ageMs < 2 * 60 * 1000) return null;
		}
		clearDevServerRegistration(root, registered.pid);
	}

	// Last-resort probe exists only for a registry that appears while probing
	// (for example another window finishing startup). Never adopt an unregistered
	// server merely because it answered on a common port.
	const order = (opts && Array.isArray(opts.ports)) ? opts.ports : portOrder(root);
	const hits = await Promise.all(order.map((p) => httpProbe(p).then((ok) => (ok ? p : null))));
	registered = readDevServerRegistration(root);
	if (!registered || !processIsAlive(registered.pid)) return null;
	const live = order.find((p, i) => hits[i] && p === registered.port);
	return live ? `http://127.0.0.1:${live}/` : null;
}

// Static file server over the workspace so Simple Browser can render the
// site the agent is building (iframe can't load file:// URLs).
class PreviewServer {
	constructor(root, opts) {
		this.root = root;
		this.onSelect = (opts && opts.onSelect) || null;
		// When set (e.g. "http://127.0.0.1:5173"), the server stops serving static
		// files and instead reverse-proxies to the agent's dev server, injecting the
		// click-to-select picker into HTML responses and proxying the HMR WebSocket.
		// This is what makes component-select work for framework apps (Vite/Next/…),
		// not just plain-HTML projects.
		this.proxyTarget = (opts && opts.proxyTarget) || null;
		this.server = null;
		this.port = 0;
	}

	setProxyTarget(target) { this.proxyTarget = target || null; }

	async ensure() {
		if (this.server) return this.port;
		this.server = http.createServer((req, res) => this.handle(req, res));
		// Proxy HMR / live-reload WebSocket upgrades through to the dev server.
		this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
		await new Promise((resolve, reject) => {
			this.server.once("error", reject);
			this.server.listen(0, "127.0.0.1", resolve);
		});
		this.port = this.server.address().port;
		return this.port;
	}

	handle(req, res) {
		try {
			let urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

			// click-to-select callback from the injected page script (handled locally
			// even in proxy mode, so it never reaches the dev server)
			if (urlPath === SELECT_ENDPOINT) {
				if (req.method !== "POST") { res.writeHead(405); res.end(); return; }
				let body = "";
				req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
				req.on("end", () => {
					try { if (this.onSelect) this.onSelect(JSON.parse(body || "{}")); } catch { }
					res.writeHead(204, { "Access-Control-Allow-Origin": "*" });
					res.end();
				});
				return;
			}

			// Reverse-proxy mode: forward everything else to the dev server, injecting
			// the picker into HTML responses.
			if (this.proxyTarget) { this.proxyHttp(req, res); return; }

			if (urlPath.endsWith("/")) urlPath += "index.html";
			const filePath = path.normalize(path.join(this.root, urlPath));
			if (!filePath.startsWith(path.normalize(this.root + path.sep)) && filePath !== path.normalize(this.root)) {
				res.writeHead(403); res.end("forbidden"); return;
			}
			let stat;
			try { stat = fs.statSync(filePath); } catch { res.writeHead(404); res.end("not found"); return; }
			if (stat.isDirectory()) {
				res.writeHead(302, { Location: urlPath.replace(/\/?$/, "/") }); res.end(); return;
			}
			const ext = path.extname(filePath).toLowerCase();
			// HTML: read, inject the selection overlay, serve with a correct length
			if (ext === ".html" || ext === ".htm") {
				let html;
				try { html = fs.readFileSync(filePath, "utf8"); } catch { res.writeHead(404); res.end("not found"); return; }
				const out = Buffer.from(injectSelect(html), "utf8");
				res.writeHead(200, {
					"Content-Type": MIME[ext],
					"Content-Length": out.length,
					"Cache-Control": "no-store",
				});
				res.end(out);
				return;
			}
			res.writeHead(200, {
				"Content-Type": MIME[ext] || "application/octet-stream",
				"Cache-Control": "no-store",
			});
			fs.createReadStream(filePath).pipe(res);
		} catch (e) {
			res.writeHead(500); res.end(String(e && e.message || e));
		}
	}

	// Reverse-proxy an HTTP request to the dev server. HTML responses are buffered
	// and the picker is injected; everything else streams straight through.
	proxyHttp(req, res) {
		let target;
		try { target = new URL(this.proxyTarget); } catch { res.writeHead(502); res.end("bad proxy target"); return; }
		const headers = { ...req.headers, host: target.host };
		// Force identity so HTML comes back uncompressed and is injectable.
		headers["accept-encoding"] = "identity";
		const opts = { protocol: target.protocol, hostname: target.hostname, port: target.port, method: req.method, path: req.url, headers };
		const pReq = http.request(opts, (pRes) => {
			const ct = String(pRes.headers["content-type"] || "");
			if (/text\/html/i.test(ct)) {
				const chunks = [];
				pRes.on("data", (c) => chunks.push(c));
				pRes.on("end", () => {
					const html = injectSelect(Buffer.concat(chunks).toString("utf8"));
					const out = Buffer.from(html, "utf8");
					const h = { ...pRes.headers };
					delete h["content-length"]; delete h["content-encoding"]; delete h["transfer-encoding"];
					h["content-length"] = out.length;
					h["cache-control"] = "no-store";
					res.writeHead(pRes.statusCode || 200, h);
					res.end(out);
				});
				pRes.on("error", () => { try { res.end(); } catch { } });
			} else {
				res.writeHead(pRes.statusCode || 200, pRes.headers);
				pRes.pipe(res);
			}
		});
		pReq.on("error", (e) => { try { res.writeHead(502); res.end("preview proxy error: " + (e && e.message || e)); } catch { } });
		req.pipe(pReq);
	}

	// Proxy a WebSocket upgrade (Vite/Next HMR, live-reload) to the dev server by
	// piping the raw sockets once the upstream completes its 101 handshake.
	handleUpgrade(req, socket, head) {
		if (!this.proxyTarget) { try { socket.destroy(); } catch { } return; }
		let target;
		try { target = new URL(this.proxyTarget); } catch { try { socket.destroy(); } catch { } return; }
		const pReq = http.request({
			protocol: target.protocol, hostname: target.hostname, port: target.port,
			method: req.method, path: req.url, headers: { ...req.headers, host: target.host },
		});
		pReq.on("upgrade", (pRes, pSocket, pHead) => {
			const lines = [`HTTP/1.1 ${pRes.statusCode} ${pRes.statusMessage || "Switching Protocols"}`];
			for (const [k, v] of Object.entries(pRes.headers)) {
				if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
				else lines.push(`${k}: ${v}`);
			}
			try { socket.write(lines.join("\r\n") + "\r\n\r\n"); } catch { }
			if (pHead && pHead.length) { try { pSocket.unshift(pHead); } catch { } }
			pSocket.pipe(socket); socket.pipe(pSocket);
			pSocket.on("error", () => { try { socket.destroy(); } catch { } });
			socket.on("error", () => { try { pSocket.destroy(); } catch { } });
		});
		pReq.on("error", () => { try { socket.destroy(); } catch { } });
		if (head && head.length) { try { pReq.write(head); } catch { } }
		pReq.end();
	}

	dispose() {
		if (this.server) { this.server.close(); this.server = null; }
	}
}

// Which npm script actually starts the dev server for this project.
function devScriptName(root) {
	try {
		const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
		const s = pkg.scripts || {};
		if (s.dev) return "dev";
		if (s.start) return "start";
		if (s.serve) return "serve";
	} catch { }
	return null;
}

// Owns the lifecycle of the project's dev server. The agent writes a framework
// app but never had a way to actually RUN it — so the live preview probed ports
// that nothing was listening on and stayed blank. This boots `npm install` (only
// when node_modules is absent) then the dev script, and resolves once a port is
// live so the preview can point at it.
class DevServer {
	constructor(root, opts) {
		this.root = root;
		this.onLog = (opts && opts.onLog) || (() => { });
		this.onStateChange = (opts && opts.onStateChange) || (() => { });
		this.idleTimeoutMs = Number.isFinite(opts && opts.idleTimeoutMs) ? Math.max(0, Number(opts.idleTimeoutMs)) : 30 * 60 * 1000;
		this.proc = null;
		this.starting = null;     // in-flight start() promise (dedupe)
		this.url = null;
		this.port = null;
		this.startedAt = 0;
		this.lastActivityAt = 0;
		this.idleDeadlineAt = 0;
		this.idleTimer = null;
	}

	log(s) { try { this.onLog(s); } catch { } }
	emitState(reason) { try { this.onStateChange({ reason, server: this }); } catch { } }
	hasOwnedProcess() { return !!(this.proc && this.proc.pid && this.proc.exitCode === null); }
	touch(reason = "activity") {
		if (!this.hasOwnedProcess()) return false;
		this.lastActivityAt = Date.now();
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.idleDeadlineAt = this.idleTimeoutMs > 0 ? this.lastActivityAt + this.idleTimeoutMs : 0;
		if (this.idleTimeoutMs > 0) {
			this.idleTimer = setTimeout(() => {
				this.idleTimer = null;
				this.log(`[dev] idle timeout reached after ${this.idleTimeoutMs}ms\n`);
				this.stop("idle-timeout");
			}, this.idleTimeoutMs);
			this.idleTimer.unref && this.idleTimer.unref();
		}
		this.emitState(reason);
		return true;
	}
	clearIdleTimer() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
		this.idleDeadlineAt = 0;
	}

	// Resolve to a live dev-server URL, starting the server if needed. Returns
	// null only if the project has no dev script or the server never came up.
	async ensure() {
		// The registry is recoverable metadata. If this Solstice window still owns
		// the child process, restore a missing/corrupt record before detection. The
		// process handle is the ownership proof, so this never adopts a server found
		// merely by probing a familiar port (which may belong to another window).
		if (this.hasOwnedProcess() && Number.isInteger(this.port) && this.port > 0) {
			const registered = readDevServerRegistration(this.root);
			if (!registered || registered.pid !== Number(this.proc.pid) || registered.port !== this.port) {
				try { writeDevServerRegistration(this.root, { port: this.port, pid: this.proc.pid }); }
				catch (error) { this.log(`[dev] cannot repair .solstice/dev-server.json: ${error && error.message || error}\n`); }
			}
		}
		const existing = await detectDevServerUrl(this.root).catch(() => null);
		if (existing) { this.url = existing; this.touch("ensure"); return existing; }
		if (this.url && this.proc && this.proc.exitCode === null) { this.touch("ensure"); return this.url; }
		if (this.starting) return this.starting;
		this.starting = this._start().finally(() => { this.starting = null; });
		return this.starting;
	}

	async _start() {
		const script = devScriptName(this.root);
		if (!script) { this.log("[dev] no dev/start script in package.json — skipping auto-run\n"); return null; }

		if (!fs.existsSync(path.join(this.root, "node_modules"))) {
			this.log("[dev] installing dependencies (npm install)…\n");
			const ok = await this._run("install", ["install", "--no-audit", "--no-fund"], 8 * 60 * 1000);
			if (!ok) { this.log("[dev] npm install failed — preview unavailable\n"); return null; }
		}

		const port = await allocateWorkspacePort(this.root);
		if (!port) { this.log("[dev] no free workspace port available — preview unavailable\n"); return null; }
		this.log(`[dev] starting dev server (npm run ${script}) on workspace port ${port}…\n`);
		const npm = process.platform === "win32" ? "npm.cmd" : "npm";
		const args = ["run", script];
		const command = (() => {
			try { return String((JSON.parse(fs.readFileSync(path.join(this.root, "package.json"), "utf8")).scripts || {})[script] || ""); }
			catch { return ""; }
		})();
		if (/\b(vite|next|astro|nuxt|svelte-kit)\b/i.test(command)) {
			args.push("--", "--port", String(port));
			if (/\b(vite|svelte-kit)\b/i.test(command)) args.push("--strictPort");
		}
		const proc = spawn(npm, args, {
			cwd: this.root,
			shell: process.platform === "win32",
			detached: process.platform !== "win32",
			windowsHide: true,
			env: { ...process.env, PORT: String(port), SOLSTICE_WORKSPACE_ROOT: canonicalRoot(this.root), BROWSER: "none", FORCE_COLOR: "0" },
		});
		this.proc = proc;
		this.port = port;
		this.startedAt = Date.now();
		this.lastActivityAt = this.startedAt;
		proc.stdout.on("data", (d) => this.log(String(d)));
		proc.stderr.on("data", (d) => this.log(String(d)));
		const ownedPid = proc.pid;
		proc.on("error", (error) => {
			this.log(`[dev] failed to start dev server: ${error && error.message || error}\n`);
			clearDevServerRegistration(this.root, ownedPid);
			if (this.proc === proc) { this.clearIdleTimer(); this.proc = null; this.url = null; this.port = null; this.emitState("spawn-error"); }
		});
		proc.on("exit", (code) => {
			this.log(`[dev] dev server exited (${code})\n`);
			clearDevServerRegistration(this.root, ownedPid);
			if (this.proc === proc) { this.clearIdleTimer(); this.proc = null; this.url = null; this.port = null; this.emitState("exit"); }
		});
		if (!ownedPid) return null; // the error handler will surface the spawn failure
		try { writeDevServerRegistration(this.root, { port, pid: ownedPid }); }
		catch (error) {
			this.log(`[dev] cannot write .solstice/dev-server.json: ${error && error.message || error}\n`);
			try { proc.kill("SIGTERM"); } catch { }
			if (this.proc === proc) { this.proc = null; this.port = null; }
			return null;
		}
		this.touch("started");

		// Poll for the port to come up (Vite/Next cold-start can take a while).
		const DEADLINE = Date.now() + 90 * 1000;
		while (Date.now() < DEADLINE) {
			if (!this.proc) return null;           // crashed during boot
			const url = await detectDevServerUrl(this.root).catch(() => null);
			if (url) { this.url = url; this.touch("live"); this.log(`[dev] live at ${url}\n`); return url; }
			await new Promise((r) => setTimeout(r, 1500));
		}
		this.log("[dev] dev server did not become reachable within 90s\n");
		return null;
	}

	_run(label, args, timeoutMs) {
		return new Promise((resolve) => {
			const npm = process.platform === "win32" ? "npm.cmd" : "npm";
			const p = spawn(npm, args, { cwd: this.root, shell: process.platform === "win32", windowsHide: true, env: process.env });
			const t = setTimeout(() => { try { p.kill(); } catch { } resolve(false); }, timeoutMs);
			p.stdout.on("data", (d) => this.log(String(d)));
			p.stderr.on("data", (d) => this.log(String(d)));
			p.on("error", () => { clearTimeout(t); resolve(false); });
			p.on("exit", (code) => { clearTimeout(t); resolve(code === 0); });
		});
	}

	stop(reason = "manual") {
		if (!this.hasOwnedProcess()) return { stopped: false, pid: null };
		const pid = this.proc.pid;
		try {
			if (process.platform === "win32") spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
			else {
				try { process.kill(-pid, "SIGTERM"); }
				catch { this.proc.kill("SIGTERM"); }
				const force = setTimeout(() => {
					try { process.kill(-pid, 0); process.kill(-pid, "SIGKILL"); }
					catch { /* process group exited cleanly */ }
				}, 2500);
				force.unref && force.unref();
			}
		} catch { return { stopped: false, pid }; }
		clearDevServerRegistration(this.root, pid);
		this.clearIdleTimer();
		this.proc = null;
		this.url = null;
		this.port = null;
		this.emitState(reason);
		return { stopped: true, pid };
	}

	dispose() {
		this.stop();
		this.url = null;
	}
}

module.exports = {
	PreviewServer,
	DevServer,
	detectDevServerUrl,
	hasFramework,
	allocateWorkspacePort,
	readDevServerRegistration,
	writeDevServerRegistration,
	clearDevServerRegistration,
};
