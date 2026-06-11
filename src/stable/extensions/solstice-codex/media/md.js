"use strict";
// Minimal markdown -> DOM renderer (no innerHTML with content — XSS-safe).
// Exposes window.mdRender(text) -> DocumentFragment.
(function () {
	function inline(target, text) {
		// links, bold, italics, inline code
		const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;
		let last = 0, m;
		while ((m = re.exec(text))) {
			if (m.index > last) target.appendChild(document.createTextNode(text.slice(last, m.index)));
			if (m[1]) {
				const c = document.createElement("code");
				c.textContent = m[1].slice(1, -1);
				target.appendChild(c);
			} else if (m[2]) {
				const b = document.createElement("strong");
				inline(b, m[2].slice(2, -2));
				target.appendChild(b);
			} else if (m[3]) {
				const i = document.createElement("em");
				inline(i, m[3].slice(1, -1));
				target.appendChild(i);
			} else if (m[4]) {
				const a = document.createElement("a");
				a.href = m[6];
				a.textContent = m[5];
				target.appendChild(a);
			}
			last = re.lastIndex;
		}
		if (last < text.length) target.appendChild(document.createTextNode(text.slice(last)));
	}

	function mdRender(text) {
		const frag = document.createDocumentFragment();
		const lines = String(text || "").split("\n");
		let i = 0;
		let list = null, listOrdered = false;
		const closeList = () => { list = null; };
		while (i < lines.length) {
			const line = lines[i];
			// fenced code block
			const fence = line.match(/^```(\w*)\s*$/);
			if (fence) {
				closeList();
				const buf = [];
				i++;
				while (i < lines.length && !/^```\s*$/.test(lines[i])) { buf.push(lines[i]); i++; }
				i++; // skip closing fence
				const pre = document.createElement("pre");
				pre.className = "mdcode";
				const code = document.createElement("code");
				code.textContent = buf.join("\n");
				pre.appendChild(code);
				frag.appendChild(pre);
				continue;
			}
			const h = line.match(/^(#{1,4})\s+(.*)$/);
			if (h) {
				closeList();
				const el = document.createElement("h" + Math.min(4, h[1].length + 2));
				el.className = "mdh";
				inline(el, h[2]);
				frag.appendChild(el);
				i++;
				continue;
			}
			const li = line.match(/^\s*([-*]|\d+\.)\s+(.*)$/);
			if (li) {
				const ordered = /\d/.test(li[1][0]);
				if (!list || listOrdered !== ordered) {
					list = document.createElement(ordered ? "ol" : "ul");
					list.className = "mdlist";
					listOrdered = ordered;
					frag.appendChild(list);
				}
				const item = document.createElement("li");
				inline(item, li[2]);
				list.appendChild(item);
				i++;
				continue;
			}
			closeList();
			if (line.trim() === "") { i++; continue; }
			// paragraph: merge consecutive plain lines
			const buf = [line];
			i++;
			while (i < lines.length && lines[i].trim() !== "" &&
				!/^```|^(#{1,4})\s|^\s*([-*]|\d+\.)\s/.test(lines[i])) {
				buf.push(lines[i]);
				i++;
			}
			const p = document.createElement("p");
			p.className = "mdp";
			inline(p, buf.join("\n"));
			frag.appendChild(p);
		}
		return frag;
	}

	window.mdRender = mdRender;
})();
