import {parseCommand,executeIntent} from '../core/commands.mjs';
import {RunJournal,redact} from '../../scripts/desktop-lab/journal.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const validCommand=value=>typeof value==='string'&&value.trim().length>0&&value.length<=1024&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
const localKinds=new Set(['note','reminder','help','error']);
const question=/^\s*(?:расскажи|объясни|вопрос\s*:)/iu;
const safeCode=value=>typeof value==='string'&&/^[A-Z_]{1,64}$/.test(value)?value:'ASSISTANT_ERROR';

/** Routes one final command. Questions never receive desktop tools or history. */
export class UnifiedCommands {
  constructor({desktop,store,chat,progress=()=>{},directory,now=Date.now}={}){
    if(typeof desktop?.run!=='function')throw new TypeError('desktop.run is required');
    Object.assign(this,{desktop,store,chat,progress,directory:directory??desktop.logDirectory,now});
    this.running=false;
  }
  stop(){
    this.abort?.abort('user_stop');
    this.desktop.stop();
    return {stopped:true};
  }
  async run({command,mode='auto',signal:externalSignal}={}){
    if(this.running)throw fail('TASK_ALREADY_RUNNING');
    if(!validCommand(command))throw fail('INVALID_COMMAND');
    if(!['auto','desktop','chat'].includes(mode))throw fail('INVALID_COMMAND_MODE');
    command=command.trim();
    this.running=true;
    const abort=new AbortController();this.abort=abort;
    const cancel=()=>{abort.abort('user_stop');if(this.route==='desktop')this.desktop.stop();};
    externalSignal?.addEventListener('abort',cancel,{once:true});
    if(externalSignal?.aborted)cancel();
    const signal=abort.signal;
    try{
      const intent=mode==='auto'?parseCommand(command,this.now()/1000):null;
      this.route=mode==='chat'?'chat':mode==='desktop'?'desktop':localKinds.has(intent.kind)?'local':question.test(command)?'chat':'desktop';
      if(this.route==='desktop'){
        if(signal.aborted)throw fail('ABORTED');
        // WindowsDesktop owns its own journal and its exact result contract.
        return await this.desktop.run({command,signal});
      }
      return await this.runOwned({command,intent,route:this.route,signal});
    }finally{
      externalSignal?.removeEventListener('abort',cancel);
      this.running=false;this.route=null;
      if(this.abort===abort)this.abort=null;
    }
  }
  async runOwned({command,intent,route,signal}){
    const started=performance.now();
    const report={mode:route==='local'?'LOCAL_ASSISTANT':'GEMINI_CHAT',command,goal:command,createdAt:new Date(this.now()).toISOString(),ok:false,reason:route==='local'?'local_rejected':'chat_failed',calls:[],trace:[],completed:[]};
    let journal;
    const gate=()=>{if(signal.aborted)throw fail('ABORTED');};
    const event=async(phase,data={})=>{
      const item=await journal.record(phase,data);
      report.trace.push(item);
      // UI progress is observational and must never turn a saved note into a failure.
      try{this.progress(item);}catch{}
      return item;
    };
    try{
      try{journal=await RunJournal.create(command,{directory:this.directory});}
      catch{throw fail('LOG_WRITE_FAILED');}
      this.activeRunId=journal.runId;report.runId=journal.runId;report.logPath=journal.jsonPath;
      gate();
      if(route==='local'){
        report.intent=intent;
        await event('local_intent',{intent,message:'Распознана точная локальная команда.'});
        // This awaited entry must exist before a persistent local mutation.
        await event('local_execute_request',{intent,message:intent.kind==='error'?'Проверяем корректность команды.':'Выполняем локальную команду.'});
        gate();
        const result=await executeIntent(intent,this.store);
        report.result=result;report.message=result.message;
        if(result.ok&&['note','reminder'].includes(intent.kind))report.completed.push({operation:intent.kind,id:result.id,outcome:'local_saved',evidence:'local_store_returned_id'});
        await event('local_execute_result',{result,message:result.message});
        gate();
        report.ok=result.ok===true;report.reason=report.ok?'local_completed':'local_rejected';
      }else{
        if(typeof this.chat!=='function')throw fail('CHAT_UNAVAILABLE');
        const call={kind:'chat',provider:'gemini',request:{text:command}};report.calls.push(call);
        await event('chat_request',{provider:'gemini',request:call.request,message:'Отправляем вопрос Gemini без инструментов управления.'});
        gate();
        const requestStart=performance.now();
        let answer;
        try{answer=await this.chat(command,{signal});}
        catch(error){call.latencyMs=Math.round(performance.now()-requestStart);call.error=signal.aborted?'ABORTED':safeCode(error?.code);throw error;}
        call.latencyMs=Math.round(performance.now()-requestStart);
        gate();
        if(typeof answer?.text!=='string'||!answer.text.trim()||answer.text.length>65536)throw fail('CHAT_INVALID_RESPONSE');
        const response={text:answer.text,...(typeof answer.model==='string'?{model:answer.model.slice(0,128)}:{})};
        call.response=response;
        await event('chat_response',{provider:'gemini',response,latencyMs:call.latencyMs,message:'Получен текстовый ответ Gemini.'});
        gate();
        report.ok=true;report.reason='chat_answer';report.message=response.text;
      }
    }catch(error){
      report.ok=false;
      report.reason=signal.aborted?'aborted':error?.code==='LOG_WRITE_FAILED'?'LOG_WRITE_FAILED':route==='local'?'local_rejected':'chat_failed';
      report.error=signal.aborted?'ABORTED':safeCode(error?.code);
      if(!report.message)report.message=report.reason==='aborted'?'Выполнение остановлено.':route==='local'?'Не удалось выполнить локальную команду.':'Не удалось получить ответ Gemini.';
      if(journal)try{await event('assistant_error',{code:report.error,reason:report.reason,message:report.message});}catch{report.reason='LOG_WRITE_FAILED';}
    }finally{
      report.elapsedMs=Math.round(performance.now()-started);
      if(journal){
        try{
          await event('result',{ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,message:report.message});
          report.events=journal.events;
          await journal.finish(report);
        }catch{report.ok=false;report.reason='LOG_WRITE_FAILED';report.events=journal.events;}
      }else report.events=[];
      this.activeRunId=null;
      Object.assign(report,redact(report));
    }
    return report;
  }
}
