import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {runtimePaths,initializeRuntime,validateVoiceSettings,saveVoiceSettings,VOICE_DEFAULTS} from '../desktop/runtime.mjs';

function setup(t){
  const temp=fs.mkdtempSync(path.join(tmpdir(),'jeff-runtime-test-'));
  t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
  const root=path.join(temp,'source'),appData=path.join(temp,'appdata'),resourcesPath=path.join(temp,'resources');
  const write=(relative,content)=>{const target=path.join(root,relative);fs.mkdirSync(path.dirname(target),{recursive:true});fs.writeFileSync(target,content);return target;};
  return {temp,root,appData,resourcesPath,write,paths:runtimePaths({root,appData,resourcesPath})};
}

test('source runtime keeps binaries and developer logs in checkout but personal data in appData',t=>{
  const f=setup(t);const p=f.paths;
  assert.equal(p.data,path.join(f.appData,'Assistant Jeff'));
  assert.equal(p.settings,path.join(p.data,'windows-voice-settings.json'));
  assert.equal(p.logs,path.join(f.root,'work','windows-desktop','runs'));
  assert.equal(p.helper,path.join(f.root,'work','windows-desktop','bin','JeffWindowsDesktopHelper.exe'));
  assert.equal(p.models,path.join(f.root,'models'));
  assert.equal(p.piper,path.join(f.root,'work','voice-runtime','piper','piper.exe'));
  assert.equal(p.denis,path.join(f.root,'data','tts','piper','ru_RU-denis-medium.onnx'));
  assert.equal(p.ffmpeg,path.join(f.root,'work','voice-runtime','ffmpeg','ffmpeg.exe'));
});

test('packaged runtime uses resources for executables and voices and writable appData for settings/logs',t=>{
  const f=setup(t);const p=runtimePaths({...f,packaged:true});
  assert.equal(p.data,path.join(f.appData,'Assistant Jeff'));
  assert.equal(p.logs,path.join(p.data,'logs','windows'));
  assert.equal(p.helper,path.join(f.resourcesPath,'windows-desktop','JeffWindowsDesktopHelper.exe'));
  assert.equal(p.models,path.join(f.resourcesPath,'models'));
  assert.equal(p.piper,path.join(f.resourcesPath,'voice-runtime','piper','piper.exe'));
  assert.equal(p.denis,path.join(f.resourcesPath,'voices','ru_RU-denis-medium.onnx'));
  assert.equal(p.ffmpeg,path.join(f.resourcesPath,'voice-runtime','ffmpeg','ffmpeg.exe'));
  for(const key of ['data','settings','logs'])assert.equal(p[key].startsWith(f.resourcesPath),false);
});

test('data override isolates settings and logs in both source and packaged modes',t=>{
  const f=setup(t);const dataOverride=path.join(f.temp,'isolated-data');
  for(const packaged of [false,true]){
    const p=runtimePaths({...f,packaged,dataOverride});
    assert.equal(p.data,dataOverride);assert.equal(p.settings,path.join(dataOverride,'windows-voice-settings.json'));assert.equal(p.logs,path.join(dataOverride,'logs','windows'));
    assert.equal(p.helper.startsWith(packaged?f.resourcesPath:f.root),true);
  }
});

test('initialization migrates only allowlisted missing gateway files without moving or copying personal records',t=>{
  const f=setup(t);
  const content={'gateway.json':'{"host":"synthetic.invalid"}','secrets/typesafe.dpapi':'synthetic-typesafe','secrets/gateway-key.dpapi':'synthetic-key','secrets/gateway-token.dpapi':'synthetic-token'};
  for(const [relative,text] of Object.entries(content))f.write(path.join('data',relative),text);
  f.write('data/assistant.sqlite','synthetic-private-records');f.write('data/settings.json','{"private":"setting"}');f.write('data/secrets/unrelated.dpapi','not-migrated');
  assert.deepEqual(initializeRuntime(f.paths,f.root),VOICE_DEFAULTS);
  for(const [relative,text] of Object.entries(content)){
    assert.equal(fs.readFileSync(path.join(f.paths.data,relative),'utf8'),text);
    assert.equal(fs.readFileSync(path.join(f.root,'data',relative),'utf8'),text);
  }
  for(const relative of ['assistant.sqlite','settings.json','secrets/unrelated.dpapi'])assert.equal(fs.existsSync(path.join(f.paths.data,relative)),false);
});

test('existing migrated secrets and user settings are never overwritten on repeated initialization',t=>{
  const f=setup(t);fs.mkdirSync(path.join(f.paths.data,'secrets'),{recursive:true});
  const originals={};
  for(const relative of ['gateway.json','secrets/typesafe.dpapi','secrets/gateway-key.dpapi','secrets/gateway-token.dpapi']){
    f.write(path.join('data',relative),'different-source-content');const target=path.join(f.paths.data,relative);fs.writeFileSync(target,'existing-user-content');originals[target]=fs.readFileSync(target);
  }
  const settings='{"activationBeep":false,"denisReply":false,"voiceAutoExecute":false,"cloudEnabled":false,"microphoneId":"synthetic-mic"}';fs.writeFileSync(f.paths.settings,settings);
  for(let i=0;i<2;i++){
    const actual=initializeRuntime(f.paths,f.root);assert.equal(actual.activationBeep,false);assert.equal(actual.cloudEnabled,false);assert.equal(actual.microphoneId,'synthetic-mic');
  }
  for(const [file,bytes] of Object.entries(originals))assert.deepEqual(fs.readFileSync(file),bytes);
  assert.equal(fs.readFileSync(f.paths.settings,'utf8'),settings);
});

test('isolated initialization never imports available source gateway configuration or secrets',t=>{
  const f=setup(t);
  for(const relative of ['gateway.json','secrets/typesafe.dpapi','secrets/gateway-key.dpapi','secrets/gateway-token.dpapi'])f.write(path.join('data',relative),'synthetic-private-source');
  const settings=initializeRuntime(f.paths,f.root,{isolated:true});assert.deepEqual(settings,VOICE_DEFAULTS);assert.deepEqual(fs.readdirSync(f.paths.data),[]);
});

test('missing or malformed JSON/settings schema uses defaults without rewriting the user file',t=>{
  const f=setup(t);assert.deepEqual(initializeRuntime(f.paths,f.root,{isolated:true}),VOICE_DEFAULTS);
  assert.equal(fs.existsSync(f.paths.settings),false);
  for(const raw of ['{corrupt','null','[]',JSON.stringify({cloudEnabled:'false'})]){
    fs.writeFileSync(f.paths.settings,raw);assert.deepEqual(initializeRuntime(f.paths,f.root,{isolated:true}),VOICE_DEFAULTS);
    assert.equal(fs.readFileSync(f.paths.settings,'utf8'),raw);
  }
});

test('voice settings validate typed patches and preserve unrelated current values',()=>{
  const current={...VOICE_DEFAULTS,microphoneId:'synthetic-mic',denisReply:false};
  const next=validateVoiceSettings({activationBeep:false,cloudEnabled:false,unknown:'discarded'},current);
  assert.deepEqual(next,{...current,activationBeep:false,cloudEnabled:false});assert.equal(current.activationBeep,true);
  assert.equal(VOICE_DEFAULTS.activationBeep,true);assert.equal(Object.hasOwn(next,'unknown'),false);
  for(const patch of [null,[],{activationBeep:1},{denisReply:'true'},{voiceAutoExecute:null},{cloudEnabled:'false'},{microphoneId:123},{microphoneId:'x'.repeat(513)}])assert.throws(()=>validateVoiceSettings(patch),/VOICE_SETTINGS_INVALID/);
  assert.equal(validateVoiceSettings({microphoneId:'x'.repeat(512)}).microphoneId.length,512);
  assert.equal(VOICE_DEFAULTS.transcriptionMode,'live');
  assert.equal(validateVoiceSettings({transcriptionMode:'batch'}).transcriptionMode,'batch');
  assert.throws(()=>validateVoiceSettings({transcriptionMode:'unknown'}),/VOICE_SETTINGS_INVALID/);
});

test('saving settings round-trips validated values and an invalid update preserves the existing file',t=>{
  const f=setup(t);const current=initializeRuntime(f.paths,f.root,{isolated:true});
  const saved=saveVoiceSettings(f.paths,{activationBeep:false,microphoneId:'new-synthetic-mic'},current);
  assert.deepEqual(JSON.parse(fs.readFileSync(f.paths.settings,'utf8')),saved);
  assert.deepEqual(initializeRuntime(f.paths,f.root,{isolated:true}),saved);
  const before=fs.readFileSync(f.paths.settings);assert.throws(()=>saveVoiceSettings(f.paths,{cloudEnabled:'yes'},saved),/VOICE_SETTINGS_INVALID/);
  assert.deepEqual(fs.readFileSync(f.paths.settings),before);assert.equal(fs.existsSync(f.paths.settings+'.tmp'),false);
});
