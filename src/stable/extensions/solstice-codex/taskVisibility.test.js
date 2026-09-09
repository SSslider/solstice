"use strict";
const assert = require("node:assert/strict");
const fs = require("fs"), os = require("os"), path = require("path"), Module = require("module");
const { TaskContinuity } = require("./taskContinuity");
const { taskSnapshot } = require("./taskVisibility");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "visibility-"));
let count = 0;
async function check(name, fn) { await fn(); count++; console.log("ok - " + name); }
(async () => { try {
 const journal = new TaskContinuity(root), task = journal.begin("main", "Build\x1b[2K\r<form>", "test");
 fs.writeFileSync(path.join(root,"proof.txt"),"v1");
 journal.notify("item/completed", {threadId:"main",item:{id:"edit",type:"fileChange",changes:[{path:"proof.txt"}]}});
 const moduleFile = path.join(__dirname,"extension.js"), compiled = new Module(moduleFile,module);
 compiled.filename=moduleFile;compiled.paths=module.paths;
 const original=compiled.require.bind(compiled);
 compiled.require=id=>id==="vscode"?{workspace:{workspaceFolders:[{uri:{fsPath:root}}]}}:original(id);
 compiled._compile(fs.readFileSync(moduleFile,"utf8")+"\nmodule.exports.Controller = AgentController;",moduleFile);
 const c=Object.create(compiled.exports.Controller.prototype), sent=[];
 c.threadId="main";c._taskCheckpoints=new Map([[root,journal]]);c.output={append(){}};
 c.companionBridgeId=()=>"test";c.fleetBridges=new Map([["test",{companionReady:true,ws:{connected:true,send:f=>sent.push(f)}}]]);
 c.scheduleCompanionRelay=()=>c.publishCompanionState();
 c.send=()=>assert.fail("evidence inspection cannot invoke a model");
 await check("real publisher relays disk-checked evidence without claiming acceptance",()=>{
  assert.equal(c.publishCompanionState(),true);
  const t=sent.at(-1).state.taskEvidence;
  assert.equal(t.id,task.id);assert.equal(t.evidence[0].current,"unchanged");
  assert.match(t.caveat,/does not prove acceptance, publication or installation/);
  assert.match(t.pendingCaveat,/not an acceptance result/);
  assert.doesNotMatch(t.objective,/[\x00-\x1f\x7f]/);
 });
 await check("heartbeat replay retains the evidence timestamp; explicit refresh detects changed files",async()=>{
  const before=sent.at(-1).state.taskEvidence;
  fs.writeFileSync(path.join(root,"proof.txt"),"v2");
  c.publishCompanionState();assert.deepEqual(sent.at(-1).state.taskEvidence,before);
  await c.handleCompanionAction({instanceId:c.companionInstanceId(),requestId:"refresh-1",action:"task_evidence"});
  assert.equal(sent.at(-1).ok,true);
  assert.equal(sent.at(-2).state.taskEvidence.evidence[0].current,"changed");
 });
 await check("deleted and escaping files are never marked unchanged",()=>{
  fs.unlinkSync(path.join(root,"proof.txt"));
  assert.equal(c.companionTaskState(true).evidence[0].current,"missing");
  fs.symlinkSync(__filename,path.join(root,"proof.txt"));
  assert.equal(c.companionTaskState(true).evidence[0].current,"missing");
 });
 await check("snapshot reads durable status, filters heartbeat, keeps failure and unknown outcomes",()=>{
  const disk=journal.read(task.id);disk.status="interrupted";disk.failure="SECRET_ERROR";
  disk.pending=[{id:"unresolved",type:"commandExecution",command:"SECRET_COMMAND"}];
  disk.events.push({at:"now",type:"heartbeat"},{at:"now",type:"item/completed",exitCode:7,arguments:"SECRET_ARGUMENTS"});
  journal.save(disk);
  const snap=c.companionTaskState();
  assert.equal(snap.status,"interrupted");assert.equal(snap.pending[0].id,"unresolved");
  assert.match(snap.failure,/inspect the engine log/);assert.equal(snap.events.at(-1).exitCode,7);
  assert.doesNotMatch(JSON.stringify(snap),/heartbeat|SECRET_/);
 });
 await check("new controller after restart recovers the same durable task",()=>{
  const second=Object.create(compiled.exports.Controller.prototype);second.output={append(){}};
  assert.equal(second.companionTaskState().id,task.id);
  assert.equal(second.companionTaskState().status,"interrupted");
 });
 await check("terminal turn awaits review and pause survives late provider failure",()=>{
  journal.notify("turn/completed",{threadId:"main",turn:{status:"completed"}});
  assert.equal(taskSnapshot(journal,task.id).status,"needs_review");
  journal.pause("main");journal.notify("error",{threadId:"main"});
  assert.equal(c.companionTaskState().status,"paused");
 });
 await check("same timestamp plan updates invalidate the snapshot cache",()=>{
  const before=journal.read(task.id);c.companionTaskState();
  before.plan=[{step:"New plan with identical timestamp",status:"pending"}];
  fs.writeFileSync(journal.file(task.id),JSON.stringify(before));
  assert.equal(c.companionTaskState().plan[0].step,"New plan with identical timestamp");
 });
 await check("corrupt journal fails visibly, clears cached evidence and returns failed ACK",async()=>{
  fs.writeFileSync(journal.file(task.id),"broken");
  assert.match(c.companionTaskState().error,/evidence unavailable/);
  await c.handleCompanionAction({instanceId:c.companionInstanceId(),requestId:"refresh-2",action:"task_evidence"});
  assert.equal(sent.at(-1).ok,false);assert.match(sent.at(-1).error,/evidence unavailable/);
  assert.equal(c._taskVisibility,null);
  const restarted=Object.create(compiled.exports.Controller.prototype);restarted.output={append(){}};
  assert.match(restarted.companionTaskState().error,/evidence unavailable/);
 });
 await check("wrong instance cannot read data; unknown action is rejected",async()=>{
  const before=sent.length;
  await c.handleCompanionAction({instanceId:"other",requestId:"wrong",action:"task_evidence"});
  assert.equal(sent.length,before);
  await c.handleCompanionAction({instanceId:c.companionInstanceId(),requestId:"unknown",action:"invented"});
  assert.equal(sent.at(-1).ok,false);
 });
 console.log(`taskVisibility.test.js: ${count}/${count} checks passed`);
} finally {fs.rmSync(root,{recursive:true,force:true});} })().catch(e=>{console.error(e);process.exitCode=1;});
