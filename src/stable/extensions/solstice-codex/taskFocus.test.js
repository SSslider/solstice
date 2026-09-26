'use strict';
const assert=require('assert/strict');const {targetedChange,focusInstructions}=require('./taskFocus');
let n=0;for(const t of ['Fix this existing application field','Fix the current button, not a new site','תקן את הטופס הקיים, לא אתר חדש','Add a counter to the current form','תקן את הכפתור בטופס הקיים','שנה את תווית השדה']){assert.equal(targetedChange(t),true);assert.match(focusInstructions(t),/skip new-site/);n++;}
for(const t of ['Build a new website from scratch','בנה אתר חדש','Create an application']){assert.equal(targetedChange(t),false);assert.equal(focusInstructions(t),'');n++;}
const fs=require('fs'),path=require('path'),vm=require('vm');
const source=fs.readFileSync(path.join(__dirname,'extension.js'),'utf8');
const fn=source.slice(source.indexOf('function needsResearchContract('),source.indexOf('function siteReplicaSourceUrl('));
const ctx={};vm.createContext(ctx);vm.runInContext(fn,ctx);
const focused=focusInstructions('Fix the existing form');
assert.equal(ctx.needsResearchContract(focused+'Inspect the app style and screenshot'),false);n++;
assert.equal(ctx.needsResearchContract(focusInstructions('Fix the existing form and research design references')+'https://example.com app'),true);n++;
assert.equal(ctx.needsResearchContract('Research this website https://example.com'),true);n++;
console.log(`taskFocus.test.js: ${n}/${n} passed`);
