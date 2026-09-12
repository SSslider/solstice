'use strict';
// Real Chromium behavior checks. Set PLAYWRIGHT_MODULE if Playwright is provided
// by the development host; SCROLLWORLD_ENGINE supports baseline/mutation probes.
const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const engine = process.env.SCROLLWORLD_ENGINE || path.join(__dirname, 'prompts/scroll-world/references/scrub-engine.js');
let checks = 0;
function check(value, label) { assert.ok(value, label); checks++; }
(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', args: ['--no-sandbox'], headless: true });
  try {
    for (const mode of ['desktop', 'mobile', 'reduced']) {
      const page = await browser.newPage({ viewport: mode === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 960 }, reducedMotion: mode === 'reduced' ? 'reduce' : 'no-preference' });
      page.setDefaultTimeout(3000);
      const errors = []; page.on('pageerror', e => errors.push(e.message));
      await page.setContent('<html dir="rtl"><body><div id="world"></div></body></html>');
      await page.evaluate(() => {
        window.activeFrames = new Set();
        const request = window.requestAnimationFrame.bind(window), cancel = window.cancelAnimationFrame.bind(window);
        window.requestAnimationFrame = cb => { const id = request(t => { activeFrames.delete(id); cb(t); }); activeFrames.add(id); return id; };
        window.cancelAnimationFrame = id => { activeFrames.delete(id); cancel(id); };
      });
      await page.addScriptTag({ path: engine });
      await page.evaluate(() => {
        const asset = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="960"><rect width="1440" height="960" fill="#456"/><circle cx="480" cy="320" r="160" fill="#a97"/></svg>');
        window.config = { atmosphere: false, backLabel: 'חזרה למסע', sections: [
          { label: 'חצר', still: asset, title: 'חצר', camera: { from: { scale: 1.1, x: 0 }, to: { scale: 1.5, x: 2 } }, layers: [{ src: asset, depth: 1.8 }], hotspots: [{ label: 'כניסה', title: '<img src=x onerror=alert(1)>', body: 'detail text', x: 35, y: 35, mobile: { x: 60, y: 25 }, zoom: 1.8 }] },
          { label: 'מים', still: asset, title: 'מים', hotspots: [{ label: 'המים', title: 'מים', body: 'water detail' }] },
          { label: 'סיום', still: asset, title: 'סיום', cta: { primary: { label: 'סיום', href: '#end' } } }
        ] };
        window.original = JSON.stringify(config);
        window.world = mountScrollWorld(document.getElementById('world'), config);
      });
      await page.waitForFunction(() => document.querySelector('.sw-hotspot'));
      check(await page.locator('.sw-hotspots__group:not([hidden])').count() === 1, mode + ': only active chapter hotspots are visible');
      check(await page.locator('.sw-copy').last().evaluate(n => n.inert), mode + ': invisible chapter CTA is not focusable');
      const position = await page.locator('.sw-hotspot').first().evaluate(n => [n.style.left, n.style.top]);
      check(position[0] === (mode === 'mobile' ? '60%' : '35%'), mode + ': mobile composition uses explicit hotspot coordinates');
      await page.evaluate(() => window.scrollTo(0, 200));
      await page.waitForTimeout(60);
      const saved = await page.evaluate(() => window.scrollY);
      const button = page.locator('.sw-hotspot').first();
      await button.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.querySelector('dialog').open);
      check(await page.locator('.sw-detail__copy h2').innerText() === '<img src=x onerror=alert(1)>', mode + ': copy is plain text');
      check(await page.locator('.sw-detail__copy img').count() === 0, mode + ': markup is never executed');
      check(await page.evaluate(() => document.activeElement.className === 'sw-detail__back'), mode + ': keyboard focus enters dialog');
      await page.keyboard.press('Tab');
      check(await page.evaluate(() => !document.activeElement.closest('.sw-hotspots,.sw-topbar')), mode + ': background is inert while inside');
      if (mode === 'reduced') {
        check(await page.locator('.sw-detail__image').evaluate(n => getComputedStyle(n).animationName === 'none' && getComputedStyle(n).transform === 'none'), 'reduced: entry camera motion suppressed');
      }
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !document.querySelector('dialog').open);
      await page.waitForTimeout(30);
      check(await page.evaluate(y => window.scrollY === y && document.body.style.overflow === '', saved), mode + ': Escape restores exact scroll and overflow');
      check(await button.evaluate(n => document.activeElement === n), mode + ': Escape restores hotspot focus');
      await button.click(); await page.locator('.sw-detail__back').click();
      await page.waitForTimeout(30);
      check(await page.evaluate(y => window.scrollY === y && !document.querySelector('dialog').open, saved), mode + ': visible back button restores exact position');
      const first = await page.locator('.sw-scene__still').first().evaluate(n => n.style.transform);
      await page.evaluate(() => scrollTo(0, 550)); await page.waitForTimeout(60);
      const second = await page.locator('.sw-scene__still').first().evaluate(n => n.style.transform);
      check(mode === 'reduced' ? first === second : first !== second, mode + ': camera follows scroll respecting reduced motion');
      const layer = await page.locator('.sw-scene__layer').first().evaluate(n => n.style.transform);
      check(mode === 'reduced' ? layer === 'none' : layer !== second && layer.includes('scale'), mode + ': foreground has independent depth');
      const scales = await page.evaluate(() => ['.sw-scene__still', '.sw-scene__layer'].map(selector => new DOMMatrixReadOnly(getComputedStyle(document.querySelector(selector)).transform).a));
      check(mode === 'reduced' ? scales.every(scale => scale === 1) : scales[1] > scales[0], mode + ': foreground expands faster than the background as the camera approaches');
      await page.evaluate(() => scrollTo(0, innerHeight * 1.8)); await page.waitForTimeout(60);
      check(await page.locator('.sw-hotspots__group:not([hidden]) button').innerText() === 'המים', mode + ': scrolling selects next chapter interaction');
      await page.locator('.sw-hotspots__group:not([hidden]) button').click();
      const framesAfterDestroy = await page.evaluate(() => { world.destroy(); return activeFrames.size; });
      check(framesAfterDestroy === 0, mode + ': teardown cancels frames synchronously');
      await page.waitForTimeout(30);
      check(await page.evaluate(() => !document.querySelector('.sw-stage,dialog') && document.body.style.overflow === ''), mode + ': destroying an open detail restores the document');
      check(await page.evaluate(() => activeFrames.size === 0), mode + ': all animation frames cancelled');
      check(await page.evaluate(() => JSON.stringify(config) === original), mode + ': input configuration was not mutated');
      await page.evaluate(() => { world.destroy(); world = mountScrollWorld(document.getElementById('world'), config); });
      check(await page.locator('.sw-stage').count() === 1, mode + ': remount has one stage');
      await page.evaluate(() => world.destroy());
      check(errors.length === 0, mode + ': no browser exceptions');
      await page.close();
    }
    const page = await browser.newPage();
    await page.setContent('<div id="world"></div>');
    await page.addScriptTag({ path: engine });
    await page.evaluate(() => {
      window.resolveClip = null; window.createdURLs = 0;
      window.fetch = () => new Promise(resolve => { window.resolveClip = resolve; });
      const create = URL.createObjectURL.bind(URL);
      URL.createObjectURL = blob => { createdURLs++; return create(blob); };
      window.world = mountScrollWorld(document.getElementById('world'), {sections:[{label:'late clip',clip:'/clip.mp4'}]});
      world.destroy();
      resolveClip({ok:true,blob:()=>Promise.resolve(new Blob(['not media']))});
    });
    await page.waitForTimeout(80);
    check(await page.evaluate(() => createdURLs === 0 && !document.querySelector('video')), 'late fetch after unmount cannot create a media URL or revive a scene');
    await page.close();
    const resources = await browser.newPage({ reducedMotion: 'no-preference' });
    await resources.setContent('<div id="world"></div>');
    await resources.addScriptTag({ path: engine });
    await resources.evaluate(() => {
      window.created = []; window.revoked = [];
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = blob => { const url = create(blob); created.push(url); return url; };
      URL.revokeObjectURL = url => { revoked.push(url); revoke(url); };
      // Real browser blob URLs; decoding is irrelevant to URL ownership.
      window.fetch = async () => ({ ok: true, blob: async () => new Blob(['media fixture']) });
    });
    for (let cycle = 0; cycle < 3; cycle++) {
      await resources.evaluate(() => {
        window.world = mountScrollWorld(document.getElementById('world'), { sections: [
          { label: 'first', clip: '/first.mp4' }, { label: 'second', clip: '/second.mp4' }
        ] });
      });
      await resources.waitForFunction(n => created.length === n && document.querySelectorAll('video').length === 2, (cycle + 1) * 2);
      const urls = await resources.evaluate(() => {
        const before = revoked.slice(); world.destroy(); world.destroy();
        return { created, revoked, before };
      });
      check(urls.before.length === cycle * 2 && new Set(urls.created).size === (cycle + 1) * 2,
        'blob cleanup: distinct owned URLs exist before teardown, cycle ' + cycle);
      check(JSON.stringify([...urls.created].sort()) === JSON.stringify([...urls.revoked].sort()),
        'blob cleanup: destroy revokes every owned URL exactly once, cycle ' + cycle);
    }
    await resources.close();

    const frames = await browser.newPage();
    await frames.setContent('<div id="world"></div>');
    await frames.addScriptTag({ path: engine });
    const cleanup = await frames.evaluate(() => {
      const pending = new Set(), cancelled = [];
      const request = requestAnimationFrame.bind(window), cancel = cancelAnimationFrame.bind(window);
      window.requestAnimationFrame = cb => {
        const id = request(t => { pending.delete(id); cb(t); }); pending.add(id); return id;
      };
      window.cancelAnimationFrame = id => { cancelled.push(id); pending.delete(id); cancel(id); };
      const world = mountScrollWorld(document.getElementById('world'), { sections: [{ label: 'frames' }] });
      const render = [...pending];
      // Queue the scroll reader and destroy in this same JS task: neither native RAF can fire first.
      dispatchEvent(new Event('scroll'));
      const both = [...pending]; world.destroy(); world.destroy();
      const after = [...pending]; dispatchEvent(new Event('scroll'));
      return { render, both, cancelled, after, afterScroll: [...pending] };
    });
    check(cleanup.render.length === 1 && cleanup.both.length === 2 && new Set(cleanup.both).size === 2,
      'RAF cleanup: render and scroll-read requests are both pending before destroy');
    check(cleanup.both.every(id => cleanup.cancelled.filter(value => value === id).length === 1) && cleanup.after.length === 0,
      'RAF cleanup: destroy synchronously cancels both pending frame IDs exactly once');
    check(cleanup.afterScroll.length === 0, 'RAF cleanup: scroll after destroy cannot queue another read');
    await frames.close();
    console.log(`scrollWorldBrowser.test.js: ${checks}/${checks} browser checks passed`);
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
