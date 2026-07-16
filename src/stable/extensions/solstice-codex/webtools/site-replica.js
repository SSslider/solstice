"use strict";

const fs = require("fs");
const path = require("path");

const BREAKPOINTS = Object.freeze([
	{ name: "desktop", width: 1440, height: 900, mobile: false },
	{ name: "tablet", width: 1024, height: 768, mobile: false },
	{ name: "mobile", width: 390, height: 844, mobile: true },
]);
const TARGET_SCORE = 80;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function safeHttpUrl(value) {
	const parsed = new URL(String(value || ""));
	if (!/^https?:$/.test(parsed.protocol)) throw new Error("replica source must use http or https");
	if (parsed.username || parsed.password) throw new Error("replica source URL must not contain credentials");
	parsed.hash = "";
	return parsed.toString();
}

function safeOutputDir(value) {
	const resolved = path.resolve(String(value || ""));
	if (!value || resolved === path.parse(resolved).root) throw new Error("replica output directory is unsafe");
	return resolved;
}

function writeJson(file, value) {
	fs.mkdirSync(path.dirname(file), { recursive: true });
	const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
	fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
	fs.renameSync(temp, file);
}

function markdownCell(value) {
	return String(value == null ? "" : value).replace(/\|/g, "\\|").replace(/[\r\n]+/g, " ").slice(0, 240);
}

async function settlePage(evalJs) {
	for (let index = 0; index < 14; index++) {
		const metrics = await evalJs("({height:Math.max(document.body?.scrollHeight||0,document.documentElement.scrollHeight),viewport:innerHeight})");
		const y = Math.min(Math.max(0, Number(metrics.height || 0) - Number(metrics.viewport || 0)), index * Math.max(420, Math.round(Number(metrics.viewport || 800) * 0.72)));
		await evalJs(`window.scrollTo({top:${y},behavior:'instant'});''`);
		await sleep(180);
		if (y >= Math.max(0, Number(metrics.height || 0) - 1.1 * Number(metrics.viewport || 0))) break;
	}
	await evalJs(`(() => {
		window.scrollTo({top:0,behavior:'instant'});
		const style=document.createElement('style');
		style.setAttribute('data-solstice-replica-stabilizer','');
		style.textContent='*,*::before,*::after{animation-delay:0s!important;animation-duration:0s!important;transition:none!important;caret-color:transparent!important}html{scroll-behavior:auto!important}';
		document.head.appendChild(style);
		return true;
	})()`);
	await sleep(350);
}

async function captureBreakpoint(session, url, root, point) {
	const { send, evalJs, goto } = session;
	await send("Emulation.setDeviceMetricsOverride", {
		width: point.width, height: point.height, screenWidth: point.width, screenHeight: point.height,
		deviceScaleFactor: 1, mobile: point.mobile, scale: 1,
	});
	await send("Emulation.setVisibleSize", { width: point.width, height: point.height });
	await goto(url, 900);
	await settlePage(evalJs);
	const pageHeight = Math.max(point.height, Math.min(12000, Number(await evalJs("Math.max(document.body?.scrollHeight||0,document.documentElement.scrollHeight)")) || point.height));
	const shot = await send("Page.captureScreenshot", {
		format: "png", fromSurface: true, captureBeyondViewport: true,
		clip: { x: 0, y: 0, width: point.width, height: pageHeight, scale: 1 },
	}, 30000);
	const file = `${point.name}.png`;
	fs.writeFileSync(path.join(root, file), Buffer.from(shot.data, "base64"));
	return { ...point, pageHeight, screenshot: file, finalUrl: String(await evalJs("location.href")) };
}

async function extractDesignModel(evalJs) {
	return await evalJs(`(() => {
		const clean=(v,n=500)=>String(v||'').replace(/\\s+/g,' ').trim().slice(0,n);
		const visible=(el)=>{const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&Number(s.opacity)!==0&&r.width>2&&r.height>2};
		const nodes=[...document.querySelectorAll('body *')].filter(visible).slice(0,1600);
		const count=(values,limit=16)=>Object.entries(values.reduce((m,v)=>{if(v)m[v]=(m[v]||0)+1;return m},{})).sort((a,b)=>b[1]-a[1]).slice(0,limit).map(([value,uses])=>({value,uses}));
		const sections=[...document.querySelectorAll('main>*,body>section,body>header,body>footer,[role=main]>section')].filter(visible).slice(0,40).map((el,index)=>{
			const r=el.getBoundingClientRect(),s=getComputedStyle(el),h=el.querySelector('h1,h2,h3');
			return {index,tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||'',heading:clean(h?.innerText,180),text:clean(el.innerText,700),box:{x:Math.round(r.x),y:Math.round(r.y+scrollY),width:Math.round(r.width),height:Math.round(r.height)},style:{background:s.backgroundColor,color:s.color,fontFamily:clean(s.fontFamily,160),fontSize:s.fontSize,textAlign:s.textAlign}};
		});
		const assets=[...document.images].filter(visible).slice(0,120).map(img=>({src:String(img.currentSrc||img.src||'').slice(0,600),alt:clean(img.alt,240),width:img.naturalWidth||0,height:img.naturalHeight||0}));
		const links=[...document.querySelectorAll('a[href]')].filter(visible).slice(0,120).map(a=>({label:clean(a.innerText||a.getAttribute('aria-label'),160),href:String(a.href||'').slice(0,500)}));
		const styles=nodes.map(el=>getComputedStyle(el));
		return {title:document.title,description:document.querySelector('meta[name=description]')?.content||'',language:document.documentElement.lang||'',direction:document.documentElement.dir||getComputedStyle(document.documentElement).direction,bodyText:clean(document.body?.innerText,18000),headings:[...document.querySelectorAll('h1,h2,h3')].filter(visible).slice(0,80).map(h=>({level:h.tagName.toLowerCase(),text:clean(h.innerText,240)})),sections,assets,links,tokens:{colors:count(styles.flatMap(s=>[s.color,s.backgroundColor,s.borderColor]).filter(v=>v&&!/rgba?\\(0, 0, 0, 0\\)|transparent/i.test(v))),fonts:count(styles.map(s=>s.fontFamily)),fontSizes:count(styles.map(s=>s.fontSize)),radii:count(styles.map(s=>s.borderRadius))}};
	})()`);
}

async function captureReplicaSource(bin, urlValue, outValue, withChrome, options = {}) {
	if (!options.authorized) throw new Error("replica-source requires explicit --authorized confirmation for client-owned/licensed material");
	const url = safeHttpUrl(urlValue);
	const root = safeOutputDir(outValue);
	fs.mkdirSync(root, { recursive: true });
	let result;
	await withChrome(bin, async (session) => {
		const breakpoints = [];
		for (const point of BREAKPOINTS) breakpoints.push(await captureBreakpoint(session, url, root, point));
		await session.goto(url, 700);
		await settlePage(session.evalJs);
		const design = await extractDesignModel(session.evalJs);
		result = {
			version: 1, kind: "solstice-replica-source", capturedAt: new Date().toISOString(), sourceUrl: url,
			authorization: { confirmed: true, basis: "operator-confirmed client-owned or licensed source", scope: "internal rebuild; no source-code copying or third-party brand resale" },
			breakpoints, design,
		};
	});
	writeJson(path.join(root, "source-manifest.json"), result);
	const sectionRows = result.design.sections.map((section) => `| ${section.index + 1} | ${markdownCell(section.heading || section.tag)} | ${section.box.width}×${section.box.height} | ${markdownCell(section.style.background)} |`).join("\n") || "| — | No visible sections extracted | — | — |";
	const md = [
		`# Replica source deconstruction — ${result.design.title || new URL(url).hostname}`, "",
		`Source: ${url}`, `Captured: ${result.capturedAt}`, "",
		"> Authorized internal rebuild evidence. Solstice captured rendered structure, content, design tokens and screenshots; it did not copy source code.", "",
		"## Breakpoint evidence", "", ...result.breakpoints.map((point) => `- [${point.name} ${point.width}×${point.height}](./${point.screenshot}) · rendered height ${point.pageHeight}px`), "",
		"## Design tokens", "", `- Colors: ${result.design.tokens.colors.map((item) => `${item.value} (${item.uses})`).join(", ") || "none"}`, `- Fonts: ${result.design.tokens.fonts.map((item) => `${item.value} (${item.uses})`).join(", ") || "none"}`, `- Type scale: ${result.design.tokens.fontSizes.map((item) => `${item.value} (${item.uses})`).join(", ") || "none"}`, "",
		"## Section map", "", "| # | rendered section | geometry | background |", "|---:|---|---:|---|", sectionRows, "",
		"## Rebuild contract", "", "- Recreate the rendered information architecture, content hierarchy, palette, typography and responsive behavior in the project stack.", "- Do not copy HTML, CSS, JavaScript, tracking code, authentication state or hidden source assets.", "- Preserve only assets the operator has rights to use; otherwise create or license replacements.", "- Run `replica-compare` after the functional browser gate and fix visual gaps until the score reaches 80 or the three-round gate fails closed.", "",
	].join("\n");
	fs.writeFileSync(path.join(root, "DECONSTRUCT.md"), md);
	return result;
}

async function comparePngs(evalJs, sourceFile, replicaFile, heatmapFile) {
	const source = `data:image/png;base64,${fs.readFileSync(sourceFile).toString("base64")}`;
	const replica = `data:image/png;base64,${fs.readFileSync(replicaFile).toString("base64")}`;
	const result = await evalJs(`(async()=>{
		const load=(src)=>new Promise((resolve,reject)=>{const img=new Image();img.onload=()=>resolve(img);img.onerror=()=>reject(new Error('image decode failed'));img.src=src});
		const [a,b]=await Promise.all([load(${JSON.stringify(source)}),load(${JSON.stringify(replica)})]);
		const size=128,canvas=document.createElement('canvas'),ctx=canvas.getContext('2d',{willReadFrequently:true});canvas.width=size;canvas.height=size;
		ctx.drawImage(a,0,0,size,size);const ad=ctx.getImageData(0,0,size,size).data;ctx.clearRect(0,0,size,size);ctx.drawImage(b,0,0,size,size);const bd=ctx.getImageData(0,0,size,size).data;
		let color=0,edge=0;const lum=(d,i)=>.2126*d[i]+.7152*d[i+1]+.0722*d[i+2];
		for(let i=0;i<ad.length;i+=4){color+=(Math.abs(ad[i]-bd[i])+Math.abs(ad[i+1]-bd[i+1])+Math.abs(ad[i+2]-bd[i+2]))/(3*255);if(i>=4){edge+=Math.abs((lum(ad,i)-lum(ad,i-4))-(lum(bd,i)-lum(bd,i-4)))/255}}
		const pixels=ad.length/4,heightRatio=Math.min(a.naturalHeight,b.naturalHeight)/Math.max(a.naturalHeight,b.naturalHeight),visual=Math.max(0,1-(.72*color/pixels+.28*edge/Math.max(1,pixels-1))),score=100*(.86*visual+.14*heightRatio);
		const heat=document.createElement('canvas'),hc=heat.getContext('2d'),scale=4;heat.width=size*scale;heat.height=size*scale;const raw=hc.createImageData(size,size);
		for(let i=0;i<ad.length;i+=4){const d=Math.min(255,Math.round((Math.abs(ad[i]-bd[i])+Math.abs(ad[i+1]-bd[i+1])+Math.abs(ad[i+2]-bd[i+2]))/3*2));raw.data[i]=d;raw.data[i+1]=Math.round((255-d)*.25);raw.data[i+2]=40;raw.data[i+3]=255}const tiny=document.createElement('canvas');tiny.width=size;tiny.height=size;tiny.getContext('2d').putImageData(raw,0,0);hc.imageSmoothingEnabled=false;hc.drawImage(tiny,0,0,heat.width,heat.height);
		return {score:Number(score.toFixed(1)),colorDelta:Number((color/pixels).toFixed(4)),edgeDelta:Number((edge/Math.max(1,pixels-1)).toFixed(4)),heightRatio:Number(heightRatio.toFixed(4)),sourceSize:{width:a.naturalWidth,height:a.naturalHeight},replicaSize:{width:b.naturalWidth,height:b.naturalHeight},heatmap:heat.toDataURL('image/png')};
	})()`);
	fs.writeFileSync(heatmapFile, Buffer.from(String(result.heatmap).split(",")[1], "base64"));
	delete result.heatmap;
	return result;
}

async function compareReplicaVisuals(bin, sourceValue, replicaUrlValue, outValue, withChrome, options = {}) {
	const sourceRoot = safeOutputDir(sourceValue);
	const out = safeOutputDir(outValue);
	const replicaUrl = safeHttpUrl(replicaUrlValue);
	const manifestFile = path.join(sourceRoot, "source-manifest.json");
	if (!fs.existsSync(manifestFile)) throw new Error("source-manifest.json is missing; run replica-source first");
	const source = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
	if (!source.authorization || source.authorization.confirmed !== true) throw new Error("replica source lacks authorization evidence");
	fs.mkdirSync(out, { recursive: true });
	fs.copyFileSync(manifestFile, path.join(out, "source-manifest.json"));
	const deconstruct = path.join(sourceRoot, "DECONSTRUCT.md");
	if (fs.existsSync(deconstruct)) fs.copyFileSync(deconstruct, path.join(out, "SOURCE_DECONSTRUCT.md"));
	const comparisons = [];
	await withChrome(bin, async (session) => {
		for (const point of BREAKPOINTS) {
			const captured = await captureBreakpoint(session, replicaUrl, out, point);
			const sourcePoint = (source.breakpoints || []).find((item) => item.name === point.name);
			if (!sourcePoint) throw new Error(`source evidence missing ${point.name} breakpoint`);
			const sourceFile = path.resolve(sourceRoot, sourcePoint.screenshot);
			if (sourceFile !== sourceRoot && !sourceFile.startsWith(sourceRoot + path.sep)) throw new Error("source screenshot escaped evidence directory");
			const packagedSource = `source-${point.name}.png`;
			fs.copyFileSync(sourceFile, path.join(out, packagedSource));
			const replicaFile = path.join(out, captured.screenshot);
			const heatmap = `${point.name}-diff.png`;
			const metrics = await comparePngs(session.evalJs, sourceFile, replicaFile, path.join(out, heatmap));
			comparisons.push({ breakpoint: point.name, width: point.width, height: point.height, source: packagedSource, replica: captured.screenshot, heatmap, ...metrics });
		}
	});
	const score = Number((comparisons.reduce((sum, item) => sum + item.score, 0) / comparisons.length).toFixed(1));
	const result = { version: 1, kind: "solstice-replica-visual-diff", taskId: String(options.taskId || ""), comparedAt: new Date().toISOString(), sourceUrl: source.sourceUrl, replicaUrl, targetScore: TARGET_SCORE, score, ok: score >= TARGET_SCORE, comparisons };
	writeJson(path.join(out, "visual-diff.json"), result);
	const rows = comparisons.map((item) => `| ${item.breakpoint} | ${item.score} | [source](${item.source}) | [replica](./${item.replica}) | [diff](./${item.heatmap}) |`).join("\n");
	fs.writeFileSync(path.join(out, "VISUAL_DIFF.md"), ["# Replica visual comparison", "", `Source: ${source.sourceUrl}`, `Replica: ${replicaUrl}`, `Score: **${score}/100** · target **${TARGET_SCORE}** · ${result.ok ? "PASS" : "FIX REQUIRED"}`, "", "| breakpoint | score | source | replica | heatmap |", "|---|---:|---|---|---|", rows, "", "Scores are deterministic rendered-image comparisons at the same desktop/tablet/mobile breakpoints. A passing score never overrides the functional CP-F1 gate.", ""].join("\n"));
	return result;
}

module.exports = { BREAKPOINTS, TARGET_SCORE, safeHttpUrl, captureReplicaSource, compareReplicaVisuals };
