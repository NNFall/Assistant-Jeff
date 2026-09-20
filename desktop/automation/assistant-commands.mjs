import {parseCommand,executeIntent} from '../core/commands.mjs';
import {buildTimeCandidates,parseReminderTimeFollowup} from '../core/natural-command.mjs';
import {RunJournal,redact} from '../../scripts/desktop-lab/journal.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const validCommand=value=>typeof value==='string'&&value.trim().length>0&&value.length<=1024&&!/[\x00-\x08\x0b\x0c\x0e-\x1f]/u.test(value);
const localKinds=new Set(['note','reminder','help','error']);
const question=/^\s*(?:расскажи|объясни|вопрос\s*:)/iu;
const safeCode=value=>typeof value==='string'&&/^[A-Z_]{1,64}$/.test(value)?value:'ASSISTANT_ERROR';
const REMINDER_CLARIFICATION_TTL_MS=120000;
const reminderDays=new Set(['сегодня','завтра','послезавтра']);

/** Routes one final command. Questions never receive desktop tools or history. */
export class UnifiedCommands {
  constructor({desktop,store,chat,interpret,executeSystem,progress=()=>{},directory,now=Date.now}={}){
    if(typeof desktop?.run!=='function')throw new TypeError('desktop.run is required');
    Object.assign(this,{desktop,store,chat,interpret,executeSystem,progress,directory:directory??desktop.logDirectory,now});
    this.running=false;this.pendingReminderTime=null;
  }
  stop(){
    this.pendingReminderTime=null;
    this.abort?.abort('user_stop');
    this.desktop.stop();
    return {stopped:true};
  }
  async run({command,mode='auto',signal:externalSignal}={}){
    if(this.running)throw fail('TASK_ALREADY_RUNNING');
    if(!validCommand(command))throw fail('INVALID_COMMAND');
    if(!['auto','desktop','chat'].includes(mode))throw fail('INVALID_COMMAND_MODE');
    command=command.trim();
    // Context is one-shot and session-local. Unrelated requests cannot inherit it.
    const pending=this.pendingReminderTime;this.pendingReminderTime=null;
    const requestedAt=this.now();
    const clock=mode==='auto'&&typeof this.interpret==='function'&&pending&&requestedAt>=pending.createdAt&&requestedAt<pending.expiresAt?parseReminderTimeFollowup(command):null;
    this.running=true;
    const abort=new AbortController();this.abort=abort;
    const cancel=()=>{this.pendingReminderTime=null;abort.abort('user_stop');if(this.route==='desktop')this.desktop.stop();};
    externalSignal?.addEventListener('abort',cancel,{once:true});
    if(externalSignal?.aborted)cancel();
    const signal=abort.signal;
    try{
      if(clock){
        this.route='local';
        return await this.runOwned({command,intent:null,route:'followup',signal,followup:{pending,clock}});
      }
      // Production injects Jev. The deterministic path remains for offline/legacy callers.
      if(mode==='auto'&&typeof this.interpret==='function'){
        this.route='semantic';
        return await this.runOwned({command,intent:null,route:'semantic',signal});
      }
      const intent=mode==='auto'?parseCommand(command,this.now()/1000):null;
      this.route=mode==='chat'?'chat':mode==='desktop'?'desktop':localKinds.has(intent.kind)?'local':question.test(command)?'chat':'desktop';
      if(this.route==='desktop'){
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
  async runOwned({command,intent,route,signal,followup}){
    const started=performance.now(),requestTime=this.now();
    const report={mode:['semantic','followup'].includes(route)?'SEMANTIC_ASSISTANT':route==='local'?'LOCAL_ASSISTANT':'GEMINI_CHAT',command,goal:command,createdAt:new Date(requestTime).toISOString(),ok:false,reason:route==='semantic'?'intent_failed':['local','followup'].includes(route)?'local_rejected':'chat_failed',calls:[],trace:[],completed:[]};
    let journal,pendingToSet;
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
      if(route==='followup'){
        route='local';
        const {pending,clock}=followup;
        const current=this.now(),day=clock.day??pending.day;
        const source={originalRequest:pending.originalRequest,followupRequest:command,originalRunId:pending.originalRunId,day,timeExpression:`${day} в ${clock.clock}`,text:pending.text};
        await event('clarification_followup',{...source,message:'Уточняем время предыдущего напоминания.'});
        gate();
        if(current<pending.createdAt||current>=pending.expiresAt)throw fail('REMINDER_CONTEXT_EXPIRED');
        // A bare clock keeps the original requested calendar day even across midnight.
        // A newly stated day is evaluated relative to this explicit follow-up.
        const candidates=buildTimeCandidates(source.timeExpression,clock.day?current:pending.referenceTime),time=candidates.length===1?candidates[0]:null;
        if(!time||time.error||!Number.isFinite(time.dueAt)||time.dueAt<=current/1000){
          report.reason='clarification_required';report.needsClarification=true;report.message=`${time?.error??'Укажите будущее время в формате ЧЧ:ММ.'} Повторите напоминание с нужным временем.`;
          await event('clarification_required',{message:report.message});
          gate();
          return report;
        }
        report.clarificationResolution={...source,dueAt:time.dueAt};
        intent={kind:'reminder',text:pending.text,dueAt:time.dueAt,message:'Напоминание установлено.'};
        report.routing={route:'reminder',origin:'pending_time_clarification',intent};
        await event('clarification_resolved',{...report.clarificationResolution,message:'Время напоминания уточнено.'});
        gate();
      }
      if(route==='semantic'){
        await event('intent_start',{message:'Jev определяет смысл запроса.'});
        const interpreted=await this.interpret(command,{signal,now:requestTime,onEvent:async item=>{
          gate();
          if(!item||!['intent_request','intent_response','intent_error'].includes(item.phase))throw fail('ASSISTANT_INTENT_RESPONSE');
          const {phase,...data}=item;
          if(phase==='intent_request')report.calls.push({kind:item.kind,provider:'typesafe',callIndex:item.callIndex,request:item.request});
          else{
            const call=report.calls.find(value=>value.provider==='typesafe'&&value.callIndex===item.callIndex);
            if(call)Object.assign(call,{latencyMs:item.latencyMs,...(item.response?{response:item.response}:{}),...(item.error?{error:item.error}:{})});
          }
          await event(phase,{...data,message:phase==='intent_request'?'Отправляем запрос Jev.':phase==='intent_response'?'Получено решение Jev.':'Не удалось получить решение Jev.'});
        }});
        gate();
        if(!interpreted||!['note','reminder','desktop','chat','no_request','system_volume','self_minimize'].includes(interpreted.route))throw fail('ASSISTANT_INTENT_RESPONSE');
        report.routing=interpreted;
        await event('intent_decision',{decision:interpreted,message:interpreted.message??'Смысл запроса определён.'});
        gate();
        if(interpreted.needsClarification){
          report.reason='clarification_required';report.needsClarification=true;report.message=interpreted.message;report.clarification=interpreted.clarification;
          await event('clarification_required',{message:report.message,clarification:report.clarification});
          gate();
          const details=interpreted.clarification;
          if(interpreted.route==='reminder'&&details?.field==='time'&&reminderDays.has(details.day)&&typeof details.text==='string'&&details.text.trim()&&command.includes(details.text)){
            const createdAt=this.now();
            pendingToSet={originalRequest:command,originalRunId:report.runId,text:details.text,day:details.day,referenceTime:requestTime,createdAt,expiresAt:createdAt+REMINDER_CLARIFICATION_TTL_MS};
          }
          return report;
        }
        if(interpreted.route==='no_request'){
          report.reason='no_request';report.message=interpreted.message??'Уточните, что нужно сделать.';
          return report;
        }
        if(interpreted.route==='desktop'){
          const scope=interpreted.desktopScope;
          if(scope&&(!['activate','minimize','maximize','restore','close'].includes(scope.operation)||Object.keys(scope).length!==1))throw fail('ASSISTANT_INTENT_RESPONSE');
          this.route='desktop';route='desktop';
          await event('desktop_delegate_request',{scope,message:'Передаём запрос управлению рабочим столом.'});
          gate();
          const child=await this.desktop.run({command,signal,...(scope?{scope}:{})});
          if(!child||typeof child.ok!=='boolean')throw fail('DESKTOP_INVALID_RESPONSE');
          report.childRunId=child.runId;report.childLogPath=child.logPath;
          // Preserve the desktop controller's evidence and success semantics, while the
          // parent journal owns the semantic decisions that preceded all OS effects.
          for(const [key,value] of Object.entries(child))if(!['runId','logPath','calls','trace','events','createdAt','elapsedMs','command','goal','mode'].includes(key))report[key]=value;
          report.desktopEvents=child.events??[];
          report.calls.push(...(child.calls??[]).map(call=>({...call,childRunId:child.runId})));
          await event('desktop_delegate_result',{childRunId:child.runId,ok:child.ok,reason:child.reason,executionUncertain:child.executionUncertain,message:child.message});
          return report;
        }
        if(['system_volume','self_minimize'].includes(interpreted.route)){
          route='system';this.route=route;intent=interpreted.intent;
          const valid=intent&&((interpreted.route==='self_minimize'&&intent.kind==='self_minimize'&&Object.keys(intent).length===1)||(interpreted.route==='system_volume'&&intent.kind==='volume'&&Object.keys(intent).length===2&&typeof intent.percent==='number'&&Number.isFinite(intent.percent)&&intent.percent>=0&&intent.percent<=100));
          if(!valid)throw fail('ASSISTANT_INTENT_RESPONSE');
          if(typeof this.executeSystem!=='function')throw fail('SYSTEM_TOOL_UNAVAILABLE');
          report.intent=intent;
          await event('system_execute_request',{intent,message:'Выполняем системную команду.'});
          gate();
          const result=await this.executeSystem(intent,{signal});
          report.result=result;report.message=result?.message??'Не удалось выполнить системную команду.';
          report.ok=result?.ok===true&&result?.verified===true;
          report.reason=report.ok?'system_completed':'system_failed';
          if(result?.effectAttempted&&!report.ok)report.executionUncertain=true;
          if(report.ok)report.completed.push({operation:intent.kind,outcome:'verified',evidence:result.evidence});
          await event('system_execute_result',{result,message:report.message});
          gate();
          return report;
        }
        route=interpreted.route==='chat'?'chat':'local';this.route=route;
        intent=interpreted.intent;
        if(route==='local'&&(!intent||intent.kind!==interpreted.route))throw fail('ASSISTANT_INTENT_RESPONSE');
      }
      if(route==='local'){
        report.intent=intent;
        await event('local_intent',{intent,message:report.routing?'Jev распознал локальную команду.':'Распознана точная локальная команда.'});
        // This awaited entry must exist before a persistent local mutation.
        await event('local_execute_request',{intent,...(report.clarificationResolution?{clarificationResolution:report.clarificationResolution}:{}),message:intent.kind==='error'?'Проверяем корректность команды.':'Выполняем локальную команду.'});
        gate();
        if(followup&&(this.now()<followup.pending.createdAt||this.now()>=followup.pending.expiresAt))throw fail('REMINDER_CONTEXT_EXPIRED');
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
      report.reason=signal.aborted?'aborted':error?.code==='LOG_WRITE_FAILED'?'LOG_WRITE_FAILED':route==='local'?'local_rejected':route==='semantic'?'intent_failed':route==='system'?'system_failed':route==='desktop'?'desktop_failed':'chat_failed';
      report.error=signal.aborted?'ABORTED':safeCode(error?.code);
      if(!report.message)report.message=report.reason==='aborted'?'Выполнение остановлено.':route==='local'?'Не удалось выполнить локальную команду.':route==='semantic'?'Не удалось определить смысл запроса.':route==='system'?'Не удалось выполнить системную команду.':route==='desktop'?'Не удалось выполнить действие на рабочем столе.':'Не удалось получить ответ Gemini.';
      if(journal)try{await event('assistant_error',{code:report.error,reason:report.reason,message:report.message});}catch{report.reason='LOG_WRITE_FAILED';}
    }finally{
      report.elapsedMs=Math.round(performance.now()-started);
      if(journal){
        try{
          await event('result',{ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,message:report.message});
          report.events=journal.events;
          await journal.finish(report);
          if(pendingToSet&&report.reason==='clarification_required'&&!signal.aborted&&this.now()<pendingToSet.expiresAt)this.pendingReminderTime=pendingToSet;
        }catch{report.ok=false;report.reason='LOG_WRITE_FAILED';report.events=journal.events;}
      }else report.events=[];
      this.activeRunId=null;
      Object.assign(report,redact(report));
    }
    return report;
  }
}
