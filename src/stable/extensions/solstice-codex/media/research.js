"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	app.innerHTML = `
		<div id="rHeader">
			<div id="rTitle">
				<span class="rIcon">🔬</span>
				<span id="rName">Research</span>
				<span id="rLive" class="rLive"><span class="rPulse"></span>LIVE</span>
			</div>
			<div id="rMeta">
				<span id="rProg" class="hidden"></span>
				<span id="rTime"></span>
			</div>
		</div>
		<div id="rProgBar" class="hidden"><div id="rProgFill"></div></div>
		<div id="rBody"><div id="rEmpty">Waiting for the agent's first findings…</div></div>`;

	const nameEl = document.getElementById("rName");
	const liveEl = document.getElementById("rLive");
	const timeEl = document.getElementById("rTime");
	const progEl = document.getElementById("rProg");
	const progBar = document.getElementById("rProgBar");
	const progFill = document.getElementById("rProgFill");
	const bodyEl = document.getElementById("rBody");

	let lastUpdate = 0;
	let lastLen = 0;
	setInterval(() => {
		liveEl.classList.toggle("stale", Date.now() - lastUpdate > 45000);
	}, 5000);

	const HEX_RE = /#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/g;
	function decorateSwatches(root) {
		const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
		const targets = [];
		let n;
		while ((n = walker.nextNode())) {
			if (HEX_RE.test(n.nodeValue)) targets.push(n);
			HEX_RE.lastIndex = 0;
		}
		for (const node of targets) {
			if (node.parentElement && node.parentElement.closest("pre")) continue;
			const frag = document.createDocumentFragment();
			let last = 0, m;
			HEX_RE.lastIndex = 0;
			const text = node.nodeValue;
			while ((m = HEX_RE.exec(text))) {
				frag.appendChild(document.createTextNode(text.slice(last, m.index)));
				const chip = document.createElement("span");
				chip.className = "swatch";
				const dot = document.createElement("span");
				dot.className = "swatchDot";
				dot.style.background = m[0];
				chip.appendChild(dot);
				chip.appendChild(document.createTextNode(m[0]));
				frag.appendChild(chip);
				last = HEX_RE.lastIndex;
			}
			frag.appendChild(document.createTextNode(text.slice(last)));
			node.parentNode.replaceChild(frag, node);
		}
	}

	function resolveImages(root, base) {
		if (!base) return;
		for (const img of root.querySelectorAll("img.mdimg[data-src]")) {
			const rel = img.getAttribute("data-src").replace(/^\.\//, "");
			img.src = base + "/" + rel;
			img.removeAttribute("data-src");
		}
	}

	function decorateChecks(root) {
		for (const li of root.querySelectorAll("li")) {
			const m = li.textContent.match(/^\s*\[( |x|X|~)\]\s*/);
			if (!m) continue;
			const st = /x/i.test(m[1]) ? "done" : m[1] === "~" ? "doing" : "todo";
			li.classList.add("chk", st);
			const first = li.firstChild;
			if (first && first.nodeType === 3) first.nodeValue = first.nodeValue.replace(/^\s*\[( |x|X|~)\]\s*/, "");
			const ic = document.createElement("span");
			ic.className = "chkIcon";
			ic.textContent = st === "done" ? "✓" : st === "doing" ? "●" : "○";
			li.insertBefore(ic, li.firstChild);
		}
	}

	function render(msg) {
		nameEl.textContent = msg.name || "Research";
		timeEl.textContent = "updated " + new Date(msg.time).toLocaleTimeString();
		lastUpdate = Date.now();
		liveEl.classList.remove("stale");

		const boxes = (msg.text.match(/\[( |x|X|~)\]/g) || []);
		const done = boxes.filter((b) => /x/i.test(b)).length;
		progBar.classList.toggle("hidden", !boxes.length);
		progEl.classList.toggle("hidden", !boxes.length);
		if (boxes.length) {
			progEl.textContent = done + " / " + boxes.length;
			progFill.style.width = Math.round((done / boxes.length) * 100) + "%";
		}

		const nearBottom = bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 160;
		const grew = msg.text.length > lastLen;
		lastLen = msg.text.length;
		bodyEl.innerHTML = "";
		const doc = document.createElement("div");
		doc.className = "mdtext rDoc";
		doc.appendChild(window.mdRender(msg.text));
		resolveImages(doc, msg.base);
		decorateSwatches(doc);
		decorateChecks(doc);
		bodyEl.appendChild(doc);
		if (grew && nearBottom) bodyEl.scrollTop = bodyEl.scrollHeight;
	}

	window.addEventListener("message", (e) => {
		if (e.data && e.data.type === "doc") render(e.data);
	});
	vscode.postMessage({ type: "ready" });
})();
