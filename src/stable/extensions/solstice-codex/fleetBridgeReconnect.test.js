"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { ReconnectingFleetBridge } = require("./fleetBridge");

class FakeBridge extends EventEmitter {
	constructor() {
		super();
		this.connected = false;
		this.connectCalls = 0;
		this.closeCalls = 0;
		this.sent = [];
	}
	connect() { this.connectCalls += 1; }
	send(frame) { this.sent.push(frame); }
	close() { this.closeCalls += 1; this.connected = false; }
}

const timers = [];
const cleared = new Set();
const made = [];
const bridge = new ReconnectingFleetBridge("ws://relay.test/solstice/ws", {
	baseDelayMs: 100,
	maxDelayMs: 800,
	jitter: 0,
	createConnection: () => {
		const ws = new FakeBridge();
		made.push(ws);
		return ws;
	},
	setTimeout: (fn, ms) => { const token = { fn, ms }; timers.push(token); return token; },
	clearTimeout: (token) => cleared.add(token),
});
bridge.on("error", () => {});

assert.strictEqual(bridge.connect(), true, "first connect starts a socket");
assert.strictEqual(bridge.connect(), false, "second connect cannot create a concurrent socket");
assert.strictEqual(made.length, 1, "only one socket exists while connecting");

made[0].emit("error", new Error("offline"));
made[0].emit("close", { code: 1006 });
assert.strictEqual(timers.length, 1, "error plus close schedules exactly one reconnect");
assert.strictEqual(timers[0].ms, 100, "first reconnect uses the base delay");

timers[0].fn();
assert.strictEqual(made.length, 2, "timer creates the replacement socket");
made[1].emit("close", { code: 1006 });
assert.strictEqual(timers.length, 2, "a second failure schedules one more reconnect");
assert.strictEqual(timers[1].ms, 200, "reconnect delay backs off exponentially");

timers[1].fn();
made[2].connected = true;
made[2].emit("frame", { type: "hello" });
made[2].emit("close", { code: 1006 });
assert.strictEqual(timers[2].ms, 100, "a successful hello resets the backoff");

bridge.close();
assert.ok(cleared.has(timers[2]), "shutdown cancels the pending reconnect");
const countAtShutdown = made.length;
timers[2].fn();
assert.strictEqual(made.length, countAtShutdown, "a cancelled timer cannot reconnect after shutdown");

const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
assert.match(extension, /new ReconnectingFleetBridge\(/, "controller uses the reconnecting transport");
assert.match(extension, /f\.type === "client_ready"[\s\S]*companionReady = true[\s\S]*publishCompanionState/, "IDE state replays only after role registration");
assert.match(extension, /ws\.on\("error",[\s\S]{0,160}companionReady = false/, "transport errors invalidate the prior companion registration");
assert.doesNotMatch(extension, /ws\.on\("close",[\s\S]{0,300}fleetBridges\.delete\(id\)/, "disconnect keeps the reconnecting record alive");

console.log("fleetBridgeReconnect.test.js: 14/14 checks passed");
