"use strict";
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {sourceRevision,sameRevision}=require('./sourceRevision');
const {latestGreenSelfCheck}=require('./artifactStore');
const {captureVisualReview,assertReviewCurrent}=require('./visualReview');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'felix-revision-'));let n=0;
const deadline=setTimeout(()=>{console.error('revision test timeout');process.exit(1);},15000);
async function test(name,fn){await fn();console.log('ok - '+name);n++;}
(async()=>{try{
 fs.writeFileSync(path.join(root,'app.js'),'original');
 const first=sourceRevision(root);
 await test('revision hashes file content even when byte length stays the same',()=>{fs.writeFileSync(path.join(root,'app.js'),'modified');assert.equal(sameRevision(first,sourceRevision(root)),false);fs.writeFileSync(path.join(root,'app.js'),'original');});
 await test('generated evidence does not invalidate source',()=>{fs.mkdirSync(path.join(root,'.solstice'),{recursive:true});fs.writeFileSync(path.join(root,'.solstice','result.json'),'{}');assert.equal(sameRevision(first,sourceRevision(root)),true);});
 await test('design contract is part of source version',()=>{fs.writeFileSync(path.join(root,'.solstice','design-contract.json'),'{}');assert.equal(sameRevision(first,sourceRevision(root)),false);fs.unlinkSync(path.join(root,'.solstice','design-contract.json'));});
 await test('Mercury seed edits invalidate accepted evidence while sync receipts do not',()=>{
  const dir=path.join(root,'.solstice','mercury');fs.mkdirSync(dir,{recursive:true});
  const seed=path.join(dir,'seed.json');fs.writeFileSync(seed,JSON.stringify({products:[{title:'Print',variants:[{price_cents:100}]}]}));
  const seeded=sourceRevision(root);assert.equal(sameRevision(first,seeded),false,'catalog input must be tracked');
  fs.writeFileSync(path.join(dir,'seeded.json'),'{}');assert.equal(sameRevision(seeded,sourceRevision(root)),true,'generated sync receipt is not source');
  fs.writeFileSync(seed,JSON.stringify({products:[{title:'Print',variants:[{price_cents:200}]}]}));assert.equal(sameRevision(seeded,sourceRevision(root)),false,'same-length price change invalidates acceptance');
  fs.rmSync(dir,{recursive:true});assert.equal(sameRevision(first,sourceRevision(root)),true);
 });
 await test('truncated inventories cannot compare equal',()=>{const a=sourceRevision(root,{maxBytes:1});assert.equal(a.complete,false);assert.equal(sameRevision(a,a),false);});
 await test('added and deleted files invalidate acceptance',()=>{fs.writeFileSync(path.join(root,'new.js'),'new');assert.equal(sameRevision(first,sourceRevision(root)),false);fs.unlinkSync(path.join(root,'new.js'));assert.equal(sameRevision(first,sourceRevision(root)),true);});
 const base=path.join(root,'.solstice','self-check','task');
 const report={ok:true,url:'http://127.0.0.1/',findings:[],sourceRevision:first,summary:{linksChecked:1,buttonsChecked:0,formsChecked:0,desktopWidth:1440,mobileWidth:390}};
 function round(number,r){const d=path.join(base,'round-'+number);fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'report.json'),JSON.stringify(r));for(const f of ['desktop.png','mobile.png'])fs.writeFileSync(path.join(d,f),'fixture');}
 await test('green report is accepted for its exact source revision',()=>{round(1,report);assert.equal(latestGreenSelfCheck(root,'task').round,1);});
 await test('new red run cannot fall back to older green',()=>{round(2,{...report,ok:false});assert.equal(latestGreenSelfCheck(root,'task'),null);fs.rmSync(path.join(base,'round-2'),{recursive:true});});
 await test('changed app invalidates a previous green report',()=>{fs.writeFileSync(path.join(root,'app.js'),'changed');assert.equal(latestGreenSelfCheck(root,'task'),null);fs.writeFileSync(path.join(root,'app.js'),'original');});
 await test('legacy report without source revision is unverified',()=>{round(2,{...report,sourceRevision:undefined});assert.equal(latestGreenSelfCheck(root,'task'),null);});
 const shot=path.join(root,'.solstice','shot.png');fs.writeFileSync(shot,Buffer.from([137,80,78,71,13,10,26,10,1]));
 const pick={picks:[{tag:'button',selector:'#save',text:'Save'}],page:{pathname:'/',viewport:{width:1440,height:900}}};
 let selection;
 await test('visual feedback keeps an immutable before image and source version',async()=>{selection=await captureVisualReview(root,pick,async()=>shot);assertReviewCurrent(root,selection.reviewPrompt);assert.match(selection.reviewPrompt,/before.png/);});
 await test('feedback from another workspace is rejected',()=>assert.throws(()=>assertReviewCurrent(path.join(root,'other'),selection.reviewPrompt),/פרויקט/));
 await test('stale selection cannot dispatch an edit',()=>{fs.writeFileSync(path.join(root,'app.js'),'modified');assert.throws(()=>assertReviewCurrent(root,selection.reviewPrompt),/השתנה/);fs.writeFileSync(path.join(root,'app.js'),'original');});
 await test('modified screenshot cannot dispatch an edit',()=>{fs.writeFileSync(path.join(root,'.solstice','reviews',selection.reviewId,'before.png'),'changed');assert.throws(()=>assertReviewCurrent(root,selection.reviewPrompt),/צילום/);});
 await test('changes during screenshot capture reject the selection',async()=>assert.rejects(captureVisualReview(root,pick,async()=>{fs.writeFileSync(path.join(root,'app.js'),'changed');return shot;}),/changed during/));
 console.log(`sourceRevision.test.js: ${n}/${n} passed`);
}finally{clearTimeout(deadline);fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
