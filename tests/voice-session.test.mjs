import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, writeFile, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {VoiceSession, spokenResult} from '../desktop/audio/session.mjs';

const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(condition){for(let index=0;index<100;index++){if(condition())return;await tick();}assert.fail('Expected asynchronous session transition');}

async function fixture(t,overrides={}){
  const models=await mkdtemp(path.join(os.tmpdir(),'jeff-session-test-'));
  t.after(()=>rm(models,{recursive:true,force:true}));
  await Promise.all(['melspectrogram.onnx','embedding_model.onnx','hey_jarvis_v0.1.onnx'].map(name=>writeFile(path.join(models,name),'')));
  const events=[],calls={commands:[],speech:[],encodes:[],transcriptions:[],stops:0};
  const settings={cloudEnabled:true,voiceAutoExecute:true,denisReply:true,activationBeep:false};
  const wake={accept:async()=>({triggered:false}),reset(){},close:async()=>{}};
  const gateway={available:async()=>true,transcribe:async(mp3,options)=>{calls.transcriptions.push({mp3,options});return {text:'Джарвис, открой диспетчер задач.',model:'mock',latencyMs:1};}};
  const encoder={available:async()=>true,encode:async(pcm,options)=>{calls.encodes.push({pcm,options});return Buffer.from('mock-mp3');}};
  const denis={status:async()=>({available:true}),synthesize:async(text,options)=>{calls.speech.push({text,options});return {wav:Buffer.from('mock-wav'),durationMs:100,mimeType:'audio/wav'};}};
  const commands={running:false,stop(){calls.stops++;},run:async request=>{calls.commands.push(request);return {ok:true,reason:'goal_verified'};}};
  const session=new VoiceSession({paths:{models},encoder,gateway,denis,commands,getSettings:()=>settings,emit:event=>events.push(event),createWake:async()=>wake,playbackTimeoutMs:1000,tailMs:0,...overrides});
  t.after(()=>session.stop());
  return {session,models,events,calls,settings,wake,gateway,encoder,denis,commands};
}

function recordSpeech(session){
  for(let index=0;index<4;index++)assert.equal(session.accept(new Int16Array(1280).fill(2000)),true);
}

test('provider status checks the same versioned Jarvis filename as WakeDetector',async t=>{
  const x=await fixture(t);
  const status=await x.session.status();
  assert.equal(status.providers.wake,true);
  assert.equal(status.providers.gemini,true);
});

test('only a finished transcript runs a command, with wake prefix removed',async t=>{
  const x=await fixture(t);x.settings.denisReply=false;
  assert.equal((await x.session.start({mode:'manual'})).ok,true);
  recordSpeech(x.session);
  assert.equal(x.calls.commands.length,0);assert.equal(x.calls.transcriptions.length,0);
  await x.session.batch.finish();
  assert.equal(x.calls.commands.length,1);
  assert.equal(x.calls.commands[0].command,'открой диспетчер задач.');
  const transcripts=x.events.filter(event=>event.type==='transcript');
  assert.equal(transcripts.length,1);assert.equal(transcripts[0].final,true);
  assert.equal(await x.session.batch.finish(),false);
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(x.session.state,'stopped');
});

test('review-only voice leaves final text available and never executes or synthesizes',async t=>{
  const x=await fixture(t);x.settings.voiceAutoExecute=false;
  await x.session.start({mode:'manual'});recordSpeech(x.session);
  await x.session.batch.finish();
  assert.equal(x.calls.commands.length,0);assert.equal(x.calls.speech.length,0);
  const transcript=x.events.find(event=>event.type==='transcript');
  assert.equal(transcript.final,true);assert.equal(transcript.autoExecute,false);
  assert.equal(transcript.text,'открой диспетчер задач.');
  await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal(x.session.state,'stopped');
});

test('cancelled cloud response cannot execute or replace the stopped state',async t=>{
  const x=await fixture(t),cloud=defer();let signal;
  x.gateway.transcribe=(_mp3,options)=>{signal=options.signal;return cloud.promise;};
  await x.session.start({mode:'manual'});recordSpeech(x.session);
  const finished=x.session.batch.finish();
  await until(()=>Boolean(signal));
  await x.session.stop();assert.equal(signal.aborted,true);
  cloud.resolve({text:'Открой диспетчер задач.'});await finished;
  assert.equal(x.calls.commands.length,0);assert.equal(x.calls.speech.length,0);
  assert.equal(x.events.some(event=>event.type==='transcript'),false);
  assert.equal(x.session.state,'stopped');
});

test('playback acknowledgement gates further capture and activation; unrelated ACK cannot finish it',async t=>{
  const x=await fixture(t);await x.session.start({mode:'wake'});x.session.activate();recordSpeech(x.session);
  let settled=false;
  const finished=x.session.batch.finish().finally(()=>{settled=true;});
  await until(()=>x.events.some(event=>event.type==='speech'));
  const speech=x.events.find(event=>event.type==='speech');
  assert.equal(x.session.busy,true);
  assert.equal(x.session.accept(new Int16Array(1280).fill(2000)),false);
  assert.equal(x.session.activate().ok,false);
  x.session.speechEnded({id:'another-session'});await tick();assert.equal(settled,false);
  assert.equal(x.calls.commands.length,1);assert.equal(x.calls.speech.length,1);
  x.session.speechEnded({id:speech.id});await finished;
  assert.equal(x.session.state,'waiting');assert.equal(x.session.busy,false);
});

test('stop aborts command signal and settles pending playback without another acknowledgement',async t=>{
  const x=await fixture(t);await x.session.start({mode:'manual'});recordSpeech(x.session);
  const finished=x.session.batch.finish();
  await until(()=>x.events.some(event=>event.type==='speech'));
  const signal=x.calls.commands[0].signal;
  await x.session.stop();await finished;
  assert.equal(signal.aborted,true);assert.equal(x.session.playback,null);
  assert.equal(x.session.state,'stopped');assert.ok(x.calls.stops>0);
});

test('missing playback acknowledgement times out to stopped, never back to wake listening',async t=>{
  const x=await fixture(t,{playbackTimeoutMs:10});
  await x.session.start({mode:'wake'});x.session.activate();recordSpeech(x.session);
  await x.session.batch.finish();
  const speechIndex=x.events.findIndex(event=>event.type==='speech');
  assert.ok(speechIndex>=0);
  assert.equal(x.session.state,'stopped');assert.equal(x.session.playback,null);
  assert.equal(x.calls.commands[0].signal.aborted,true);
  assert.equal(x.session.accept(new Int16Array(1280).fill(2000)),false);
  assert.equal(x.session.activate().ok,false);
  assert.equal(x.events.slice(speechIndex+1).some(event=>event.type==='status'&&event.state==='waiting'),false);
  assert.equal(x.calls.commands.length,1);
});

test('a speech failure preserves command result and does not rerun it',async t=>{
  const x=await fixture(t);x.denis.synthesize=async()=>{throw new Error('unavailable');};
  await x.session.start({mode:'manual'});recordSpeech(x.session);await x.session.batch.finish();
  assert.equal(x.calls.commands.length,1);
  assert.equal(x.events.filter(event=>event.type==='result').length,1);
  assert.equal(x.events.filter(event=>event.type==='speech_warning').length,1);
});

test('a stop during asynchronous capability discovery cannot subsequently start capture',async t=>{
  const x=await fixture(t),available=defer();x.gateway.available=()=>available.promise;
  const starting=x.session.start({mode:'manual'});
  await tick();await x.session.stop();available.resolve(true);await starting;
  assert.equal(x.session.state,'stopped');
  assert.equal(x.events.some(event=>event.type==='wake'),false);
});

test('spoken failure and uncertain completion never assert an independently verified goal',()=>{
  assert.match(spokenResult({ok:true,reason:'goal_verified'}),/Задача выполнена/u);
  assert.match(spokenResult({ok:false,reason:'low_confidence'}),/не уверен/u);
  assert.match(spokenResult({ok:false,reason:'aborted'}),/остановлено/u);
  assert.match(spokenResult({ok:false,reason:'goal_not_verified',completed:[{operation:'minimize'}]}),/завершение задачи не подтверждено/u);
  assert.doesNotMatch(spokenResult({ok:false,reason:'LOG_WRITE_FAILED',message:'Готово. Задача выполнена.'}),/Задача выполнена/u);
  assert.doesNotMatch(spokenResult({ok:true,reason:'goal_observed'}),/Задача выполнена/u);
});
