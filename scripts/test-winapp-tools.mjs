// Real, fixture-only integration smoke. No cloud, personal window contents,
// text input, shell passthrough, keyboard injection, or clipboard access.
// Prerequisites: scripts/build-desktop-lab.ps1 and prepare-winapp-runtime.ps1.
// Run: node scripts/test-winapp-tools.mjs
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {access, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createWinAppTools} from '../desktop/agent/winapp-tools.mjs';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const executable=path.join(repo,'work','winapp-runtime','winapp.exe');
const fixturePath=path.join(repo,'work','desktop-lab','bin','JeffDesktopLabTarget.exe');
const evidenceDirectory=path.join(repo,'work','winapp-smoke');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const checks=[],trace=[];
const report={startedAt:new Date().toISOString(),fixture:'JeffDesktopLabTarget',checks,limitations:[
  'The existing fixture has no checkbox, expandable control, or scrollable content; toggle, expand, and scroll cannot be verified here.',
  'The CLI exposes a runtime hash, not a full UIA RuntimeId or process start identity. This script additionally confines commands to its own live child PID.',
  'Only this disposable fixture is inspected or operated. Other window inventory records are discarded before reaching the adapter or evidence.',
]};
let fixture,fixtureExited=false,ownedHwnd=null;
const makeError=(code,effectAttempted=false)=>Object.assign(new Error(code),{code,effectAttempted});

async function fixtureRunner(command,args,{signal,timeoutMs=12000,maxOutputBytes=1024*1024}={}){
  assert.equal(command,executable);
  assert.ok(fixture?.pid&&fixture.exitCode===null&&!fixture.killed,'Fixture process must remain alive');
  const inventory=args.length===3&&args[0]==='ui'&&args[1]==='list-windows'&&args[2]==='--json';
  const verb=args[1],effect=['invoke','scroll'].includes(verb);
  if(!inventory){
    assert.ok(['inspect','search','get-property','invoke','scroll'].includes(verb),'Only adapter UI verbs may run');
    assert.equal(args[0],'ui');
    assert.ok(ownedHwnd&&args[args.indexOf('-w')+1]===String(ownedHwnd),'Every target must belong to this fixture');
  }
  if(signal?.aborted)throw makeError('ABORTED');
  const result=await new Promise((resolve,reject)=>{
    let child,stdout='',bytes=0,settled=false,timer;
    const finish=(error,value)=>{
      if(settled)return;settled=true;clearTimeout(timer);signal?.removeEventListener('abort',abort);
      if(error){child?.kill();reject(error);}else resolve(value);
    };
    const abort=()=>finish(makeError('ABORTED',effect&&!!child?.pid));
    child=spawn(command,args,{cwd:repo,shell:false,windowsHide:true,stdio:['ignore','pipe','pipe'],
      env:{...process.env,WINAPP_CLI_TELEMETRY_OPTOUT:'1',DOTNET_CLI_TELEMETRY_OPTOUT:'1'}});
    child.stdout.setEncoding('utf8');
    child.stdout.on('data',chunk=>{bytes+=Buffer.byteLength(chunk);if(bytes>maxOutputBytes)finish(makeError('WINAPP_OUTPUT_LIMIT',effect));else stdout+=chunk;});
    child.stderr.on('data',chunk=>{bytes+=chunk.length;if(bytes>maxOutputBytes)finish(makeError('WINAPP_OUTPUT_LIMIT',effect));});
    child.once('error',()=>finish(makeError('WINAPP_UNAVAILABLE')));
    child.once('close',exitCode=>finish(null,{exitCode,stdout}));
    signal?.addEventListener('abort',abort,{once:true});
    timer=setTimeout(()=>finish(makeError('WINAPP_TIMEOUT',effect)),timeoutMs);
    if(signal?.aborted)abort();
  });
  let body;
  try{body=JSON.parse(result.stdout);}catch{
    if(!inventory)trace.push({verb,exitCode:result.exitCode,invalidJson:true,fixtureOnlyOutput:result.stdout.slice(0,10000)});
    throw makeError('WINAPP_INVALID_RESPONSE',effect);
  }
  if(inventory){
    assert.ok(Array.isArray(body),'Inventory must be a JSON array');
    body=body.filter(window=>window.processId===fixture.pid);
    assert.ok(body.every(window=>window.processName==='JeffDesktopLabTarget'&&window.title==='Jeff Desktop Lab Target'),'Owned PID must retain the expected fixture identity');
    assert.ok(body.length<=1,'Fixture unexpectedly has multiple windows');
    if(body[0]){
      assert.ok(!ownedHwnd||ownedHwnd===body[0].hwnd,'Fixture HWND must not change');
      ownedHwnd=body[0].hwnd;
    }
    result.stdout=JSON.stringify(body);
  }
  // After inventory filtering, every captured response is scoped to our fixture.
  trace.push({verb,exitCode:result.exitCode,args:inventory?args:args.map(value=>value===String(ownedHwnd)?'<owned-fixture-hwnd>':value),response:body});
  return result;
}

async function check(name,action){
  const result=await action();checks.push({name,status:'passed',...result});
  console.log(`PASS ${name}`);
}

async function run(){
  assert.equal(process.platform,'win32','The real UIA smoke requires Windows');
  assert.equal(process.argv.length,2,'Usage: node scripts/test-winapp-tools.mjs');
  await Promise.all([access(executable),access(fixturePath)]);
  report.runtimeSha256=createHash('sha256').update(await readFile(executable)).digest('hex');
  report.fixtureSha256=createHash('sha256').update(await readFile(fixturePath)).digest('hex');
  // This explicitly requested UI smoke needs a visible disposable test window.
  // Hiding its startup window prevents UIA inventory from observing the fixture.
  fixture=spawn(fixturePath,[],{cwd:repo,shell:false,windowsHide:false,stdio:'ignore'});
  fixture.once('exit',()=>{fixtureExited=true;});
  await new Promise((resolve,reject)=>{fixture.once('spawn',resolve);fixture.once('error',reject);});
  const tools=Object.fromEntries(createWinAppTools({executable,runner:fixtureRunner}).map(tool=>[tool.name,tool]));
  const call=(name,args)=>tools[name].execute(args);
  let inventory;
  for(let attempt=0;attempt<15;attempt++){
    inventory=await call('winapp_observe',{});
    if(inventory.ok&&inventory.data.windows.length===1)break;
    assert.equal(inventory.ok,true,inventory.error);await delay(200);
  }
  assert.equal(inventory.data.windows.length,1,'Owned fixture window must appear');
  const windowId=inventory.data.windows[0].id;
  await check('fixture-only inventory',async()=>{
    assert.equal(inventory.data.windows[0].restricted,undefined);
    return {windowCount:inventory.data.windows.length};
  });
  let snapshot;
  await check('observe controls and static context',async()=>{
    snapshot=await call('winapp_observe',{windowId,depth:10});
    assert.equal(snapshot.ok,true,snapshot.error);
    assert.ok(snapshot.data.elements.some(item=>item.label==='Playback: stopped'),'Static playback label must be visible');
    assert.ok(snapshot.data.elements.some(item=>item.role==='TabItem'&&item.label==='Music'));
    return {elementCount:snapshot.data.elements.length,coverage:snapshot.data.coverage};
  });
  await check('search returns owned Music tab',async()=>{
    snapshot=await call('winapp_search',{windowId,query:'Music',limit:50});
    assert.equal(snapshot.ok,true,snapshot.error);
    assert.ok(snapshot.data.elements.some(item=>item.role==='TabItem'&&item.label==='Music'));
    return {elementCount:snapshot.data.elements.length};
  });
  await check('select Music with actual selected state readback',async()=>{
    const element=snapshot.data.elements.find(item=>item.role==='TabItem'&&item.label==='Music');
    const action=snapshot.data.actions.find(item=>item.elementId===element.id&&item.op==='select');
    assert.ok(action,'Music must offer a typed select action');
    const result=await call('winapp_execute',{snapshotVersion:snapshot.data.snapshotVersion,actionId:action.id});
    assert.equal(result.ok,true,result.error);assert.equal(result.verified,true);
    assert.equal(result.effectAttempted,true);assert.equal(result.data.receipt.before.selected,false);
    assert.equal(result.data.receipt.after.selected,true);
    return {evidence:result.evidence,receipt:result.data.receipt};
  });
  let dispatched;
  await check('invoke Play music confirms dispatch only',async()=>{
    snapshot=await call('winapp_observe',{windowId,depth:10});assert.equal(snapshot.ok,true,snapshot.error);
    const element=snapshot.data.elements.find(item=>item.label==='Play music'&&item.role==='Button');
    assert.ok(element,'Music tab must reveal Play music');
    const action=snapshot.data.actions.find(item=>item.elementId===element.id&&item.op==='invoke');assert.ok(action);
    dispatched=await call('winapp_execute',{snapshotVersion:snapshot.data.snapshotVersion,actionId:action.id});
    assert.equal(dispatched.ok,true,dispatched.error);assert.equal(dispatched.verified,false);
    assert.equal(dispatched.effectConfirmed,true);assert.equal(dispatched.needsObservation,true);
    assert.equal(dispatched.data.goalVerified,false);
    const repeat=await call('winapp_execute',{snapshotVersion:snapshot.data.snapshotVersion,actionId:action.id});
    assert.equal(repeat.ok,false);assert.equal(repeat.effectAttempted,false);assert.equal(repeat.error,'WINAPP_OBSERVATION_REQUIRED');
    return {evidence:dispatched.evidence,receipt:dispatched.data.receipt};
  });
  await check('fresh observation proves playback changed',async()=>{
    snapshot=await call('winapp_observe',{windowId,depth:10});assert.equal(snapshot.ok,true,snapshot.error);
    assert.ok(snapshot.data.elements.some(item=>item.label==='Playback: playing'),'Post-invoke static state must confirm playing');
    assert.ok(snapshot.data.elements.some(item=>item.label==='Pause music'&&item.role==='Button'));
    return {facts:['Playback: playing','Pause music'],dispatchAloneWasGoalProof:false};
  });
  await check('search reads post-invoke static state',async()=>{
    const result=await call('winapp_search',{windowId,query:'Playback',limit:20});assert.equal(result.ok,true,result.error);
    assert.ok(result.data.elements.some(item=>item.label==='Playback: playing'));
    return {facts:['Playback: playing']};
  });
  for(const operation of ['toggle','expand','scroll'])checks.push({name:operation,status:'not_supported_by_fixture',reason:'The checked-in DesktopLabTarget does not declare a corresponding test control.'});
  report.status='passed';
}

try{await run();}
catch(error){report.status='failed';report.failure={code:error?.code??error?.name??'ERROR',message:String(error?.message??error).slice(0,1000)};process.exitCode=1;console.error(`FAIL ${report.failure.message}`);}
finally{
  if(fixture&&!fixture.killed&&fixture.exitCode===null){
    const closed=new Promise(resolve=>fixture.once('close',resolve));fixture.kill();await Promise.race([closed,delay(1500)]);
  }
  report.finishedAt=new Date().toISOString();report.fixtureStopped=!fixture||fixtureExited;
  if(!report.fixtureStopped){report.status='failed';report.cleanupError='Fixture exit was not observed';process.exitCode=1;}
  await mkdir(evidenceDirectory,{recursive:true});
  const reportText=JSON.stringify(report,null,2)+'\n',traceText=JSON.stringify(trace,null,2)+'\n';
  const runId=report.startedAt.replace(/[:.]/g,'-');
  await writeFile(path.join(evidenceDirectory,'report.json'),reportText);
  await writeFile(path.join(evidenceDirectory,'fixture-trace.json'),traceText);
  await writeFile(path.join(evidenceDirectory,`${runId}-report.json`),reportText);
  await writeFile(path.join(evidenceDirectory,`${runId}-fixture-trace.json`),traceText);
  console.log(`Evidence: ${path.relative(repo,evidenceDirectory)}`);
}
