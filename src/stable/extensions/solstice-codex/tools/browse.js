#!/usr/bin/env node
"use strict";
// Headless-browser helper for the Solstice agent.
//   node browse.js shot <url> <out.png> [widthxheight]
//   node browse.js scrollshot <url> <outPrefix> [stops]   → outPrefix_s0..sN.png at scroll positions
//   node browse.js dom  <url>
//   node browse.js videoframes <url> <outPrefix> [frames] [referrer] → outPrefix_f0..fN.png seeked across the video
// Uses an installed Chrome/Chromium/Edge in headless mode.
// scrollshot exists because scroll-reveal sites (GSAP/IntersectionObserver) render
// below-the-fold sections at opacity:0 in a single no-scroll capture.
// videoframes exists for case-study videos (Behance/Dribbble embed Vimeo players that
// 401 on direct download but play fine in-browser with the right referrer).
const { execFileSync, spawn } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

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

function main() {
	const [mode, url, out, size, extra] = process.argv.slice(2);
	if (!mode || !url || ((mode === "shot" || mode === "scrollshot" || mode === "videoframes") && !out)) {
		console.error("usage: browse.js shot <url> <out.png> [WxH] | browse.js scrollshot <url> <outPrefix> [stops] | browse.js videoframes <url> <outPrefix> [frames] [referrer] | browse.js dom <url>");
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
