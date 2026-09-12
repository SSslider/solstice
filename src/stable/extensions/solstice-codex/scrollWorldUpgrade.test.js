'use strict';
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict'), crypto=require('node:crypto');
const {FelixSkills}=require('./felixSkills');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'scrollworld-upgrade-'));
let checks=0; const check=(v,label)=>{assert.ok(v,label);checks++;};
try{
  const bundle=path.join(dir,'bundle'), bundled=path.join(bundle,'prompts/scroll-world');
  fs.mkdirSync(path.join(bundled,'references'),{recursive:true});
  fs.copyFileSync(path.join(__dirname,'prompts/scroll-world/SKILL.md'),path.join(bundled,'SKILL.md'));
  fs.writeFileSync(path.join(bundled,'references/scrub-engine.js'),'new engine');
  const oldSkill=fs.readFileSync(path.join(bundled,'SKILL.md'),'utf8').replace('version: 2','version: 1');
  const original={'SKILL.md':oldSkill,'references/scrub-engine.js':'old engine'};
  fs.writeFileSync(path.join(bundled,'upgrade-from.json'),JSON.stringify({files:Object.fromEntries(Object.entries(original).map(([file,text])=>[file,crypto.createHash('sha256').update(text).digest('hex')]))}));
  for(const mode of ['unchanged','custom-engine','custom-contract','custom-extra','partial']){
    const skills=new FelixSkills({dir:path.join(dir,mode)});
    const runtime=path.join(skills.skillsDir,'scroll-world-gpt-image');fs.mkdirSync(path.join(runtime,'references'),{recursive:true});
    for(const [file,text]of Object.entries(original))fs.writeFileSync(path.join(runtime,file),text);
    fs.writeFileSync(path.join(runtime,'.felix-runtime.json'),JSON.stringify({uses:17}));
    if(mode==='custom-engine')fs.appendFileSync(path.join(runtime,'references/scrub-engine.js'),' custom');
    if(mode==='custom-contract')fs.appendFileSync(path.join(runtime,'SKILL.md'),'\ncustom instructions');
    if(mode==='custom-extra')fs.writeFileSync(path.join(runtime,'extra.txt'),'my resource');
    if(mode==='partial')fs.unlinkSync(path.join(runtime,'references/scrub-engine.js'));
    const before=fs.readFileSync(path.join(runtime,'SKILL.md'),'utf8');
    const result=skills.seedFrom(bundle).scrollWorld;
    if(mode==='unchanged'){
      check(result.status==='repaired','shipped old bundle automatically upgrades');
      check(fs.readFileSync(path.join(result.backup,'references/scrub-engine.js'),'utf8')==='old engine','prior engine survives in backup');
      check(skills.runtimeDiagnostics(bundle).status==='healthy','upgraded resource inventory matches the current bundle');
      check(JSON.parse(fs.readFileSync(path.join(runtime,'.felix-runtime.json'))).uses===17,'usage metadata preserved');
      check(skills.seedFrom(bundle).scrollWorld.status==='verified','second launch does not repeat the migration');
    }else{
      check(fs.readFileSync(path.join(runtime,'SKILL.md'),'utf8')===before,mode+': existing contract not overwritten');
      check(result.backup===undefined,mode+': custom or incomplete runtime not automatically replaced');
      if(mode==='custom-extra')check(fs.readFileSync(path.join(runtime,'extra.txt'),'utf8')==='my resource','extra resource remains active');
      if(mode==='custom-engine')check(fs.readFileSync(path.join(runtime,'references/scrub-engine.js'),'utf8')==='old engine custom','custom engine stays byte-exact');
      check(skills.runtimeDiagnostics(bundle).status==='runtime-modified',mode+': diagnostics expose the old/custom runtime');
    }
  }
  console.log(`scrollWorldUpgrade.test.js: ${checks}/${checks} checks passed`);
}finally{fs.rmSync(dir,{recursive:true,force:true});}
