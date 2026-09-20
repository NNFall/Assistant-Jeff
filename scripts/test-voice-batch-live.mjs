// Explicit live-provider diagnostic. Synthesized audio only; never opens a microphone or executes a command.
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {DenisVoice} from '../desktop/audio/denis.mjs';
import {Mp3Encoder} from '../desktop/audio/mp3.mjs';
import {VoiceSession} from '../desktop/audio/session.mjs';
import {GeminiGateway} from '../desktop/providers/gemini.mjs';

if(!process.argv.includes('--live'))throw new Error('Requires --live; sends one synthesized audio phrase to Gemini.');
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'work','voice-batch-live',String(Date.now()));await fs.mkdir(directory,{recursive:true});
const ffmpeg=path.join(root,'work','voice-runtime','ffmpeg','ffmpeg.exe');
const gateway=new GeminiGateway(path.join(root,'data')),denis=new DenisVoice();
const phrase='Джарвис, открой диспетчер задач.';
const report={phrase,microphoneActivated:false,commandExecutions:0,events:[]};
let session;
try{
  const started=performance.now();const wav=await denis.synthesize(phrase);
  report.synthesisMs=Math.round(performance.now()-started);report.audioDurationMs=wav.durationMs;
  const wavPath=path.join(directory,'synthetic-command.wav');await fs.writeFile(wavPath,wav.wav);
  const decoded=await promisify(execFile)(ffmpeg,['-hide_banner','-loglevel','error','-i',wavPath,'-f','s16le','-ar','16000','-ac','1','pipe:1'],{shell:false,windowsHide:true,encoding:'buffer',maxBuffer:2*1024*1024});
  const pcm=new Int16Array(decoded.stdout.buffer.slice(decoded.stdout.byteOffset,decoded.stdout.byteOffset+decoded.stdout.byteLength));
  session=new VoiceSession({paths:{models:path.join(root,'models')},encoder:new Mp3Encoder({executablePath:ffmpeg}),gateway,denis,
    commands:{running:false,stop(){},run(){report.commandExecutions++;throw new Error('Diagnostic must not execute commands');}},
    getSettings:()=>({cloudEnabled:true,voiceAutoExecute:false,denisReply:true,activationBeep:false}),emit:event=>{
      if(event.type!=='speech')report.events.push(event);
      if(event.type==='transcript')report.transcript=event.text;
    }});
  if(!(await session.start({mode:'manual'})).ok)throw new Error('Voice providers unavailable');
  const input=new Int16Array(pcm.length+16000*3);input.set(pcm);
  const requestStart=performance.now();
  for(let offset=0;offset<input.length;offset+=1280){const frame=new Int16Array(1280);frame.set(input.subarray(offset,offset+1280));session.accept(frame);}
  const deadline=Date.now()+60000;
  while(!['stopped','error'].includes(session.state)&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,50));
  report.processingMs=Math.round(performance.now()-requestStart);report.state=session.state;
  report.ok=report.state==='stopped'&&report.commandExecutions===0&&/открой диспетчер задач/iu.test(report.transcript??'');
  if(!report.ok)process.exitCode=1;
}catch(error){report.ok=false;report.error=error.code??error.message;process.exitCode=1;}
finally{await session?.stop();gateway.close();await fs.writeFile(path.join(directory,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({ok:report.ok,transcript:report.transcript,synthesisMs:report.synthesisMs,audioDurationMs:report.audioDurationMs,processingMs:report.processingMs,state:report.state,commandExecutions:report.commandExecutions,directory}));
