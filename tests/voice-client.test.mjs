import test from 'node:test';
import assert from 'node:assert/strict';
import {VoiceClient} from '../scripts/desktop-lab/voice-client.mjs';

const defer=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return {promise,resolve};};
function fixture(t){
  const calls={starts:0,micStops:0,backendStops:0,acks:[],played:0,paused:0,revoked:[],chunks:[]};
  const events=[],states=[],errors=[],audios=[];
  class FakeMicrophone {constructor(onChunk){this.onChunk=onChunk;}async start(){calls.starts++;}async stop(){calls.micStops++;}}
  const api={voiceStatus:async()=>({state:'stopped',settings:{denisReply:true}}),voiceStart:async()=>({ok:true,state:'recording'}),voiceStop:async()=>{calls.backendStops++;return {ok:true};},
    voiceSettings:async settings=>({settings}),speechEnded:({id})=>{calls.acks.push(id);},audioChunk:chunk=>calls.chunks.push(chunk),onVoiceEvent:()=>()=>{}};
  const client=new VoiceClient(api,{MicrophoneClass:FakeMicrophone,onState:value=>states.push(value),onEvent:value=>events.push(value),onError:error=>errors.push(error),
    createAudio:()=>{const audio={play:async()=>{calls.played++;},pause:()=>{calls.paused++;}};audios.push(audio);return audio;},
    createUrl:()=>`blob:test-${audios.length}`,revokeUrl:url=>calls.revoked.push(url)});
  t.after(()=>client.dispose());return {client,api,calls,events,states,errors,audios};
}
const typed=(type,props={})=>({type,source:'typed',operationId:'typed-1',...props});
const speech=(props={})=>typed('speech',{id:'audio-1',wav:new Uint8Array([1,2,3]),mimeType:'audio/wav',...props});

test('typed playback is accepted with microphone off and keeps busy through speaking',async t=>{
  const x=fixture(t);await x.client.initialize();
  await x.client.handleEvent(typed('status',{state:'processing'}));
  await x.client.handleEvent(typed('result',{report:{ok:false,reason:'unsupported'}}));
  await x.client.handleEvent(typed('status',{state:'speaking'}));await x.client.handleEvent(speech());
  assert.equal(x.client.enabled,false);assert.equal(x.calls.starts,0);assert.equal(x.client.busy,true);
  assert.equal(x.calls.played,1);assert.equal(x.events[0].type,'result');
  x.audios[0].onended();assert.deepEqual(x.calls.acks,['audio-1']);
  await x.client.handleEvent(typed('status',{state:'idle'}));assert.equal(x.client.busy,false);assert.equal(x.calls.backendStops,0);
});

test('stopped typed operation cannot restart audio or replace a newer operation',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.handleEvent(typed('status',{state:'processing'}));await x.client.stop();
  await x.client.handleEvent(typed('status',{state:'processing'}));await x.client.handleEvent(speech());
  assert.equal(x.calls.played,0);assert.deepEqual(x.calls.acks,['audio-1']);assert.equal(x.client.state,'off');
  await x.client.handleEvent(typed('status',{state:'processing',operationId:'typed-2'}));
  await x.client.handleEvent(speech({id:'audio-2',operationId:'typed-2'}));
  await x.client.handleEvent(speech({id:'late-old'}));
  assert.equal(x.calls.played,1);assert.equal(x.client.playback.id,'audio-2');assert.equal(x.calls.paused,0);
});

test('unscoped speech is never accepted while microphone is off',async t=>{
  const x=fixture(t);await x.client.initialize();
  await x.client.handleEvent({type:'speech',id:'voice-old',source:'voice',wav:new Uint8Array([1])});
  assert.equal(x.calls.played,0);assert.deepEqual(x.calls.acks,['voice-old']);assert.equal(x.calls.starts,0);
});

test('backend error releases capture without aborting its local explanation',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.start('manual');
  await x.client.handleEvent({type:'voice_notice',source:'voice',code:'VOICE_PROCESSING_FAILED',title:'Не получилось',message:'Повторите команду.'});
  await x.client.handleEvent({type:'status',source:'voice',state:'error'});
  await x.client.handleEvent({type:'speech',source:'voice',id:'error-audio',wav:new Uint8Array([1])});
  assert.equal(x.client.enabled,false);assert.equal(x.calls.backendStops,0);assert.equal(x.calls.played,1);
  await x.client.handleEvent({type:'status',source:'voice',state:'stopped'});
  assert.equal(x.events.filter(event=>event.type==='voice_notice').length,1);assert.equal(x.calls.backendStops,0);
});

test('playback failure acknowledges audio without rerunning or aborting the command',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.handleEvent(typed('status',{state:'processing'}));await x.client.handleEvent(speech());
  x.audios[0].onerror();assert.deepEqual(x.calls.acks,['audio-1']);assert.equal(x.calls.backendStops,0);assert.equal(x.errors[0].code,'VOICE_PLAYBACK_FAILED');
  await x.client.handleEvent(typed('status',{state:'idle'}));assert.equal(x.client.busy,false);
});

test('disabled narration acknowledges typed audio without capture or playback',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.setSettings({denisReply:false});
  await x.client.handleEvent(typed('status',{state:'processing'}));await x.client.handleEvent(speech());
  assert.equal(x.calls.starts,0);assert.equal(x.calls.played,0);assert.deepEqual(x.calls.acks,['audio-1']);
});

test('cancelling asynchronous voice start does not start the microphone afterwards',async t=>{
  const x=fixture(t),start=defer();await x.client.initialize();x.api.voiceStart=()=>start.promise;
  const pending=x.client.start('manual');await x.client.stop();start.resolve({ok:true,state:'recording'});await pending;
  assert.equal(x.calls.starts,0);assert.equal(x.client.enabled,false);assert.equal(x.client.state,'off');
});

test('review completion stops the microphone and retains its guidance while settings change',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.start('wake');
  const message='Проверьте текст и нажмите «Выполнить». Микрофон выключен.';
  await x.client.handleEvent({type:'transcript',source:'voice',text:'Открой браузер',final:true,autoExecute:false});
  await x.client.handleEvent({type:'status',source:'voice',state:'stopped',review:true,message});
  assert.equal(x.client.enabled,false);assert.equal(x.client.busy,false);assert.equal(x.states.at(-1).review,true);
  assert.ok(x.calls.micStops>0);assert.equal(x.calls.backendStops,0);
  await x.client.setSettings({activationBeep:false});assert.equal(x.states.at(-1).message,message);assert.equal(x.states.at(-1).review,true);
  assert.equal(x.events[0].text,'Открой браузер');
  await x.client.start('manual');assert.equal(x.client.enabled,true);assert.equal(x.states.at(-1).review,false);
});

test('voice-start provider error reaches friendly UI mapping with its stable code and without capture',async t=>{
  const x=fixture(t);await x.client.initialize();x.api.voiceStart=async()=>({ok:false,code:'GEMINI_UNAVAILABLE',message:'Настройте Gemini.'});
  await x.client.start('manual');assert.equal(x.calls.starts,0);assert.equal(x.errors[0].code,'GEMINI_UNAVAILABLE');assert.equal(x.client.busy,false);
});

test('late typed result after Stop cannot replace a newer typed task',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.handleEvent(typed('status',{state:'processing'}));await x.client.stop();
  await x.client.handleEvent(typed('result',{report:{runId:'old-after-stop',reason:'aborted'}}));
  await x.client.handleEvent(typed('status',{state:'processing',operationId:'typed-2'}));
  await x.client.handleEvent(typed('result',{report:{runId:'old-after-new',reason:'aborted'}}));
  assert.equal(x.events.length,0);assert.equal(x.client.busy,true);
  await x.client.handleEvent(typed('result',{operationId:'typed-2',report:{runId:'new',reason:'goal_verified',ok:true}}));
  assert.equal(x.events.length,1);assert.equal(x.events[0].report.runId,'new');
});

test('voice terminal report is delivered after Stop, but an old voice report is rejected after a new task starts',async t=>{
  const x=fixture(t);await x.client.initialize();await x.client.start('manual');
  await x.client.handleEvent({type:'status',state:'processing',source:'voice',operationId:'voice-1'});await x.client.stop();
  await x.client.handleEvent({type:'result',source:'voice',operationId:'voice-1',report:{runId:'cancelled',reason:'aborted'}});
  assert.equal(x.events.length,1);assert.equal(x.events[0].report.reason,'aborted');
  await x.client.start('manual');await x.client.handleEvent({type:'status',state:'processing',source:'voice',operationId:'voice-2'});
  await x.client.handleEvent({type:'result',source:'voice',operationId:'voice-1',report:{runId:'old'}});
  await x.client.handleEvent({type:'speech',source:'voice',operationId:'voice-1',id:'late-voice-audio',wav:new Uint8Array([1])});
  assert.equal(x.events.length,1);assert.equal(x.calls.played,0);
  await x.client.handleEvent({type:'result',source:'voice',operationId:'voice-2',report:{runId:'current',reason:'goal_verified'}});
  assert.equal(x.events.length,2);assert.equal(x.events[1].report.runId,'current');
});
