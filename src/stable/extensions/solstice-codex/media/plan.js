"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");

	app.innerHTML = `
		<div id="planRoot">
			<header id="pHero">
				<div class="pHeroRing"><div id="pRing"></div><span id="pRingTxt">0%</span></div>
				<div class="pHeroText">
				<div class="pKicker"><span class="pIcon">🗺</span> תוכנית זורמת <span id="pLive" class="pLive"><span class="pPulse"></span>LIVE</span></div>
					<h1 id="pTitle">ממתין לתוכנית מהסוכן…</h1>
					<div id="pStatus" class="pStatus"></div>
					<div id="pChips" class="pChips"></div>
				</div>
			</header>
			<div id="pFlowMeta" class="pApprovalNote">הביצוע מתחיל מיד. אפשר לכוון מחדש דרך הערה — בלי לעצור או לפתוח פרויקט מחדש.</div>
			<section id="pApproval" hidden>
				<div id="pBrief" class="pBrief" hidden></div>
				<label for="pPrompt">ערוך את המשימה לפני ביצוע</label>
				<textarea id="pPrompt" rows="6"></textarea>
				<div id="pQuestions"></div>
				<div class="pPlanningTools"><button id="pResearch">🔎 מחקר תכנון</button><button id="pReplan">↻ עדכן תוכנית</button></div>
				<div class="pApprovalActions"><button id="pCancel">עצור</button><button id="pApprove">אשר והתחל</button></div>
				<div id="pApprovalMeta" class="pApprovalNote">הסוכן לא יכתוב קוד עד האישור.</div>
			</section>
			<section id="pAnnotations">
				<div class="pAnnotationTitle">📝 הערה על ה-artifact</div>
				<div class="pAnnotationRow"><select id="pArtifact"><option value="PLAN.md">Plan</option><option value="WALKTHROUGH.md">Walkthrough</option></select><input id="pAnnotation" placeholder="כתוב שינוי או תיקון — הוא ייכנס ל-turn הפעיל בלי restart"><button id="pAnnotate">עדכן תוך כדי</button></div>
				<div id="pAnnotationMeta" class="pApprovalNote"></div>
			</section>
			<div id="pBody"><div id="pEmpty">הסוכן יפרק את העבודה לשלבים — הם יופיעו כאן בזמן אמת.</div></div>
		</div>`;

	const ringEl = document.getElementById("pRing");
	const ringTxt = document.getElementById("pRingTxt");
	const titleEl = document.getElementById("pTitle");
	const statusEl = document.getElementById("pStatus");
	const chipsEl = document.getElementById("pChips");
	const bodyEl = document.getElementById("pBody");
	const liveEl = document.getElementById("pLive");
	const approvalEl = document.getElementById("pApproval");
	const promptEl = document.getElementById("pPrompt");
	const questionsEl = document.getElementById("pQuestions");
	const approvalMetaEl = document.getElementById("pApprovalMeta");
	let questions = [], revision = 0, dirty = false, replanTimer = null, approvalKind = "plan";
	let readyAttempts = 0, readyTimer = null;
	function stopReadyHandshake() { if (readyTimer) { clearInterval(readyTimer); readyTimer = null; } }
	function requestPlanState() {
		vscode.postMessage({ type: "ready" });
		readyAttempts += 1;
		if (readyAttempts >= 20) stopReadyHandshake();
	}
	function answers() { const out = {}; for (const q of questions) { const input = document.querySelector('[data-q="' + q.id + '"]'); out[q.id] = input ? input.value.trim() : ""; } return out; }
	function validate() {
		let ok = !!promptEl.value.trim();
		for (const q of questions) { const input = document.querySelector('[data-q="' + q.id + '"]'); const missing = q.required && (!input || !input.value.trim()); if (input) input.classList.toggle("pMissing", missing); if (missing) ok = false; }
		return ok;
	}
	function scheduleReplan() {
		dirty = true; clearTimeout(replanTimer);
		replanTimer = setTimeout(() => {
			if (!validate()) return;
			dirty = false; vscode.postMessage({ type: "replanPlan", prompt: promptEl.value.trim(), answers: answers() });
		}, 700);
	}
	document.getElementById("pApprove").addEventListener("click", () => {
		const prompt = promptEl.value.trim(); if (!validate()) { approvalMetaEl.textContent = "חסרות תשובות חובה לפני אישור."; return; }
		if (dirty) { dirty = false; vscode.postMessage({ type: "replanPlan", prompt, answers: answers() }); return; }
		approvalEl.hidden = true; vscode.postMessage({ type: approvalKind === "site-brief" ? "approveSiteBrief" : "approvePlan", prompt, answers: answers() });
	});
	document.getElementById("pReplan").addEventListener("click", () => { if (!validate()) return; dirty = false; vscode.postMessage({ type: "replanPlan", prompt: promptEl.value.trim(), answers: answers() }); });
	document.getElementById("pResearch").addEventListener("click", () => { if (!validate()) return; dirty = false; vscode.postMessage({ type: "researchPlan", prompt: promptEl.value.trim(), answers: answers() }); });
	document.getElementById("pCancel").addEventListener("click", () => { approvalEl.hidden = true; vscode.postMessage({ type: "cancelPlan" }); });
	document.getElementById("pAnnotate").addEventListener("click", () => { const input = document.getElementById("pAnnotation"); const note = input.value.trim(); if (!note) return; vscode.postMessage({ type: "artifactAnnotation", artifact: document.getElementById("pArtifact").value, note }); input.value = ""; document.getElementById("pAnnotationMeta").textContent = "ההערה נקלטה ונוספה לתור העבודה."; });
	promptEl.addEventListener("input", scheduleReplan);

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
		} else if (m.type === "approval") {
			stopReadyHandshake();
			promptEl.value = m.prompt || ""; questions = Array.isArray(m.questions) ? m.questions : []; revision = m.revision || 0; approvalKind = m.kind || "plan";
			const briefEl = document.getElementById("pBrief");
			if (approvalKind === "site-brief" && m.brief) {
				briefEl.hidden = false;
				briefEl.innerHTML = "";
				briefEl.appendChild(el("div", "pBriefKicker", "בריף אתר · אישור לפני קוד"));
				briefEl.appendChild(el("h2", "pBriefTitle", m.prompt || "אתר חדש"));
				const grid = el("div", "pBriefGrid");
				[["קהל", m.brief.audience], ["סקשנים", (m.brief.sections || []).join(" · ")], ["טון", m.brief.tone], ["רפרנסים", (m.brief.references || []).join(" · ")], ["תנועה", m.brief.motion && m.brief.motion.label]].forEach(function (row) {
					const card = el("div", "pBriefCard");
					card.appendChild(el("span", "pBriefLabel", row[0]));
					card.appendChild(el("div", "pBriefValue", row[1] || "—"));
					grid.appendChild(card);
				});
				briefEl.appendChild(grid);
			} else { briefEl.hidden = true; briefEl.innerHTML = ""; }
			questionsEl.innerHTML = "";
			for (const q of questions) { const wrap = el("label", "pQuestion"); wrap.appendChild(el("span", "pQuestionLabel", q.label + (q.required ? " *" : ""))); const input = el("input", "pQuestionInput"); input.dataset.q = q.id; input.placeholder = q.placeholder || ""; input.value = (m.answers || {})[q.id] || ""; input.addEventListener("input", scheduleReplan); wrap.appendChild(input); questionsEl.appendChild(wrap); }
			approvalMetaEl.textContent = approvalKind === "site-brief"
				? "הבנייה חסומה עד אישור הבריף. אחרי האישור פליקס חוקר רפרנסים ורק אז כותב קוד."
				: (m.researched ? "המחקר המקדים הושלם · " : "") + "תבנית " + (m.projectType || "project") + " · גרסה " + revision + ". שינוי נוסף דורש re-plan לפני ביצוע.";
			dirty = false; approvalEl.hidden = false; promptEl.focus();
		} else if (m.type === "planFlowing") {
			stopReadyHandshake();
			approvalEl.hidden = true;
			document.getElementById("pFlowMeta").textContent = "הביצוע רץ עכשיו. כל הערה נשלחת ל-turn הפעיל ומעדכנת את התוכנית בלי לעצור אותו.";
		}
	});

	requestPlanState();
	readyTimer = setInterval(requestPlanState, 500);
})();
