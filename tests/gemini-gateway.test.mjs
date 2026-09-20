import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createGatewayServer } from '../server/gateway.mjs';
import { GeminiGateway } from '../desktop/providers/gemini.mjs';

const TOKEN='test-gateway-token';
const KEY='test-provider-key';
const frame=Buffer.alloc(417);
frame.set([0xff,0xfb,0x90,0x00]);
const audioBody=(audio=frame)=>({audio:audio.toString('base64'),mimeType:'audio/mp3'});
const completed=text=>Response.json({status:'completed',steps:[{type:'model_output',content:[{type:'text',text}]}]});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};

async function start(t,fetchImpl,options={}){
  const server=createGatewayServer({token:TOKEN,apiKey:KEY,fetchImpl,...options});
  server.listen(0,'127.0.0.1');
  await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}`;
  return {url,call:(route,body,extra={})=>fetch(`${url}${route}`,{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:JSON.stringify(body),...extra})};
}

test('gateway import has no startup side effects and requires credentials at construction',()=>{
  assert.throws(()=>createGatewayServer({token:'',apiKey:''}),/credentials/);
});

test('authentication protects health, chat and transcription without upstream requests',async t=>{
  let calls=0;
  const {url}=await start(t,()=>{calls++;throw new Error('must not call');});
  for(const route of ['/health','/chat','/transcribe']){
    const response=await fetch(`${url}${route}`,{headers:{authorization:'Bearer wrong'}});
    assert.equal(response.status,401);
    assert.deepEqual(await response.json(),{error:'Unauthorized'});
  }
  const health=await fetch(`${url}/health`,{headers:{authorization:`Bearer ${TOKEN}`}});
  assert.equal(health.status,200);
  assert.equal((await health.json()).transcribeModel,'gemini-3.5-transcribe');
  assert.equal(calls,0);
});

test('MP3 transcription sends the documented inline interactions contract and extracts REST output',async t=>{
  let seen;
  const {call}=await start(t,async(url,options)=>{
    seen={url,options};
    return Response.json({status:'completed',steps:[
      {type:'user_input',content:[{type:'text',text:'Not output'}]},
      {type:'model_output',content:[{type:'thought',text:'Not transcript'},{type:'text',thought:true,text:'Hidden'},{type:'text',text:'Открой '}]},
      {type:'tool_result',content:[{type:'text',text:'Ignore'}]},
      {type:'model_output',content:[{type:'text',text:'диспетчер задач.'}]},
    ]});
  });
  const response=await call('/transcribe',audioBody());
  assert.equal(response.status,200);
  const result=await response.json();
  assert.deepEqual({...result,latencyMs:0},{text:'Открой диспетчер задач.',model:'gemini-3.5-transcribe',latencyMs:0});
  assert.ok(Number.isInteger(result.latencyMs)&&result.latencyMs>=0);
  assert.equal(seen.url,'https://generativelanguage.googleapis.com/v1beta/interactions');
  assert.equal(seen.options.headers['x-goog-api-key'],KEY);
  assert.deepEqual(JSON.parse(seen.options.body),{model:'gemini-3.5-transcribe',store:false,input:[{type:'audio',mime_type:'audio/mp3',data:frame.toString('base64')}]});
});

test('ID3-prefixed MP3 and configured model are accepted',async t=>{
  const {call}=await start(t,async()=>Response.json({status:'completed',output_text:' Готово '}),{transcribeModel:'test-transcribe-model'});
  const tag=Buffer.from([0x49,0x44,0x33,4,0,0,0,0,0,0]);
  const response=await call('/transcribe',audioBody(Buffer.concat([tag,frame])));
  assert.equal(response.status,200);
  const data=await response.json();
  assert.equal(data.text,'Готово');assert.equal(data.model,'test-transcribe-model');
});

test('invalid base64, MIME, signature, ID3 bounds and incomplete MPEG frames never reach Gemini',async t=>{
  let calls=0;
  const {call}=await start(t,async()=>{calls++;return completed('wrong');});
  const oversizedTag=Buffer.from([0x49,0x44,0x33,4,0,0,127,127,127,127]);
  const invalid=[null,[],{},audioBody(Buffer.from('RIFF not an MP3')),
    {audio:frame.toString('base64'),mimeType:'audio/wav'},
    {audio:frame.toString('base64')+'\n',mimeType:'audio/mp3'},
    {audio:'Zg=',mimeType:'audio/mp3'},
    {audio:'Zg==ignored',mimeType:'audio/mp3'},
    audioBody(Buffer.from([0xff,0xfb,0x90,0])),
    audioBody(Buffer.concat([oversizedTag,frame])),
    audioBody(Buffer.concat([Buffer.from([0x49,0x44,0x33,4,0,0,128,0,0,0]),frame])),
  ];
  for(const body of invalid)assert.equal((await call('/transcribe',body)).status,400);
  assert.equal(calls,0);
});

test('decoded audio and route-specific JSON size limits are enforced',async t=>{
  let calls=0;
  const {call}=await start(t,async()=>{calls++;return completed('wrong');});
  const tooMuch=Buffer.alloc(1024*1024+1);frame.copy(tooMuch);
  assert.equal((await call('/transcribe',audioBody(tooMuch))).status,400);
  assert.equal((await call('/transcribe',{padding:'x'.repeat(2*1024*1024)})).status,413);
  assert.equal((await call('/chat',{text:'x'.repeat(17000)})).status,413);
  assert.equal(calls,0);
});

test('chat keeps its payload, authentication, model and text-only response',async t=>{
  let seen;
  const {call}=await start(t,async(url,options)=>{
    seen={url,options};
    return Response.json({candidates:[{content:{parts:[{thought:true,text:'private reasoning'},{text:'Привет!'}]}}],usageMetadata:{totalTokenCount:12}});
  },{model:'test-chat-model'});
  const response=await call('/chat',{text:'Привет'});
  assert.equal(response.status,200);
  assert.deepEqual(await response.json(),{text:'Привет!',model:'test-chat-model',usage:{totalTokenCount:12}});
  assert.equal(seen.url,'https://generativelanguage.googleapis.com/v1beta/models/test-chat-model:generateContent');
  const body=JSON.parse(seen.options.body);
  assert.deepEqual(body.contents,[{role:'user',parts:[{text:'Привет'}]}]);
  assert.equal(body.generationConfig.maxOutputTokens,1024);
  assert.ok(body.systemInstruction.parts[0].text.includes('нет инструментов'));
});

test('bad chat bodies and unknown routes return errors without upstream requests',async t=>{
  let calls=0;
  const {call}=await start(t,()=>{calls++;throw new Error();});
  for(const body of [null,[],{text:''},{text:'  '},{text:1},{text:'x'.repeat(4097)}])assert.equal((await call('/chat',body)).status,400);
  assert.equal((await call('/chat',null,{body:'{invalid'})).status,400);
  assert.equal((await call('/unknown',{})).status,404);
  assert.equal(calls,0);
});

test('incomplete, failed, provider errors and empty transcription cannot become commands',async t=>{
  const variants=[
    {status:'incomplete',output_text:'Открой'},
    {status:'failed',output_text:'Открой'},
    {status:'completed',errors:[{code:'other',message:'internal'}],output_text:'Открой'},
    {status:'completed',steps:[{type:'model_output',content:[{type:'thought',text:'Открой'}]}]},
    {status:'completed',output_text:' '},
    {output_text:'Нет статуса завершения'},
  ];
  const {call}=await start(t,async()=>Response.json(variants.shift()));
  for(let i=0;i<6;i++)assert.equal((await call('/transcribe',audioBody())).status,502);
});

test('upstream errors do not expose provider bodies or request data',async t=>{
  const {call}=await start(t,async()=>new Response(`secret ${KEY} private transcript`,{status:403}));
  const response=await call('/transcribe',audioBody());
  assert.equal(response.status,502);
  assert.deepEqual(await response.json(),{error:'Gemini unavailable',upstreamStatus:403});
});

test('upstream output has a strict size limit',async t=>{
  const {call}=await start(t,async()=>Response.json({status:'completed',output_text:'x'.repeat(300000)}));
  assert.equal((await call('/transcribe',audioBody())).status,502);
});

test('chat and transcription share the two-request concurrency limit and release capacity',async t=>{
  const bothStarted=deferred();const release=deferred();let count=0;
  const {call}=await start(t,async()=>{if(++count===2)bothStarted.resolve();await release.promise;return completed('готово');});
  const first=call('/transcribe',audioBody());const second=call('/transcribe',audioBody());
  await bothStarted.promise;
  assert.equal((await call('/chat',{text:'привет'})).status,429);
  release.resolve();
  assert.equal((await first).status,200);assert.equal((await second).status,200);
  assert.equal((await call('/transcribe',audioBody())).status,200);
});

test('provider timeout aborts transcription and returns a bounded error',async t=>{
  let aborted=false;
  const {call}=await start(t,async(url,{signal})=>new Promise((resolve,reject)=>{
    signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true});
  }),{transcribeTimeoutMs:20});
  const response=await call('/transcribe',audioBody());
  assert.equal(response.status,502);assert.equal(aborted,true);
});

test('client disconnect aborts the pending upstream request and releases its slot',async t=>{
  const started=deferred();const aborted=deferred();let count=0;
  const {call}=await start(t,async(url,{signal})=>{
    if(++count>1)return completed('next');
    started.resolve();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted.resolve();reject(signal.reason);},{once:true}));
  });
  const cancel=new AbortController();
  const first=call('/transcribe',audioBody(),{signal:cancel.signal}).catch(error=>error);
  await started.promise;cancel.abort();await aborted.promise;
  assert.equal((await first).name,'AbortError');
  assert.equal((await call('/transcribe',audioBody())).status,200);
});

function localClient(url,fetchImpl=fetch){
  const gateway=new GeminiGateway('unused-test-directory',{fetchImpl});
  gateway.connect=async()=>{gateway.url=url;gateway.token=TOKEN;};
  return gateway;
}

test('desktop client transcribes MP3 through the authenticated gateway end to end',async t=>{
  const {url}=await start(t,async()=>completed('Открой диспетчер задач.'));
  const gateway=localClient(url);t.after(()=>gateway.close());
  const result=await gateway.transcribe(frame);
  assert.equal(result.text,'Открой диспетчер задач.');
  assert.equal(result.model,'gemini-3.5-transcribe');
  assert.ok(result.latencyMs>=0);
});

test('desktop client validates audio before connecting',async()=>{
  const gateway=new GeminiGateway('unused-test-directory');
  gateway.connect=async()=>{throw new Error('should not connect');};
  for(const audio of [new Uint8Array(frame),Buffer.alloc(0),Buffer.alloc(1024*1024+1),Buffer.from('text')])await assert.rejects(gateway.transcribe(audio),/MP3/);
});

test('desktop client preserves caller cancellation and close aborts active requests',async()=>{
  const started=deferred();
  const gateway=localClient('http://not-used',async(url,{signal})=>{
    started.resolve();
    return new Promise((resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));
  });
  const cancelled=new AbortController();cancelled.abort();
  await assert.rejects(gateway.transcribe(frame,{signal:cancelled.signal}),{name:'AbortError'});
  const request=gateway.transcribe(frame);
  await started.promise;gateway.close();
  await assert.rejects(request,{name:'AbortError'});
});

test('closing a connecting desktop client prevents a stale request from being sent',async()=>{
  const wait=deferred();let requests=0;
  const gateway=new GeminiGateway('unused-test-directory',{fetchImpl:async()=>{requests++;return Response.json({text:'bad'});}});
  gateway.connect=async()=>{await wait.promise;gateway.url='http://not-used';};
  const request=gateway.transcribe(frame);gateway.close();wait.resolve();
  await assert.rejects(request,{name:'AbortError'});assert.equal(requests,0);
});

test('caller cancellation does not wait for an unfinished SSH connection',async()=>{
  const gateway=new GeminiGateway('unused-test-directory');
  const wait=deferred();gateway.connect=()=>wait.promise;
  const cancel=new AbortController();
  const request=gateway.transcribe(frame,{signal:cancel.signal});cancel.abort();
  await assert.rejects(request,{name:'AbortError'});
  wait.resolve();gateway.close();
});

test('an old connection completion cannot clear a newer connect promise',async()=>{
  const gateway=new GeminiGateway('unused-test-directory');
  const first=deferred(),second=deferred();let count=0;
  gateway.open=()=>++count===1?first.promise:second.promise;
  const opening=gateway.connect();gateway.close();const reopening=gateway.connect();
  const current=gateway.starting;first.resolve();await opening;
  assert.equal(gateway.starting,current);second.resolve();await reopening;assert.equal(gateway.starting,null);
});
