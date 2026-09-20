const VOLUME_TOLERANCE_PERCENT=0.05;
const failure=code=>Object.assign(new Error(code),{code});
const safeCode=value=>typeof value==='string'&&/^[A-Z_]{1,64}$/.test(value)?value:'SYSTEM_TOOL_FAILED';
const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exactKeys=(value,keys)=>plain(value)&&Object.keys(value).length===keys.length&&keys.every(key=>Object.hasOwn(value,key));
const percent=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0&&value<=100;
const checkAbort=signal=>{if(signal?.aborted)throw failure('ABORTED');};
const display=value=>Number(value.toFixed(2)).toLocaleString('ru-RU');

function volumeState(value){
  if(!exactKeys(value,['percent','muted','endpointId'])||!percent(value.percent)||typeof value.muted!=='boolean'||!/^audio_[a-f0-9]{24}$/.test(value.endpointId))throw failure('SYSTEM_TOOL_INVALID_RESPONSE');
  return {percent:value.percent,muted:value.muted,endpointId:value.endpointId};
}

function volumeReceipt(raw,intent){
  const setting=intent.kind==='volume',operation=setting?'volume_set':'volume_get';
  if(!plain(raw)||raw.operation!==operation||raw.provider!=='windows_coreaudio'||raw.endpointRole!=='multimedia'||
    typeof raw.verified!=='boolean'||typeof raw.effectAttempted!=='boolean'||
    raw.requestedPercent!==(setting?intent.percent:null)||
    !['volume_read','volume_level_verified','volume_level_not_verified','default_endpoint_changed','effect_outcome_unknown'].includes(raw.evidence))throw failure('SYSTEM_TOOL_INVALID_RESPONSE');
  const before=volumeState(raw.before),after=raw.after===null?null:volumeState(raw.after);
  const levelMatches=after!==null&&before.endpointId===after.endpointId&&Math.abs(after.percent-(setting?intent.percent:before.percent))<=VOLUME_TOLERANCE_PERCENT;
  const verified=raw.verified&&levelMatches&&raw.evidence===(setting?'volume_level_verified':'volume_read')&&raw.effectAttempted===setting;
  const message=verified
    ?`${setting?'Громкость установлена:':'Текущая громкость:'} ${display(after.percent)}%.${after.muted?' Звук остаётся выключен.':''}`
    :raw.evidence==='default_endpoint_changed'?'Устройство вывода звука изменилось. Громкость не подтверждена.'
    :'Не удалось подтвердить громкость. Повторная установка не выполнялась.';
  return {ok:verified,kind:intent.kind,operation,status:verified?'goal_verified':'unverified',verified,
    effectAttempted:raw.effectAttempted,before,after,requestedPercent:raw.requestedPercent,evidence:raw.evidence,message,
    ...(typeof raw.stage==='string'&&/^[a-z_]{1,64}$/.test(raw.stage)?{stage:raw.stage}:{}),
    ...(typeof raw.providerCode==='string'&&/^0x[A-Fa-f0-9]{8}$/.test(raw.providerCode)?{providerCode:raw.providerCode}:{})};
}

/** Fixed tools only. Call once for a final, validated semantic intent. */
export async function executeSystemTool(intent,{bridge,minimizeAssistant,signal}={}){
  let effectAttempted=false,operation=null;
  try{
    checkAbort(signal);
    if(!plain(intent)||!['volume','get_system_volume','self_minimize'].includes(intent.kind))throw failure('SYSTEM_TOOL_DENIED');
    if(!exactKeys(intent,intent.kind==='volume'?['kind','percent']:['kind']))throw failure('INVALID_SYSTEM_INTENT');
    if(intent.kind==='volume'&&!percent(intent.percent))throw failure('INVALID_VOLUME_PERCENT');
    if(intent.kind==='self_minimize'){
      operation='self_minimize';
      if(typeof minimizeAssistant!=='function')throw failure('SELF_MINIMIZE_UNAVAILABLE');
      checkAbort(signal);effectAttempted=true;
      const raw=await minimizeAssistant({signal});
      if(!plain(raw)||typeof raw.verified!=='boolean'||typeof raw.effectAttempted!=='boolean'||
        !exactKeys(raw.before,['minimized'])||!exactKeys(raw.after,['minimized'])||
        typeof raw.before.minimized!=='boolean'||typeof raw.after.minimized!=='boolean')throw failure('SYSTEM_TOOL_INVALID_RESPONSE');
      const verified=raw.verified&&raw.after.minimized===true;
      return {ok:verified,kind:intent.kind,operation,status:verified?'goal_verified':'unverified',verified,effectAttempted:raw.effectAttempted,
        before:{minimized:raw.before.minimized},after:{minimized:raw.after.minimized},evidence:verified?'assistant_minimized':'not_verified',
        message:verified?'Окно помощника свёрнуто.':'Не удалось подтвердить сворачивание помощника.'};
    }
    operation=intent.kind==='volume'?'volume_set':'volume_get';
    if(typeof bridge?.request!=='function')throw failure('SYSTEM_TOOL_UNAVAILABLE');
    checkAbort(signal);effectAttempted=intent.kind==='volume';
    const raw=await bridge.request(operation,intent.kind==='volume'?{percent:intent.percent}:{},signal);
    // A verified receipt already obtained remains evidence even if Stop arrived
    // immediately afterwards. Abort or timeout during the request never retries it.
    return volumeReceipt(raw,intent);
  }catch(error){
    if(typeof error?.details?.effectAttempted==='boolean')effectAttempted=error.details.effectAttempted;
    const code=safeCode(error?.code),aborted=code==='ABORTED'||signal?.aborted;
    return {ok:false,kind:plain(intent)&&['volume','get_system_volume','self_minimize'].includes(intent.kind)?intent.kind:null,operation,
      status:aborted?'aborted':'failed',verified:false,effectAttempted,before:null,after:null,error:code,
      evidence:effectAttempted?'effect_outcome_unknown':'not_executed',
      message:effectAttempted?'Результат системной команды неизвестен. Повторное действие не выполнялось.'
        :aborted?'Выполнение остановлено.':'Не удалось выполнить системную команду.'};
  }
}

export function createSystemTools({bridge,minimizeAssistant}={}){
  return {executeSystemTool:(intent,{signal}={})=>executeSystemTool(intent,{bridge,minimizeAssistant,signal})};
}
