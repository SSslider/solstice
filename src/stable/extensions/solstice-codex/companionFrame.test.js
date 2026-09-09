"use strict";
const assert = require("node:assert/strict"), fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const { companionFrame } = require("./companionFrame");
const { TaskContinuity } = require("./taskContinuity");
const { taskSnapshot } = require("./taskVisibility");
const root=fs.mkdtempSync(path.join(os.tmpdir(),"frame-budget-"));
let passed=0;
function check(name,fn){fn();passed++;console.log("ok - "+name);}
const bytes=f=>Buffer.byteLength(JSON.stringify(f),"utf8");
const lists=["plan","events","evidence","pending"];
function validate(frame,source){
 assert.ok(bytes(frame)<=65536,`full frame ${bytes(frame)} bytes`);
 const t=frame.state.taskEvidence;
 for(const key of ["id","status","checkedAt","caveat","pendingCaveat"])assert.equal(t[key],source[key],key);
 for(const key of lists)assert.equal(t[key].length+t[key+"Omitted"],source[key].length+source[key+"Omitted"],key+" total");
}
try {
 const journal=new TaskContinuity(root);
 for(const [label,char] of [["ascii","a"],["hebrew","א"],["three-byte","界"]])check(label+" durable task through actual publisher budgets the full frame",()=>{
  const saved=journal.begin(label,char.repeat(12000),"test");
  journal.notify("turn/plan/updated",{threadId:label,plan:Array.from({length:100},()=>({step:char.repeat(500),status:"pending"}))});
  const disk=journal.read(saved.id);disk.pending=Array.from({length:140},(_,i)=>({id:char.repeat(490)+i,type:"commandExecution"}));journal.save(disk);
  const source=taskSnapshot(new TaskContinuity(root),saved.id);
  assert.equal(source.pending.length,100);assert.equal(source.pendingOmitted,40);
  const file=path.join(__dirname,"extension.js"),m=new Module(file,module);m.filename=file;m.paths=module.paths;
  const orig=m.require.bind(m);m.require=id=>id==="vscode"?{}:orig(id);
  m._compile(fs.readFileSync(file,"utf8")+"\nmodule.exports.Controller=AgentController;",file);
  const c=Object.create(m.exports.Controller.prototype);let sent;
  c.companionBridgeId=()=>"test";c.companionInstanceId=()=>"solstice:test";
  c.companionRelayState=()=>({taskEvidence:source,messages:[{text:char.repeat(10000)}],connected:true});
  c.fleetBridges=new Map([["test",{companionReady:true,ws:{connected:true,send:f=>sent=f}}]]);c.output={append(){}};
  const before=JSON.stringify(source);assert.equal(c.publishCompanionState(),true);validate(sent,source);
  assert.equal(JSON.stringify(source),before);console.log(JSON.stringify({label,frameBytes:bytes(sent),pending:sent.state.taskEvidence.pending.length,plan:sent.state.taskEvidence.plan.length}));
 });
 check("snapshot count caps preserve totals from durable records and ignore heartbeats",()=>{
  const saved=journal.begin("count-caps","Counts","test"),disk=journal.read(saved.id);
  disk.plan=Array.from({length:101},(_,i)=>({step:"step "+i,status:"pending"}));
  disk.evidence=Array.from({length:101},(_,i)=>({path:"absent-"+i,sha256:"hash"}));
  disk.events=Array.from({length:20},(_,i)=>({type:"item/completed",at:String(i)})).concat([{type:"heartbeat"}]);
  journal.save(disk);
  const snap=taskSnapshot(new TaskContinuity(root),saved.id);
  assert.equal(snap.plan.length,100);assert.equal(snap.planOmitted,1);
  assert.equal(snap.evidence.length,100);assert.equal(snap.evidenceOmitted,1);
  assert.equal(snap.events.length,12);assert.equal(snap.eventsOmitted,8);
  assert.equal(companionFrame("id",{taskEvidence:snap}).state.taskEvidence.truncated,true);
 });
 const source={id:"id",status:"interrupted",checkedAt:"now",caveat:"Never acceptance, publication or installation.",pendingCaveat:"No unresolved actions is not acceptance.",plan:[],events:[],evidence:[],pending:[],planOmitted:0,eventsOmitted:0,evidenceOmitted:0,pendingOmitted:0};
 check("exact byte boundary includes envelope overhead and non-ASCII metadata",()=>{
  const base=companionFrame("א",{taskEvidence:source,padding:""});
  const room=65536-bytes(base);
  assert.equal(bytes(companionFrame("א",{taskEvidence:source,padding:"x".repeat(room)})),65536);
  const over=companionFrame("א",{taskEvidence:source,padding:"x".repeat(room+1)});
  validate(over,source);assert.equal(over.state.truncated,true);assert.ok(over.state.relayOmittedFields.includes("padding"));
 });
 check("fixed list reduction order and latest events are preserved",()=>{
  const rich={...source};for(const key of lists)rich[key]=Array.from({length:6},(_,i)=>({id:i,text:"界".repeat(1000)}));
  for(const key of lists){
   const target={...rich};for(const previous of lists.slice(0,lists.indexOf(key))){target[previous]=rich[previous].slice(previous==="events"?-1:0,previous==="events"?undefined:1);target[previous+"Omitted"]=5;}
   target[key]=key==="events"?rich[key].slice(-3):rich[key].slice(0,3);target[key+"Omitted"]=3;target.truncated=true;
   const base={type:"companion_state",instanceId:"id",state:{taskEvidence:target,padding:""}};
   const frame=companionFrame("id",{taskEvidence:rich,padding:"x".repeat(65536-bytes(base))});
   validate(frame,rich);assert.deepEqual(frame.state.taskEvidence[key],target[key]);
   for(const later of lists.slice(lists.indexOf(key)+1))assert.deepEqual(frame.state.taskEvidence[later],rich[later]);
  }
 });
 check("oversized auxiliary data produces minimal explicit totals without altering caveats",()=>{
  const rich={...source};for(const key of lists)rich[key]=[{id:"a"}];rich.pendingOmitted=39;
  const f=companionFrame("id",{taskEvidence:rich,previewImage:"x".repeat(100000),messages:["large"],connected:true});validate(f,rich);
  assert.equal(f.state.taskEvidence.pendingOmitted,40);assert.equal(f.state.taskEvidence.pending.length,0);
  assert.equal(f.state.taskEvidence.truncated,true);assert.ok(f.state.relayOmittedFields.includes("previewImage"));
 });
 check("impossible required metadata fails visibly instead of cutting a caveat",()=>{
  assert.throws(()=>companionFrame("id",{taskEvidence:{...source,caveat:"א".repeat(40000)}}),/Required companion metadata/);
 });
 console.log(`companionFrame.test.js: ${passed}/${passed} checks passed`);
}finally{fs.rmSync(root,{recursive:true,force:true});}
