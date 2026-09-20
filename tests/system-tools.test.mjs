import test from 'node:test';
import assert from 'node:assert/strict';
import {createSystemTools,executeSystemTool} from '../desktop/automation/system-tools.mjs';

const endpointId='audio_0123456789abcdef01234567';
const state=(percent=34,muted=false)=>({percent,muted,endpointId});
const receipt=(percent=75,overrides={})=>({operation:'volume_set',provider:'windows_coreaudio',endpointRole:'multimedia',
  requestedPercent:percent,before:state(),after:state(percent),verified:true,effectAttempted:true,evidence:'volume_level_verified',...overrides});
const fail=(code,details)=>Object.assign(new Error('provider text must not leak'),{code,...(details?{details}:{})});

test('sets an exact percentage through the fixed native operation and returns readback evidence',async()=>{
  const calls=[],signal=new AbortController().signal;
  const bridge={request:async(...args)=>{calls.push(args);return receipt(75);}};
  const {executeSystemTool:execute}=createSystemTools({bridge});
  const result=await execute({kind:'volume',percent:75},{signal});
  assert.deepEqual(calls,[['volume_set',{percent:75},signal]]);
  assert.equal(result.ok,true);assert.equal(result.status,'goal_verified');
  assert.deepEqual(result.before,state());assert.deepEqual(result.after,state(75));
  assert.match(result.message,/75%/);assert.equal(result.effectAttempted,true);
});

test('accepts boundary and fractional percentages without rounding the request',async()=>{
  for(const value of [0,100,75.125]){
    const bridge={request:async(method,args)=>{assert.equal(method,'volume_set');assert.equal(args.percent,value);return receipt(value);}};
    assert.equal((await executeSystemTool({kind:'volume',percent:value},{bridge})).ok,true);
  }
});

test('rejects invalid, ambiguous and unknown intents before calling any dependency',async()=>{
  let effects=0;const bridge={request:async()=>{effects++;}},minimizeAssistant=async()=>{effects++;};
  const intents=[null,[],{},'volume',{kind:'shell',command:'anything'},
    ...[-1,101,Infinity,-Infinity,NaN,'75',null,true,undefined].map(percent=>({kind:'volume',percent})),
    {kind:'volume',percent:75,command:'ignored'}, {kind:'volume',percent:75,confidence:1},
    {kind:'get_system_volume',percent:75},{kind:'self_minimize',target:'other'}];
  for(const intent of intents){
    const result=await executeSystemTool(intent,{bridge,minimizeAssistant});
    assert.equal(result.ok,false);assert.equal(result.effectAttempted,false);assert.equal(result.evidence,'not_executed');
  }
  assert.equal(effects,0);
});

test('read-only volume uses only volume_get and reports muted status',async()=>{
  const calls=[];
  const bridge={request:async(...args)=>{calls.push(args);return receipt(null,{operation:'volume_get',before:state(22,true),after:state(22,true),effectAttempted:false,evidence:'volume_read'});}};
  const result=await executeSystemTool({kind:'get_system_volume'},{bridge});
  assert.deepEqual(calls,[['volume_get',{},undefined]]);
  assert.equal(result.ok,true);assert.equal(result.effectAttempted,false);assert.match(result.message,/22%/);assert.match(result.message,/выключен/);
});

test('volume set preserves mute evidence and does not unmute or invoke another method',async()=>{
  const methods=[];
  const bridge={request:async method=>{methods.push(method);return receipt(75,{before:state(34,true),after:state(75,true)});}};
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge});
  assert.equal(result.ok,true);assert.equal(result.after.muted,true);assert.match(result.message,/выключен/);
  assert.deepEqual(methods,['volume_set']);
});

test('a claimed native success is insufficient when fresh readback differs',async()=>{
  let calls=0;
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>{calls++;return receipt(75,{after:state(74)});}}});
  assert.equal(result.ok,false);assert.equal(result.verified,false);assert.equal(result.effectAttempted,true);assert.equal(calls,1);
});

test('small floating-point readback error is accepted within the native tolerance',async()=>{
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>receipt(75,{after:state(75.000003)})}});
  assert.equal(result.ok,true);
});

test('default endpoint change is unverified even when the old endpoint reached the target',async()=>{
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>receipt(75,{verified:false,evidence:'default_endpoint_changed'})}});
  assert.equal(result.ok,false);assert.equal(result.evidence,'default_endpoint_changed');assert.equal(result.after.percent,75);
});

test('endpoint change before mutation retains the explicit no-effect evidence',async()=>{
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>receipt(75,{verified:false,effectAttempted:false,after:null,evidence:'default_endpoint_changed'})}});
  assert.equal(result.ok,false);assert.equal(result.effectAttempted,false);assert.equal(result.after,null);
});

test('native readback failure preserves before state, stage and outcome-unknown without retry',async()=>{
  let calls=0;
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>{calls++;return receipt(75,{after:null,verified:false,evidence:'effect_outcome_unknown',stage:'volume_read_after',providerCode:'0x80070490'});}}});
  assert.equal(result.ok,false);assert.deepEqual(result.before,state());assert.equal(result.evidence,'effect_outcome_unknown');
  assert.equal(result.stage,'volume_read_after');assert.equal(result.providerCode,'0x80070490');assert.equal(calls,1);
});

test('transport timeout after mutation dispatch is outcome-unknown and never repeated',async()=>{
  let calls=0;
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>{calls++;throw fail('WINDOWS_TIMEOUT');}}});
  assert.equal(result.error,'WINDOWS_TIMEOUT');assert.equal(result.effectAttempted,true);assert.equal(result.evidence,'effect_outcome_unknown');assert.equal(calls,1);
  assert.doesNotMatch(JSON.stringify(result),/provider text/);
});

test('native rejection before effect overrides conservative transport uncertainty',async()=>{
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>{throw fail('SYSTEM_VOLUME_FAILED',{effectAttempted:false});}}});
  assert.equal(result.ok,false);assert.equal(result.effectAttempted,false);assert.equal(result.evidence,'not_executed');
});

test('pre-aborted command does not touch the system or self window',async()=>{
  const abort=new AbortController();abort.abort();let calls=0;
  for(const intent of [{kind:'volume',percent:75},{kind:'get_system_volume'},{kind:'self_minimize'}]){
    const result=await executeSystemTool(intent,{signal:abort.signal,bridge:{request:async()=>{calls++;}},minimizeAssistant:async()=>{calls++;}});
    assert.equal(result.status,'aborted');assert.equal(result.effectAttempted,false);
  }
  assert.equal(calls,0);
});

test('abort during a dispatched setter cannot assert that volume stayed unchanged',async()=>{
  const abort=new AbortController();let calls=0;
  const result=await executeSystemTool({kind:'volume',percent:75},{signal:abort.signal,bridge:{request:async()=>{calls++;abort.abort();throw fail('ABORTED');}}});
  assert.equal(result.status,'aborted');assert.equal(result.effectAttempted,true);assert.equal(result.evidence,'effect_outcome_unknown');assert.equal(calls,1);
});

test('validated readback received with cancellation remains honest effect evidence',async()=>{
  const abort=new AbortController();
  const result=await executeSystemTool({kind:'volume',percent:75},{signal:abort.signal,bridge:{request:async()=>{abort.abort();return receipt(75);}}});
  assert.equal(result.ok,true);assert.equal(result.verified,true);
});

test('malformed native receipts cannot become success or inject provider fields',async()=>{
  const malformed=[null,{},receipt(74),receipt(75,{after:state(NaN)}),receipt(75,{after:{...state(75),unexpected:'secret'}}),
    receipt(75,{after:{...state(75),endpointId:'not-an-endpoint'}}),receipt(75,{provider:'untrusted'}),receipt(75,{effectAttempted:'yes'})];
  for(const raw of malformed){
    const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>raw}});
    assert.equal(result.ok,false);assert.equal(result.error,'SYSTEM_TOOL_INVALID_RESPONSE');assert.equal(result.effectAttempted,true);
    assert.doesNotMatch(JSON.stringify(result),/secret|untrusted/);
  }
});

test('different endpoint identifiers never verify even with a claimed native success',async()=>{
  const result=await executeSystemTool({kind:'volume',percent:75},{bridge:{request:async()=>receipt(75,{after:{...state(75),endpointId:'audio_111111111111111111111111'}})}});
  assert.equal(result.ok,false);
});

test('self minimize calls only the injected owner-window capability and verifies its receipt',async()=>{
  let nativeCalls=0;const calls=[],signal=new AbortController().signal;
  const result=await executeSystemTool({kind:'self_minimize'},{signal,bridge:{request:async()=>{nativeCalls++;}},
    minimizeAssistant:async args=>{calls.push(args);return {verified:true,effectAttempted:true,before:{minimized:false},after:{minimized:true}};}});
  assert.equal(result.ok,true);assert.equal(result.evidence,'assistant_minimized');assert.deepEqual(calls,[{signal}]);assert.equal(nativeCalls,0);
});

test('self minimize cannot claim success while the owner window remains visible',async()=>{
  const result=await executeSystemTool({kind:'self_minimize'},{minimizeAssistant:async()=>({verified:true,effectAttempted:true,before:{minimized:false},after:{minimized:false}})});
  assert.equal(result.ok,false);assert.equal(result.verified,false);
});

test('missing capabilities fail before any possible effect',async()=>{
  for(const intent of [{kind:'volume',percent:75},{kind:'get_system_volume'},{kind:'self_minimize'}]){
    const result=await executeSystemTool(intent);
    assert.equal(result.ok,false);assert.equal(result.effectAttempted,false);
  }
});
