'use strict';
function targetedChange(text){
 const t=String(text||'').replace(/\b(?:not|no|without)\s+(?:(?:a|an|any)\s+)?(?:brand[- ]new|new)\s+(?:site|website|application)\b/ig,'').replace(/\bnot\s+from scratch\b/ig,'').replace(/(?:לא|בלי)\s+(?:אתר חדש|אפליקציה חדשה|מאפס)/g,'');
 if(/from scratch|brand.new|new (?:site|website|application)|מאפס|אתר חדש|אפליקציה חדשה/i.test(t))return false;
 return /\b(fix|repair|adjust|change|update|add)\b|תקן|שנה|עדכן|תוסיף|הוסף/i.test(t)&&/\b(existing|current|button|field|counter|component|form|label)\b|קיים|כפתור|שדה|רכיב|טופס|תווית/i.test(t);
}
function focusInstructions(text){return targetedChange(text)||String(text).includes('[FELIX_TARGETED_CHANGE]')?[
 '[FELIX_TARGETED_CHANGE]',
 /\b(research|deconstruct|inspiration|references)\b|חקור|תחקור|רפרנס|השראה/i.test(String(text)) ? '[FELIX_TARGETED_RESEARCH]' : '',
 'This is a focused change to an existing project. Inspect the affected files and preserve the current architecture, shared design contract, data flow and unrelated UI.',
 'For this scope, skip new-site brief/deconstruction/research scaffolding, brand redefinition and new imagery unless explicitly requested. This scope exception overrides the general new-build workflow.',
 'Use only relevant or explicitly requested skills. Reproduce the issue, make the smallest complete change, run focused checks and the configured acceptance scenarios, and retain before/after evidence for visual edits.',
 'Do not turn a field or component change into a rebuild. State any unverified result accurately.',
 '[/FELIX_TARGETED_CHANGE]',''].join('\n'):'';}
module.exports={targetedChange,focusInstructions};
