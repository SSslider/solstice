'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto');
const {scaffoldBusinessApp}=require('./businessApp');const {runProjectCheck}=require('./webtools/project-check');const {PreviewServer}=require('./preview');const {chromium}=require('playwright');
let n=0;async function test(name,fn){await fn();n++;console.log('ok - '+name);}
const root=fs.mkdtempSync(path.join(os.tmpdir(),'felix-business-')),token=crypto.randomBytes(24).toString('hex');let server,proxy,browser;
const deadline=setTimeout(()=>{console.error('business test timeout');process.exit(1);},140000);
(async()=>{try{
 await test('scaffold writes runnable app and shared acceptance contracts',()=>assert.equal(scaffoldBusinessApp(root).written.length,8));
 await test('scaffold preserves existing work',()=>{const before=fs.readFileSync(path.join(root,'app.js'),'utf8');assert.throws(()=>scaffoldBusinessApp(root),/empty project/);assert.equal(fs.readFileSync(path.join(root,'app.js'),'utf8'),before);});
 const {start}=require(path.join(root,'server.cjs'));server=await start({root,adminToken:token});let url='http://127.0.0.1:'+server.address().port;
 const payload={kind:'travel',name:'QA',contact:'qa@example.test',details:'Test request'},key=crypto.randomUUID();
 const post=(body=payload,k=key)=>fetch(url+'/api/requests',{method:'POST',headers:{'content-type':'application/json','idempotency-key':k},body:JSON.stringify(body)});let receipt;
 await test('API validates input before writing',async()=>{const r=await post({...payload,name:''});assert.equal(r.status,422);});
 await test('API stores a real SQLite record',async()=>{const r=await post();assert.equal(r.status,201);receipt=await r.json();assert.ok(receipt.id);const {DatabaseSync}=require('node:sqlite');const db=new DatabaseSync(path.join(root,'.solstice/business-data/requests.sqlite'));assert.equal(db.prepare('select count(*) as n from requests').get().n,1);db.close();});
 await test('same operation retries without duplicate records',async()=>{const r=await post();assert.equal(r.status,200);assert.equal((await r.json()).id,receipt.id);});
 await test('changed payload cannot reuse an operation identifier',async()=>assert.equal((await post({...payload,details:'different'})).status,409));
 await test('untrusted origin cannot write',async()=>{const r=await fetch(url+'/api/requests',{method:'POST',headers:{origin:'https://external.example','idempotency-key':crypto.randomUUID()},body:JSON.stringify(payload)});assert.equal(r.status,403);});
 await test('admin data rejects guest and wrong credentials',async()=>{for(const authorization of ['', 'Bearer wrong'])assert.equal((await fetch(url+'/api/admin/requests',{headers:{authorization}})).status,401);});
 await test('authorized admin sees exactly one stored record',async()=>{const r=await fetch(url+'/api/admin/requests',{headers:{authorization:'Bearer '+token}});assert.equal(r.status,200);assert.equal((await r.json()).items.length,1);});
 await test('receipt survives server shutdown and reopen',async()=>{await new Promise(r=>server.close(r));server=await start({root,adminToken:token});url='http://127.0.0.1:'+server.address().port;const r=await fetch(url+'/api/requests/'+receipt.id);assert.equal(r.status,200);assert.equal((await r.json()).details,payload.details);});
 const selections=[];proxy=new PreviewServer(root,{onSelect:p=>selections.push(p)});proxy.proxyTarget=url;const proxyPort=await proxy.ensure();const preview='http://127.0.0.1:'+proxyPort;
 await test('three business flows and six design viewports pass through the actual preview proxy',async()=>{const r=await runProjectCheck(root,preview,path.join(root,'.solstice','project-check','test'));fs.writeFileSync(path.join(root,'.solstice','project-check','latest.json'),JSON.stringify(r));assert.equal(r.ok,true,JSON.stringify(r.findings));assert.equal(r.layers.filter(x=>x.status==='passed').length,9);assert.equal(r.screenshots.length,9);});
 await test('selection works on a CSP-protected application through the proxy',async()=>{browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(preview+'/restaurant');await page.getByRole('button',{name:'✕ Select',exact:true}).click();await page.locator('#heading').click();await page.getByRole('button',{name:/✏️ Edit/}).click();await new Promise(r=>setTimeout(r,200));assert.equal(selections.length,1);assert.equal(selections[0].picks[0].id,'heading');});
 await test('failed readback retry does not create a second saved request',async()=>{
  const page=await browser.newPage();await page.goto(preview+'/restaurant');let posts=0;page.on('request',r=>{if(r.method()==='POST'&&r.url().endsWith('/api/requests'))posts++;});
  let fail=true;await page.route('**/api/requests/*',route=>{if(fail){fail=false;return route.fulfill({status:503,contentType:'application/json',body:'{}'});}return route.continue();});
  await page.locator('#name').fill('Retry readback');await page.locator('#contact').fill('qa@example.test');await page.locator('#details').fill('readback failure');await page.locator('#submit').click();await page.locator('#status').filter({hasText:'אפשר לנסות שוב'}).waitFor();
  await page.locator('#submit').click();await page.locator('#status').filter({hasText:'נשמרה ונקראה מחדש'}).waitFor();assert.equal(posts,1);assert.match(await page.locator('#receipt').innerText(),/Retry readback/);await page.close();
 });
 await test('token drift on one screen fails the design gate',async()=>{const file=path.join(root,'styles.css');fs.appendFileSync(file,'\n:root{--brand-accent:#ff0000}\n');const r=await runProjectCheck(root,preview,path.join(root,'.solstice','project-check','mutated'));assert.equal(r.ok,false);assert.equal(r.layers.filter(x=>x.layer==='design'&&x.status==='failed').length,6);});
 console.log(`businessApp.test.js: ${n}/${n} passed`);
 if(process.env.SOLSTICE_BUSINESS_EVIDENCE){fs.cpSync(root,process.env.SOLSTICE_BUSINESS_EVIDENCE,{recursive:true});console.log('Evidence preserved');}
}finally{clearTimeout(deadline);if(browser)await browser.close();if(proxy)proxy.dispose();if(server)await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
