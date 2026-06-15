"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let meta = { provider: "Composer 2.5", version: "", agents: [] };

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	// the pipeline a message travels through, Thomas → … → live preview, and back
	function stages() {
		return [
			{ id: "you", glyph: "🧑", title: "אתה", sub: "Telegram / צ׳אט Fleet", desc: "שולח משימה: \u201Cבנה את reformcollective\u201D" },
			{ id: "fleet", glyph: "☀", title: "Fleet", sub: "פאנל הצי ב-IDE", desc: "המשימה נכנסת ל-thread של הסוכן הנכון" },
			{ id: "bridge", glyph: "⇄", title: "FleetBridge", sub: "WebSocket חי", desc: "מעביר את ההודעה בזמן אמת לשרת ובחזרה" },
			{ id: "brain", glyph: "❖", title: "מוח הסוכן", sub: "ג׳ספר / אוריון · בשרת", desc: "מתכנן, מפרק את האתר, מחליט מה לבנות" },
			{ id: "solstice", glyph: "◆", title: "Solstice", sub: meta.provider + " · בונה", desc: "כותב קוד, מריץ, מתקן — עם אישורי פעולה" },
			{ id: "out", glyph: "▲", title: "תוצר חי", sub: "Preview · Vercel · Atrium", desc: "אתר/אפליקציה שאתה רואה ומאשר" },
		];
	}

	function node(s, i) {
		const n = el("div", "node node--" + s.id);
		n.style.setProperty("--i", String(i));
		const orb = el("div", "orb");
		orb.appendChild(el("span", "orbGlyph", s.glyph));
		n.appendChild(orb);
		n.appendChild(el("div", "nTitle", s.title));
		n.appendChild(el("div", "nSub", s.sub));
		n.appendChild(el("div", "nDesc", s.desc));
		return n;
	}

	function connector(i, back) {
		const c = el("div", "conn" + (back ? " conn--back" : ""));
		c.style.setProperty("--i", String(i));
		const line = el("div", "connLine");
		for (let k = 0; k < 3; k++) {
			const dot = el("span", "packet");
			dot.style.animationDelay = (k * 0.9 + i * 0.25) + "s";
			line.appendChild(dot);
		}
		c.appendChild(line);
		return c;
	}

	function render() {
		app.innerHTML = "";
		const wrap = el("div", "wf");

		const head = el("div", "wfHead");
		const h = el("div", "wfTitleWrap");
		h.appendChild(el("div", "wfTitle", "איך Solstice עובד"));
		h.appendChild(el("div", "wfSub", "מהמשימה שלך ועד אתר חי — בזמן אמת"));
		head.appendChild(h);
		const badge = el("div", "wfBadge");
		badge.appendChild(el("span", "wfBadgeDot"));
		badge.appendChild(document.createTextNode(meta.provider + (meta.version ? "  ·  Solstice " + meta.version : "")));
		head.appendChild(badge);
		wrap.appendChild(head);

		// forward pipeline
		const flow = el("div", "flow");
		const sg = stages();
		sg.forEach((s, i) => {
			flow.appendChild(node(s, i));
			if (i < sg.length - 1) flow.appendChild(connector(i));
		});
		wrap.appendChild(flow);

		// return path caption
		const ret = el("div", "retPath");
		const rl = el("div", "retLine");
		for (let k = 0; k < 4; k++) { const d = el("span", "packet packet--back"); d.style.animationDelay = (k * 0.7) + "s"; rl.appendChild(d); }
		ret.appendChild(rl);
		ret.appendChild(el("div", "retLabel", "↩ התשובה, ה-preview והעדכונים חוזרים אליך באותו ערוץ"));
		wrap.appendChild(ret);

		// legend cards
		const leg = el("div", "legend");
		[
			["⇄", "Bridge חי", "חיבור WebSocket מתמשך — לא polling. כל פעולה שהסוכן עושה נראית מיד ב-Fleet."],
			["🛡", "אישורי פעולה", "כתיבה לקובץ / הרצת פקודה עוברת gate — אתה מאשר או דוחה לפני ביצוע."],
			["⚠", "Watchdog", "אם סוכן נתקע בלולאה מעבר לסף — נדלקת התראה במקום שקט של שעות."],
			["⊟", "מד טוקנים", "צריכת xAI/Composer מוצגת בזמן אמת כדי לא לשרוף את החבילה בלי לדעת."],
		].forEach(([g, t, d]) => {
			const card = el("div", "legCard");
			card.appendChild(el("span", "legGlyph", g));
			const b = el("div", "");
			b.appendChild(el("div", "legTitle", t));
			b.appendChild(el("div", "legDesc", d));
			card.appendChild(b);
			leg.appendChild(card);
		});
		wrap.appendChild(leg);

		app.appendChild(wrap);
	}

	window.addEventListener("message", (e) => {
		const m = e.data;
		if (m && m.type === "model") {
			meta = { provider: m.provider || meta.provider, version: m.version || "", agents: Array.isArray(m.agents) ? m.agents : [] };
			render();
		}
	});

	render();
	vscode.postMessage({ type: "ready" });
})();
