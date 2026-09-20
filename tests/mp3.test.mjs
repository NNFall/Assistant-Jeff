import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough,Writable} from 'node:stream';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {Mp3Encoder} from '../desktop/audio/mp3.mjs';

async function fixture(t,{behavior}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'jeff-mp3-test-'));
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const executablePath=path.join(directory,'ffmpeg.exe');await writeFile(executablePath,'');
  const calls=[];
  const spawnImpl=(exe,args,options)=>{
    const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.bytes=[];
    child.kills=0;child.kill=()=>{child.kills++;queueMicrotask(()=>child.emit('close',null));};
    child.stdin=new Writable({write(chunk,_encoding,callback){child.bytes.push(Buffer.from(chunk));callback();}});
    child.stdin.once('finish',()=>queueMicrotask(()=>{
      if(behavior)behavior(child);else{child.stdout.write(Buffer.alloc(128,1));child.emit('close',0);}
    }));
    calls.push({exe,args,options,child});return child;
  };
  return {executablePath,spawnImpl,calls};
}

test('MP3 encoding uses fixed flags and the precise PCM view through stdin',async t=>{
  const x=await fixture(t),encoder=new Mp3Encoder(x);
  const source=new Int16Array([123,1000,-1000,456]),pcm=source.subarray(1,3);
  assert.equal(await encoder.available(),true);
  const result=await encoder.encode(pcm);
  assert.deepEqual(result,Buffer.alloc(128,1));
  const call=x.calls[0];assert.equal(call.exe,x.executablePath);
  assert.deepEqual(call.args,['-hide_banner','-loglevel','error','-f','s16le','-ar','16000','-ac','1','-i','pipe:0','-codec:a','libmp3lame','-b:a','64k','-f','mp3','pipe:1']);
  assert.equal(call.options.shell,false);assert.equal(call.options.windowsHide,true);
  assert.deepEqual(Buffer.concat(call.child.bytes),Buffer.from([0xe8,0x03,0x18,0xfc]));
});

test('invalid audio and an already cancelled request never spawn a process',async t=>{
  const x=await fixture(t),encoder=new Mp3Encoder(x);
  for(const pcm of [null,Buffer.alloc(2),new Int16Array(),new Int16Array(16000*32+1)])await assert.rejects(encoder.encode(pcm),{code:'AUDIO_INVALID'});
  const abort=new AbortController();abort.abort();
  await assert.rejects(encoder.encode(new Int16Array(1280),{signal:abort.signal}),{code:'ABORTED'});
  assert.equal(x.calls.length,0);
});

test('missing encoder exposes stable availability and error without process creation',async t=>{
  const x=await fixture(t);await rm(x.executablePath);
  const encoder=new Mp3Encoder(x);assert.equal(await encoder.available(),false);
  await assert.rejects(encoder.encode(new Int16Array(1280)),{code:'ENCODER_MISSING'});
  assert.equal(x.calls.length,0);
});

test('cancel kills only its own encoder once and late output cannot resolve it',async t=>{
  let ready;const started=new Promise(resolve=>{ready=resolve;});
  const x=await fixture(t,{behavior:child=>ready(child)}),encoder=new Mp3Encoder(x),abort=new AbortController();
  const pending=encoder.encode(new Int16Array(1280),{signal:abort.signal});
  const checked=assert.rejects(pending,{code:'ABORTED'});const child=await started;
  abort.abort();child.stdout.write(Buffer.alloc(128));child.emit('close',0);await checked;
  assert.equal(child.kills,1);
});

test('cancel during encoder discovery prevents the spawn',async t=>{
  const x=await fixture(t),encoder=new Mp3Encoder(x),abort=new AbortController();
  let available;encoder.available=()=>new Promise(resolve=>{available=resolve;});
  const pending=encoder.encode(new Int16Array(1280),{signal:abort.signal});
  const checked=assert.rejects(pending,{code:'ABORTED'});abort.abort();available(true);await checked;
  assert.equal(x.calls.length,0);
});

test('timeout and oversized stdout kill the encoder, while stderr remains private',async t=>{
  const hung=await fixture(t,{behavior:()=>{}});
  await assert.rejects(new Mp3Encoder({...hung,timeoutMs:5}).encode(new Int16Array(1280)),{code:'ENCODER_TIMEOUT'});
  assert.equal(hung.calls[0].child.kills,1);
  const huge=await fixture(t,{behavior:child=>child.stdout.write(Buffer.alloc(1024*1024+1))});
  await assert.rejects(new Mp3Encoder(huge).encode(new Int16Array(1280)),{code:'AUDIO_TOO_LARGE'});
  assert.equal(huge.calls[0].child.kills,1);
  const failed=await fixture(t,{behavior:child=>{child.stderr.write('sensitive local path');child.emit('close',2);}});
  await assert.rejects(new Mp3Encoder(failed).encode(new Int16Array(1280)),error=>error.code==='ENCODER_FAILED'&&!error.message.includes('sensitive'));
});

test('truncated MP3 output and spawn errors are not reported as successful audio',async t=>{
  const x=await fixture(t,{behavior:child=>{child.stdout.write(Buffer.alloc(99));child.emit('close',0);}});
  await assert.rejects(new Mp3Encoder(x).encode(new Int16Array(1280)),{code:'ENCODER_FAILED'});
  const y=await fixture(t);
  await assert.rejects(new Mp3Encoder({...y,spawnImpl:()=>{throw new Error('private details');}}).encode(new Int16Array(1280)),error=>error.code==='ENCODER_FAILED'&&!error.message.includes('private'));
});
