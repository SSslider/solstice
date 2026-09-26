'use strict';
const http=require('http'),fs=require('fs'),path=require('path'),crypto=require('crypto');
const {DatabaseSync}=require('node:sqlite');
function start({root=__dirname,port=0,adminToken=process.env.BUSINESS_ADMIN_TOKEN||''}={}){
 const dir=path.join(root,'.solstice','business-data');fs.mkdirSync(dir,{recursive:true});
 const db=new DatabaseSync(path.join(dir,'requests.sqlite'));
 db.exec('PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL)');
 const insert=db.prepare('INSERT INTO requests VALUES (?,?,?,?)'),byKey=db.prepare('SELECT * FROM requests WHERE request_key=?'),byId=db.prepare('SELECT * FROM requests WHERE id=?');
 const json=(res,status,data)=>{res.writeHead(status,{'content-type':'application/json; charset=utf-8','cache-control':'no-store','x-content-type-options':'nosniff'});res.end(JSON.stringify(data));};
 const body=req=>new Promise((resolve,reject)=>{let size=0,chunks=[];req.on('data',chunk=>{size+=chunk.length;if(size<=8192)chunks.push(chunk);});req.on('end',()=>{try{if(size>8192)throw new Error('too large');resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));}catch{reject(new Error('invalid JSON'));}});req.on('error',reject);});
 const safeEqual=(a,b)=>{const x=Buffer.from(a),y=Buffer.from(b);return x.length===y.length&&crypto.timingSafeEqual(x,y);};
 const record=row=>({id:row.id,...JSON.parse(row.payload),createdAt:row.created_at});
 const server=http.createServer(async(req,res)=>{
  try{
   const pathname=new URL(req.url,'http://127.0.0.1').pathname;
   if(req.headers.origin&&req.headers.origin!==`http://${req.headers.host}`){json(res,403,{error:'Origin not allowed'});return;}
   if(pathname==='/api/requests'&&req.method==='POST'){
    const input=await body(req),key=String(req.headers['idempotency-key']||'');
    if(!/^[a-zA-Z0-9_-]{16,80}$/.test(key)){json(res,400,{error:'A request identifier is required'});return;}
    const {kind,name,contact,details}=input;
    if(!['travel','jewelry','restaurant'].includes(kind)||typeof name!=='string'||!name.trim()||name.length>100||typeof contact!=='string'||!contact.trim()||contact.length>150||typeof details!=='string'||details.length>1000){json(res,422,{error:'בדוק את השם, פרטי הקשר ותוכן הבקשה'});return;}
    const payload=JSON.stringify({kind,name:name.trim(),contact:contact.trim(),details:details.trim()}),old=byKey.get(key);
    if(old){if(old.payload!==payload){json(res,409,{error:'Request identifier already belongs to different content'});return;}json(res,200,record(old));return;}
    const id=crypto.randomBytes(24).toString('base64url'),createdAt=new Date().toISOString();
    insert.run(id,key,payload,createdAt);json(res,201,record(byId.get(id)));return;
   }
   if(pathname==='/api/admin/requests'){
    if(!adminToken||!safeEqual(String(req.headers.authorization||''),'Bearer '+adminToken)){json(res,401,{error:'Unauthorized'});return;}
    if(req.method!=='GET'){json(res,405,{error:'Method not allowed'});return;}
    json(res,200,{items:db.prepare('SELECT * FROM requests ORDER BY created_at DESC').all().map(record)});return;
   }
   if(pathname.startsWith('/api/requests/')&&req.method==='GET'){
    const id=pathname.slice('/api/requests/'.length),row=/^[a-zA-Z0-9_-]{32}$/.test(id)?byId.get(id):null;
    if(!row){json(res,404,{error:'Request not found'});return;}json(res,200,record(row));return;
   }
   if(pathname==='/api/health'){json(res,200,{ok:true,storage:'sqlite'});return;}
   if(pathname.startsWith('/api/')){json(res,404,{error:'Not found'});return;}
   if(!['GET','HEAD'].includes(req.method)){json(res,405,{error:'Method not allowed'});return;}
   const files={'/':'index.html','/travel':'index.html','/jewelry':'index.html','/restaurant':'index.html','/app.js':'app.js','/styles.css':'styles.css'};
   const file=files[pathname];if(!file){res.writeHead(404);res.end('Not found');return;}
   const bytes=fs.readFileSync(path.join(root,file));res.writeHead(200,{'content-type':file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8','content-security-policy':"default-src 'self'; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'self' vscode-webview: vscode-file://vscode-app",'x-content-type-options':'nosniff','cache-control':'no-store'});res.end(req.method==='HEAD'?undefined:bytes);
  }catch{if(!res.headersSent)json(res,400,{error:'הבקשה לא נשמרה. נסה שוב.'});else res.end();}
 });
 server.on('close',()=>db.close());return new Promise((resolve,reject)=>{server.once('error',e=>{db.close();reject(e);});server.listen(port,'127.0.0.1',()=>resolve(server));});
}
if(require.main===module)start({port:Number(process.env.PORT)||3000}).then(s=>console.log('Business app listening on http://127.0.0.1:'+s.address().port)).catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={start};
