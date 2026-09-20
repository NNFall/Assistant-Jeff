import {spawn,spawnSync} from 'node:child_process';
import {createInterface} from 'node:readline';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';

const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const work=path.join(repo,'work','windows-desktop');
const helperExe=path.join(work,'bin','JeffWindowsDesktopHelper.exe');
const fixtureDir=path.join(work,'input-fixture');
const fixtureExe=path.join(fixtureDir,'JeffWindowsInputFixture.exe');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
if(process.platform!=='win32')throw new Error('Native text tests require Windows.');
if(!fs.existsSync(helperExe))throw new Error('Build the helper first with npm.cmd run windows:build.');
fs.mkdirSync(fixtureDir,{recursive:true});
const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
const compile=spawnSync(compiler,['/nologo','/codepage:65001','/target:winexe','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',`/out:${fixtureExe}`,path.join(repo,'native','windows-desktop','InputFixture.cs')],{cwd:repo,windowsHide:true,encoding:'utf8',timeout:30000});
if(compile.status!==0)throw new Error(`Input fixture compilation failed: ${(compile.stdout||compile.stderr||compile.error?.message||'').slice(0,2000)}`);

function channel(child,label){
  let sequence=0,closed=false;const pending=new Map();const lines=createInterface({input:child.stdout});
  const finish=error=>{if(closed)return;closed=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(error);}pending.clear();};
  lines.on('line',line=>{let value;try{value=JSON.parse(line);}catch{finish(new Error(`${label}_INVALID_JSON`));return;}const item=pending.get(value.id);if(!item)return;pending.delete(value.id);clearTimeout(item.timer);value.ok?item.resolve(value.result):item.reject(Object.assign(new Error(value.error?.code||`${label}_FAILED`),{code:value.error?.code,details:value.error}));});
  child.stderr.resume();child.on('error',()=>finish(new Error(`${label}_START_FAILED`)));child.on('exit',code=>finish(new Error(`${label}_EXIT_${code}`)));
  return {request:(method,args={})=>new Promise((resolve,reject)=>{if(closed){reject(new Error(`${label}_CLOSED`));return;}const id=++sequence,timer=setTimeout(()=>{pending.delete(id);reject(new Error(`${label}_TIMEOUT`));},15000);pending.set(id,{resolve,reject,timer});child.stdin.write(`${JSON.stringify({id,method,args})}\n`);}),finish};
}
let fixture,helper,fixtureRpc,helperRpc;
try{
  fixture=spawn(fixtureExe,[],{cwd:repo,windowsHide:false,stdio:['pipe','pipe','pipe']});fixtureRpc=channel(fixture,'FIXTURE');
  await fixtureRpc.request('status');await fixtureRpc.request('focus',{field:'normal'});await delay(200);
  helper=spawn(helperExe,['--fixture-pid',String(fixture.pid)],{cwd:repo,windowsHide:true,stdio:['pipe','pipe','pipe']});helperRpc=channel(helper,'HELPER');
  const inventory=await helperRpc.request('observe');assert.equal(inventory.windows.length,1);const windowId=inventory.windows[0].id;
  const observed=await helperRpc.request('text_observe',{windowId});
  assert.equal(observed.windowId,windowId);assert.equal(observed.coverage.truncated,false);
  assert.equal(observed.fields.length,2,'only normal and nonfocused writable fields are exposed');
  assert.equal(observed.fields.some(field=>field.value==='INITIAL_PASSWORD_SENTINEL_1b3d'),false);
  assert.equal(observed.fields.some(field=>field.value==='INITIAL_READONLY_SENTINEL_6f5a'),false);
  const normal=observed.fields.find(field=>field.value==='INITIAL_NORMAL_SENTINEL_92a6');const secondary=observed.fields.find(field=>field.value==='INITIAL_SECONDARY_SENTINEL_48c1');
  assert.ok(normal&&secondary,'normal and nonfocused fields must be discoverable');
  const exact='line one\nline two\tend';const receipt=await helperRpc.request('text_replace',{targetId:normal.id,expectedVersion:observed.version,text:exact});
  assert.equal(receipt.operation,'text_replace');assert.equal(receipt.targetId,normal.id);assert.equal(receipt.verified,true);assert.equal(receipt.effectAttempted,true);assert.equal(receipt.evidence,'text_value_verified');assert.equal((await fixtureRpc.request('status')).normalText,exact);
  const oldSecondaryVersion=observed.version;await fixtureRpc.request('set',{field:'secondary',text:'changed outside snapshot'});
  const staleError=await helperRpc.request('text_replace',{targetId:secondary.id,expectedVersion:oldSecondaryVersion,text:'must not write'}).then(()=>null,error=>error);assert.equal(staleError.code,'TEXT_VALUE_CHANGED');assert.equal(staleError.details.effectAttempted,false);
  const malformed=await helperRpc.request('text_replace',{targetId:secondary.id,expectedVersion:oldSecondaryVersion,text:'x',extra:'reject'}).then(()=>null,error=>error);assert.equal(malformed.code,'INVALID_ARGUMENT');assert.equal(malformed.details.effectAttempted,false);
  await fixtureRpc.request('close');await delay(300);
  const identity=await helperRpc.request('text_replace',{targetId:secondary.id,expectedVersion:oldSecondaryVersion,text:'identity reject'}).then(()=>null,error=>error);assert.ok(['TEXT_TARGET_IDENTITY_CHANGED','TEXT_TARGET_UNAVAILABLE'].includes(identity.code));assert.equal(identity.details.effectAttempted,false);
  console.log(JSON.stringify({passed:true,checks:['password and readonly omission','nonfocused editable discovery','newline/tab exact readback','stale value denial','malformed argument denial','window identity denial'],scope:'disposable InputFixture only'}));
}finally{
  try{await fixtureRpc?.request('close');}catch{}
  helperRpc?.finish(new Error('TEST_FINISHED'));fixtureRpc?.finish(new Error('TEST_FINISHED'));
  for(const child of [helper,fixture])if(child&&child.exitCode===null)child.kill();
}
