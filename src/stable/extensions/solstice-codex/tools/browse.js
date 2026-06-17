#!/usr/bin/env node
"use strict";
// Headless-browser helper for the Solstice agent.
//   node browse.js search <query> [count]    → ranked web results (title/url/snippet), no API key
//   node browse.js read <url>                 → page main content as clean readable text/markdown
//   node browse.js crawl <url> [depth] [maxPages] → same-site crawl, prints text of each page
//   node browse.js shot <url> <out.png> [widthxheight]
//   node browse.js scrollshot <url> <outPrefix> [stops]   → outPrefix_s0..sN.png at scroll positions
//   node browse.js dom  <url>
//   node browse.js videoframes <url> <outPrefix> [frames] [referrer] → outPrefix_f0..fN.png seeked across the video
// Uses an installed Chrome/Chromium/Edge in headless mode.
// search/read/crawl give the agent real autonomous research: discover URLs, read pages as
// text, and walk a site (e.g. an Awwwards/Behance gallery) — beyond single-URL screenshots.
// scrollshot exists because scroll-reveal sites (GSAP/IntersectionObserver) render
// below-the-fold sections at opacity:0 in a single no-scroll capture.
// videoframes exists for case-study videos (Behance/Dribbble embed Vimeo players that
// 401 on direct download but play fine in-browser with the right referrer).
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findBrowser() {
	if (process.env.SOLSTICE_BROWSER && fs.existsSync(process.env.SOLSTICE_BROWSER)) {
		return process.env.SOLSTICE_BROWSER;
	}
	const candidates = [];
	if (process.platform === "win32") {
		for (const base of [process.env["PROGRAMFILES"], process.env["PROGRAMFILES(X86)"], process.env["LOCALAPPDATA"]]) {
			if (!base) continue;
			candidates.push(
				path.join(base, "Google/Chrome/Application/chrome.exe"),
				path.join(base, "Microsoft/Edge/Application/msedge.exe"),
				path.join(base, "BraveSoftware/Brave-Browser/Application/brave.exe")
			);
		}
	} else if (process.platform === "darwin") {
		candidates.push(
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"
		);
	} else {
		candidates.push(
			"/usr/bin/google-chrome", "/usr/bin/google-chrome-stable",
			"/usr/bin/chromium", "/usr/bin/chromium-browser",
			"/snap/bin/chromium", "/usr/bin/microsoft-edge"
		);
	}
	for (const c of candidates) {
		if (fs.existsSync(c)) return c;
	}
	return null;
}

async function scrollshot(bin, url, outPrefix, nStops, dims) {
	if (typeof WebSocket !== "function") {
		console.error("scrollshot needs Node >= 22 (global WebSocket). Falling back: use 'shot' at several heights.");
		process.exit(4);
	}
	const [w, h] = dims.split(",").map(Number);
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const chrome = spawn(bin, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		`--user-data-dir=${tmpProfile}`, `--window-size=${w},${h}`,
		"--remote-debugging-port=0", "about:blank",
	], { stdio: "ignore" });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await new Promise(r => setTimeout(r, 100));
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		// Use the initial tab + Page.navigate: tabs opened via /json/new are backgrounded
		// and Page.captureScreenshot hangs forever on a hidden target.
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
		const tab = tabs.find(t => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		};
		// Every command gets a deadline — a wedged page must produce an error, not a silent hang.
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms (page may be wedged)`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.navigate", { url }, 30000);
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true })).result.value;
		for (let i = 0; i < 30; i++) { // dev servers compile on first hit — wait for real load
			if (await evalJs("document.readyState === 'complete'")) break;
			await new Promise(r => setTimeout(r, 500));
		}
		await new Promise(r => setTimeout(r, 2500)); // settle: fonts + first animations
		const height = await evalJs("Math.max(document.body.scrollHeight, document.documentElement.scrollHeight)");
		const stops = Array.from({ length: nStops }, (_, i) => Math.floor(Math.max(0, height - h) * (nStops === 1 ? 0 : i / (nStops - 1))));
		for (let i = 0; i < stops.length; i++) {
			await evalJs(`window.scrollTo({ top: ${stops[i]}, behavior: 'instant' }); ''`);
			await new Promise(r => setTimeout(r, 1500)); // let reveal animations fire
			const shot = await send("Page.captureScreenshot", { format: "png" });
			const file = path.resolve(`${outPrefix}_s${i}.png`);
			fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
			console.log(file);
		}
		ws.close();
	} finally {
		try { chrome.kill(); } catch { }
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

async function videoframes(bin, url, outPrefix, nFrames, referrer) {
	if (typeof WebSocket !== "function") {
		console.error("videoframes needs Node >= 22 (global WebSocket).");
		process.exit(4);
	}
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const chrome = spawn(bin, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		"--autoplay-policy=no-user-gesture-required",
		`--user-data-dir=${tmpProfile}`, "--window-size=1440,810",
		"--remote-debugging-port=0", "about:blank",
	], { stdio: "ignore" });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await new Promise(r => setTimeout(r, 100));
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then(r => r.json());
		const tab = tabs.find(t => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => {
			const msg = JSON.parse(ev.data);
			if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
		};
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		await send("Page.navigate", referrer ? { url, referrer } : { url }, 30000);
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
		let duration = 0;
		for (let i = 0; i < 60; i++) { // wait for a <video> with known duration (player JS + manifest load)
			duration = await evalJs("(() => { const v = document.querySelector('video'); return v && isFinite(v.duration) ? v.duration : 0; })()");
			if (duration > 0) break;
			await new Promise(r => setTimeout(r, 1000));
		}
		if (!duration) throw new Error("no playable <video> found on the page (player may have blocked the referrer)");
		console.log(`video duration: ${duration.toFixed(1)}s`);
		await evalJs("(() => { const v = document.querySelector('video'); v.pause(); v.muted = true; return 1; })()");
		for (let i = 0; i < nFrames; i++) {
			// keep 2% off both ends — t=0 is often a blank poster, t=duration snaps back to 0 on looped players
			const t = duration * (0.02 + 0.96 * (nFrames === 1 ? 0 : i / (nFrames - 1)));
			await evalJs(`(() => new Promise(res => {
				const v = document.querySelector('video');
				const done = () => { v.removeEventListener('seeked', done); setTimeout(() => res(1), 400); };
				v.addEventListener('seeked', done);
				v.currentTime = ${t};
				setTimeout(() => res(0), 8000);
			}))()`);
			const shot = await send("Page.captureScreenshot", { format: "png" });
			const file = path.resolve(`${outPrefix}_f${i}.png`);
			fs.writeFileSync(file, Buffer.from(shot.data, "base64"));
			console.log(`${file} @ ${t.toFixed(1)}s`);
		}
		ws.close();
	} finally {
		try { chrome.kill(); } catch { }
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

// ---- shared headless-Chrome + CDP session (search / read / crawl) ----
// Mirrors the scrollshot/videoframes setup but exposes a tiny {send, evalJs, goto}
// API so the text-oriented modes don't each re-implement the boilerplate.
async function withChrome(bin, fn) {
	if (typeof WebSocket !== "function") {
		console.error("This mode needs Node >= 22 (global WebSocket).");
		process.exit(4);
	}
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const chrome = spawn(bin, [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", "--hide-scrollbars", "--no-first-run", "--disable-extensions",
		`--user-data-dir=${tmpProfile}`, "--window-size=1440,900",
		"--remote-debugging-port=0", "about:blank",
	], { stdio: "ignore" });
	const portFile = path.join(tmpProfile, "DevToolsActivePort");
	try {
		let port = 0;
		for (let i = 0; i < 100 && !port; i++) {
			await sleep(100);
			try { port = parseInt(fs.readFileSync(portFile, "utf8").split("\n")[0], 10) || 0; } catch { }
		}
		if (!port) throw new Error("Chrome DevTools port never appeared");
		const tabs = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
		const tab = tabs.find((t) => t.type === "page");
		if (!tab) throw new Error("no page target found");
		const ws = new WebSocket(tab.webSocketDebuggerUrl);
		await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("CDP socket failed")); });
		let seq = 0;
		const pending = new Map();
		ws.onmessage = (ev) => { const msg = JSON.parse(ev.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
		const send = (method, params = {}, deadlineMs = 20000) => new Promise((res, rej) => {
			const id = ++seq;
			const timer = setTimeout(() => { pending.delete(id); rej(new Error(`${method} timed out after ${deadlineMs}ms`)); }, deadlineMs);
			pending.set(id, (msg) => { clearTimeout(timer); msg.error ? rej(new Error(msg.error.message)) : res(msg.result); });
			ws.send(JSON.stringify({ id, method, params }));
		});
		await send("Page.enable");
		await send("Runtime.enable");
		const evalJs = async (expr) => (await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true })).result.value;
		const goto = async (u, settleMs = 800) => {
			await send("Page.navigate", { url: u }, 30000);
			for (let i = 0; i < 40; i++) { if (await evalJs("document.readyState === 'complete'")) break; await sleep(400); }
			await sleep(settleMs);
		};
		return await fn({ send, evalJs, goto });
	} finally {
		try { chrome.kill(); } catch { }
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

// In-page readable-content extractor: strips chrome/boilerplate and returns
// { title, headings[], text, links[] } — far more useful to the model than raw --dump-dom HTML.
const EXTRACT_JS = `(() => {
	const drop = ['script','style','noscript','svg','iframe','nav','footer','header','aside','form','button'];
	const clone = document.body ? document.body.cloneNode(true) : null;
	if (clone) drop.forEach(s => clone.querySelectorAll(s).forEach(n => n.remove()));
	const main = document.querySelector('main, article, [role=main]');
	const text = (((main && main.innerText) || (clone && clone.innerText) || (document.body && document.body.innerText) || '')).replace(/\\n{3,}/g,'\\n\\n').trim();
	const headings = [...document.querySelectorAll('h1,h2,h3')].slice(0,40).map(e => e.tagName.toLowerCase()+': '+(e.innerText||'').trim()).filter(s => s.length>3 && s.length<200);
	const links = [...document.querySelectorAll('a[href]')].map(a => ({ t:(a.innerText||'').trim().slice(0,90), u:a.href })).filter(l => /^https?:/.test(l.u)).slice(0,300);
	return { title: document.title||'', headings, text: text.slice(0,14000), links };
})()`;

// Bing results scraper (no API key) — reliable for headless Chromium. Bing wraps each
// result href in a /ck/a redirect with the real URL base64url-encoded in the ?u= param
// (prefixed "a1"); decode it in-page with atob so the model gets the true destination.
const SEARCH_JS = `(() => {
	const real = (href) => {
		try {
			const u = new URL(href);
			if (u.hostname.includes('bing.com') && u.pathname.startsWith('/ck/')) {
				let b = u.searchParams.get('u') || '';
				if (b.startsWith('a1')) b = b.slice(2);
				b = b.replace(/-/g,'+').replace(/_/g,'/');
				while (b.length % 4) b += '=';
				try { return atob(b); } catch { return href; }
			}
			return href;
		} catch { return href; }
	};
	const out = [];
	document.querySelectorAll('li.b_algo').forEach(li => {
		const a = li.querySelector('h2 a'); if (!a) return;
		const sn = li.querySelector('.b_caption p, .b_algoSlug, p');
		out.push({ title:(a.innerText||'').trim(), url: real(a.href), snippet:(sn ? sn.innerText : '').trim().slice(0,300) });
	});
	return out;
})()`;

async function search(bin, query, n) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		await goto("https://www.bing.com/search?setlang=en&q=" + encodeURIComponent(query), 1500);
		let results = (await evalJs(SEARCH_JS)) || [];
		if (!results.length) { // fallback: DuckDuckGo lite
			await goto("https://lite.duckduckgo.com/lite/?q=" + encodeURIComponent(query), 1200);
			results = (await evalJs(`(() => [...document.querySelectorAll('a.result-link')].map(a => ({title:(a.innerText||'').trim(), url:a.href, snippet:''})))()`)) || [];
		}
		results = results.filter((r) => r.url && r.title && /^https?:/.test(r.url)).slice(0, n);
		if (!results.length) { console.log(`No results for: ${query}`); return; }
		console.log(`# Search results for: ${query}\n`);
		results.forEach((r, i) => { console.log(`${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? "\n   " + r.snippet : ""}\n`); });
	});
}

async function read(bin, url) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		await goto(url, 1500);
		const d = (await evalJs(EXTRACT_JS)) || {};
		console.log(`# ${d.title || url}\nURL: ${url}\n`);
		if (d.headings && d.headings.length) console.log("## Outline\n" + d.headings.join("\n") + "\n");
		console.log("## Content\n" + (d.text || "(no readable text extracted)"));
	});
}

async function crawl(bin, startUrl, depth, maxPages) {
	await withChrome(bin, async ({ evalJs, goto }) => {
		const origin = new URL(startUrl).origin;
		const seen = new Set();
		const queue = [{ u: startUrl.split("#")[0], d: 0 }];
		let count = 0;
		while (queue.length && count < maxPages) {
			const { u, d } = queue.shift();
			if (seen.has(u)) continue;
			seen.add(u);
			try { await goto(u, 700); } catch { continue; }
			const data = (await evalJs(EXTRACT_JS)) || {};
			count++;
			console.log(`\n===== [${count}] ${u} =====`);
			console.log(`title: ${data.title || ""}`);
			if (data.headings && data.headings.length) console.log(data.headings.slice(0, 12).join("\n"));
			console.log((data.text || "").slice(0, 1800));
			if (d < depth) {
				for (const l of data.links || []) {
					try {
						const lu = new URL(l.u);
						const clean = (lu.origin + lu.pathname).split("#")[0];
						if (lu.origin === origin && !seen.has(clean) && !/\.(png|jpe?g|gif|svg|css|js|pdf|zip|mp4|webp|ico|woff2?|ttf)(\?|$)/i.test(lu.pathname)) {
							queue.push({ u: clean, d: d + 1 });
						}
					} catch { }
				}
			}
		}
		console.log(`\n[crawl] visited ${count} page(s) under ${origin}`);
	});
}

// Model-agnostic image viewing. The default chat model (composer-2.5/grok) is
// text-only and cannot see images, so "look at this Behance design" must be routed
// to a vision-capable model. This shells out to codex (native `-i` vision) and
// falls back to claude (Read tool), returning a text description either way — so
// image viewing works regardless of which chat model drives the turn.
function describeImage(imagePath, question) {
	const abs = path.resolve(imagePath);
	if (!fs.existsSync(abs)) { console.error(`describe: file not found: ${abs}`); process.exit(3); }
	const q = question || "Describe this design/screenshot in exhaustive detail: overall layout and every section top-to-bottom, exact colors (hex where possible), typography, imagery style, spacing, components, and the visual mood. If it shows both mobile and desktop views, describe each.";
	const env = { ...process.env };
	delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_BASE_URL; delete env.OPENAI_API_KEY; delete env.XAI_API_KEY;
	const opts = { encoding: "utf8", env, timeout: 180000, maxBuffer: 16 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] };
	// 1) codex — native image vision
	try {
		const out = execFileSync("codex", ["exec", "--skip-git-repo-check", "--color", "never", "-i", abs, q], opts);
		if (out && out.trim()) { process.stdout.write(out); return; }
	} catch (e) { if (e && e.stdout && String(e.stdout).trim()) { process.stdout.write(String(e.stdout)); return; } }
	// 2) claude — Read tool
	try {
		const out = execFileSync("claude", ["--print", "--allowedTools", "Read", "-p", `Use your Read tool to open the image at ${abs}, then ${q}`], opts);
		if (out && out.trim()) { process.stdout.write(out); return; }
	} catch (e) { if (e && e.stdout && String(e.stdout).trim()) { process.stdout.write(String(e.stdout)); return; } }
	console.error("describe failed: no vision provider (codex or claude) could view the image. Ensure one is installed and signed in.");
	process.exit(1);
}

function main() {
	const [mode, url, out, size, extra] = process.argv.slice(2);
	if (mode === "describe") {
		if (!url) { console.error("usage: browse.js describe <image.png> [question]"); process.exit(2); }
		describeImage(url, process.argv.slice(4).join(" ").trim());
		return;
	}
	if (!mode || !url || ((mode === "shot" || mode === "scrollshot" || mode === "videoframes") && !out)) {
		console.error("usage:\n  browse.js search <query> [count]            web search → ranked title/url/snippet list (no API key)\n  browse.js read <url>                        page main content as clean readable text/markdown\n  browse.js crawl <url> [depth] [maxPages]    same-site crawl → text of each page\n  browse.js shot <url> <out.png> [WxH]        screenshot\n  browse.js scrollshot <url> <outPrefix> [stops]\n  browse.js videoframes <url> <outPrefix> [frames] [referrer]\n  browse.js dom <url>                         raw rendered HTML");
		process.exit(2);
	}
	const bin = findBrowser();
	if (!bin) {
		console.error("No Chrome/Chromium/Edge found. Install one or set SOLSTICE_BROWSER.");
		process.exit(3);
	}
	if (mode === "videoframes") {
		const frames = /^\d+$/.test(size || "") ? Math.min(24, Math.max(2, parseInt(size, 10))) : 10;
		videoframes(bin, url, out, frames, extra || "").catch((err) => {
			console.error(`videoframes failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	if (mode === "scrollshot") {
		const stops = /^\d+$/.test(size || "") ? Math.min(12, Math.max(2, parseInt(size, 10))) : 5;
		scrollshot(bin, url, out, stops, "1440,900").catch((err) => {
			console.error(`scrollshot failed: ${err.message}`);
			process.exit(1);
		});
		return;
	}
	if (mode === "search") {
		const n = /^\d+$/.test(out || "") ? Math.min(20, Math.max(1, parseInt(out, 10))) : 8;
		search(bin, url, n).catch((err) => { console.error(`search failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "read") {
		read(bin, url).catch((err) => { console.error(`read failed: ${err.message}`); process.exit(1); });
		return;
	}
	if (mode === "crawl") {
		const depth = /^\d+$/.test(out || "") ? Math.min(3, Math.max(0, parseInt(out, 10))) : 1;
		const maxPages = /^\d+$/.test(size || "") ? Math.min(40, Math.max(1, parseInt(size, 10))) : 10;
		crawl(bin, url, depth, maxPages).catch((err) => { console.error(`crawl failed: ${err.message}`); process.exit(1); });
		return;
	}
	const dims = /^\d+x\d+$/.test(size || "") ? size.replace("x", ",") : "1440,2200";
	const tmpProfile = fs.mkdtempSync(path.join(os.tmpdir(), "solstice-browse-"));
	const common = [
		"--headless=new", "--disable-gpu", "--no-sandbox", "--mute-audio",
		"--enable-unsafe-swiftshader", // software WebGL: without it three.js canvases render black in headless
		"--hide-scrollbars", "--no-first-run", "--disable-extensions",
		`--user-data-dir=${tmpProfile}`, `--window-size=${dims}`,
		"--virtual-time-budget=9000", "--timeout=25000",
	];
	try {
		if (mode === "shot") {
			execFileSync(bin, [...common, `--screenshot=${path.resolve(out)}`, url], { stdio: ["ignore", "ignore", "inherit"], timeout: 60000 });
			console.log(path.resolve(out));
		} else if (mode === "dom") {
			const html = execFileSync(bin, [...common, "--dump-dom", url], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, timeout: 60000 });
			console.log(html);
		} else {
			console.error(`unknown mode: ${mode}`);
			process.exit(2);
		}
	} finally {
		try { fs.rmSync(tmpProfile, { recursive: true, force: true }); } catch { }
	}
}

main();
