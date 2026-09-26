'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto');
// Persist a receipt BEFORE a remote side effect. If the IDE dies mid-action,
// replay reports an unknown outcome instead of executing the command twice.
class CompanionActions {
 constructor(root){this.file=path.join(root,'.solstice','companion-actions.json');this.running=new Map();}
 async run(frame,execute){
  const id=String(frame.requestId||'');if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,95}$/.test(id))return {ok:false,error:'A valid request identifier is required'};
  const fingerprint=crypto.createHash('sha256').update(JSON.stringify([frame.action,frame.payload||{}])).digest('hex');
  let records={};try{records=JSON.parse(fs.readFileSync(this.file,'utf8'));if(!records||Array.isArray(records)||typeof records!=='object')throw Error('invalid');}catch(error){if(error.code!=='ENOENT')return {ok:false,error:'Remote action receipts are unavailable. Inspect the saved task before retrying.'};}
  if(Object.hasOwn(records,id)){
   const record=records[id];if(record.fingerprint!==fingerprint)return {ok:false,error:'Request identifier already belongs to another action'};
   if(this.running.has(id))return this.running.get(id);
   return record.result||{ok:false,error:'Previous action was interrupted; outcome is unknown. Inspect the saved task before issuing a new action.'};
  }
  const keys=Object.keys(records);if(keys.length>=256){for(const key of keys){if(records[key].result){delete records[key];break;}}if(Object.keys(records).length>=256)return {ok:false,error:'Too many unresolved remote actions. Inspect saved tasks first.'};}
  records[id]={fingerprint,startedAt:new Date().toISOString()};
  const save=rows=>{fs.mkdirSync(path.dirname(this.file),{recursive:true});const temp=this.file+'.tmp';fs.writeFileSync(temp,JSON.stringify(rows));fs.renameSync(temp,this.file);};
  try{save(records);}catch{return {ok:false,error:'Could not save remote action receipt. No action was executed.'};}
  const pending=(async()=>{let result;try{result=await execute();}catch(error){result={ok:false,error:String(error.message||error)};}
   try{const latest=JSON.parse(fs.readFileSync(this.file,'utf8'));latest[id]={...latest[id],result,completedAt:new Date().toISOString()};save(latest);}catch{return {ok:false,error:'Action ran but its receipt could not be saved. Inspect the task before retrying.'};}
   return result;
  })();this.running.set(id,pending);
  try{return await pending;}finally{this.running.delete(id);}
 }
}
module.exports={CompanionActions};
