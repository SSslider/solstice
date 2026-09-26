'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),Module=require('module');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'mercury-completion-'));
const workspace={workspaceFolders:[{uri:{fsPath:root}}]};
const file=path.join(__dirname,'extension.js'),m=new Module(file,module);m.filename=file;m.paths=module.paths;
const original=m.require.bind(m);m.require=id=>id==='vscode'?{workspace}:original(id);
m._compile(fs.readFileSync(file,'utf8')+'\nmodule.exports.Controller=AgentController;',file);
const C=m.exports.Controller;
function fixture(){
 const c=Object.create(C.prototype),events=[];let resolve,reject;
 const pending=new Promise((a,b)=>{resolve=a;reject=b;});
 c.threadId='thread';c.threads=new Map();c.pendingApprovals=new Map();c.activeCliChildren=new Set();c.output={append(){}};
 c.cfg=()=>({get:()=>false});c.injectMercuryClient=()=>pending;
 for(const name of ['announceAgentMessage','post','postManager','postFleetActivity','sendBuildStatus','fleetFlow','maybeCreateWalkthrough','drainSteerQueue','markBusy','postPreview','refreshPreview','noteFidelityDraftEligibility','pushThreads','pushManagerTasks','notePulse'])c[name]=(...args)=>events.push([name,...args]);
 c.maybeRunBrowserSelfCheck=()=>{events.push(['qa']);return false;};
 c.upsertThread=({id})=>{if(!c.threads.has(id))c.threads.set(id,{id});return c.threads.get(id);};
 c._companion=()=>({});c.providerLabel=()=> 'test';c.captureCompanionState=()=>{};
 return {c,events,resolve,reject};
}
function seed(){fs.mkdirSync(path.join(root,'.solstice/mercury'),{recursive:true});fs.writeFileSync(path.join(root,'.solstice/mercury/seed.json'),'{"products":[]}');}
const has=(f,name,value)=>f.events.some(e=>e[0]===name&&(value===undefined||e[1]===value));
test.after(()=>fs.rmSync(root,{recursive:true,force:true}));
test('turn completion waits for Mercury before QA, walkthrough or done even with selfVerify disabled',async()=>{
 seed();const f=fixture();f.c.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn'}});
 assert.equal(has(f,'qa'),false);assert.equal(has(f,'fleetFlow','done'),false);assert.equal(has(f,'maybeCreateWalkthrough'),false);
 f.resolve(true);await f.c._mercuryCompletionPromise;
 assert.equal(has(f,'qa'),true);assert.equal(has(f,'fleetFlow','done'),true);assert.equal(has(f,'maybeCreateWalkthrough'),true);
});
test('sync failure blocks green and gives the agent and remote owner an actionable failure',async()=>{
 seed();const f=fixture();f.c._activeBuild={taskId:'build'};f.c._browserSelfCheck={token:'check'};f.c._walkthroughPending=true;
 f.c.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn'}});f.reject(Error('price_cents invalid'));await f.c._mercuryCompletionPromise;
 assert.equal(has(f,'qa'),false);assert.equal(has(f,'fleetFlow','done'),false);assert.equal(has(f,'maybeCreateWalkthrough'),false);
 assert.equal(has(f,'sendBuildStatus','error'),true);assert.ok(f.events.some(e=>e[0]==='post'&&e[1].text?.includes('FELIX_MERCURY_SYNC_FAILED')));
 assert.equal(f.c._activeBuild,null);assert.equal(f.c._browserSelfCheck,null);assert.equal(f.c._walkthroughPending,false);
});
test('new turn invalidates old sync completion and start injects only the client',async()=>{
 seed();const f=fixture();f.c.maybeFinishMercuryTurn('thread');const old=f.c._mercuryCompletionPromise;
 let options;f.c.injectMercuryClient=async o=>{options=o;return true;};
 f.c.onNotification('turn/started',{threadId:'thread',turn:{id:'next'}});assert.deepEqual(options,{sync:false});
 f.resolve(true);await old;assert.equal(has(f,'qa'),false);assert.equal(has(f,'fleetFlow','done'),false);
});
test('stop invalidates pending Mercury completion',async()=>{
 seed();const f=fixture();f.c.maybeFinishMercuryTurn('thread');const old=f.c._mercuryCompletionPromise;
 await f.c.interrupt('thread');f.resolve(true);await old;
 assert.equal(has(f,'qa'),false);assert.equal(has(f,'fleetFlow','done'),false);
});
test('late failure after switching threads cannot clear a new build',async()=>{
 seed();const f=fixture();f.c._activeBuild={taskId:'original'};f.c.maybeFinishMercuryTurn('thread');const old=f.c._mercuryCompletionPromise;
 f.c.threadId='next';f.reject(Error('late offline'));await old;
 assert.equal(f.c._activeBuild.taskId,'original');assert.equal(has(f,'sendBuildStatus','error'),false);
});
test('project without Mercury seed follows normal completion without connector access',()=>{
 fs.rmSync(path.join(root,'.solstice/mercury/seed.json'),{force:true});const f=fixture();
 assert.equal(f.c.maybeFinishMercuryTurn('thread'),false);assert.equal(f.c._mercuryCompletionPromise,undefined);
 f.c.onNotification('turn/completed',{threadId:'thread',turn:{id:'plain'}});assert.equal(has(f,'qa'),true);assert.equal(has(f,'fleetFlow','done'),true);
});
test('client injection propagates missing-store failure and writes no success receipt',async()=>{
 seed();const f=fixture();f.c.mercuryConfig=async()=>null;
 await assert.rejects(C.prototype.injectMercuryClient.call(f.c),/חבר חנות/);
 const status=JSON.parse(fs.readFileSync(path.join(root,'.solstice/mercury/sync-status.json'),'utf8'));assert.equal(status.status,'failed');
});

test('manager task stays running while sync is pending and fails on connector failure',async()=>{
 seed();const f=fixture(),states=[];let inspected=0;
 f.c.managerTasks={forThread:()=>({id:'task'}),setStatus:(_id,status)=>states.push(status),inspect:async()=>{inspected++;}};
 f.c.onNotification('turn/completed',{threadId:'thread',turn:{id:'turn'}});
 assert.deepEqual(states,['running']);assert.equal(inspected,0);assert.equal(f.c.agentBusy(),true);
 f.reject(Error('offline'));await f.c._mercuryCompletionPromise;
 assert.deepEqual(states,['running','failed']);assert.equal(inspected,0);
});
test('same-thread replacement build cannot be completed by an older sync',async()=>{
 seed();const f=fixture();f.c._activeBuild={taskId:'old'};f.c.maybeFinishMercuryTurn('thread');
 f.c._activeBuild={taskId:'new'};f.resolve(true);await f.c._mercuryCompletionPromise;
 assert.equal(has(f,'fleetFlow','done'),false);assert.equal(f.c._activeBuild.taskId,'new');
});
