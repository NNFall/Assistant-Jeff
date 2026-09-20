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
  assert.match(spokenResult({ok:false,reason:'low_confidence'}),/не уверен/iu);
  assert.match(spokenResult({ok:false,reason:'aborted'}),/остановлено/u);
  assert.match(spokenResult({ok:false,reason:'goal_not_verified',completed:[{operation:'minimize',outcome:'verified'}]}),/завершение задачи не подтверждено/u);
  assert.doesNotMatch(spokenResult({ok:false,reason:'LOG_WRITE_FAILED',message:'Готово. Задача выполнена.'}),/Задача выполнена/u);
  assert.doesNotMatch(spokenResult({ok:true,reason:'goal_observed'}),/Задача выполнена/u);
});

test('typed failures publish a result before narration with capture off, and stay busy until playback ends',async t=>{
  const x=await fixture(t);
  x.commands.run=async request=>{x.calls.commands.push(request);return {ok:false,reason:'unsupported',command:request.command};};
  const running=x.session.runTyped({command:'Открой отсутствующее приложение'});
  await until(()=>x.events.some(event=>event.type==='speech'));
  assert.equal(x.session.batch.state,'stopped');assert.equal(x.session.busy,true);
  assert.equal(x.session.accept(new Int16Array(1280)),false);assert.equal(x.calls.encodes.length,0);
  const result=x.events.find(event=>event.type==='result'),speech=x.events.find(event=>event.type==='speech');
  assert.equal(result.source,'typed');assert.equal(speech.source,'typed');assert.equal(result.operationId,speech.operationId);
  assert.ok(x.events.indexOf(result)<x.events.indexOf(speech));assert.doesNotMatch(x.calls.speech[0].text,/Задача выполнена/u);
  await assert.rejects(()=>x.session.runTyped({command:'Вторая команда'}),{code:'TASK_ALREADY_RUNNING'});
  x.session.speechEnded({id:speech.id});const report=await running;
  assert.equal(report.reason,'unsupported');assert.equal(x.session.busy,false);assert.equal(x.session.state,'stopped');
  assert.equal(x.events.at(-1).state,'stopped');assert.equal(x.events.at(-1).source,'typed');
});

test('typed narration respects disabled reply, and successful report is not delayed or changed',async t=>{
  const x=await fixture(t);x.settings.denisReply=false;
  const report=await x.session.runTyped({command:'Открой диспетчер задач'});
  assert.equal(report.reason,'goal_verified');assert.equal(x.calls.speech.length,0);
  assert.equal(x.events.filter(event=>event.type==='result').length,1);assert.equal(x.session.busy,false);
});

test('stopping typed synthesis suppresses a late audio result and a stale idle event',async t=>{
  const x=await fixture(t),audio=defer();let signal;
  x.denis.synthesize=async(_text,options)=>{signal=options.signal;return audio.promise;};
  const running=x.session.runTyped({command:'Открой диспетчер задач'});
  await until(()=>Boolean(signal));await x.session.stop();
  assert.equal(signal.aborted,true);assert.equal(x.session.busy,false);
  const stoppedAt=x.events.length;
  audio.resolve({wav:Buffer.from('late'),durationMs:1});const report=await running;
  assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');
  assert.equal(x.events.slice(stoppedAt).length,0);assert.equal(x.session.playback,null);
});

test('stopping a typed command suppresses stale result and narration even when executor ignores abort',async t=>{
  const x=await fixture(t),result=defer();let signal;
  x.commands.run=async request=>{signal=request.signal;return result.promise;};
  const running=x.session.runTyped({command:'Открой диспетчер задач'});
  await until(()=>Boolean(signal));await x.session.stop();result.resolve({ok:true,reason:'goal_verified'});
  assert.equal((await running).reason,'aborted');assert.equal(signal.aborted,true);
  assert.equal(x.events.some(event=>event.type==='result'),false);assert.equal(x.calls.speech.length,0);
});

test('thrown command errors resolve into a friendly result and release voice processing',async t=>{
  const x=await fixture(t);x.settings.denisReply=false;
  x.commands.run=async()=>{throw Object.assign(new Error('PRIVATE provider response'),{code:'WINDOWS_CHOICE_NETWORK'});};
  await x.session.start({mode:'manual'});recordSpeech(x.session);await x.session.batch.finish();
  const result=x.events.find(event=>event.type==='result');
  assert.equal(result.report.reason,'WINDOWS_CHOICE_NETWORK');assert.equal(result.report.ok,false);
  assert.equal(JSON.stringify(x.events).includes('PRIVATE'),false);
  assert.equal(x.session.busy,false);assert.equal(x.events.some(event=>event.type==='voice_notice'),false);
});

test('silence yields a persistent notice and local explanation without cloud or command',async t=>{
  const x=await fixture(t);await x.session.start({mode:'wake'});x.session.activate();
  const finish=x.session.batch.finish();await until(()=>x.events.some(event=>event.type==='speech'));
  const notice=x.events.find(event=>event.type==='voice_notice'),speech=x.events.find(event=>event.type==='speech');
  assert.equal(notice.code,'NO_SPEECH');assert.ok(notice.title);assert.ok(notice.message);assert.equal(notice.source,'voice');
  assert.equal(x.session.accept(new Int16Array(1280)),false);
  x.session.speechEnded({id:speech.id});await finish;
  assert.equal(x.session.state,'waiting');assert.equal(x.calls.commands.length,0);assert.equal(x.calls.transcriptions.length,0);
  assert.equal(x.events.filter(event=>event.type==='voice_notice').length,1);
});

test('cloud failure is explained locally before error state and never exposes raw provider text',async t=>{
  const x=await fixture(t);x.gateway.transcribe=async()=>{throw new Error('PRIVATE cloud payload');};
  await x.session.start({mode:'manual'});recordSpeech(x.session);
  const finish=x.session.batch.finish();await until(()=>x.events.some(event=>event.type==='speech'));
  const notice=x.events.find(event=>event.type==='voice_notice'),speech=x.events.find(event=>event.type==='speech');
  assert.equal(notice.code,'VOICE_PROCESSING_FAILED');assert.equal(x.session.state,'ready');
  x.session.speechEnded({id:speech.id});await finish;
  assert.equal(x.session.state,'error');assert.equal(x.calls.commands.length,0);assert.equal(JSON.stringify(x.events).includes('PRIVATE'),false);
});

test('pending voice capability discovery prevents a competing typed command',async t=>{
  const x=await fixture(t),available=defer();x.gateway.available=()=>available.promise;
  const starting=x.session.start({mode:'manual'});
  await assert.rejects(()=>x.session.runTyped({command:'Открой диспетчер задач'}),{code:'TASK_ALREADY_RUNNING'});
  await x.session.stop();available.resolve(true);assert.equal((await starting).ok,false);
  assert.equal(x.calls.commands.length,0);assert.equal(x.session.state,'stopped');assert.equal(x.session.busy,false);
});

test('stopping a recognition explanation cannot resume listening or emit stale error afterward',async t=>{
  const x=await fixture(t);await x.session.start({mode:'wake'});x.session.activate();
  const finishing=x.session.batch.finish();await until(()=>x.events.some(event=>event.type==='speech'));
  await x.session.stop();const stopIndex=x.events.length;await finishing;
  assert.equal(x.session.state,'stopped');assert.equal(x.events.slice(stopIndex).some(event=>event.type==='status'),false);
  assert.equal(x.calls.commands.length,0);assert.equal(x.session.playback,null);
});

test('wake transcription for review closes capture and remains editable until the next explicit command',async t=>{
  const x=await fixture(t);x.settings.voiceAutoExecute=false;x.settings.denisReply=false;let closes=0;x.wake.close=async()=>{closes++;};
  await x.session.start({mode:'wake'});x.session.activate();recordSpeech(x.session);
  assert.equal(await x.session.batch.finish(),true);
  assert.equal(x.session.state,'stopped');assert.equal(x.session.busy,false);assert.equal(closes,1);
  const final=x.events.at(-1);assert.equal(final.review,true);assert.match(final.message,/Проверьте текст/u);
  assert.equal(x.session.accept(new Int16Array(1280)),false);assert.equal(x.session.activate().ok,false);
  assert.equal(x.calls.commands.length,0);assert.equal(x.calls.speech.length,0);
  await tick();assert.equal(x.events.at(-1),final);
  const edited='Сверни диспетчер задач';await x.session.runTyped({command:edited});
  assert.equal(x.calls.commands[0].command,edited);
});

test('unavailable voice providers have stable independent error codes and never record',async t=>{
  for(const kind of ['cloud','gemini','encoder'])await t.test(kind,async t=>{
    const x=await fixture(t);x.settings.denisReply=false;
    if(kind==='cloud')x.settings.cloudEnabled=false;
    if(kind==='gemini')x.gateway.available=async()=>false;
    if(kind==='encoder')x.encoder.available=async()=>false;
    const expected={cloud:'CLOUD_DISABLED',gemini:'GEMINI_UNAVAILABLE',encoder:'ENCODER_MISSING'}[kind];
    const result=await x.session.start({mode:'manual'});
    assert.equal(result.ok,false);assert.equal(result.error,expected);assert.equal(result.code,expected);assert.ok(result.message);
    assert.equal(x.session.state,'stopped');assert.equal(x.session.busy,false);assert.equal(x.session.accept(new Int16Array(1280)),false);
  });
});

test('wake loading failure returns the same stable code as the persistent notice',async t=>{
  const x=await fixture(t,{createWake:async()=>{throw new Error('PRIVATE missing model');}});x.settings.denisReply=false;
  const result=await x.session.start({mode:'wake'});
  assert.equal(result.ok,false);assert.equal(result.error,'WAKE_LOAD_FAILED');assert.equal(x.session.state,'error');
  assert.equal(x.events.find(event=>event.type==='voice_notice').code,result.code);
  assert.equal(JSON.stringify({result,events:x.events}).includes('PRIVATE'),false);
});

test('failed manual activation is never reported as a successful microphone start',async t=>{
  const x=await fixture(t);x.session.batch.activate=()=>false;
  const result=await x.session.start({mode:'manual'});
  assert.equal(result.ok,false);assert.equal(result.error,'VOICE_BUSY');assert.equal(x.calls.commands.length,0);
});

test('stopping typed playback preserves the successful result instead of turning it into cancellation',async t=>{
  const x=await fixture(t);const running=x.session.runTyped({command:'Открой диспетчер задач'});
  await until(()=>x.events.some(event=>event.type==='speech'));
  const resultEvent=x.events.find(event=>event.type==='result');await x.session.stop();const report=await running;
  assert.equal(report,resultEvent.report);assert.equal(report.ok,true);assert.equal(report.reason,'goal_verified');
  assert.equal(x.events.filter(event=>event.type==='result').length,1);assert.equal(x.session.playback,null);
  assert.ok(x.events.some(event=>event.source==='typed'&&event.type==='status'&&/Озвучка остановлена/u.test(event.message)));
});

test('stopping voice execution still publishes a correlated final report with partial receipts and no narration',async t=>{
  const x=await fixture(t),result=defer();let executionSignal;
  x.commands.run=async request=>{executionSignal=request.signal;return result.promise;};
  await x.session.start({mode:'manual'});recordSpeech(x.session);const finished=x.session.batch.finish();
  await until(()=>Boolean(executionSignal));
  const processing=x.events.find(event=>event.type==='status'&&event.state==='processing');assert.ok(processing.operationId);
  await x.session.stop();const stoppedAt=x.events.length;assert.equal(executionSignal.aborted,true);
  const receipt={operation:'minimize',outcome:'verified',window:'fixture'};
  result.resolve({ok:false,reason:'aborted',runId:'cancelled-voice-run',command:'открой диспетчер задач.',completed:[receipt]});
  await finished;
  const terminal=x.events.slice(stoppedAt).find(event=>event.type==='result');
  assert.ok(terminal,'Renderer needs a final report after Stop to release its pending task');
  assert.equal(terminal.operationId,processing.operationId);assert.equal(terminal.source,'voice');
  assert.equal(terminal.report.runId,'cancelled-voice-run');assert.equal(terminal.report.reason,'aborted');
  assert.deepEqual(terminal.report.completed,[receipt]);assert.equal(x.calls.speech.length,0);assert.equal(x.session.state,'stopped');
  assert.equal(x.events.filter(event=>event.type==='result').length,1);
});

test('voice execution throwing on abort still produces one safe terminal report after Stop',async t=>{
  const x=await fixture(t),result=defer();let entered=false;
  x.commands.run=async()=>{entered=true;await result.promise;throw new Error('PRIVATE cancelled executor details');};
  await x.session.start({mode:'manual'});recordSpeech(x.session);const finished=x.session.batch.finish();
  await until(()=>entered);await x.session.stop();result.resolve();await finished;
  const reports=x.events.filter(event=>event.type==='result');assert.equal(reports.length,1);
  assert.equal(reports[0].report.reason,'aborted');assert.equal(reports[0].report.error,'ABORTED');
  assert.equal(JSON.stringify(reports).includes('PRIVATE'),false);assert.equal(x.calls.speech.length,0);
});
