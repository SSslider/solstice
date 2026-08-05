"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const path = require("path");
const { listenOnFirstAvailable } = require("./companionPort");

function close(server) { return new Promise((resolve) => server.close(resolve)); }

(async () => {
	const occupied = http.createServer();
	await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
	const first = occupied.address().port;
	const second = first + 1;
	const fallback = http.createServer();
	assert.equal(await listenOnFirstAvailable(fallback, [first, second]), second);
	assert.equal(fallback.address().address, "127.0.0.1");

	const occupiedSecond = http.createServer();
	await new Promise((resolve) => occupiedSecond.listen(second + 1, "127.0.0.1", resolve));
	const exhausted = http.createServer();
	await assert.rejects(() => listenOnFirstAvailable(exhausted, [first, second + 1]), /No Companion diagnostic port available/);

	await close(fallback);
	await close(occupiedSecond);
	await close(occupied);

	const extension = fs.readFileSync(path.join(__dirname, "extension.js"), "utf8");
	assert.match(extension, /const ports = \[8800, 8801, 8802, 8803, 8804, 8805, 8806, 8807, 8808, 8809\]/);
	assert.doesNotMatch(extension, /const ports = \[[^\]]*8794/);
	assert.match(extension, /127\.0\.0\.1:\$\{port\}/);
	assert.match(extension, /showErrorMessage\(`Companion 2\.0 relay/);
	console.log("companionPort.test.js: 8/8 checks passed");
})().catch((error) => { console.error(error); process.exit(1); });
