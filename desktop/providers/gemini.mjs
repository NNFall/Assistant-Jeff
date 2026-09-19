import {Client} from 'ssh2';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import {readProtected} from '../secrets.mjs';

export class GeminiGateway {
  constructor(dataDir){this.dataDir=dataDir;this.client=null;this.server=null;this.starting=null;this.generation=0;}
  async available(){try{await fs.access(path.join(this.dataDir,'gateway.json'));return !!(await readProtected(path.join(this.dataDir,'secrets','gateway-token.dpapi')));}catch{return false;}}
  async connect(){
    if(this.url) return;
    if(this.starting) return this.starting;
    const generation=this.generation;
    this.starting=this.open(generation).finally(()=>{this.starting=null;}); return this.starting;
  }
  async open(generation){
    const config=JSON.parse(await fs.readFile(path.join(this.dataDir,'gateway.json'),'utf8'));
    if(!config.host || !/^[a-f0-9]{64}$/.test(config.hostHash)||config.remotePort!==18741) throw new Error('Неверная настройка сервера Jeff.');
    const privateKey=await readProtected(path.join(this.dataDir,'secrets','gateway-key.dpapi'));
    this.token=await readProtected(path.join(this.dataDir,'secrets','gateway-token.dpapi'));
    if(!privateKey||!this.token)throw new Error('Ключ сервера Jeff не настроен.');
    const client=new Client(); this.client=client;
    await new Promise((resolve,reject)=>{
      client.once('ready',resolve);
      client.on('error',()=>{this.url=null;reject(new Error('Сервер Jeff недоступен.'));});
      client.on('close',()=>{this.url=null;this.server?.close();this.server=null;});
      client.connect({host:config.host,port:config.port||22,username:config.username||'root',privateKey,hostHash:'sha256',hostVerifier:hash=>hash===config.hostHash,readyTimeout:10000,keepaliveInterval:15000});
    });
    if(generation!==this.generation){client.end();throw new Error('Соединение отменено.');}
    const server=net.createServer(socket=>{
      client.forwardOut('127.0.0.1',socket.remotePort||0,'127.0.0.1',18741,(err,stream)=>{
        if(err){socket.destroy();return;}
        socket.on('error',()=>stream.destroy());stream.on('error',()=>socket.destroy());socket.pipe(stream).pipe(socket);
      });
    }); this.server=server;
    await new Promise((resolve,reject)=>{server.once('error',()=>reject(new Error('Не удалось открыть локальное соединение.')));server.listen(0,'127.0.0.1',resolve);});
    this.url=`http://127.0.0.1:${server.address().port}`;
  }
  async chat(text,{signal}={}){
    signal?.throwIfAborted();
    await this.connect();
    signal?.throwIfAborted();
    const requestSignal=signal?AbortSignal.any([signal,AbortSignal.timeout(30000)]):AbortSignal.timeout(30000);
    const response=await fetch(`${this.url}/chat`,{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${this.token}`},body:JSON.stringify({text}),signal:requestSignal}).catch(()=>{throw new Error('Не удалось получить ответ Gemini.');});
    if(!response.ok)throw new Error('Gemini сейчас недоступен. Попробуйте позже.');
    const result=await response.json();
    if(typeof result.text!=='string'||!result.text)throw new Error('Gemini вернул пустой ответ.');
    return {text:result.text,model:result.model};
  }
  close(){this.generation++;this.server?.close();this.client?.end();this.server=null;this.client=null;this.url=null;}
}
