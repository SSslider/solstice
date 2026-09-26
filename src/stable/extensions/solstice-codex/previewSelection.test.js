"use strict";
const assert = require('assert/strict'), fs = require('fs'), os = require('os'), path = require('path');
const { chromium } = require('playwright');
const { PreviewServer } = require(process.env.SELECTION_SOURCE || './preview');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'felix-selection-'));
let count = 0;
async function test(name, fn) { await fn(); count++; console.log('ok - ' + name); }
const deadline = setTimeout(() => { console.error('selection test timeout'); process.exit(1); }, 45000);
(async () => {
 let browser, server;
 try {
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html><html><body><main><button id="first">First</button><button id="second">Second</button><p>Unchanged content</p></main></body></html>');
  const picks = []; server = new PreviewServer(root, { onSelect: p => picks.push(p) });
  const port = await server.ensure(); browser = await chromium.launch({headless:true});
  const page = await browser.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  async function select(ids) { await page.getByRole('button', {name:'✕ Select', exact:true}).click(); for (let i=0;i<ids.length;i++) await page.locator(ids[i]).click({modifiers:i?['Control']:[]}); await page.getByRole('button', {name:/✏️ Edit/}).click(); }
  await test('real picker delivers a single selected element through HTTP', async () => { await select(['#first']); await page.waitForFunction(() => !document.querySelector('[data-solstice-ui] button')?.disabled); await new Promise(r=>setTimeout(r,250)); assert.equal(picks.length,1); assert.equal(picks[0].picks[0].id,'first'); });
  await test('multi-select serializes all elements without a circular reference', async () => { await select(['#first','#second']); await new Promise(r=>setTimeout(r,250)); assert.equal(picks.length,2); assert.deepEqual(picks[1].picks.map(p=>p.id),['first','second']); });
  await test('selection includes an exact selector, viewport and page location', () => { const p=picks[1]; assert.equal(p.picks[1].selector,'#second'); assert.equal(p.page.pathname,'/'); assert.ok(p.page.viewport.width>0); assert.ok(p.picks[1].rect.width>0); });
  await test('invalid payload receives failure instead of false acknowledgement', async () => { const r=await fetch(`http://127.0.0.1:${port}/__solstice/select`,{method:'POST',body:'{broken'}); assert.equal(r.status,400); assert.equal(picks.length,2); });
  await test('failed submission preserves selection and allows retry', async () => { await page.route('**/__solstice/select',r=>r.fulfill({status:503})); await select(['#first']); await page.getByRole('button',{name:'Retry edit',exact:true}).waitFor({timeout:2500}); assert.ok(await page.locator('#first').isVisible()); await page.unroute('**/__solstice/select'); await page.getByRole('button',{name:'Retry edit',exact:true}).click(); await new Promise(r=>setTimeout(r,250)); assert.equal(picks.length,3); });
  console.log(`previewSelection.test.js: ${count}/${count} passed`);
 } finally { clearTimeout(deadline); if(browser)await browser.close(); if(server)server.dispose(); fs.rmSync(root,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1;});
