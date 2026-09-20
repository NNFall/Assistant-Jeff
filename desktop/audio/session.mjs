import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {BatchVoiceController} from './batch-controller.mjs';
import {silenceDurationMs} from './utterance.mjs';
import {describeError,describeResult} from '../automation/feedback.mjs';

export const spokenResult=report=>describeResult(report).spoken;
const safeCode=error=>typeof error?.code==='string'&&/^[A-Z][A-Z0-9_]{1,79}$/.test(error.code)?error.code:'ASSISTANT_ERROR';

/** Final commands share truthful feedback; narration never starts microphone capture. */
export class VoiceSession {
  constructor({paths,encoder,gateway,denis,commands,getSettings,emit=()=>{},createWake,playbackTimeoutMs=120000,tailMs=350}){
    Object.assign(this,{paths,encoder,gateway,denis,commands,getSettings,emit,playbackTimeoutMs,tailMs});
    this.epoch=0;this.playback=null;
    this.batch=new BatchVoiceController({createWake,getSettings:()=>({...getSettings(),transcriptionMode:getSettings().transcriptionMode??'live',voiceBeep:getSettings().activationBeep,duckAudio:false}),
      encodeMp3:(pcm,options)=>encoder.encode(pcm,options),
      transcribe:async(mp3,options)=>{const result=await gateway.transcribe(mp3,options);if(!options.signal.aborted)this.voiceEvent({type:'transcription_metrics',model:result.model,latencyMs:result.latencyMs,bytes:mp3.length});return result;},
      createTranscriptionStream:options=>gateway.createTranscriptionStream(options),
      onTranscript:(text,options)=>this.transcript(text,options),onNotice:(code,options)=>this.notice(code,options),emit:event=>this.event(event)});
  }
  get state(){return this.typedTask?this.typedState:this.batch.state;}
  get busy(){return !!this.startingEpoch||!!this.typedTask||!['stopped','waiting','error'].includes(this.state);}
  voiceEvent(event){this.emit({...event,source:'voice'});}
  event(event){
    if(event.type==='wake')event={...event,activationSource:event.source};
    if(event.type==='status'&&event.state==='recording')this.utteranceStarted=true;
    this.voiceEvent(event);
    if(event.type==='status'&&event.state==='waiting'&&this.batch.config?.manual&&this.utteranceStarted){
      const generation=this.batch.generation;
      setTimeout(()=>{
        if(generation!==this.batch.generation||this.batch.state!=='waiting'||!this.batch.config?.manual||this.typedTask||this.commands.running)return;
        // The command and its narration are already complete. Release capture
        // without cancelling the executor's pending reminder clarification.
        // Explicit Stop still uses stop() below and cancels both lifecycles.
        this.utteranceStarted=false;
        void this.batch.stop();
      },0);
    }
  }
  async status(){
    const settings=this.getSettings();
    const [gemini,denis,encoder,wake]=await Promise.all([this.gateway.available(),this.denis.status(),this.encoder.available(),
      Promise.all(['melspectrogram.onnx','embedding_model.onnx','hey_jarvis_v0.1.onnx'].map(name=>access(path.join(this.paths.models,name)))).then(()=>true,()=>false)]);
    return {state:this.state,settings,providers:{gemini,live:gemini&&typeof this.gateway.createTranscriptionStream==='function',denis:denis.available,wake,encoder},silenceMs:silenceDurationMs(settings.silenceMs??settings.voiceSilenceMs)};
  }
  async start({mode='wake'}={}){
    if(!['wake','manual'].includes(mode))throw Object.assign(new Error(),{code:'VOICE_MODE_INVALID'});
    if(this.commands.running||this.busy)throw Object.assign(new Error(),{code:'TASK_ALREADY_RUNNING'});
    const epoch=++this.epoch;
    this.startingEpoch=epoch;
    try{
    const cancelled=()=>({ok:false,error:'ABORTED',code:'ABORTED',state:'stopped',message:'Включение микрофона отменено.'});
    const unavailable=code=>({ok:false,error:code,code,state:this.batch.state,message:describeError(code).message});
    const available=await this.status();
    if(epoch!==this.epoch)return cancelled();
    if(!available.settings.cloudEnabled)return unavailable('CLOUD_DISABLED');
    if(!available.providers.gemini)return unavailable('GEMINI_UNAVAILABLE');
    const live=available.settings.transcriptionMode!=='batch';
    if(live&&!available.providers.live)return unavailable('LIVE_TRANSCRIPTION_UNAVAILABLE');
    if(!live&&!available.providers.encoder)return unavailable('ENCODER_MISSING');
    this.utteranceStarted=false;
    await this.batch.start({...this.getSettings(),modelsDir:this.paths.models,manual:mode==='manual',silenceMs:available.silenceMs});
    if(epoch!==this.epoch)return cancelled();
    if(this.state==='error')return unavailable('WAKE_LOAD_FAILED');
    if(mode==='manual'&&!this.batch.activate())return unavailable('VOICE_BUSY');
    return {ok:true,...available,state:this.state};
    }finally{if(this.startingEpoch===epoch)this.startingEpoch=null;}
  }
  async stop(){
    this.epoch++;this.startingEpoch=null;const task=this.typedTask;this.typedTask=null;task?.abort.abort();this.commands.stop();this.playback?.finish();
    if(task)this.emit({type:'status',state:'stopped',message:task.report?'Озвучка остановлена. Результат остаётся на экране.':'Выполнение остановлено.',source:'typed',operationId:task.id});
    await this.batch.stop();return {ok:true,state:this.state};
  }
  activate(){return {ok:!this.typedTask&&this.batch.activate(),state:this.state};}
  finish(){void this.batch.finish();return {ok:true};}
  accept(pcm){return !this.typedTask&&this.batch.accept(pcm);}
  speechEnded({id}={}){if(id===this.playback?.id)this.playback.finish();return {ok:true};}
  async execute(command,signal,payload={}){
    const started=performance.now();
    try{return await this.commands.run({...payload,command,signal});}
    catch(error){
      const code=signal.aborted?'ABORTED':safeCode(error),feedback=describeError(code);
      return {ok:false,mode:'ASSISTANT',reason:signal.aborted?'aborted':code,error:code,command,
        message:feedback.message,elapsedMs:Math.round(performance.now()-started),completed:[],calls:[],trace:[],events:[]};
    }
  }
  /** IPC callers receive the original report; result events arrive before speech. */
  async runTyped(payload={}){
    if(this.busy||this.commands.running)throw Object.assign(new Error(),{code:'TASK_ALREADY_RUNNING'});
    const task={id:randomUUID(),abort:new AbortController()};this.typedTask=task;this.typedState='processing';
    const context={signal:task.abort.signal,source:'typed',operationId:task.id};
    try{
      // A typed task may suspend an already enabled wake session, never enable one.
      if(this.batch.state==='waiting')await this.batch.stop();
      if(context.signal.aborted)return {ok:false,reason:'aborted',command:payload.command};
      this.emit({type:'status',state:'processing',message:'Выполняю команду.',source:'typed',operationId:task.id});
      const report=await this.execute(payload.command,context.signal,payload);
      if(context.signal.aborted)return {...report,ok:false,reason:'aborted'};
      task.report=report;
      this.emit({type:'result',report,source:'typed',operationId:task.id});
      await this.narrate(spokenResult(report),context);
      return report;
    }finally{
      if(this.typedTask===task){this.typedTask=null;this.typedState=null;this.emit({type:'status',state:'stopped',message:'Готов к задаче.',source:'typed',operationId:task.id});}
    }
  }
  async transcript(text,{signal,autoExecute}){
    if(!autoExecute||signal.aborted)return;
    const operationId=randomUUID();
    this.voiceEvent({type:'status',state:'processing',message:'Выполняю окончательную команду.',operationId});
    const executed=await this.execute(text,signal);
    const report=signal.aborted?{...executed,ok:false,reason:'aborted',error:'ABORTED'}:executed;
    // Stop cancels effects and speech, but the UI still needs the executor's
    // final receipt to close the active task and show any partial effects.
    this.voiceEvent({type:'result',report,operationId});
    await this.narrate(spokenResult(report),{signal,source:'voice',operationId});
  }
  async notice(code,{signal}={}){
    if(signal?.aborted)return;
    const feedback=describeError(code);
    this.voiceEvent({type:'voice_notice',code,...feedback});
    await this.narrate(feedback.spoken,{signal,source:'voice'});
  }
  async narrate(text,{signal,source,operationId}){
    if(signal?.aborted||!this.getSettings().denisReply||!text)return;
    const send=event=>this.emit({...event,source,...(operationId?{operationId}:{})});
    if(source==='typed')this.typedState='speaking';
    send({type:'status',state:'speaking',message:'Ответ голосом Денис.'});
    try{
      const audio=await this.denis.synthesize(text,{signal});
      if(signal?.aborted)return;
      await new Promise(resolve=>{
        const id=randomUUID();
        const finish=()=>{clearTimeout(timer);signal?.removeEventListener('abort',finish);if(this.playback?.id===id)this.playback=null;resolve();};
        const timer=setTimeout(()=>{finish();void this.stop();},Math.min(this.playbackTimeoutMs,Math.max(5000,audio.durationMs+10000)));
        this.playback={id,finish};signal?.addEventListener('abort',finish,{once:true});
        send({type:'speech',id,wav:new Uint8Array(audio.wav),mimeType:audio.mimeType});
        if(signal?.aborted)finish();
      });
      if(!signal?.aborted&&this.tailMs>0)await new Promise(resolve=>setTimeout(resolve,this.tailMs));
    }catch{
      if(!signal?.aborted)send({type:'speech_warning',message:'Голосовой ответ недоступен. Результат показан текстом.'});
    }
  }
}
