import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {access} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export const HELPER=fileURLToPath(new URL('../../work/windows-desktop/bin/JeffWindowsDesktopHelper.exe',import.meta.url));
const failure=code=>Object.assign(new Error(code),{code});

/** Transport for this application's own native backend; no shell or model code. */
export class WindowsBridge {
  constructor({ownerPid=process.pid,helper=HELPER}={}){this.ownerPid=ownerPid;this.helper=helper;this.sequence=0;this.pending=new Map();this.closed=false;}
  async start(){
    if(this.process&&!this.closed)return;
    if(this.starting)return this.starting;
    this.starting=this.startProcess();
    try{await this.starting;}finally{this.starting=null;}
  }
  async startProcess(){
    try{await access(this.helper);}catch{throw failure('WINDOWS_HELPER_MISSING');}
    this.closed=false;
    const child=this.process=spawn(this.helper,['--owner-pid',String(this.ownerPid)],{cwd:path.dirname(this.helper),windowsHide:true,stdio:['pipe','pipe','pipe']});
    const closeCurrent=code=>{if(this.process===child)this.close(code);};
    child.stderr.resume();
    child.stdin.on('error',()=>closeCurrent('WINDOWS_BRIDGE_STOPPED'));
    child.once('error',()=>closeCurrent('WINDOWS_BRIDGE_UNAVAILABLE'));
    child.once('exit',()=>closeCurrent('WINDOWS_BRIDGE_STOPPED'));
    createInterface({input:child.stdout}).on('line',line=>{
      if(this.process!==child)return;
      if(line.length>2*1024*1024)return this.close('WINDOWS_RESPONSE_TOO_LARGE');
      let result;try{result=JSON.parse(line);}catch{return this.close('WINDOWS_INVALID_RESPONSE');}
      const entry=this.pending.get(result.id);if(!entry)return;
      this.pending.delete(result.id);entry.cleanup();
      result.ok?entry.resolve(result.result):entry.reject(failure(/^[A-Z_]{1,64}$/.test(result.error?.code)?result.error.code:'WINDOWS_NATIVE_REJECTED'));
    });
  }
  async request(method,args={},signal){
    if(signal?.aborted)throw failure('ABORTED');
    if(!this.process||this.closed)await this.start();
    if(signal?.aborted)throw failure('ABORTED');
    const id=++this.sequence;
    return new Promise((resolve,reject)=>{
      const cancel=()=>this.close('ABORTED');
      const timer=setTimeout(()=>this.close('WINDOWS_TIMEOUT'),12000);
      this.pending.set(id,{resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}});
      signal?.addEventListener('abort',cancel,{once:true});
      this.process.stdin.write(JSON.stringify({id,method,args})+'\n');
    });
  }
  close(code='WINDOWS_BRIDGE_CLOSED'){
    if(this.closed)return;this.closed=true;
    for(const entry of this.pending.values()){entry.cleanup();entry.reject(failure(code));}this.pending.clear();
    this.process?.stdin.destroy();this.process?.kill();this.process=null;
  }
}
