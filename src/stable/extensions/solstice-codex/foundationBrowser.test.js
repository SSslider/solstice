"use strict";
const assert=require('assert/strict'),fs=require('fs'),path=require('path');
const {chromium}=require('playwright');
let count=0;
const output=process.env.FOUNDATION_PROOF_DIR;
const details={business:{id:'qa',slug:'qa',name:'סביבת בדיקה · עסק לדוגמה',configStatus:'active'},domain:{},connections:[],events:[],relationships:[],canvas:{revision:3,snapshot:{nodes:[],edges:[]}}};
(async()=>{
const browser=await chromium.launch({headless:true});
try{
 const page=await browser.newPage({viewport:{width:1440,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.setContent('<html lang="he" dir="rtl"><body><div id="app"></div></body></html>');
 await page.addStyleTag({path:path.join(__dirname,'media/foundation.css')});
 await page.evaluate(()=>{window.sent=[];window.acquireVsCodeApi=()=>({postMessage:m=>window.sent.push(m)});});
 await page.addScriptTag({path:path.join(__dirname,'media/foundation.js')});
 async function message(data){await page.evaluate(d=>window.dispatchEvent(new MessageEvent('message',{data:d})),data);}
 async function test(name,fn){await fn();count++;console.log('ok - '+name);}
 await test('initial ready requests actual board',async()=>assert.equal((await page.evaluate(()=>window.sent))[0].type,'ready'));
 await test('successful empty board is connected and not loading',async()=>{await message({type:'state',state:{board:{businesses:[]},connectedAt:new Date().toISOString()}});assert.match(await page.locator('.connection').innerText(),/FOUNDATION CONNECTED/);assert.match(await page.locator('.empty').innerText(),/אין עסקים להצגה/);});
 await test('populated board shows real supplied records',async()=>{await message({type:'state',state:{board:{businesses:[{id:'qa',slug:'qa',name:'סביבת בדיקה · עסק לדוגמה'}]},connectedAt:new Date().toISOString()}});assert.equal(await page.locator('.business').count(),1);});
 await test('refresh failure marks old data offline',async()=>{await message({type:'error',message:'Foundation request timed out.'});assert.match(await page.locator('.connection').innerText(),/OFFLINE/);assert.match(await page.locator('.connection').innerText(),/מוצגים נתונים מהעדכון האחרון/);assert.equal(await page.locator('.business').count(),1);});
 await test('selection has visible loading and cancel',async()=>{await page.locator('.business').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).slug,'qa');assert.match(await page.locator('#app [role=status]').last().innerText(),/פותח/);await page.locator('[data-action=back]').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).type,'show_board');});
 await test('detail render connects draft input to business',async()=>{await page.locator('.business').click();await message({type:'detail',detail:details});assert.equal(await page.locator('#canvasNodeTitle').count(),1);await page.locator('#canvasNodeTitle').fill('טיוטה שלא תאבד');});
 await test('poll preserves draft focus and caret',async()=>{await page.locator('#canvasNodeTitle').evaluate(el=>el.setSelectionRange(3,7));await message({type:'connection',connectedAt:new Date().toISOString()});assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'טיוטה שלא תאבד');assert.deepEqual(await page.locator('#canvasNodeTitle').evaluate(el=>[document.activeElement===el,el.selectionStart,el.selectionEnd]),[true,3,7]);});
 await test('offline canvas is labelled and blocks writes',async()=>{await message({type:'error',message:'HTTP 503'});assert.match(await page.locator('.canvas-live').innerText(),/לא מסונכרן/);assert.equal(await page.locator('[data-action=add-canvas-node]').isDisabled(),true);assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'טיוטה שלא תאבד');});
 await test('recovery unlocks canvas while retaining draft',async()=>{await message({type:'detail',detail:details,connectedAt:new Date().toISOString()});assert.equal(await page.locator('[data-action=add-canvas-node]').isDisabled(),false);assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'טיוטה שלא תאבד');});
 await test('saving and poll cannot reenable duplicate writes',async()=>{await page.locator('[data-action=add-canvas-node]').click();await message({type:'connection',connectedAt:new Date().toISOString()});assert.equal(await page.locator('[data-action=add-canvas-node]').isDisabled(),true);assert.equal((await page.evaluate(()=>window.sent)).at(-1).title,'טיוטה שלא תאבד');});
 await test('confirmed save clears only submitted draft',async()=>{await message({type:'saved',slug:'qa',title:'טיוטה שלא תאבד'});await message({type:'saving',saving:false});assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'');await page.locator('#canvasNodeTitle').fill('עריכה חדשה');await message({type:'saved',slug:'qa',title:'טיוטה קודמת'});assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'עריכה חדשה');});
 const pixel='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS1sAAAAASUVORK5CYII=';
 const illustrated={...details,domain:{influencers:[{name:'דיוקן לבדיקה',baseImageUrl:pixel}]},canvas:{revision:4,snapshot:{nodes:[{id:'image1',title:'תמונת קנבס',imageDataUri:pixel}],edges:[]}}};
 await test('portrait opens an accessible image dialog with the actual asset',async()=>{await message({type:'detail',detail:illustrated});await page.locator('.portrait button').click();assert.equal(await page.locator('dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('dialog img').getAttribute('src'),pixel);assert.equal(await page.locator('dialog figcaption').innerText(),'דיוקן לבדיקה');});
 await test('poll preserves open image and unsaved canvas draft',async()=>{await message({type:'connection',connectedAt:new Date().toISOString()});assert.equal(await page.locator('dialog').evaluate(d=>d.open),true);assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'עריכה חדשה');});
 await test('Escape closes image and restores keyboard focus after poll',async()=>{await page.keyboard.press('Escape');assert.equal(await page.locator('dialog').evaluate(d=>d.open),false);assert.equal(await page.locator('.portrait button').evaluate(b=>document.activeElement===b),true);});
 await test('canvas image opens with keyboard and close button returns focus',async()=>{await page.locator('.canvas-node button').focus();await page.keyboard.press('Enter');assert.equal(await page.locator('dialog figcaption').innerText(),'תמונת קנבס');await page.getByRole('button',{name:'סגור תמונה',exact:true}).click();assert.equal(await page.locator('.canvas-node button').evaluate(b=>document.activeElement===b),true);});
 await test('image failure is visible and can be dismissed',async()=>{await page.locator('.portrait button').click();await page.locator('dialog img').evaluate(img=>img.dispatchEvent(new Event('error')));assert.equal(await page.locator('dialog [role=status]').isVisible(),true);await page.keyboard.press('Escape');});
 await test('image dialog fits mobile and leaves underlying draft intact',async()=>{await page.setViewportSize({width:390,height:844});await page.locator('.portrait button').click();const box=await page.locator('dialog').boundingBox();assert.ok(box.x>=0 && box.x+box.width<=390 && box.height<=844);await page.keyboard.press('Escape');assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'עריכה חדשה');await page.setViewportSize({width:1440,height:900});});
 if(output){fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'foundation-detail-fixture-desktop.png'),fullPage:true});}
 await test('mobile RTL fits viewport',async()=>{await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>getComputedStyle(document.body).direction),'rtl');assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);});
 if(output)await page.screenshot({path:path.join(output,'foundation-detail-fixture-mobile.png'),fullPage:true});
 await test('back clears selection and informs host',async()=>{await page.locator('[data-action=back]').click();assert.equal((await page.evaluate(()=>window.sent)).at(-1).type,'show_board');assert.equal(await page.locator('#canvasNodeTitle').count(),0);});
 await test('business draft survives round trip',async()=>{await page.locator('.business').click();await message({type:'detail',detail:details});assert.equal(await page.locator('#canvasNodeTitle').inputValue(),'עריכה חדשה');});
 await test('HTML in errors is escaped',async()=>{await message({type:'error',message:'<img src=x onerror="throw Error(1)">'});assert.equal(await page.locator('.error img').count(),0);assert.match(await page.locator('.error').innerText(),/<img/);});
 await test('no browser JavaScript errors',async()=>assert.deepEqual(errors,[]));
 console.log(`foundationBrowser.test.js: ${count}/${count} passed`);
}finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
