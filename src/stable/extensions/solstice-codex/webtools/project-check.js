#!/usr/bin/env node
"use strict";
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {withChrome,findBrowser}=require('./browse');
const {sourceRevision,sameRevision}=require('../sourceRevision');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function localUrl(value,base) {
 const u=new URL(value,base);
 if(!['http:','https:'].includes(u.protocol)||!['127.0.0.1','localhost','[::1]'].includes(u.hostname)||u.username||u.password)throw new Error('Project checks require a local preview');
 if(base&&u.origin!==new URL(base).origin)throw new Error('Check must stay on the project preview origin');
 return u.href;
}
function readConfig(root,name) {
 const file=path.join(root,'.solstice',name);
 if(!fs.existsSync(file))return null;
 if(fs.statSync(file).size>64*1024)throw new Error(name+' exceeds 64KB');
 const c=JSON.parse(fs.readFileSync(file,'utf8'));if(c.version!==1)throw new Error(name+' requires version 1');return c;
}
async function viewport(send,value) {
 const width=Number(value?.width)||1440,height=Number(value?.height)||900;
 if(width<240||width>3840||height<240||height>3000)throw new Error('Unsupported viewport');
 await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<600});
}
async function screenshot(send,file,options={}) {
 const budget=options.maxBytes;let bytes;
 if(budget!==undefined){
  if(!Number.isInteger(budget)||budget<4096||budget>49152)throw new Error('Invalid preview byte budget');
  for(const quality of [60,45,30,15]){const shot=await send('Page.captureScreenshot',{format:'jpeg',quality,captureBeyondViewport:false});bytes=Buffer.from(shot.data,'base64');if(bytes.length<=budget)break;}
  if(bytes.length>budget)throw new Error('Preview image exceeds the relay budget');
 }else{const shot=await send('Page.captureScreenshot',{format:'png'});bytes=Buffer.from(shot.data,'base64');}
 fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,bytes);return file;
}
async function capture(spec) {
 const url=localUrl(spec.url), bin=findBrowser();if(!bin)throw new Error('Browser not installed');
 return withChrome(bin,async({send,evalJs,goto})=>{
  await viewport(send,spec.viewport);await goto(url);
  for(const selector of spec.selectors||[])if(!selector||await evalJs(`document.querySelectorAll(${JSON.stringify(selector)}).length`)!==1)throw new Error('Selected element cannot be reconstructed. Reopen the route and select again.');
  for(const expected of spec.expected||[]) {
   const matches=await evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(expected.selector)});if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0&&(el.textContent||'').trim().slice(0,120)===${JSON.stringify(String(expected.text||''))};})()`);
   if(!matches)throw new Error('Selected state differs from the captured page. Reopen the route and select again.');
  }
  await evalJs(`document.querySelectorAll('[data-solstice-ui]').forEach(e=>e.style.visibility='hidden');window.scrollTo(${Number(spec.scroll?.x)||0},${Number(spec.scroll?.y)||0});true`);
  await wait(150);return screenshot(send,path.resolve(spec.output),spec);
 });
}
async function poll(evalJs,expression) {
 const start=Date.now();while(Date.now()-start<5000){if(await evalJs(expression))return;await wait(80);}throw new Error('Expected page state was not observed');
}
async function runProjectCheck(root,url,out) {
 root=path.resolve(root);url=localUrl(url);out=path.resolve(out);
 const revision=sourceRevision(root),design=readConfig(root,'design-contract.json'),acceptance=readConfig(root,'acceptance.json');
 const report={version:1,checkedAt:new Date().toISOString(),sourceRevision:revision,url,layers:[],screenshots:[],findings:[],caveats:['Configured browser and HTTP flows cover only the listed scenarios. External services, production deployment and database restart durability are not implied.']};
 fs.mkdirSync(out,{recursive:true});
 async function check(layer,name,fn){try{await fn();report.layers.push({layer,name,status:'passed'});}catch(e){report.layers.push({layer,name,status:'failed',message:e.message});report.findings.push({severity:'error',check:layer,message:name+': '+e.message,evidence:{}});}}
 if(design) {
  if(!Array.isArray(design.screens)||!design.screens.length||design.screens.length>12)throw new Error('Design contract requires 1–12 screens');
  if(!design.tokens||!Object.keys(design.tokens).length)throw new Error('Design contract requires shared CSS tokens');
  for(const key of Object.keys(design.tokens))if(!/^--[a-zA-Z0-9_-]+$/.test(key)||typeof design.tokens[key]!=='string')throw new Error('Invalid design token');
  const bin=findBrowser();if(!bin)throw new Error('Browser not installed');
  await withChrome(bin,async({send,evalJs,goto})=>{
   for(const screen of design.screens)for(const [size,dims]of Object.entries({desktop:{width:1440,height:900},mobile:{width:390,height:844}})){
    await check('design',`${screen.name||screen.path} · ${size}`,async()=>{
     await viewport(send,dims);await goto(localUrl(screen.path,url));
     const result=await evalJs(`(()=>{const spec=${JSON.stringify(screen)},tokens=${JSON.stringify(design.tokens)},errors=[],style=getComputedStyle(document.documentElement);for(const [key,value]of Object.entries(tokens))if(style.getPropertyValue(key).trim()!==value.trim())errors.push('Token '+key+' differs');if(spec.direction&&style.direction!==spec.direction)errors.push('Text direction differs');if(document.documentElement.scrollWidth>innerWidth+2)errors.push('Horizontal overflow');for(const selector of spec.required||[])if(!document.querySelector(selector))errors.push('Missing '+selector);for(const component of spec.components||[]){const nodes=[...document.querySelectorAll(component.selector)];if(!nodes.length)errors.push('Missing component '+component.selector);for(const node of nodes)for(const [key,value]of Object.entries(component.styles||{}))if(getComputedStyle(node)[key]!==value)errors.push(component.selector+' '+key+' differs');}return errors;})()`);
     const file=path.join(out,`screen-${report.screenshots.length+1}-${size}.png`);await screenshot(send,file);report.screenshots.push({name:screen.name||screen.path,size,path:file});
     if(result.length)throw new Error(result.join('; '));
    });
   }
  });
 }else report.layers.push({layer:'design',name:'Shared design contract',status:'unverified'});
 if(acceptance){
  if(!Array.isArray(acceptance.flows)||!acceptance.flows.length||acceptance.flows.length>12)throw new Error('Acceptance requires 1–12 flows');
  const bin=findBrowser();if(!bin)throw new Error('Browser not installed');
  for(const flow of acceptance.flows)await check('business',String(flow.name||'Business flow'),async()=>{
   if(!Array.isArray(flow.steps)||!flow.steps.length||flow.steps.length>40)throw new Error('Flow requires 1–40 steps');
   let assertions=0;
   await withChrome(bin,async({send,evalJs,goto})=>{
    await goto(localUrl(flow.path||'/',url));
    for(const step of flow.steps){
     if(step.fill){if(acceptance.fixtureWrites!==true)throw new Error('Flow writes require fixtureWrites in the acceptance config');
      const ok=await evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(step.fill)});if(!el)return false;el.focus();return true;})()`);if(!ok)throw new Error('Input not found: '+step.fill);await send('Input.insertText',{text:String(step.value||'')});
     }else if(step.click){if(acceptance.fixtureWrites!==true)throw new Error('Flow interactions require fixtureWrites in the acceptance config');
      const pt=await evalJs(`(()=>{const el=document.querySelector(${JSON.stringify(step.click)});if(!el||el.disabled)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);if(!pt)throw new Error('Clickable control not found: '+step.click);
      for(const type of ['mousePressed','mouseReleased'])await send('Input.dispatchMouseEvent',{type,...pt,button:'left',clickCount:1});
     }else if(step.expectText){assertions++;await poll(evalJs,`(document.querySelector(${JSON.stringify(step.expectText[0])})?.textContent||'').includes(${JSON.stringify(String(step.expectText[1]))})`);
     }else if(step.reload){await goto(localUrl(flow.path||'/',url));
     }else if(step.request){
      const request=step.request,method=String(request.method||'GET').toUpperCase();
      if(!['GET','POST','PUT','PATCH','DELETE'].includes(method))throw new Error('Unsupported HTTP method');
      if(method!=='GET'&&acceptance.fixtureWrites!==true)throw new Error('HTTP writes require fixtureWrites in the acceptance config');
      if(!Number.isInteger(request.status))throw new Error('HTTP assertion requires expected status');
      const response=await fetch(localUrl(request.path,url),{method,headers:{'content-type':'application/json',...(request.headers||{})},body:request.body===undefined?undefined:JSON.stringify(request.body),redirect:'manual',signal:AbortSignal.timeout(5000)});
      assertions++;if(response.status!==request.status)throw new Error(`HTTP expected ${request.status}, received ${response.status}`);
      if(request.json){const data=await response.json();for(const [key,expected]of Object.entries(request.json)){const actual=key.split('.').reduce((v,k)=>v?.[k],data);if(JSON.stringify(actual)!==JSON.stringify(expected))throw new Error('Response field differs: '+key);assertions++;}}
     }else throw new Error('Unknown acceptance step');
    }
    if(!assertions)throw new Error('Flow contains no assertions');
    const file=path.join(out,`flow-${report.screenshots.length+1}.png`);await screenshot(send,file);report.screenshots.push({name:flow.name,size:'flow',path:file});
   });
  });
 }else report.layers.push({layer:'business',name:'Business acceptance scenarios',status:'unverified'});
 if(!sameRevision(revision,sourceRevision(root)))report.findings.push({severity:'error',check:'source-changed',message:'Source changed during project verification',evidence:{}});
 report.ok=report.findings.length===0&&report.layers.length>0&&report.layers.every(l=>l.status==='passed');
 report.sha256=crypto.createHash('sha256').update(JSON.stringify(report)).digest('hex');
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2)+'\n');return report;
}
if(require.main===module){
 const deadline=setTimeout(()=>{console.error('Project verification timed out');process.exit(1);},180000);
 const [mode,root,url,out]=process.argv.slice(2);
 (mode==='capture'?capture(JSON.parse(fs.readFileSync(root,'utf8'))):runProjectCheck(root,url,out)).then(r=>{console.log(JSON.stringify(r,null,2));if(mode!=='capture'&&!r.ok)process.exitCode=1;}).catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>clearTimeout(deadline));
}
module.exports={runProjectCheck,capture,localUrl};
