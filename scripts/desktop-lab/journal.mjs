import {appendFile,mkdir,writeFile,readFile,readdir,rename,stat} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {describeResult} from '../../desktop/automation/feedback.mjs';

export const LOG_DIRECTORY=fileURLToPath(new URL('../../work/desktop-lab/runs/',import.meta.url));
const MAX_BYTES=8*1024*1024;
const error=code=>Object.assign(new Error(code),{code});
const validId=id=>typeof id==='string'&&/^\d{13}(?:-[a-f0-9-]{36})?$/.test(id);
const privateField=/^(?:api.?key|authorization|password|access.?token|refresh.?token|secret|headers)$/i;
export function redact(value){
  if(typeof value==='string')return value.replace(/\bapikey_[A-Za-z0-9_]{15,}/g,'[REDACTED]').replace(/\bBearer\s+[A-Za-z0-9._-]+/gi,'Bearer [REDACTED]');
  if(Array.isArray(value))return value.map(redact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,privateField.test(key)?'[REDACTED]':redact(item)]));
  return value;
}
async function boundedRead(file){const info=await stat(file);if(info.size>MAX_BYTES)throw error('LOG_TOO_LARGE');return readFile(file,'utf8');}
async function atomicJson(file,value){await writeFile(file+'.tmp',JSON.stringify(redact(value),null,2)+'\n');await rename(file+'.tmp',file);}

export class RunJournal {
  static async create(command,{directory=LOG_DIRECTORY}={}){
    await mkdir(directory,{recursive:true});
    const run=new RunJournal(directory);
    run.initial={runId:run.runId,createdAt:new Date().toISOString(),command:redact(command),status:'running',ok:false,reason:'running',logPath:run.jsonPath};
    try {await atomicJson(run.jsonPath,run.initial);await run.record('session_start',{command});}
    catch{throw error('LOG_WRITE_FAILED');}
    return run;
  }
  constructor(directory){this.directory=directory;this.runId=Date.now()+'-'+randomUUID();this.events=[];this.queue=Promise.resolve();this.bytes=0;this.jsonPath=path.join(directory,this.runId+'.json');this.eventPath=path.join(directory,this.runId+'.jsonl');}
  record(phase,data={}){
    const event=redact({...data,phase,runId:this.runId,sequence:this.events.length+1,time:new Date().toISOString()});
    const line=JSON.stringify(event)+'\n';this.bytes+=Buffer.byteLength(line);
    this.events.push(event);
    this.queue=this.queue.then(async()=>{if(this.bytes>MAX_BYTES)throw error('LOG_TOO_LARGE');await appendFile(this.eventPath,line);}).catch(()=>{throw error('LOG_WRITE_FAILED');});
    // Synchronous model hooks may queue a write; flush before any OS effect.
    this.queue.catch(()=>{});
    return this.queue.then(()=>event);
  }
  async flush(){await this.queue;}
  async finish(report){await this.flush();try{await atomicJson(this.jsonPath,{...this.initial,...report,status:'finished',events:this.events,logPath:this.jsonPath});}catch{throw error('LOG_WRITE_FAILED');}}
}

export async function readRun(runId,{directory=LOG_DIRECTORY,activeRunId,activeRunIds=[]}={}){
  if(!validId(runId))throw error('INVALID_RUN_ID');
  try{
    const file=path.join(directory,runId+'.json');
    const report=JSON.parse(await boundedRead(file));
    if(report.status==='running'){
      let lines=[];try{lines=(await boundedRead(path.join(directory,runId+'.jsonl'))).split('\n').filter(Boolean);}catch(e){if(e.code!=='ENOENT')throw e;}
      const events=[];for(const line of lines){try{events.push(JSON.parse(line));}catch{break;}}
      report.events=events;
      if(runId!==activeRunId&&!activeRunIds.includes(runId)){report.status='interrupted';report.reason='interrupted';}
    }
    return {...redact(report),runId,logPath:file};
  }catch(e){if(e.code==='ENOENT')throw error('RUN_NOT_FOUND');if(/^LOG_/.test(e.code))throw e;throw error('LOG_READ_FAILED');}
}
export async function listRuns({directory=LOG_DIRECTORY,activeRunId,activeRunIds=[],excludeRunIds=[]}={}){
  await mkdir(directory,{recursive:true});
  const names=(await readdir(directory)).filter(name=>name.endsWith('.json')&&validId(name.slice(0,-5))).sort().reverse().slice(0,40);
  const runs=[],children=new Set(excludeRunIds);
  for(const name of names){try{const r=await readRun(name.slice(0,-5),{directory,activeRunId,activeRunIds});if(validId(r.childRunId))children.add(r.childRunId);const {tone,title}=describeResult(r);runs.push({runId:r.runId,createdAt:r.createdAt,command:r.command,status:r.status,ok:r.ok,reason:r.reason,elapsedMs:r.elapsedMs,feedback:{tone,title}});}catch{runs.push({runId:name.slice(0,-5),ok:false,reason:'LOG_READ_FAILED'});}}
  // The routing and desktop/data journals are one user task. Child logs stay
  // accessible by ID and are embedded in the parent, not duplicate history rows.
  return {runs:runs.filter(run=>!children.has(run.runId)).slice(0,20)};
}
