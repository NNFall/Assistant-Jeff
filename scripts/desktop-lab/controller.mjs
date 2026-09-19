import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access, mkdir, writeFile} from 'node:fs/promises';
import {readProtected} from '../../desktop/secrets.mjs';
import {chooseUiAction,buildUiChoiceRequest} from '../../desktop/providers/ui-choice.mjs';
import {runObservedTask} from '../../desktop/automation/observed-task.mjs';
import {validateScenarioCommand,firstVkTarget,isLabGoalSatisfied,isSupportedLabCandidate,verifyLabAction} from './scenarios.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const bin = path.join(root, 'work', 'desktop-lab', 'bin');
const fail = code => Object.assign(new Error(code), {code});
const assertActive = signal => {if(signal?.aborted)throw fail('ABORTED');};
function waitActive(promise,signal) {
  assertActive(signal);
  return new Promise((resolve,reject)=>{
    const cancel=()=>{cleanup();reject(fail('ABORTED'));};
    const cleanup=()=>signal?.removeEventListener('abort',cancel);
    signal?.addEventListener('abort',cancel,{once:true});
    promise.then(value=>{cleanup();resolve(value);},error=>{cleanup();reject(error);});
  });
}
const delay = (ms,signal) => new Promise((resolve,reject)=>{
  if(signal?.aborted){reject(fail('ABORTED'));return;}
  const cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);reject(fail('ABORTED'));};
  const timer=setTimeout(()=>{signal?.removeEventListener('abort',cancel);resolve();},ms);
  signal?.addEventListener('abort',cancel,{once:true});
});

class Bridge {
  constructor(pid) {
    this.pending = new Map(); this.sequence = 0; this.closed = false;
    this.process = spawn(path.join(bin, 'JeffDesktopLabHelper.exe'), ['--pid', String(pid), '--exe', path.join(bin, 'JeffDesktopLabTarget.exe')], {cwd:bin,windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.process.stderr.resume();
    this.process.stdin.on('error', () => this.close('BRIDGE_STOPPED'));
    this.process.once('error', () => this.close('BRIDGE_UNAVAILABLE'));
    this.process.once('exit', () => this.close('BRIDGE_STOPPED'));
    const lines = createInterface({input:this.process.stdout});
    lines.on('line', line => {
      if (line.length > 200000) { this.close('RESPONSE_TOO_LARGE'); return; }
      let value; try { value=JSON.parse(line); } catch { this.close('INVALID_RESPONSE'); return; }
      const pending=this.pending.get(value.id); if (!pending) return;
      this.pending.delete(value.id); pending.cleanup();
      const errorCode=value.error?.code;
      value.ok ? pending.resolve(value.result) : pending.reject(fail(/^[A-Z_]{1,60}$/.test(errorCode) ? errorCode : 'NATIVE_REJECTED'));
    });
  }
  request(method,args={},signal) {
    if (signal?.aborted) return Promise.reject(fail('ABORTED'));
    if (this.closed) return Promise.reject(fail('BRIDGE_STOPPED'));
    const id=++this.sequence;
    return new Promise((resolve,reject) => {
      const cancel=()=>this.close('ABORTED');
      const timer=setTimeout(()=>this.close('NATIVE_TIMEOUT'),8000);
      this.pending.set(id,{resolve,reject,cleanup:()=>{clearTimeout(timer);signal?.removeEventListener('abort',cancel);}});
      signal?.addEventListener('abort',cancel,{once:true});
      this.process.stdin.write(JSON.stringify({id,method,args})+'\n');
    });
  }
  close(code='BRIDGE_CLOSED') {
    if (this.closed) return; this.closed=true;
    for (const entry of this.pending.values()) {entry.cleanup();entry.reject(fail(code));} this.pending.clear();
    this.process.stdin.destroy(); this.process.kill();
  }
}

export class NativeLab {
  constructor(progress=()=>{}) { this.progress=progress; this.running=false; this.snapshots=new Map(); }
  async start({signal}={}) {
    assertActive(signal);
    if (this.starting) return waitActive(this.starting,signal);
    this.starting=this.#start(signal);
    try {return await this.starting;} finally {this.starting=null;}
  }
  async #start(signal) {
    assertActive(signal);
    if (!this.target || this.target.exitCode !== null || this.target.killed) {
      await access(path.join(bin,'JeffDesktopLabTarget.exe'));
      assertActive(signal);
      this.target=spawn(path.join(bin,'JeffDesktopLabTarget.exe'),[],{cwd:bin,windowsHide:false,stdio:'ignore'});
      await waitActive(new Promise((resolve,reject)=>{this.target.once('spawn',resolve);this.target.once('error',()=>reject(fail('TARGET_START_FAILED')));}),signal);
      this.bridge?.close(); this.bridge=null;
    }
    assertActive(signal);
    if (!this.bridge || this.bridge.closed) this.bridge=new Bridge(this.target.pid);
    // Read-only readiness retries: no actions are issued here.
    let last;
    for (let attempt=0;attempt<12;attempt++) {
      assertActive(signal);
      try {return await this.state({signal});} catch(error) {assertActive(signal);last=error;if(this.bridge.closed)break;await delay(250,signal);}
    }
    throw last ?? fail('TARGET_NOT_READY');
  }
  async observe(signal) {
    if (!this.bridge) throw fail('START_TEST_WINDOW_FIRST');
    const snapshot=await this.bridge.request('observe',{},signal);
    if (!snapshot || typeof snapshot.version !== 'string' || !Array.isArray(snapshot.elements) || !snapshot.facts) throw fail('INVALID_SNAPSHOT');
    this.snapshots.set(snapshot.version,snapshot);
    while(this.snapshots.size>32)this.snapshots.delete(this.snapshots.keys().next().value);
    this.lastSnapshot=snapshot;
    return snapshot;
  }
  async state({signal}={}) { assertActive(signal);return {running:this.running,snapshot:await this.observe(signal)}; }
  stop() {this.abort?.abort();return {stopped:true};}
  async run({scenario,command}={}) {
    if(this.running)throw fail('TASK_ALREADY_RUNNING');
    validateScenarioCommand(scenario,command);
    this.running=true; this.abort=new AbortController();
    const signal=this.abort.signal;
    const report={createdAt:new Date().toISOString(),mode:'REAL_API_REAL_WINDOWS_UIA_TEST_WINDOW',scenario,command,calls:[]};
    try {
      await this.start({signal});
      if(signal.aborted)throw fail('ABORTED');
      const apiKey=process.env.TYPESAFE_API_KEY||await readProtected(path.join(root,'data','secrets','typesafe.dpapi'));
      if(!apiKey)throw fail('TYPESAFE_KEY_MISSING');
      const initial=await this.observe(signal);
      report.initial=initial;
      const firstVk=firstVkTarget(initial);
      const adapter={
        observe:async({signal}={})=>this.observe(signal),
        execute:async(candidate,{expectedVersion,signal})=>{
          assertActive(signal);
          if(!isSupportedLabCandidate(this.snapshots.get(expectedVersion),candidate))throw fail('UNSUPPORTED_CONTROL');
          this.progress({phase:'execute',message:`${candidate.operation}: ${candidate.label}`});
          return this.bridge.request('execute',{targetId:candidate.targetId,operation:candidate.operation,expectedVersion},signal);
        },
        verify:async({before,after,candidate})=>verifyLabAction({before:this.snapshots.get(before.version),after:this.snapshots.get(after.version),candidate}),
        isGoalSatisfied:async snapshot=>isLabGoalSatisfied(scenario,this.snapshots.get(snapshot.version),firstVk),
      };
      const result=await runObservedTask({command,adapter,signal,maxSteps:6,maxDurationMs:45000,
        choose:async(input,{signal})=>{
          const call={input,request:buildUiChoiceRequest(input)};
          report.calls.push(call);
          let decision;
          try {decision=await chooseUiAction(input,{apiKey,signal,onResponse:response=>{call.response=response;}});}
          catch(error){call.error=/^UI_[A-Z_]{1,50}$/.test(error.code)?error.code:'UI_ERROR';throw error;}
          call.decision=decision;
          this.progress({phase:'decision',choice:decision.choice,probability:decision.probability,confidence:decision.confidence,latencyMs:decision.latencyMs});
          return decision;
        }});
      Object.assign(report,result);
      report.final=this.lastSnapshot;
      this.progress({phase:'result',message:result.ok?'Результат подтверждён чтением Windows UIA.':`Остановка: ${result.reason}`});
      return report;
    } catch(error) {
      Object.assign(report,{ok:false,reason:signal.aborted?'aborted':/^[A-Z_]{1,60}$/.test(error.code)?error.code:'LAB_ERROR'});
      return report;
    } finally {
      this.running=false;this.abort=null;
      const directory=path.join(root,'work','desktop-lab','runs');
      await mkdir(directory,{recursive:true});
      await writeFile(path.join(directory,`${Date.now()}.json`),JSON.stringify(report,null,2)+'\n');
    }
  }
  dispose() {this.stop();this.bridge?.close();this.target?.kill();this.target=null;}
}
