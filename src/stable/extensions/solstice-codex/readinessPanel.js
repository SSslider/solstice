'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
const {sourceRevision,sameRevision}=require('./sourceRevision');
const {writeBrowserSelfCheckReport}=require('./browserSelfCheck');
const {projectReadiness}=require('./projectReadiness');
const {scaffoldBusinessApp}=require('./businessApp');
const panels=new WeakMap();
function showReadiness(controller,vscode,mediaHtml){
 const root=vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;if(!root)throw new Error('Open a project first');
 if(panels.has(controller)){panels.get(controller).reveal();return;}
 const panel=vscode.window.createWebviewPanel('solstice.readiness','Project Readiness',vscode.ViewColumn.One,{enableScripts:true,localResourceRoots:[controller.context.extensionUri,vscode.Uri.file(path.join(root,'.solstice'))]});
 panels.set(controller,panel);let busy=false,disposed=false;
 panel.webview.html=mediaHtml(panel.webview,controller.context.extensionUri,'readiness.js','readiness.css');
 const push=()=>{if(disposed)return;const data=projectReadiness(root);data.screenshots=data.screenshots.map(shot=>{const file=path.resolve(shot.path||'');return {...shot,uri:file.startsWith(path.resolve(root,'.solstice')+path.sep)&&fs.existsSync(file)?panel.webview.asWebviewUri(vscode.Uri.file(file)).toString():''};});data.reviews=data.reviews.map(review=>{const uri=relative=>{if(!relative)return '';const file=path.resolve(root,relative);return file.startsWith(path.resolve(root,'.solstice','reviews')+path.sep)&&fs.existsSync(file)?panel.webview.asWebviewUri(vscode.Uri.file(file)).toString():'';};return {...review,beforeUri:uri(review.screenshot),afterUri:uri(review.afterScreenshot)};});panel.webview.postMessage({type:'readiness',data,busy});};
 panel.webview.onDidReceiveMessage(async message=>{try{
  if(root!==vscode.workspace.workspaceFolders?.[0]?.uri.fsPath)throw new Error('Workspace changed; reopen Project Readiness.');
  if(message.type==='runChecks'){
   if(busy)return;if(controller.agentBusy()||controller._browserSelfCheckRunning)throw new Error('המתן לסיום העבודה הפעילה כדי לבדוק גרסת קוד יציבה.');
   busy=true;push();
   try{const url=await controller.browserSelfCheckUrl();if(!url)throw new Error('פתח פריוויו מקומי לפני הבדיקה.');
    const out=path.join(root,'.solstice','project-check',Date.now()+'-'+crypto.randomUUID().slice(0,8)),runtime=controller.resolveWalkthroughRuntime();
    const before=sourceRevision(root),roundDir=path.join(root,'.solstice','self-check','readiness-'+Date.now(),'round-1');
    const browserResult=await controller.runCli(runtime.bin,[path.join(controller.context.extensionPath,'webtools','browse.js'),'check',url,roundDir],root,runtime.env);
    let browserReport;try{browserReport=JSON.parse(browserResult.stdout);}catch{browserReport={ok:false,findings:[{check:'report-contract',message:'Browser checker did not return a report'}]};}
    browserReport.sourceRevision=before;
    if(browserResult.code!==0||!sameRevision(before,sourceRevision(root)))browserReport={...browserReport,ok:false,findings:[...(browserReport.findings||[]),{check:'source-changed',message:'Browser check failed or source changed during verification'}]};
    writeBrowserSelfCheckReport(root,path.basename(path.dirname(roundDir)),1,browserReport);
    const result=await controller.runCli(runtime.bin,[path.join(controller.context.extensionPath,'webtools','project-check.js'),'check',root,url,out],root,runtime.env);
    const file=path.join(out,'report.json');if(!fs.existsSync(file))throw new Error(String(result.stderr||'Checker produced no report').slice(-600));
    fs.copyFileSync(file,path.join(root,'.solstice','project-check','latest.json'));
   }finally{busy=false;push();}
  }else if(message.type==='openPreview')await controller.openPreview('');
  else if(message.type==='scaffoldBusiness'){const result=scaffoldBusinessApp(root);controller.post({type:'systemNote',text:'בסיס עסקי מקומי מוכן: '+result.written.length+' קבצים. דורש Node 22.13 ומעלה; npm run dev מפעיל את השרת המקומי.'});}
  push();
 }catch(error){if(!disposed)panel.webview.postMessage({type:'error',message:error.message});}});
 const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root,'**/*'));
 let timer;const changed=()=>{clearTimeout(timer);timer=setTimeout(push,250);};watcher.onDidChange(changed);watcher.onDidCreate(changed);watcher.onDidDelete(changed);
 panel.onDidDispose(()=>{disposed=true;clearTimeout(timer);watcher.dispose();panels.delete(controller);});push();
}
module.exports={showReadiness};
