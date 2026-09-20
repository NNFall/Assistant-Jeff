import {randomUUID} from 'node:crypto';
import {access} from 'node:fs/promises';
import path from 'node:path';
import {BatchVoiceController} from './batch-controller.mjs';

export function spokenResult(report){
  if(report.message&&(report.ok||['local_rejected','chat_failed'].includes(report.reason)))return String(report.message).slice(0,2000);
  if(report.ok&&report.reason==='goal_observed')return 'Интерфейс изменился согласно задаче. Проверьте результат в приложении.';
  if(report.ok)return 'Готово. Задача выполнена.';
  if(report.reason==='low_confidence')return 'Я не уверен в следующем действии. Посмотрите решение в журнале.';
  if(report.reason==='unsupported')return 'Не нашёл подходящего действия среди доступных элементов. Подробности в журнале.';
  if(report.reason==='aborted')return 'Выполнение остановлено.';
  if(report.completed?.some(step=>step.operation!=='inspect'))return 'Часть действий выполнена, но завершение задачи не подтверждено. Посмотрите журнал.';
  return 'Не удалось подтвердить выполнение задачи. Посмотрите журнал.';
}

/** Connects final transcription, the shared executor and local speech playback. */
export class VoiceSession {
  constructor({paths,encoder,gateway,denis,commands,getSettings,emit=()=>{},createWake,playbackTimeoutMs=120000,tailMs=350}){
    Object.assign(this,{paths,encoder,gateway,denis,commands,getSettings,emit,playbackTimeoutMs,tailMs});
    this.epoch=0;
    this.batch=new BatchVoiceController({createWake,getSettings:()=>({...getSettings(),voiceBeep:getSettings().activationBeep,duckAudio:false}),
      encodeMp3:(pcm,options)=>encoder.encode(pcm,options),
      transcribe:async(mp3,options)=>{const result=await gateway.transcribe(mp3,options);if(!options.signal.aborted)emit({type:'transcription_metrics',model:result.model,latencyMs:result.latencyMs,bytes:mp3.length});return result;},
      onTranscript:(text,options)=>this.transcript(text,options),emit:event=>this.event(event)});
  }
  get state(){return this.batch.state;}
  get busy(){return !['stopped','waiting','error'].includes(this.state);}
  event(event){
    if(event.type==='status'&&event.state==='recording')this.utteranceStarted=true;
    this.emit(event);
    if(event.type==='status'&&event.state==='waiting'&&this.batch.config?.manual&&this.utteranceStarted){
      const generation=this.batch.generation;
      setTimeout(()=>{if(generation===this.batch.generation)void this.stop();},0);
    }
  }
  async status(){
    const [gemini,denis,encoder,wake]=await Promise.all([this.gateway.available(),this.denis.status(),this.encoder.available(),
      Promise.all(['melspectrogram.onnx','embedding_model.onnx','hey_jarvis_v0.1.onnx'].map(name=>access(path.join(this.paths.models,name)))).then(()=>true,()=>false)]);
    return {state:this.state,settings:this.getSettings(),providers:{gemini,denis:denis.available,wake,encoder},silenceMs:2500};
  }
  async start({mode='wake'}={}){
    if(!['wake','manual'].includes(mode))throw Object.assign(new Error(),{code:'VOICE_MODE_INVALID'});
    if(this.commands.running)throw Object.assign(new Error(),{code:'TASK_ALREADY_RUNNING'});
    const epoch=++this.epoch;
    const cancelled=()=>({ok:false,state:'stopped',message:'Включение микрофона отменено.'});
    const available=await this.status();
    if(epoch!==this.epoch)return cancelled();
    if(!available.providers.gemini||!available.providers.encoder||!available.settings.cloudEnabled)return {ok:false,message:'Не настроен Gemini или локальный MP3-кодировщик.'};
    this.utteranceStarted=false;
    await this.batch.start({...this.getSettings(),modelsDir:this.paths.models,manual:mode==='manual',silenceMs:2500});
    if(epoch!==this.epoch)return cancelled();
    if(this.state==='error')return {ok:false,message:'Не удалось загрузить распознавание имени.'};
    if(mode==='manual')this.batch.activate();
    return {ok:true,...available,state:this.state};
  }
  async stop(){this.epoch++;this.commands.stop();this.playback?.finish();await this.batch.stop();return {ok:true,state:this.state};}
  activate(){return {ok:this.batch.activate(),state:this.state};}
  finish(){void this.batch.finish();return {ok:true};}
  accept(pcm){return this.batch.accept(pcm);}
  speechEnded({id}={}){if(id===this.playback?.id)this.playback.finish();return {ok:true};}
  async transcript(text,{signal,autoExecute}){
    if(!autoExecute)return;
    signal.throwIfAborted();
    this.emit({type:'status',state:'processing',message:'Выполняю окончательную команду.'});
    const report=await this.commands.run({command:text,signal});
    this.emit({type:'result',report});
    if(signal.aborted||!this.getSettings().denisReply)return;
    this.emit({type:'status',state:'speaking',message:'Ответ голосом Денис.'});
    try{
      const audio=await this.denis.synthesize(spokenResult(report),{signal});
      signal.throwIfAborted();
      await new Promise(resolve=>{
        const id=randomUUID();
        const finish=()=>{clearTimeout(timer);signal.removeEventListener('abort',finish);if(this.playback?.id===id)this.playback=null;resolve();};
        const timer=setTimeout(()=>{finish();void this.stop();},Math.min(this.playbackTimeoutMs,Math.max(5000,audio.durationMs+10000)));
        this.playback={id,finish};signal.addEventListener('abort',finish,{once:true});
        this.emit({type:'speech',id,wav:new Uint8Array(audio.wav),mimeType:audio.mimeType});
        if(signal.aborted)finish();
      });
      if(!signal.aborted)await new Promise(resolve=>setTimeout(resolve,this.tailMs));
    }catch{
      if(!signal.aborted)this.emit({type:'speech_warning',message:'Команда обработана, но голосовой ответ недоступен. Результат показан текстом.'});
    }
  }
}
