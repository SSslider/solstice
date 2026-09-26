'use strict';
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process'),Module=require('module');
const {PreviewServer}=require('./preview');const {assertReviewCurrent}=require('./visualReview');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'felix-capture-'));let server,count=0;
const deadline=setTimeout(()=>{console.error('visual capture timeout');process.exit(1);},45000);
(async()=>{try{
fs.writeFileSync(path.join(root,'index.html'),'<html><body><button id="save">Save</button></body></html>');server=new PreviewServer(root);const port=await server.ensure();
const file=path.join(__dirname,'extension.js'),m=new Module(file,module);m.filename=file;m.paths=module.paths;const original=m.require.bind(m);m.require=id=>id==='vscode'?{workspace:{workspaceFolders:[{uri:{fsPath:root}}]}}:original(id);m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.Controller=AgentController;',file);
const c=Object.create(m.exports.Controller.prototype);c.previewUrl=`http://127.0.0.1:${port}/`;c.context={extensionPath:__dirname};c.resolveWalkthroughRuntime=()=>({bin:process.execPath,env:process.env});c.runCli=(bin,args,cwd)=>new Promise(resolve=>cp.execFile(bin,args,{cwd,timeout:15000},(error,stdout,stderr)=>resolve({code:error?1:0,stdout,stderr})));
const pick={picks:[{selector:'#save',text:'Save',tag:'button'}],page:{pathname:'/',viewport:{width:800,height:600},scroll:{x:0,y:0}}};
const selected=await c.captureSelectedElement(pick,root);assertReviewCurrent(root,selected.reviewPrompt);const image=fs.readFileSync(path.join(root,'.solstice/reviews',selected.reviewId,'before.png'));assert.equal(image.subarray(0,8).toString('hex'),'89504e470d0a1a0a');count++;console.log('ok - controller captures real PNG at selected route and accepts its current revision');
await assert.rejects(c.captureSelectedElement({...pick,picks:[{selector:'#save',text:'Changed',tag:'button'}]},root),/Could not capture/);count++;console.log('ok - mismatched selected state fails rather than using another screenshot');
const preview=await c.captureCompanionPreview(c.previewUrl),jpeg=fs.readFileSync(preview);assert.equal(jpeg.subarray(0,2).toString('hex'),'ffd8');assert.ok(jpeg.length<=28*1024);const frame=require('./companionFrame').companionFrame('solstice:test',{previewImage:'data:image/jpeg;base64,'+jpeg.toString('base64'),project:'בדיקה'});assert.ok(frame.state.previewImage);assert.ok(Buffer.byteLength(JSON.stringify(frame))<65536);count++;console.log('ok - real mobile JPEG survives the complete relay envelope within budget');
fs.writeFileSync(path.join(root,'index.html'),'<html><body><button id="save">Changed</button></body></html>');assert.throws(()=>assertReviewCurrent(root,selected.reviewPrompt),/השתנה/);count++;console.log('ok - later source edit invalidates captured feedback');
console.log(`visualCapture.test.js: ${count}/${count} passed`);
}finally{clearTimeout(deadline);server?.dispose();fs.rmSync(root,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1;});
