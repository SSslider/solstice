"use strict";
// Solstice live preview panel — wraps the workspace preview server (or a running
// dev server) in an iframe with selectable device frames (desktop / tablet /
// iPhone / Android), a live "building" indicator, and auto-reload as the agent
// writes files. Lets Thomas watch the site/app take shape and check responsive
// layouts before deploying.
(function () {
  const vscode = window.acquireVsCodeApi ? acquireVsCodeApi() : { postMessage() {} };

  // width × height in CSS px; bezel describes the on-screen chrome around it
  const DEVICES = {
    desktop: { label: "מסך מלא", w: 0, h: 0, bezel: "none", glyph: "🖥" },
    tablet:  { label: "טאבלט · iPad", w: 834, h: 1112, bezel: "pad", glyph: "▢" },
    iphone:  { label: "אייפון", w: 390, h: 844, bezel: "ios", glyph: "📱" },
    android: { label: "אנדרואיד", w: 412, h: 915, bezel: "droid", glyph: "📱" },
  };
  const ORDER = ["desktop", "tablet", "iphone", "android"];

  let url = "";
  let device = "desktop";
  let building = false;
  let buildTimer = 0;

  const root = document.getElementById("app");
  root.innerHTML = `
    <div class="pvbar">
      <div class="pvdevs" id="pvdevs"></div>
      <div class="pvlive" id="pvlive"><span class="pvdot"></span><span id="pvlivetxt">ממתין</span></div>
      <div class="pvspacer"></div>
      <div class="pvurl" id="pvurl"></div>
      <button class="pvbtn" id="pvreload" title="רענון">⟳</button>
      <button class="pvbtn" id="pvext" title="פתח בדפדפן">⤢</button>
    </div>
    <div class="pvprog" id="pvprog"></div>
    <div class="pvstage" id="pvstage">
      <div class="pvframe" id="pvframe">
        <div class="pvnotch" id="pvnotch"></div>
        <iframe id="pvif" title="preview" sandbox="allow-scripts allow-same-origin allow-forms allow-popups"></iframe>
        <div class="pvshim" id="pvshim"><div class="pvshimbar"></div><div class="pvshimtxt">נבנה…</div></div>
        <div class="pvhome" id="pvhome"></div>
      </div>
    </div>`;

  const devs = document.getElementById("pvdevs");
  ORDER.forEach((k) => {
    const b = document.createElement("button");
    b.className = "pvdev" + (k === device ? " on" : "");
    b.dataset.dev = k;
    b.innerHTML = `<span class="pvg">${DEVICES[k].glyph}</span>${DEVICES[k].label}`;
    b.onclick = () => setDevice(k);
    devs.appendChild(b);
  });

  const stage = document.getElementById("pvstage");
  const frame = document.getElementById("pvframe");
  const iframe = document.getElementById("pvif");
  const shim = document.getElementById("pvshim");
  const prog = document.getElementById("pvprog");
  const liveTxt = document.getElementById("pvlivetxt");
  const live = document.getElementById("pvlive");
  const urlEl = document.getElementById("pvurl");

  document.getElementById("pvreload").onclick = () => reload();
  document.getElementById("pvext").onclick = () => vscode.postMessage({ type: "openExternal", url });

  function setDevice(k) {
    device = k;
    [...devs.children].forEach((c) => c.classList.toggle("on", c.dataset.dev === k));
    layout();
    vscode.postMessage({ type: "device", device: k });
  }

  // Scale the device frame to fit the available stage area.
  function layout() {
    const d = DEVICES[device];
    frame.className = "pvframe pv-" + d.bezel;
    if (d.bezel === "none") {
      frame.style.transform = "";
      frame.style.width = "100%";
      frame.style.height = "100%";
      iframe.style.width = "100%";
      iframe.style.height = "100%";
      return;
    }
    iframe.style.width = d.w + "px";
    iframe.style.height = d.h + "px";
    // outer bezel padding so phones/tablets get a visible body
    const padX = d.bezel === "pad" ? 26 : 12;
    const padTop = d.bezel === "ios" ? 14 : d.bezel === "droid" ? 16 : 26;
    const padBot = d.bezel === "ios" ? 14 : d.bezel === "droid" ? 16 : 26;
    frame.style.width = d.w + padX * 2 + "px";
    frame.style.height = d.h + padTop + padBot + "px";
    const avail = stage.getBoundingClientRect();
    const sw = (avail.width - 24) / (d.w + padX * 2);
    const sh = (avail.height - 24) / (d.h + padTop + padBot);
    const s = Math.min(1, sw, sh);
    frame.style.transform = `scale(${s})`;
  }
  window.addEventListener("resize", layout);

  function reload() {
    if (!url) return;
    const u = url + (url.includes("?") ? "&" : "?") + "__t=" + Date.now();
    iframe.src = u;
    urlEl.textContent = url.replace(/^https?:\/\//, "");
  }

  function setBuilding(on) {
    building = on;
    shim.classList.toggle("show", on);
    prog.classList.toggle("run", on);
    live.className = "pvlive " + (on ? "build" : url ? "ok" : "");
    liveTxt.textContent = on ? "נבנה…" : url ? "חי" : "ממתין";
  }

  window.addEventListener("message", (e) => {
    const m = e.data || {};
    if (m.type === "load") {
      url = m.url || "";
      if (m.device && DEVICES[m.device]) setDevice(m.device);
      reload();
      layout();
      if (!building) { live.className = "pvlive ok"; liveTxt.textContent = "חי"; }
    } else if (m.type === "reload") {
      reload();
      // a reload during a build => pulse the building shimmer briefly
      setBuilding(true);
      clearTimeout(buildTimer);
      buildTimer = setTimeout(() => setBuilding(false), m.holdMs || 900);
    } else if (m.type === "building") {
      clearTimeout(buildTimer);
      setBuilding(!!m.on);
    } else if (m.type === "device") {
      if (DEVICES[m.device]) setDevice(m.device);
    }
  });

  vscode.postMessage({ type: "ready" });
})();
