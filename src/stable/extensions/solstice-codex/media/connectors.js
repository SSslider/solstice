"use strict";
(function () {
	const vscode = acquireVsCodeApi();
	const app = document.getElementById("app");
	let connectors = [];

	const STATUS = {
		connected: { label: "מחובר", cls: "ok" },
		requested: { label: "ממתין לאישור — לחץ 'חבר'", cls: "wait" },
		disconnected: { label: "לא מחובר", cls: "off" },
	};

	function el(tag, cls, text) {
		const e = document.createElement(tag);
		if (cls) e.className = cls;
		if (text !== undefined) e.textContent = text;
		return e;
	}

	function render() {
		app.innerHTML = "";
		const head = el("div", "cHead");
		const tw = el("div", "cTitleWrap");
		tw.appendChild(el("span", "cMark", "🔌"));
		const tt = el("div");
		tt.appendChild(el("div", "cTitle", "Connectors"));
		tt.appendChild(el("div", "cSub", "חבר פרויקטים שנבנו ב-Solstice לשירותים חיצוניים"));
		tw.appendChild(tt);
		head.appendChild(tw);
		app.appendChild(head);

		const grid = el("div", "cGrid");
		for (const c of connectors) grid.appendChild(card(c));
		app.appendChild(grid);

		app.appendChild(el("div", "cNote", "לחיצה על 'חבר' פותחת את דף ההתחברות של הספק בדפדפן — מתחברים, יוצרים token ומדביקים בשדה מאובטח. ה-credential נשמר בכספת המוצפנת (לא נחשף לסוכן ולא נכתב לקובץ)."));
	}

	function card(c) {
		const card = el("div", "cCard cCard--" + c.id);
		const top = el("div", "cTop");
		top.appendChild(el("span", "cGlyph", c.glyph || "◆"));
		const meta = el("div", "cMeta");
		meta.appendChild(el("div", "cName", c.name));
		meta.appendChild(el("div", "cBlurb", c.blurb || ""));
		top.appendChild(meta);
		card.appendChild(top);

		const st = STATUS[c.status] || STATUS.disconnected;
		const row = el("div", "cStatusRow");
		const dot = el("span", "cDot cDot--" + st.cls);
		row.appendChild(dot);
		row.appendChild(el("span", "cStatusText cStatusText--" + st.cls, st.label));
		card.appendChild(row);

		card.appendChild(el("div", "cToken", "token: " + c.tokenKey));

		if (c.status === "connected") {
			const b = el("button", "cBtn cBtn--ok", "מחובר ✓ — נתק");
			b.addEventListener("click", () => vscode.postMessage({ type: "disconnect", id: c.id }));
			card.appendChild(b);
		} else {
			const b = el("button", "cBtn cBtn--primary", c.status === "requested" ? "חבר עכשיו" : "חבר");
			b.addEventListener("click", () => vscode.postMessage({ type: "connect", id: c.id }));
			card.appendChild(b);
		}
		return card;
	}

	window.addEventListener("message", (event) => {
		const msg = event.data;
		if (msg.type === "connectors") { connectors = Array.isArray(msg.connectors) ? msg.connectors : []; render(); }
	});

	render();
	vscode.postMessage({ type: "ready" });
})();
