import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {access} from 'node:fs/promises';
import {readProtected} from '../../desktop/secrets.mjs';
import {chooseUiAction,buildUiChoiceRequest} from '../../desktop/providers/ui-choice.mjs';
import {runObservedTask} from '../../desktop/automation/observed-task.mjs';
import {isSupportedLabCandidate,verifyLabAction} from './scenarios.mjs';
import {compileLabGoal,buildLabGoalRequest} from '../../desktop/providers/lab-goal.mjs';
import {validateCommand,goalSatisfied} from './goal-contract.mjs';
import {RunJournal,listRuns,readRun,LOG_DIRECTORY,redact} from './journal.mjs';

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
    // Explicit user Start/Run prepares only our owned window (including restore).
    let last;
    for (let attempt=0;attempt<12;attempt++) {
      assertActive(signal);
      try {
        const prepared=await this.bridge.request('prepare',{},signal);
        this.remember(prepared.snapshot);
        return {running:this.running,snapshot:prepared.snapshot,restored:prepared.restored};
      } catch(error) {assertActive(signal);last=error;if(this.bridge.closed)break;await delay(250,signal);}
    }
    throw last ?? fail('TARGET_NOT_READY');
  }
  async observe(signal) {
    if (!this.bridge) throw fail('START_TEST_WINDOW_FIRST');
    if(this.target?.exitCode!==null||this.target?.killed)throw fail('TARGET_NOT_RUNNING');
    const snapshot=await this.bridge.request('observe',{},signal);
    return this.remember(snapshot);
  }
  remember(snapshot) {
    if (!snapshot || typeof snapshot.version !== 'string' || !Array.isArray(snapshot.elements) || !snapshot.facts) throw fail('INVALID_SNAPSHOT');
    this.snapshots.set(snapshot.version,snapshot);
    while(this.snapshots.size>32)this.snapshots.delete(this.snapshots.keys().next().value);
    this.lastSnapshot=snapshot;
    return snapshot;
  }
  async state({signal}={}) { assertActive(signal);return {running:this.running,snapshot:await this.observe(signal)}; }
  stop() {this.abort?.abort('user_stop');return {stopped:true};}
  history(){return listRuns({activeRunId:this.activeRunId});}
  readRun({runId}={}){return readRun(runId,{activeRunId:this.activeRunId});}
  get logDirectory(){return LOG_DIRECTORY;}
  async run({command}={}) {
    if(this.running)throw fail('TASK_ALREADY_RUNNING');
    command=validateCommand(command);
    this.running=true; this.abort=new AbortController();
    const signal=this.abort.signal;
    const started=performance.now();
    const timeout=setTimeout(()=>this.abort?.abort('time_limit'),60000);
    const report={createdAt:new Date().toISOString(),mode:'REAL_API_REAL_WINDOWS_UIA_TEST_WINDOW',command,calls:[],trace:[],completed:[]};
    let journal;
    let finishing=false;
    const event=async(phase,data={})=>{
      if(finishing&&phase!=='result')return;
      const recorded=await journal.record(phase,data);
      this.progress(recorded);
      return recorded;
    };
    try {
      journal=await RunJournal.create(command);this.activeRunId=journal.runId;
      report.runId=journal.runId;report.logPath=journal.jsonPath;
      await event('window_prepare',{message:'Открываем или восстанавливаем тестовое окно.',logPath:report.logPath});
      const prepared=await this.start({signal});
      await event('window_ready',{restored:prepared.restored,snapshot:prepared.snapshot,message:prepared.restored?'Тестовое окно восстановлено.':'Тестовое окно готово.'});
      if(signal.aborted)throw fail('ABORTED');
      const apiKey=process.env.TYPESAFE_API_KEY||await readProtected(path.join(root,'data','secrets','typesafe.dpapi'));
      if(!apiKey)throw fail('TYPESAFE_KEY_MISSING');
      const initial=await this.observe(signal);
      report.initial=initial;
      const goalInput={command,currentFacts:initial.facts};
      const goalCall={kind:'goal',request:buildLabGoalRequest(goalInput)};
      report.calls.push(goalCall);
      await event('model_request',{kind:'goal',request:goalCall.request,message:'Jev определяет проверяемую цель команды.'});
      try{
        report.plan=await compileLabGoal(goalInput,{apiKey,signal,onResponse:response=>{goalCall.response=response;void event('model_response',{kind:'goal',response,message:'Получен ответ Jev о цели.'}).catch(()=>{});}});
        goalCall.decision=report.plan;
      }catch(error){goalCall.error=/^[A-Z_]{1,60}$/.test(error.code)?error.code:'LAB_ERROR';throw error;}
      await journal.flush();
      report.goal=report.plan.goal;
      await event('plan',{plan:report.plan,goal:report.goal,message:report.plan.ok?'Цель определена; проверяем состояние окна.':'Команда не допущена к исполнению.'});
      if(!report.plan.ok){report.ok=false;report.reason=report.plan.reason==='no_action'?'no_request':report.plan.reason==='low_confidence'?'goal_low_confidence':report.plan.reason;return report;}
      const adapter={
        observe:async({signal}={})=>{
          const t=performance.now();const snapshot=await this.observe(signal);
          await event('native_observation',{snapshot,latencyMs:Math.round(performance.now()-t),message:'Получено свежее наблюдение Windows.'});return snapshot;
        },
        execute:async(candidate,{expectedVersion,signal})=>{
          assertActive(signal);
          if(!isSupportedLabCandidate(this.snapshots.get(expectedVersion),candidate))throw fail('UNSUPPORTED_CONTROL');
          await event('native_execute_request',{candidate,expectedVersion,message:`${candidate.operation}: ${candidate.label}`});
          assertActive(signal);
          const t=performance.now();
          const receipt=await this.bridge.request('execute',{targetId:candidate.targetId,operation:candidate.operation,expectedVersion},signal);
          await event('native_execute_result',{receipt,latencyMs:Math.round(performance.now()-t),message:'Исполнитель вернул результат; проверяем факты.'});
          return receipt;
        },
        verify:async({before,after,candidate})=>verifyLabAction({before:this.snapshots.get(before.version),after:this.snapshots.get(after.version),candidate}),
        isGoalSatisfied:async snapshot=>goalSatisfied(report.goal,this.snapshots.get(snapshot.version)),
      };
      const result=await runObservedTask({command,adapter,signal,maxSteps:8,maxDurationMs:Math.max(1,Math.round(60000-(performance.now()-started))),
        onEvent:async item=>event(item.phase,{...item,message:({observe:'Состояние перед шагом.',decision:'Выбор следующего действия.',goal:'Проверка достижения цели.',verify:'Проверка результата действия.',stale:'Окно изменилось; перечитываем.',stop:'Цикл остановлен.'})[item.phase]??'Шаг исполнения.'}),
        choose:async(input,{signal})=>{
          const call={kind:'action',input,request:buildUiChoiceRequest(input)};
          report.calls.push(call);
          await event('model_request',{kind:'action',request:call.request,message:'Отправляем наблюдение и варианты действий в Jev.'});
          let decision;
          try {decision=await chooseUiAction(input,{apiKey,signal,onResponse:response=>{call.response=response;void event('model_response',{kind:'action',response,message:'Получен ответ Jev о действии.'}).catch(()=>{});}});}
          catch(error){call.error=/^UI_[A-Z_]{1,50}$/.test(error.code)?error.code:'UI_ERROR';throw error;}
          await journal.flush();
          call.decision=decision;
          await event('model_decision',{...decision,message:'Проверены выбранный id, вероятность и уверенность.'});
          return decision;
        }});
      Object.assign(report,result);
      report.loopElapsedMs=result.elapsedMs;
      report.errorCode=result.trace.findLast(e=>e.phase==='stop')?.code;
      if(report.reason==='no_action')report.reason='action_low_confidence';
      report.final=this.lastSnapshot;
      return report;
    } catch(error) {
      Object.assign(report,{ok:false,reason:signal.aborted?(signal.reason==='time_limit'?'time_limit':'aborted'):/^[A-Z_]{1,60}$/.test(error.code)?error.code:'LAB_ERROR'});
      return report;
    } finally {
      finishing=true;
      clearTimeout(timeout);
      report.elapsedMs=Math.round(performance.now()-started);
      if(journal){
        try{
          await event('result',{ok:report.ok,reason:report.reason,errorCode:report.errorCode,elapsedMs:report.elapsedMs,goal:report.goal,message:report.ok?'Цель подтверждена чтением Windows.':`Остановка: ${report.reason}`});
          report.events=journal.events;
          await journal.finish(report);
        }catch{report.ok=false;report.reason='LOG_WRITE_FAILED';report.events=journal.events;}
      }
      // The returned report follows the same redaction policy as durable logs.
      Object.assign(report,redact(report));
      this.running=false;this.abort=null;this.activeRunId=null;
    }
  }
  dispose() {this.stop();this.bridge?.close();this.target?.kill();this.target=null;}
}
