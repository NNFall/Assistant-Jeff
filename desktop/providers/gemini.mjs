import {Client} from 'ssh2';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readProtected} from '../secrets.mjs';
import {GeminiLiveStream} from './gemini-live.mjs';

function waitForConnection(promise,signal){
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(promise).then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
    if(signal.aborted)abort();
  });
}

export class GeminiGateway {
  constructor(dataDir,{fetchImpl=globalThis.fetch}={}){this.dataDir=dataDir;this.fetchImpl=fetchImpl;this.client=null;this.server=null;this.starting=null;this.generation=0;this.lifetime=new AbortController();}
  async available(){try{await fs.access(path.join(this.dataDir,'gateway.json'));return !!(await readProtected(path.join(this.dataDir,'secrets','gateway-token.dpapi')));}catch{return false;}}
  async connect(){
    if(this.url) return;
    if(this.starting) return this.starting;
    const generation=this.generation;
    const starting=this.open(generation).finally(()=>{if(this.starting===starting)this.starting=null;});
    this.starting=starting; return starting;
  }
  async open(generation){
    const config=JSON.parse(await fs.readFile(path.join(this.dataDir,'gateway.json'),'utf8'));
    if(!config.host || !/^[a-f0-9]{64}$/.test(config.hostHash)||config.remotePort!==18741) throw new Error('Неверная настройка сервера Jeff.');
    const privateKey=await readProtected(path.join(this.dataDir,'secrets','gateway-key.dpapi'));
    const token=await readProtected(path.join(this.dataDir,'secrets','gateway-token.dpapi'));
    if(!privateKey||!token)throw new Error('Ключ сервера Jeff не настроен.');
    if(generation!==this.generation)throw new Error('Соединение отменено.');
    const client=new Client();
    let server;
    this.client=client;
    try {
      await new Promise((resolve,reject)=>{
        client.once('ready',resolve);
        client.on('error',()=>{if(this.client===client)this.url=null;reject(new Error('Сервер Jeff недоступен.'));});
        client.on('close',()=>{
          server?.close();
          if(this.client===client){this.url=null;this.server=null;this.client=null;this.token=null;}
          reject(new Error('Соединение с сервером Jeff закрыто.'));
        });
        client.connect({host:config.host,port:config.port||22,username:config.username||'root',privateKey,hostHash:'sha256',hostVerifier:hash=>hash===config.hostHash,readyTimeout:10000,keepaliveInterval:15000});
      });
      if(generation!==this.generation||this.client!==client)throw new Error('Соединение отменено.');
      server=net.createServer(socket=>{
        client.forwardOut('127.0.0.1',socket.remotePort||0,'127.0.0.1',18741,(err,stream)=>{
          if(err){socket.destroy();return;}
          socket.on('error',()=>stream.destroy());stream.on('error',()=>socket.destroy());socket.pipe(stream).pipe(socket);
        });
      });
      await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error('Не удалось открыть локальное соединение.')));server.listen(0,'127.0.0.1',resolve);});
      if(generation!==this.generation||this.client!==client)throw new Error('Соединение отменено.');
      this.server=server;this.token=token;this.url=`http://127.0.0.1:${server.address().port}`;
    }catch(error){
      server?.close();client.end();
      if(this.client===client){this.client=null;this.server=null;this.url=null;this.token=null;}
      throw error;
    }
  }
  async request(route,body,{signal,timeoutMs=30000}={}){
    signal?.throwIfAborted();
    const generation=this.generation;
    const lifetime=this.lifetime.signal;
    await waitForConnection(this.connect(),AbortSignal.any([lifetime,...(signal?[signal]:[])]));
    signal?.throwIfAborted();
    lifetime.throwIfAborted();
    if(generation!==this.generation||!this.url)throw new Error('Соединение отменено.');
    const requestSignal=AbortSignal.any([lifetime,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    const response=await this.fetchImpl(`${this.url}${route}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},body:JSON.stringify(body),signal:requestSignal}).catch(()=>{
      requestSignal.throwIfAborted();
      throw new Error('Не удалось получить ответ Gemini.');
    });
    if(!response.ok)throw new Error('Gemini сейчас недоступен. Попробуйте позже.');
    const result=await response.json();
    requestSignal.throwIfAborted();
    if(typeof result.text!=='string'||!result.text.trim()||result.text.length>16384)throw new Error('Gemini вернул пустой ответ.');
    return result;
  }
  async chat(text,{signal}={}){
    if(typeof text!=='string'||!text.trim()||text.length>4096)throw new Error('Неверный текст запроса Gemini.');
    const result=await this.request('/chat',{text},{signal});
    return {text:result.text,model:result.model};
  }
  async transcribe(mp3,{signal}={}){
    if(!Buffer.isBuffer(mp3)||mp3.length<4||mp3.length>1024*1024)throw new Error('Ожидается MP3-запись размером до 1 МиБ.');
    if(mp3.subarray(0,3).toString('ascii')!=='ID3'&&!(mp3[0]===255&&(mp3[1]&0xe0)===0xe0))throw new Error('Неверный формат MP3-записи.');
    const started=performance.now();
    const result=await this.request('/transcribe',{audio:mp3.toString('base64'),mimeType:'audio/mp3'},{signal,timeoutMs:50000});
    return {text:result.text,model:result.model,latencyMs:Math.round(performance.now()-started)};
  }
  createTranscriptionStream({signal,onTranscript,onMetrics,...options}={}){
    const lifetime=this.lifetime.signal;
    const combined=AbortSignal.any([lifetime,...(signal?[signal]:[])]);
    const generation=this.generation;
    return new GeminiLiveStream({...options,signal:combined,onTranscript,onMetrics,connect:async()=>{
      combined.throwIfAborted();
      await waitForConnection(this.connect(),combined);
      combined.throwIfAborted();
      if(generation!==this.generation||!this.url)throw new Error('Соединение отменено.');
      return {url:this.url.replace(/^http:/,'ws:')+'/transcribe/live',token:this.token};
    }});
  }
  close(){
    this.generation++;this.lifetime.abort();this.lifetime=new AbortController();
    this.server?.close();this.client?.end();this.server=null;this.client=null;this.starting=null;this.url=null;this.token=null;
  }
}
