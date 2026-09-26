"use strict";
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const SKIP = new Set(['.git', 'node_modules', '.next', '.nuxt', '.turbo', 'dist', 'build', 'out', 'coverage', '.venv', '__pycache__']);
const CONFIG = new Set(['brand-dna.json', 'design-contract.json', 'acceptance.json', 'mercury']);
function sourceRevision(root, limits = {}) {
 const hash = crypto.createHash('sha256'), files = []; let bytes = 0, complete = true;
 const maxFiles = limits.maxFiles ?? 10000, maxBytes = limits.maxBytes ?? 256 * 1024 * 1024;
 function walk(dir, rel = '') {
  let entries; try { entries = fs.readdirSync(dir, {withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0); } catch { complete=false; return; }
  for (const entry of entries) {
   if (SKIP.has(entry.name) || /^\.env(?:\.|$)/.test(entry.name) || entry.name === '.DS_Store') continue;
   if (rel === '.solstice' && !CONFIG.has(entry.name)) continue;
   if (rel === '.solstice/mercury' && entry.name !== 'seed.json') continue;
   const name = rel ? rel+'/'+entry.name : entry.name, file = path.join(dir,entry.name);
   if (entry.isDirectory()) { walk(file,name); continue; }
   if (!entry.isFile()) { complete=false; continue; }
   try {
    const before=fs.statSync(file); bytes+=before.size;
    if (files.length>=maxFiles || bytes>maxBytes) { complete=false; return; }
    const content=fs.readFileSync(file), after=fs.statSync(file);
    if (before.size!==after.size || before.mtimeMs!==after.mtimeMs) complete=false;
    const digest=crypto.createHash('sha256').update(content).digest('hex');
    hash.update(JSON.stringify([name,digest])+'\n'); files.push(name);
   } catch { complete=false; }
  }
 }
 walk(path.resolve(root));
 return {sha256:hash.digest('hex'),complete,files:files.length,bytes};
}
function sameRevision(a,b) { return !!(a && b && a.complete===true && b.complete===true && a.sha256===b.sha256); }
module.exports={sourceRevision,sameRevision};
