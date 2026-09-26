'use strict';
const kind=['travel','jewelry','restaurant'].find(k=>location.pathname==='/'+k)||'travel';
const labels={travel:['תיירות','בקשת הצעה לטיול'],jewelry:['תכשיטים','פנייה לגבי פריט'],restaurant:['מסעדה','בקשת הזמנת מקום']};
document.querySelector('#kindLabel').textContent=labels[kind][0];document.querySelector('#heading').textContent=labels[kind][1];document.querySelector(`nav a[href="/${kind}"]`).setAttribute('aria-current','page');
const form=document.querySelector('#requestForm'),status=document.querySelector('#status'),receipt=document.querySelector('#receipt'),button=document.querySelector('#submit');
const storageKey='solstice-request-'+kind;let pending;try{pending=JSON.parse(sessionStorage.getItem(storageKey+'-pending')||'null');}catch{}
function show(data){receipt.replaceChildren();const title=document.createElement('strong');title.textContent='הבקשה נשמרה · '+data.name;const detail=document.createElement('p');detail.textContent=data.details;const time=document.createElement('small');time.textContent=new Date(data.createdAt).toLocaleString('he-IL');receipt.append(title,detail,time);}
async function readBack(id){const response=await fetch('/api/requests/'+encodeURIComponent(id));if(!response.ok)throw new Error('לא ניתן לקרוא את הבקשה מהשרת');show(await response.json());}
let accepted;try{accepted=JSON.parse(sessionStorage.getItem(storageKey)||'null');}catch{}
if(accepted?.id)readBack(accepted.id).catch(e=>receipt.textContent=e.message);
form.addEventListener('submit',async event=>{event.preventDefault();if(button.disabled)return;const body={kind,name:form.elements.name.value,contact:form.elements.contact.value,details:form.elements.details.value};
 if(accepted&&JSON.stringify(accepted.body)===JSON.stringify(body)){button.disabled=true;try{await readBack(accepted.id);status.textContent='הבקשה נשמרה ונקראה מחדש מהשרת.';}catch(e){status.textContent=e.message+' אפשר לנסות שוב.';}finally{button.disabled=false;}return;}
 if(pending&&JSON.stringify(pending.body)!==JSON.stringify(body)){status.textContent='יש שליחה שלא הוכרעה. נסה שוב עם הפרטים הקודמים לפני יצירת בקשה חדשה.';return;}
 if(!pending){pending={key:crypto.randomUUID(),body};sessionStorage.setItem(storageKey+'-pending',JSON.stringify(pending));}
 button.disabled=true;status.textContent='שומר בקשה…';
 try{const response=await fetch('/api/requests',{method:'POST',headers:{'content-type':'application/json','idempotency-key':pending.key},body:JSON.stringify(pending.body)});const data=await response.json();if(!response.ok){if(response.status>=400&&response.status<500){pending=null;sessionStorage.removeItem(storageKey+'-pending');}throw new Error(data.error||'השמירה נכשלה');}
  if(typeof data.id!=='string'||!data.createdAt)throw new Error('לא התקבל אישור שמירה תקין');accepted={id:data.id,body:pending.body};sessionStorage.setItem(storageKey,JSON.stringify(accepted));pending=null;sessionStorage.removeItem(storageKey+'-pending');await readBack(data.id);status.textContent='הבקשה נשמרה ונקראה מחדש מהשרת.';
 }catch(error){status.textContent=error.message+' אפשר לנסות שוב.';}finally{button.disabled=false;}
});
if(pending){for(const key of ['name','contact','details'])form.elements[key].value=pending.body[key];status.textContent='נמצאה שליחה שלא הוכרעה. ניסיון חוזר ישתמש באותו מזהה.';}
