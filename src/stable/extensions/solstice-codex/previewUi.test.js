'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path');const {chromium}=require('playwright');
const deadline=setTimeout(()=>{console.error('preview UI timeout');process.exit(1);},20000);
(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage({viewport:{width:1000,height:800}});await page.setContent('<div id="app"></div>');await page.addStyleTag({content:fs.readFileSync(process.env.PREVIEW_CSS||path.join(__dirname,'media/preview.css'),'utf8')});await page.addScriptTag({path:path.join(__dirname,'media/preview.js')});
assert.equal(await page.locator('#pvdrawer').isVisible(),false);const width=await page.locator('#pvstage').evaluate(e=>e.getBoundingClientRect().width);console.log('ok - hidden drawer does not consume preview width');
await page.locator('#pvscreens').click();assert.equal(await page.locator('#pvdrawer').isVisible(),true);assert.ok(await page.locator('#pvstage').evaluate(e=>e.getBoundingClientRect().width)<width);console.log('ok - opening drawer allocates visible space');
await page.locator('#pvdx').click();assert.equal(await page.locator('#pvdrawer').isVisible(),false);assert.equal(await page.locator('#pvstage').evaluate(e=>e.getBoundingClientRect().width),width);console.log('ok - closing drawer restores full preview width');console.log('previewUi.test.js: 3/3 passed');
}finally{clearTimeout(deadline);await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
