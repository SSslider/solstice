"use strict";
// Windows cannot CreateProcess a .cmd/.bat/.ps1 batch shim directly — attempting
// it throws `spawn <name> EPERM`. npm installs CLIs (grok, codex, claude) as such
// shims on Windows, so a bare `spawn("grok", args)` fails on the desktop while the
// IDENTICAL code works on Linux/macOS (where the bin is a real binary or a shell
// script with a shebang). That is the entire "works on the server, EPERM on
// Thomas's PC" mystery.
//
// We cannot fix this by routing through cmd.exe / { shell: true }, because our
// args carry newlines (grok's `--system-prompt-override <PROMPT>` is the whole
// multi-line system prompt) and a Windows command line would mangle them. The
// correct fix: find the JS entry the npm shim wraps and run it with Node directly,
// which preserves argv verbatim and never hits a batch file.
const fs = require("fs");
const path = require("path");

// Search PATH (+ PATHEXT on Windows) for a bare command name. Returns the full
// path of the first match, or null. Mirrors how the OS resolves the command.
function whichFull(bin) {
	if (!bin) return null;
	if (bin.includes("/") || bin.includes("\\")) {
		try { return fs.existsSync(bin) ? bin : null; } catch { return null; }
	}
	const isWin = process.platform === "win32";
	const exts = isWin
		? ["", ...(process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";")]
		: [""];
	const dirs = (process.env.PATH || "").split(isWin ? ";" : ":").filter(Boolean);
	for (const dir of dirs) {
		for (const ext of exts) {
			const p = path.join(dir, bin + ext);
			try { if (fs.existsSync(p)) return p; } catch { /* ignore */ }
		}
	}
	return null;
}

// Extract the JS file an npm shim (.cmd / .ps1 / extension-less bash) delegates
// to. npm shims reference the target relative to the shim dir, e.g.
//   "%~dp0\node.exe"  "%dp0%\node_modules\@scope\pkg\bin\cli.js" %*
//   node  "$basedir/node_modules/@scope/pkg/bin/cli.js" "$@"
// We pull the node_modules/<...>.js path and resolve it next to the shim.
function jsEntryFromShim(shimPath) {
	let text;
	try { text = fs.readFileSync(shimPath, "utf8"); } catch { return null; }
	const dir = path.dirname(shimPath);
	const m = text.match(/((?:node_modules[\\/]).+?\.[cm]?js)\b/i);
	if (!m) return null;
	const rel = m[1].split(/[\\/]/).join(path.sep);
	const full = path.join(dir, rel);
	try { return fs.existsSync(full) ? full : null; } catch { return null; }
}

// Given (bin, args) decide what to actually spawn. No-op everywhere except
// Windows, so Linux/macOS (server + fleet) behaviour is byte-identical to before.
// Returns { cmd, args, env } — env is null when nothing extra is needed.
function resolveWinSpawn(bin, args) {
	const passthrough = { cmd: bin, args: args.slice(), env: null };
	if (process.platform !== "win32") return passthrough;

	const full = whichFull(bin) || bin;
	const ext = path.extname(full).toLowerCase();

	// A real executable — spawn it directly, that always works.
	if (ext === ".exe" || ext === ".com") return { cmd: full, args: args.slice(), env: null };

	// A batch/PowerShell/bash npm shim — run the JS it wraps with Node, verbatim.
	const js = jsEntryFromShim(full);
	if (js) {
		// 1) Prefer a node the USER already has on PATH. This is the path that
		//    worked for a week of Composer use — a user-installed node is
		//    Defender-trusted and launches with no EPERM. (Regression: a build
		//    that preferred a freshly written BUNDLED node.exe ahead of this one
		//    re-introduced `spawn EPERM` + the Defender alert, because the
		//    unsigned bundled binary is exactly what Defender blocks.)
		const node = whichFull("node");
		if (node && path.extname(node).toLowerCase() === ".exe") {
			return { cmd: node, args: [js, ...args], env: null };
		}
		// 2) No user node on PATH — fall back to the bundled node.exe if present.
		const bundledNode = path.join(__dirname, "bin", "node.exe");
		try { if (fs.existsSync(bundledNode)) return { cmd: bundledNode, args: [js, ...args], env: null }; } catch { /* ignore */ }
		// 3) Last resort — drive Electron's own binary as Node. May be blocked by
		//    Defender on an unsigned build.
		return { cmd: process.execPath, args: [js, ...args], env: { ELECTRON_RUN_AS_NODE: "1" } };
	}

	// Couldn't crack the shim — last resort through cmd.exe (may mangle newline
	// args, but strictly better than a hard EPERM that builds nothing).
	if (ext === ".cmd" || ext === ".bat") {
		return { cmd: process.env.ComSpec || "cmd.exe", args: ["/d", "/s", "/c", full, ...args], env: null };
	}
	return { cmd: full, args: args.slice(), env: null };
}

module.exports = { resolveWinSpawn, whichFull, jsEntryFromShim };
