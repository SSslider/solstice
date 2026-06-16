"use strict";
const http = require("http");
const fs = require("fs");
const path = require("path");

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
const SELECT_SCRIPT = `<script data-solstice-select>
(function () {
  if (window.__solsticeSelect) return;
  window.__solsticeSelect = true;
  var ENDPOINT = ${JSON.stringify(SELECT_ENDPOINT)};
  var active = false, hovered = null, prevOutline = "";

  var btn = document.createElement("button");
  btn.textContent = "\u2715 Select";
  btn.setAttribute("data-solstice-ui", "1");
  btn.style.cssText = "position:fixed;top:12px;right:12px;z-index:2147483647;" +
    "font:600 12px/1 ui-sans-serif,system-ui,sans-serif;padding:8px 12px;" +
    "border-radius:999px;border:1px solid rgba(0,0,0,.15);cursor:pointer;" +
    "background:#111;color:#fff;box-shadow:0 2px 8px rgba(0,0,0,.25);";

  var tip = document.createElement("div");
  tip.setAttribute("data-solstice-ui", "1");
  tip.style.cssText = "position:fixed;z-index:2147483646;pointer-events:none;" +
    "font:500 11px/1.3 ui-monospace,monospace;padding:4px 7px;border-radius:6px;" +
    "background:#34d399;color:#06231a;display:none;max-width:60vw;white-space:nowrap;" +
    "overflow:hidden;text-overflow:ellipsis;box-shadow:0 1px 4px rgba(0,0,0,.3);";

  function isUI(el) { return !el || (el.getAttribute && el.getAttribute("data-solstice-ui")); }

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

  function clearHover() {
    if (hovered) { try { hovered.style.outline = prevOutline; } catch (e) {} }
    hovered = null; tip.style.display = "none";
  }

  function onMove(e) {
    if (!active) return;
    var el = e.target;
    if (isUI(el)) { clearHover(); return; }
    if (el === hovered) return;
    clearHover();
    hovered = el; prevOutline = el.style.outline;
    el.style.outline = "2px solid #34d399";
    el.style.outlineOffset = "-1px";
    var d = describe(el);
    tip.textContent = d.tag + (d.id ? "#" + d.id : "") + (d.classes ? " ." + d.classes.split(" ")[0] : "");
    tip.style.left = Math.min(e.clientX + 12, window.innerWidth - 200) + "px";
    tip.style.top = (e.clientY + 16) + "px";
    tip.style.display = "block";
  }

  function onClick(e) {
    if (!active) return;
    if (isUI(e.target)) return;
    e.preventDefault(); e.stopPropagation();
    var pick = describe(e.target);
    try {
      fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(pick),
      });
    } catch (err) {}
    disarm();
  }

  function arm() {
    active = true;
    btn.textContent = "\u2713 Picking\u2026 (Esc)";
    btn.style.background = "#34d399"; btn.style.color = "#06231a";
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
  }
  function disarm() {
    active = false; clearHover();
    btn.textContent = "\u2715 Select";
    btn.style.background = "#111"; btn.style.color = "#fff";
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("click", onClick, true);
  }

  btn.addEventListener("click", function (e) {
    e.preventDefault(); e.stopPropagation();
    if (active) disarm(); else arm();
  });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && active) disarm(); });

  function mount() { document.body.appendChild(btn); document.body.appendChild(tip); }
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

// Returns http://127.0.0.1:<port>/ of a live dev server for this project, or null.
async function detectDevServerUrl(root) {
	const order = portOrder(root);
	const hits = await Promise.all(order.map((p) => httpProbe(p).then((ok) => (ok ? p : null))));
	const live = order.find((_p, i) => hits[i]);
	return live ? `http://127.0.0.1:${live}/` : null;
}

// Static file server over the workspace so Simple Browser can render the
// site the agent is building (iframe can't load file:// URLs).
class PreviewServer {
	constructor(root, opts) {
		this.root = root;
		this.onSelect = (opts && opts.onSelect) || null;
		this.server = null;
		this.port = 0;
	}

	async ensure() {
		if (this.server) return this.port;
		this.server = http.createServer((req, res) => this.handle(req, res));
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

			// click-to-select callback from the injected page script
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

	dispose() {
		if (this.server) { this.server.close(); this.server = null; }
	}
}

module.exports = { PreviewServer, detectDevServerUrl, hasFramework };
