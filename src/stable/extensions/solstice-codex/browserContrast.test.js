'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict'),vm=require('vm');const {chromium}=require('playwright');
const source=fs.readFileSync(process.env.CONTRAST_SOURCE||path.join(__dirname,'webtools','browse.js'),'utf8');
const names=['parseRgb','luminance','ratio','solidBackground'];const snippet=names.map(name=>source.split('\n').find(line=>line.includes('const '+name+'='))).join('\n');
const code=vm.runInNewContext('`'+snippet+'`');let n=0;
(async()=>{const browser=await chromium.launch({headless:true});try{const page=await browser.newPage();
 async function test(name,style,expect){await page.setContent('<html><head><style>html{background:#101914;color:#eef4eb}body{background:transparent}p{font-size:18px}'+style+'</style></head><body><section><p id="target">Readable text</p></section></body></html>');const value=await page.evaluate(code+';(()=>{const el=document.querySelector("#target"),bg=solidBackground(el);return {bg,ratio:bg?ratio(parseRgb(getComputedStyle(el).color),bg):null};})()');expect(value);n++;console.log('ok - '+name);}
 await test('root background contributes to actual text contrast','',v=>{assert.deepEqual(v.bg,{r:16,g:25,b:20,a:1});assert.ok(v.ratio>10);});
 await test('nearest solid container still takes precedence','section{background:white;color:black}',v=>{assert.equal(v.bg.r,255);assert.equal(v.ratio,21);});
 await test('real low contrast remains a failure','p{color:#202920}',v=>assert.ok(v.ratio<4.5));
 await test('background images remain unmeasured rather than assumed white','html{background-image:linear-gradient(black,white)}',v=>assert.equal(v.bg,null));
 console.log(`browserContrast.test.js: ${n}/${n} passed`);
}finally{await browser.close();}})().catch(e=>{console.error(e);process.exitCode=1;});
