'use strict';
// One in-flight recording per controller. Cancellation and deadline cover both
// the HTTP request and reading its body; stale completions never reach the view.
class VoiceTranscription {
 constructor({fetchImpl=globalThis.fetch,timeoutMs=45000,maxBytes=20*1024*1024}={}) {Object.assign(this,{fetchImpl,timeoutMs,maxBytes});this.active=null;}
 cancel() {this.active?.abort();this.active=null;}
 async run({audio,mime='audio/webm',requestId,key,language='he'},post) {
  this.cancel();const controller=new AbortController();this.active=controller;
  const emit=data=>{if(this.active===controller)post({...data,requestId});};
  let timer;
  try {
   if(!requestId||typeof requestId!=='string'||requestId.length>120)throw new Error('Recording identifier is missing. Record again.');
   if(!key)throw new Error('Voice needs a Groq key — configure voice transcription first.');
   if(typeof audio!=='string'||audio.length>Math.ceil(this.maxBytes/3)*4||!audio.length||audio.length%4!==0||!/^[A-Za-z0-9+/]+={0,2}$/.test(audio))throw new Error('Recording is empty, invalid or too large.');
   const bytes=Buffer.from(audio,'base64');if(!bytes.length||bytes.length>this.maxBytes)throw new Error('Recording is too large.');
   const format=String(mime).split(';')[0];const ext={'audio/webm':'webm','audio/ogg':'ogg','audio/mp4':'mp4','audio/wav':'wav'}[format];
   if(!ext)throw new Error('Recording format is not supported.');
   const form=new FormData();form.append('file',new Blob([bytes],{type:format}),'voice.'+ext);form.append('model','whisper-large-v3');
   if(language!=='auto')form.append('language',/^[a-z]{2,3}$/.test(language)?language:'he');
   const aborted=new Promise((_,reject)=>{controller.signal.addEventListener('abort',()=>reject(new Error('Transcription cancelled or timed out. Try recording again.')),{once:true});});
   timer=setTimeout(()=>controller.abort(),this.timeoutMs);
   const operation=(async()=>{const response=await this.fetchImpl('https://api.groq.com/openai/v1/audio/transcriptions',{method:'POST',headers:{Authorization:'Bearer '+key},body:form,signal:controller.signal});
    if(!response.ok)throw new Error('Transcription service returned HTTP '+response.status+'. Try again.');
    const data=await response.json();if(typeof data?.text!=='string'||!data.text.trim())throw new Error('No speech detected.');return data.text.trim();})();
   const text=await Promise.race([operation,aborted]);emit({type:'transcribed',text});
  }catch(error){emit({type:'transcribeError',message:error.message});}
  finally{clearTimeout(timer);if(this.active===controller)this.active=null;}
 }
}
module.exports={VoiceTranscription};
