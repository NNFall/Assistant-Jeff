import {spawn} from 'node:child_process';
import {access} from 'node:fs/promises';

const failure=code=>Object.assign(new Error(code),{code});
/** Fixed local PCM16 -> MP3 encoder. No microphone access or audio files. */
export class Mp3Encoder {
  constructor({executablePath,spawnImpl=spawn,timeoutMs=15000}={}){Object.assign(this,{executablePath,spawnImpl,timeoutMs});}
  async available(){try{await access(this.executablePath);return true;}catch{return false;}}
  async encode(pcm,{signal}={}){
    if(signal?.aborted)throw failure('ABORTED');
    if(!(pcm instanceof Int16Array)||!pcm.length||pcm.length>16000*32)throw failure('AUDIO_INVALID');
    if(!await this.available())throw failure('ENCODER_MISSING');
    if(signal?.aborted)throw failure('ABORTED');
    return new Promise((resolve,reject)=>{
      let child,settled=false,size=0;const chunks=[];
      const finish=(code)=>{if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',cancel);if(code){child?.kill();reject(failure(code));}else resolve(Buffer.concat(chunks));};
      const cancel=()=>finish('ABORTED');const timer=setTimeout(()=>finish('ENCODER_TIMEOUT'),this.timeoutMs);
      signal?.addEventListener('abort',cancel,{once:true});
      try{
        child=this.spawnImpl(this.executablePath,['-hide_banner','-loglevel','error','-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-codec:a','libmp3lame','-b:a','64k','-f','mp3','pipe:1'],{shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
        child.stderr.resume();child.on('error',()=>finish('ENCODER_FAILED'));child.stdin.on('error',()=>finish('ENCODER_FAILED'));
        child.stdout.on('data',chunk=>{size+=chunk.length;if(size>1024*1024)finish('AUDIO_TOO_LARGE');else if(!settled)chunks.push(chunk);});
        child.on('close',code=>finish(code!==0||size<100?'ENCODER_FAILED':null));
        child.stdin.end(Buffer.from(pcm.buffer,pcm.byteOffset,pcm.byteLength));
      }catch{finish('ENCODER_FAILED');}
    });
  }
}
