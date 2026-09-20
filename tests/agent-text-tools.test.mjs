import test from 'node:test';
import assert from 'node:assert/strict';
import {createTextTools} from '../desktop/agent/text-tools.mjs';

const version='a'.repeat(64);
const sha256=async value=>(await import('node:crypto')).createHash('sha256').update(value,'utf8').digest('hex');
const field=(id,value,patch={})=>({id,label:`Field ${id}`,value,...patch});
const snapshot=(fields=[field('txt_one','old')],patch={})=>({version,windowId:'win_editor',fields,coverage:{scanned:4,truncated:false,...patch}});
function fixture({response=snapshot(),dispatch,observed=true}={}){
  const calls=[];const desktop={lastSnapshot:observed?{version:'b'.repeat(64),windows:[{id:'win_editor',title:'Editor'}]}:null,bridge:{async request(method,args,signal){calls.push({method,args,signal});if(method==='text_observe')return structuredClone(response);assert.equal(method,'text_replace');return dispatch?dispatch(args,signal):{operation:'text_replace',targetId:args.targetId,verified:true,effectAttempted:true,evidence:'text_value_verified',expectedVersion:args.expectedVersion,textLength:args.text.length,valueHash:await sha256(args.text)};}}};
  const tools=Object.fromEntries(createTextTools({desktop}).map(tool=>[tool.name,tool]));
  return {desktop,calls,tools,call:(name,args={},options={})=>tools[name].execute(args,options)};
}

test('text descriptors require a current windows_observe window and call the separate native method',async()=>{
  const f=fixture({response:snapshot([field('txt_normal','hello\nworld',{truncated:true})])});
  assert.deepEqual(Object.keys(f.tools),['windows_text_fields','windows_text_replace']);
  const result=await f.call('windows_text_fields',{windowId:'win_editor'});
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.effectAttempted,false);assert.equal(result.evidence,'text_fields_observed');
  assert.deepEqual(f.calls[0].args,{windowId:'win_editor'});assert.equal(result.data.fields[0].value,'hello\nworld');
  const missing=fixture({observed:false});assert.equal((await missing.call('windows_text_fields',{windowId:'win_editor'})).error,'WINDOWS_OBSERVATION_REQUIRED');assert.equal(missing.calls.length,0);
});

test('replacement uses only the cached field ID, permits empty multiline text, and verifies exact native receipt',async()=>{
  const f=fixture({response:snapshot([field('txt_normal','old')])});await f.call('windows_text_fields',{windowId:'win_editor'});
  const text='first\nsecond\t';const result=await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text});
  assert.equal(result.ok,true);assert.equal(result.verified,true);assert.equal(result.effectAttempted,true);assert.equal(result.evidence,'text_value_verified');
  assert.deepEqual(f.calls[1].args,{targetId:'txt_normal',expectedVersion:version,text});
  const empty=fixture({response:snapshot([field('txt_normal','old')])});await empty.call('windows_text_fields',{windowId:'win_editor'});const cleared=await empty.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:''});assert.equal(cleared.ok,true);assert.equal(empty.calls[1].args.text,'');
});

test('stale snapshots, unknown field IDs, and malformed arguments do not reach native replacement',async()=>{
  const f=fixture({response:snapshot([field('txt_normal','old')])});await f.call('windows_text_fields',{windowId:'win_editor'});
  assert.equal((await f.call('windows_text_replace',{snapshotVersion:'c'.repeat(64),fieldId:'txt_normal',text:'bad'})).status,'stale');
  assert.equal((await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'invented',text:'bad'})).error,'TEXT_TARGET_NOT_OBSERVED');
  for(const args of [{snapshotVersion:version,fieldId:'txt_normal',text:'bad',extra:true},{snapshotVersion:version,fieldId:'txt_normal',text:'bad\0nul'},{snapshotVersion:version,fieldId:'txt_normal',text:'x'.repeat(2001)},{snapshotVersion:version,fieldId:'txt_normal',text:42}])assert.equal((await f.call('windows_text_replace',args)).ok,false);
  assert.equal(f.calls.filter(call=>call.method==='text_replace').length,0);
});

test('a dispatch failure after SetValue is uncertain and blocks retries',async()=>{
  const f=fixture({response:snapshot([field('txt_normal','old')]),dispatch:async()=>{throw Object.assign(new Error('unknown'),{code:'TEXT_OUTCOME_UNKNOWN',details:{effectAttempted:true}});}});
  await f.call('windows_text_fields',{windowId:'win_editor'});const failed=await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:'new'});
  assert.equal(failed.ok,false);assert.equal(failed.effectAttempted,true);assert.equal(failed.status,'execution_uncertain');
  assert.equal((await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:'retry'})).error,'WINDOWS_OUTCOME_UNKNOWN');assert.equal(f.calls.filter(call=>call.method==='text_replace').length,1);
});

test('a missing post-dispatch receipt is uncertain and never retried',async()=>{
  const f=fixture({response:snapshot([field('txt_normal','old')]),dispatch:async()=>null});
  await f.call('windows_text_fields',{windowId:'win_editor'});const failed=await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:'new'});
  assert.equal(failed.ok,false);assert.equal(failed.effectAttempted,true);assert.equal(failed.status,'execution_uncertain');
  assert.equal((await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:'retry'})).error,'WINDOWS_OUTCOME_UNKNOWN');assert.equal(f.calls.filter(call=>call.method==='text_replace').length,1);
});

test('verified receipt survives cancellation delivered after native mutation',async()=>{
  const controller=new AbortController();
  const f=fixture({response:snapshot([field('txt_normal','old')]),dispatch:async(args)=>{controller.abort();return {operation:'text_replace',targetId:args.targetId,verified:true,effectAttempted:true,evidence:'text_value_verified',expectedVersion:args.expectedVersion,textLength:args.text.length,valueHash:await sha256(args.text)};}});
  await f.call('windows_text_fields',{windowId:'win_editor'});const result=await f.call('windows_text_replace',{snapshotVersion:version,fieldId:'txt_normal',text:'after cancel'},{signal:controller.signal});
  assert.equal(result.ok,true);assert.equal(result.verified,true);
});

test('unsafe token values are rejected at the JS boundary if a native response violates omission policy',async()=>{
  const f=fixture({response:snapshot([field('txt_secret','Bearer sk-aaaaaaaaaaaaaaaa')])});
  const result=await f.call('windows_text_fields',{windowId:'win_editor'});assert.equal(result.ok,false);assert.equal(result.error,'WINDOWS_TEXT_INVALID_SNAPSHOT');
});
