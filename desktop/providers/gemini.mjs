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

const AGENT_NAME=/^[A-Za-z0-9_-]{1,128}$/u;
const AGENT_MAX_PARTS=64;
const AGENT_MAX_SIGNATURE=16*1024;
const AGENT_MAX_ID=1024;
const DEFAULT_AGENT_RETRY_DELAYS=Object.freeze([2000,8000]);
const AGENT_RETRY_STATUSES=new Set([429,502,503,504]);

export const GEMINI_ERROR_CODES=Object.freeze({
  AGENT_INPUT_INVALID:'AGENT_INPUT_INVALID',
  AGENT_MODEL_INVALID:'AGENT_MODEL_INVALID',
  AGENT_PROVIDER_ERROR:'AGENT_PROVIDER_ERROR',
  GEMINI_UPSTREAM_ERROR:'GEMINI_UPSTREAM_ERROR',
  GEMINI_NETWORK_ERROR:'GEMINI_NETWORK_ERROR',
  GEMINI_RESPONSE_INVALID:'GEMINI_RESPONSE_INVALID',
});

function geminiError(message,code,details){
  const error=new Error(message);
  error.code=code;
  if(details!==undefined)error.details=details;
  return error;
}

function defaultSleep(milliseconds,signal){
  return new Promise((resolve,reject)=>{
    let timer;
    const abort=()=>{
      clearTimeout(timer);
      signal?.removeEventListener('abort',abort);
      reject(signal.reason);
    };
    if(signal?.aborted){abort();return;}
    timer=setTimeout(()=>{
      signal?.removeEventListener('abort',abort);
      resolve();
    },milliseconds);
    signal?.addEventListener('abort',abort,{once:true});
  });
}

function retryStatus(error){
  if(error?.code!==GEMINI_ERROR_CODES.GEMINI_UPSTREAM_ERROR)return null;
  const upstreamStatus=error?.details?.upstreamStatus;
  const status=Number.isSafeInteger(upstreamStatus)?upstreamStatus:error?.details?.status;
  return AGENT_RETRY_STATUSES.has(status)?status:null;
}

function normalizeRetryDelays(value){
  return [0,1].map(index=>{
    const candidate=Array.isArray(value)?value[index]:undefined;
    return Number.isFinite(candidate)&&candidate>=0&&candidate<=60000?candidate:DEFAULT_AGENT_RETRY_DELAYS[index];
  });
}

function agentObject(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function agentKeys(value,keys){return Object.keys(value).every(key=>keys.has(key));}
export function validateAgentResponse(value){
  if(!agentObject(value)||typeof value.model!=='string'||!value.model||!Number.isSafeInteger(value.latencyMs)||value.latencyMs<0)throw geminiError('Gemini вернул некорректный ответ агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
  if(!agentObject(value.content)||value.content.role!=='model'||!Array.isArray(value.content.parts)||!value.content.parts.length||value.content.parts.length>AGENT_MAX_PARTS)throw geminiError('Gemini вернул некорректный ответ агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
  const parts=value.content.parts.map(part=>{
    if(!agentObject(part)||!agentKeys(part,new Set(['text','functionCall','thoughtSignature']))||(('text' in part)+('functionCall' in part))!==1)throw geminiError('Gemini вернул некорректную часть ответа агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    if('thoughtSignature' in part&& (typeof part.thoughtSignature!=='string'||part.thoughtSignature.length>AGENT_MAX_SIGNATURE))throw geminiError('Gemini вернул некорректную подпись агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    if('text' in part){if(typeof part.text!=='string')throw geminiError('Gemini вернул некорректный текст агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);return {...part};}
    const call=part.functionCall;
    if(!agentObject(call)||!agentKeys(call,new Set(['name','args','id','thoughtSignature']))||typeof call.name!=='string'||!AGENT_NAME.test(call.name))throw geminiError('Gemini вернул некорректный вызов агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    if('args' in call){
      let argsBytes;
      try{argsBytes=Buffer.byteLength(JSON.stringify(call.args),'utf8');}catch{argsBytes=Infinity;}
      if(!agentObject(call.args)||argsBytes>64*1024)throw geminiError('Gemini вернул некорректные аргументы агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    }
    if('id' in call&&(typeof call.id!=='string'||call.id.length>AGENT_MAX_ID))throw geminiError('Gemini вернул некорректный идентификатор агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    if('thoughtSignature' in call&&(typeof call.thoughtSignature!=='string'||call.thoughtSignature.length>AGENT_MAX_SIGNATURE))throw geminiError('Gemini вернул некорректную подпись агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    return {...part,functionCall:{...call}};
  });
  let usage=null;
  if(value.usage!==null&&value.usage!==undefined){
    if(!agentObject(value.usage)||Object.entries(value.usage).some(([key,item])=>!/^[A-Za-z][A-Za-z0-9_]{0,63}$/u.test(key)||!Number.isSafeInteger(item)||item<0))throw geminiError('Gemini вернул некорректную статистику агента.',GEMINI_ERROR_CODES.AGENT_MODEL_INVALID);
    usage={...value.usage};
  }
  return {content:{role:'model',parts},model:value.model,usage,latencyMs:value.latencyMs};
}

export class GeminiGateway {
  constructor(dataDir,{fetchImpl=globalThis.fetch,sleepImpl=defaultSleep,sleep,delay,agentRetryDelays,retryDelays}={}){
    this.dataDir=dataDir;
    this.fetchImpl=fetchImpl;
    this.sleepImpl=[delay,sleep,sleepImpl].find(value=>typeof value==='function')||defaultSleep;
    this.agentRetryDelays=normalizeRetryDelays(agentRetryDelays??retryDelays);
    this.client=null;this.server=null;this.starting=null;this.generation=0;this.lifetime=new AbortController();
  }
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
  async request(route,body,{signal,timeoutMs=30000,validateResponse}={}){
    signal?.throwIfAborted();
    const generation=this.generation;
    const lifetime=this.lifetime.signal;
    await waitForConnection(this.connect(),AbortSignal.any([lifetime,...(signal?[signal]:[])]));
    signal?.throwIfAborted();
    lifetime.throwIfAborted();
    if(generation!==this.generation||!this.url)throw new Error('Соединение отменено.');
    const requestSignal=AbortSignal.any([lifetime,AbortSignal.timeout(timeoutMs),...(signal?[signal]:[])]);
    const agentRoute=route==='/agent';
    let response;
    try{
      response=await this.fetchImpl(`${this.url}${route}`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},body:JSON.stringify(body),signal:requestSignal});
    }catch{
      requestSignal.throwIfAborted();
      throw geminiError('Не удалось получить ответ Gemini.',GEMINI_ERROR_CODES.GEMINI_NETWORK_ERROR);
    }
    if(!response.ok){
      let errorBody=null;
      try{if(typeof response.json==='function')errorBody=await response.json();}catch{}
      const serverCode=typeof errorBody?.code==='string'?errorBody.code:'';
      const knownCode=new Set(Object.values(GEMINI_ERROR_CODES));
      const code=knownCode.has(serverCode)?serverCode:GEMINI_ERROR_CODES.GEMINI_UPSTREAM_ERROR;
      const status=Number.isSafeInteger(response.status)&&response.status>=100&&response.status<=599?response.status:0;
      const details={status};
      if(Number.isSafeInteger(errorBody?.upstreamStatus)&&errorBody.upstreamStatus>=100&&errorBody.upstreamStatus<=599)details.upstreamStatus=errorBody.upstreamStatus;
      const message=code===GEMINI_ERROR_CODES.AGENT_INPUT_INVALID?'Неверный запрос агента Gemini.':'Gemini сейчас недоступен. Попробуйте позже.';
      throw geminiError(message,code,details);
    }
    let result;
    try{result=await response.json();}
    catch{
      requestSignal.throwIfAborted();
      throw geminiError('Gemini вернул некорректный ответ.',agentRoute?GEMINI_ERROR_CODES.AGENT_PROVIDER_ERROR:GEMINI_ERROR_CODES.GEMINI_RESPONSE_INVALID,{status:response.status});
    }
    requestSignal.throwIfAborted();
    if(validateResponse)return validateResponse(result);
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
  async agentStep(payload,{signal}={}){
    if(!agentObject(payload)||!Array.isArray(payload.contents)||!Array.isArray(payload.tools)||!agentObject(payload.context))throw geminiError('Неверный запрос агента Gemini.',GEMINI_ERROR_CODES.AGENT_INPUT_INVALID);
    let serialized;
    try{serialized=JSON.stringify(payload);}catch{throw geminiError('Неверный запрос агента Gemini.',GEMINI_ERROR_CODES.AGENT_INPUT_INVALID);}
    if(typeof serialized!=='string'||Buffer.byteLength(serialized,'utf8')>512*1024)throw geminiError('Запрос агента Gemini слишком большой.',GEMINI_ERROR_CODES.AGENT_INPUT_INVALID);
    for(let retry=0;;retry++){
      try{
        return await this.request('/agent',payload,{signal,timeoutMs:60000,validateResponse:validateAgentResponse});
      }catch(error){
        if(retry>=this.agentRetryDelays.length||retryStatus(error)===null)throw error;
        const delayMs=this.agentRetryDelays[retry];
        const waiting=Promise.resolve().then(()=>this.sleepImpl(delayMs,signal));
        if(signal)await waitForConnection(waiting,signal);
        else await waiting;
      }
    }
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
