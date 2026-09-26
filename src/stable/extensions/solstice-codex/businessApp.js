"use strict";
const fs=require('fs'),path=require('path');
function scaffoldBusinessApp(root) {
 if(!root)throw new Error('Open an empty project folder first');
 fs.mkdirSync(root,{recursive:true});
 const existing=fs.readdirSync(root).filter(n=>!['.git','.vscode','.solstice'].includes(n));
 if(existing.length)throw new Error('Business scaffold requires an empty project; existing files are preserved.');
 const written=[];
 const write=(name,value)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,value,{flag:'wx'});written.push(name);};
 const configs=['design-contract.json','acceptance.json'];
 for(const name of configs)if(fs.existsSync(path.join(root,'.solstice',name)))throw new Error('Existing project contract must be preserved: '+name);
 for(const file of ['server.cjs','index.html','app.js','styles.css'])write(file,fs.readFileSync(path.join(__dirname,'templates','business',file)));
 write('package.json',JSON.stringify({name:'solstice-business-app',private:true,engines:{node:'>=22.13.0'},scripts:{dev:'node server.cjs',start:'node server.cjs'}},null,2)+'\n');
 const tokens={'--brand-accent':'#b9ee83','--brand-bg':'#101914','--brand-text':'#eef4eb'};
 const screens=['travel','jewelry','restaurant'].map((kind,i)=>({name:['תיירות','תכשיטים','מסעדה'][i],path:'/'+kind,direction:'rtl',required:['#requestForm','#receipt'],components:[{selector:'.primary',styles:{backgroundColor:'rgb(185, 238, 131)'}}]}));
 write('.solstice/design-contract.json',JSON.stringify({version:1,tokens,screens},null,2)+'\n');
 write('.solstice/acceptance.json',JSON.stringify({version:1,fixtureWrites:true,flows:screens.map((screen,i)=>({name:screen.name+' · טופס, שמירה וקריאה חוזרת',path:screen.path,steps:[{fill:'#name',value:'בדיקת קבלה '+i},{fill:'#contact',value:'qa@example.test'},{fill:'#details',value:'פניית בדיקה מקומית'},{click:'#submit'},{expectText:['#status','נשמרה ונקראה מחדש']},{reload:true},{expectText:['#receipt','בדיקת קבלה '+i]},{request:{path:'/api/admin/requests',status:401}}]}))},null,2)+'\n');
 write('README.md','# Solstice business application\n\nLocal development starter; no external services or production deployment. Requires Node 22.13 or newer with node:sqlite. Run `npm run dev` and open http://127.0.0.1:3000.\n\nThree independent flows: travel quote, jewelry inquiry, restaurant request. POST validates input and an idempotency key; receipt tokens permit readback of one request. The admin list requires BUSINESS_ADMIN_TOKEN supplied by the operator at runtime and is disabled without it. Never expose receipt tokens. This is not a complete user-account or production authentication system.\n\nSQLite lives under .solstice/business-data. The first local start creates its own database; do not point this starter at a production database. The acceptance configuration explicitly allows local fixture writes. Tests create only example.test requests. Adapt the shared CSS tokens and design-contract.json together.\n\nBefore publishing: choose real identity and role policies, hosting and data retention; validate them separately. Local passing tests do not mark the app deployed.\n');
 return {written};
}
module.exports={scaffoldBusinessApp};
