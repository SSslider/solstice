"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	app.innerHTML = `
		<div id="planRoot">
			<header id="pHero">
				<div class="pHeroRing"><div id="pRing"></div><span id="pRingTxt">0%</span></div>
				<div class="pHeroText">
					<div class="pKicker"><span class="pIcon">🗺</span> תוכנית בנייה <span id="pLive" class="pLive"><span class="pPulse"></span>LIVE</span></div>
					<h1 id="pTitle">ממתין לתוכנית מהסוכן…</h1>
					<div id="pStatus" class="pStatus"></div>
					<div id="pChips" class="pChips"></div>
				</div>
			</header>
			<div id="pBody"><div id="pEmpty">הסוכן יפרק את העבודה לשלבים — הם יופיעו כאן בזמן אמת.</div></div>
		</div>`;

	const ringEl = document.getElementById("pRing");
	const ringTxt = document.getElementById("pRingTxt");
	const titleEl = document.getElementById("pTitle");
	const statusEl = document.getElementById("pStatus");
	const chipsEl = document.getElementById("pChips");
	const bodyEl = document.getElementById("pBody");
	const liveEl = document.getElementById("pLive");

	let lastUpdate = 0;
	setInterval(() => { liveEl.classList.toggle("stale", Date.now() - lastUpdate > 45000); }, 5000);

	function el(t, c, x) { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; }

	function glyph(s) {
		const t = (s.group || "") + " " + (s.step || "");
		if (/research|analy|deconstruct|explore|inspect|study|חקר|ניתוח/i.test(t)) return "🔎";
		if (/design|layout|style|theme|visual|ui|עיצוב/i.test(t)) return "🎨";
		if (/build|implement|code|develop|create|write|בנייה|בניית/i.test(t)) return "🛠";
		if (/test|verify|qa|check|review|אימות|בדיקה/i.test(t)) return "🧪";
		if (/deploy|ship|publish|release|פריסה/i.test(t)) return "🚀";
		return "◆";
	}

	function render(plan, title) {
		if (!Array.isArray(plan) || !plan.length) return;
		if (title) titleEl.textContent = title;

		const total = plan.length;
		const done = plan.filter((s) => s.status === "completed").length;
		const running = plan.filter((s) => s.status === "inProgress").length;
		const pending = total - done - running;
		const current = plan.find((s) => s.status === "inProgress");
		const pct = Math.round((done / total) * 100);

		ringEl.style.background = "conic-gradient(var(--sol-accent,#f59e0b) " + pct + "%, var(--sol-line,#33333c) 0)";
		ringTxt.textContent = pct + "%";
		statusEl.textContent = current ? "▸ " + current.step : (done === total ? "✓ כל השלבים הושלמו" : "");

		chipsEl.innerHTML = "";
		chipsEl.appendChild(el("span", "pChip pChip--done", "✓ " + done + " הושלמו"));
		if (running) chipsEl.appendChild(el("span", "pChip pChip--run", "▸ " + running + " בתהליך"));
		chipsEl.appendChild(el("span", "pChip pChip--wait", "· " + pending + " ממתינים"));

		bodyEl.innerHTML = "";
		const tl = el("div", "pTL");
		let curGroup = null;
		let idx = 0;
		for (const s of plan) {
			if (s.group && s.group !== curGroup) {
				curGroup = s.group;
				tl.appendChild(el("div", "pGroup", curGroup));
			}
			const st = s.status || "pending";
			const node = el("div", "pStep p--" + st);
			node.style.animationDelay = (idx++ * 28) + "ms";
			const rail = el("div", "pRail");
			const dot = el("div", "pDot");
			dot.textContent = st === "completed" ? "✓" : glyph(s);
			if (st === "inProgress") dot.classList.add("pDot--pulse");
			rail.appendChild(dot);
			node.appendChild(rail);
			const b = el("div", "pStepBody");
			b.appendChild(el("div", "pStepTitle", s.step || ""));
			if (s.detail) b.appendChild(el("div", "pStepDetail", s.detail));
			if (Array.isArray(s.substeps) && s.substeps.length) {
				const subDone = s.substeps.filter((x) => x.status === "completed").length;
				b.appendChild(el("div", "pSubCap", subDone + "/" + s.substeps.length + " תת-שלבים"));
				const subs = el("div", "pSubs");
				for (const sub of s.substeps) {
					const sr = el("div", "pSub p--" + (sub.status || "pending"));
					sr.appendChild(el("span", "pSubMark", sub.status === "completed" ? "✓" : sub.status === "inProgress" ? "▸" : "·"));
					sr.appendChild(el("span", "pSubTxt", sub.step || ""));
					subs.appendChild(sr);
				}
				b.appendChild(subs);
			}
			node.appendChild(b);
			tl.appendChild(node);
		}
		bodyEl.appendChild(tl);
	}

	window.addEventListener("message", (ev) => {
		const m = ev.data || {};
		if (m.type === "plan") {
			lastUpdate = Date.now();
			liveEl.classList.remove("stale");
			render(m.plan, m.title);
		}
	});

	vscode.postMessage({ type: "ready" });
})();
