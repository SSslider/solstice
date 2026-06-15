"use strict";
// Minimal zero-dependency WebSocket client (RFC 6455, text frames) for the
// Solstice extension host (Node side). Lets the IDE open a live socket to a
// fleet agent's brain — the SolsticeBridgeChannel running on the server over
// Tailscale — instead of the old file-drop inbox bridge.
//
// Why hand-rolled instead of the `ws` npm package: the solstice-codex extension
// is intentionally zero-dependency (packaged by the local-extensions stream,
// no node_modules ship). We only need a single client socket speaking JSON text
// frames, so a small framer is cheaper than vendoring a library.
//
// Server protocol (see src/channels/solstice_bridge_channel.py):
//   server → client  {type:"hello", agent, version}
//   client → server  {type:"message", id, text, context?}
//   server → client  {type:"push",  text}                 (mid-turn progress)
//   server → client  {type:"reply", id, text, status}     (turn done)
//   server → client  {type:"error", id?, error}
//   client → server  {type:"ping"}  →  server {type:"pong"}

const http = require("http");
const https = require("https");
const crypto = require("crypto");
const { EventEmitter } = require("events");

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

// One live connection to one agent's bridge. Emits:
//   "open"            — handshake complete, hello received
//   "frame" (obj)     — any parsed JSON frame from the server
//   "close" (info)    — socket closed (info: {code, reason, clean})
//   "error" (err)     — transport/handshake error
class FleetBridge extends EventEmitter {
	constructor(url, opts) {
		super();
		opts = opts || {};
		this.url = url;
		this.token = opts.token || "";
		this.log = opts.log || (() => { });
		this.socket = null;
		this.connected = false;       // true once 'open' has fired
		this.closing = false;
		this._buf = Buffer.alloc(0);   // unparsed inbound bytes
		this._frag = null;             // text reassembly across continuation frames
		this._pingTimer = null;
	}

	connect() {
		let u;
		try { u = new URL(this.url); } catch (e) { this._fail(new Error("bad bridge url: " + this.url)); return; }
		const secure = u.protocol === "wss:";
		const key = crypto.randomBytes(16).toString("base64");
		const headers = {
			Connection: "Upgrade",
			Upgrade: "websocket",
			"Sec-WebSocket-Key": key,
			"Sec-WebSocket-Version": "13",
		};
		if (this.token) headers["Authorization"] = "Bearer " + this.token;
		const reqOpts = {
			hostname: u.hostname,
			port: u.port || (secure ? 443 : 80),
			path: (u.pathname || "/") + (u.search || ""),
			headers,
			timeout: 15000,
		};
		const lib = secure ? https : http;
		const req = lib.request(reqOpts);
		this._req = req;
		req.on("upgrade", (res, socket, head) => {
			const accept = res.headers["sec-websocket-accept"];
			const expect = crypto.createHash("sha1").update(key + WS_GUID).digest("base64");
			if (accept !== expect) { this._fail(new Error("bad handshake accept")); try { socket.destroy(); } catch { } return; }
			this.socket = socket;
			socket.on("data", (d) => this._onData(d));
			socket.on("close", () => this._onClose(1006, "socket closed"));
			socket.on("error", (e) => { this.log("ws socket error: " + e.message + "\n"); this.emit("error", e); });
			this.connected = true;
			this._pingTimer = setInterval(() => { try { this.send({ type: "ping" }); } catch { } }, 25000);
			this.emit("open");
			// `head` holds any bytes already read past the HTTP headers — often the
			// server's first frame (the hello). Feed it before live socket data.
			if (head && head.length) this._onData(head);
		});
		req.on("response", (res) => {
			// Server refused the upgrade (e.g. 401 unauthorized) — surface the code.
			let body = "";
			res.on("data", (c) => { body += c.toString(); });
			res.on("end", () => this._fail(new Error("bridge refused upgrade (HTTP " + res.statusCode + ")" + (body ? ": " + body.slice(0, 200) : ""))));
		});
		req.on("error", (e) => this._fail(e));
		req.on("timeout", () => { req.destroy(); this._fail(new Error("bridge connect timeout")); });
		req.end();
	}

	_fail(err) {
		if (this.closing) return;
		this.log("fleet bridge error: " + err.message + "\n");
		this.emit("error", err);
	}

	// Send a JSON object as a masked text frame (client→server MUST mask).
	send(obj) {
		if (!this.socket || this.socket.destroyed) throw new Error("bridge not connected");
		const payload = Buffer.from(JSON.stringify(obj), "utf8");
		this.socket.write(this._encode(0x1, payload));
	}

	_encode(opcode, payload) {
		const len = payload.length;
		let header;
		if (len < 126) {
			header = Buffer.alloc(2);
			header[1] = 0x80 | len;
		} else if (len < 65536) {
			header = Buffer.alloc(4);
			header[1] = 0x80 | 126;
			header.writeUInt16BE(len, 2);
		} else {
			header = Buffer.alloc(10);
			header[1] = 0x80 | 127;
			header.writeBigUInt64BE(BigInt(len), 2);
		}
		header[0] = 0x80 | (opcode & 0x0f); // FIN + opcode
		const mask = crypto.randomBytes(4);
		const masked = Buffer.allocUnsafe(len);
		for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i & 3];
		return Buffer.concat([header, mask, masked]);
	}

	_onData(chunk) {
		this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
		// Parse as many complete frames as are buffered.
		for (;;) {
			if (this._buf.length < 2) return;
			const b0 = this._buf[0];
			const b1 = this._buf[1];
			const fin = (b0 & 0x80) !== 0;
			const opcode = b0 & 0x0f;
			const masked = (b1 & 0x80) !== 0; // server frames are unmasked
			let len = b1 & 0x7f;
			let offset = 2;
			if (len === 126) {
				if (this._buf.length < offset + 2) return;
				len = this._buf.readUInt16BE(offset); offset += 2;
			} else if (len === 127) {
				if (this._buf.length < offset + 8) return;
				len = Number(this._buf.readBigUInt64BE(offset)); offset += 8;
			}
			if (masked) offset += 4; // tolerate (shouldn't happen from server)
			if (this._buf.length < offset + len) return; // wait for full payload
			let payload = this._buf.subarray(offset, offset + len);
			if (masked) {
				const m = this._buf.subarray(offset - 4, offset);
				const out = Buffer.allocUnsafe(len);
				for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
				payload = out;
			}
			this._buf = this._buf.subarray(offset + len);
			this._handleFrame(fin, opcode, payload);
		}
	}

	_handleFrame(fin, opcode, payload) {
		switch (opcode) {
			case 0x8: { // close
				const code = payload.length >= 2 ? payload.readUInt16BE(0) : 1005;
				const reason = payload.length > 2 ? payload.subarray(2).toString("utf8") : "";
				this._onClose(code, reason);
				return;
			}
			case 0x9: // ping → pong (echo payload)
				try { this.socket.write(this._encode(0xA, payload)); } catch { }
				return;
			case 0xA: // pong
				return;
			case 0x0: // continuation
			case 0x1: { // text
				if (this._frag == null && opcode === 0x1) this._frag = "";
				if (this._frag != null) this._frag += payload.toString("utf8");
				if (!fin) return;
				const text = this._frag != null ? this._frag : payload.toString("utf8");
				this._frag = null;
				let obj;
				try { obj = JSON.parse(text); } catch { this.log("ws non-json frame: " + text.slice(0, 200) + "\n"); return; }
				this.emit("frame", obj);
				return;
			}
			default:
				return; // binary/unknown — bridge protocol is text-only
		}
	}

	_onClose(code, reason) {
		if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
		const wasConnected = this.connected;
		this.connected = false;
		if (this.socket) { try { this.socket.destroy(); } catch { } this.socket = null; }
		this.emit("close", { code, reason, clean: this.closing || code === 1000, wasConnected });
	}

	close() {
		this.closing = true;
		if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
		if (this.socket && !this.socket.destroyed) {
			try { this.socket.write(this._encode(0x8, Buffer.alloc(0))); } catch { }
			try { this.socket.destroy(); } catch { }
		}
		if (this._req) { try { this._req.destroy(); } catch { } }
		this.socket = null;
	}
}

module.exports = { FleetBridge };
