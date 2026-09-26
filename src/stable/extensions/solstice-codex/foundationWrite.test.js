"use strict";
const assert=require('assert/strict'),http=require('http');
const {FoundationClient}=require('./foundationClient');
let count=0;
(async()=>{
const snapshot={nodes:[],edges:[]};let payload={ok:true,revision:2,snapshot},status=200;
const requests=[];
const server=http.createServer((req,res)=>{let text='';req.on('data',d=>text+=d);req.on('end',()=>{requests.push({key:req.headers['x-studio-key'],body:JSON.parse(text)});res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(payload));});});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const client=new FoundationClient({endpoint:`http://127.0.0.1:${server.address().port}/api/foundation/events`,studioKey:'local-test-only',timeout:1000});
async function test(name,fn){await fn();count++;console.log('ok - '+name);}
try{
 await test('complete authenticated write carries id and revision',async()=>{const saved=await client.saveCanvas('test',snapshot,1,'retry-id');assert.equal(saved.revision,2);assert.equal(requests[0].key,'local-test-only');assert.equal(requests[0].body.expected_revision,1);assert.equal(requests[0].body.mutation_id,'retry-id');});
 await test('HTTP success with application failure is not acknowledgement',async()=>{payload={ok:false,error:'failed'};await assert.rejects(()=>client.saveCanvas('test',snapshot,1),e=>e.code==='invalid_canvas_ack');});
 await test('missing or malformed canonical revision fails closed',async()=>{for(const value of [{ok:true},{ok:true,revision:2},{ok:true,revision:'2',snapshot},{ok:true,revision:2,snapshot:{nodes:[]}}]){payload=value;await assert.rejects(()=>client.saveCanvas('test',snapshot,1),e=>e.code==='invalid_canvas_ack');}});
 await test('revision conflicts remain distinguishable for recovery',async()=>{status=409;payload={error:'revision conflict'};await assert.rejects(()=>client.saveCanvas('test',snapshot,1),e=>e.statusCode===409);});
 await test('keyless writes make no request',async()=>{const before=requests.length;const keyless=new FoundationClient({endpoint:client.endpoint,studioKey:''});await assert.rejects(()=>keyless.saveCanvas('test',snapshot,1),e=>e.code==='missing_studio_key');assert.equal(requests.length,before);keyless.dispose();});
 console.log(`foundationWrite.test.js: ${count}/${count} passed`);
}finally{client.dispose();await new Promise(r=>server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
