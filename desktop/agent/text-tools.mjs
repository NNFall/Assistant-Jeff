import {createHash} from 'node:crypto';

const plain=value=>value!==null&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
const exact=(value,allowed,required=[])=>plain(value)&&Object.keys(value).every(key=>allowed.includes(key))&&required.every(key=>Object.hasOwn(value,key));
const validId=value=>typeof value==='string'&&/^[A-Za-z][A-Za-z0-9_-]{0,127}$/u.test(value);
const validVersion=value=>typeof value==='string'&&/^[a-f0-9]{16,128}$/iu.test(value);
const secretToken=/(?:apikey_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+)/iu;
const blockedPayload=/^\s*(?:javascript:|data:|file:)/iu;
const preEffectCodes=new Set(['INVALID_ARGUMENT','INVALID_TEXT_PAYLOAD','TEXT_WINDOW_NOT_OBSERVED','TEXT_WINDOW_UNAVAILABLE','STALE_TEXT_SNAPSHOT','TEXT_TARGET_NOT_OBSERVED','TEXT_TARGET_IDENTITY_CHANGED','TEXT_TARGET_UNAVAILABLE','TEXT_TARGET_READ_ONLY','TEXT_TARGET_SENSITIVE','TEXT_VALUE_CHANGED']);
const fail=(code,details={})=>Object.assign(new Error(code),{code,details});
const gate=signal=>{if(signal?.aborted)throw fail('ABORTED',{effectAttempted:false});};
const boundedText=value=>{
  if(typeof value!=='string'||value.length>2000||blockedPayload.test(value))throw fail('INVALID_TEXT_PAYLOAD',{effectAttempted:false});
  for(let index=0;index<value.length;index++){
    const code=value.charCodeAt(index);
    if((code<0x20||code===0x7f)&&code!==0x09&&code!==0x0a&&code!==0x0d)throw fail('INVALID_TEXT_PAYLOAD',{effectAttempted:false});
    if(code>=0xd800&&code<=0xdbff){const low=value.charCodeAt(++index);if(!(low>=0xdc00&&low<=0xdfff))throw fail('INVALID_TEXT_PAYLOAD',{effectAttempted:false});}
    else if(code>=0xdc00&&code<=0xdfff)throw fail('INVALID_TEXT_PAYLOAD',{effectAttempted:false});
  }
  return value;
};
const hashText=value=>createHash('sha256').update(value,'utf8').digest('hex');
const publicReceipt=(receipt)=>({operation:receipt.operation,targetId:receipt.targetId,verified:receipt.verified,effectAttempted:receipt.effectAttempted,evidence:receipt.evidence,expectedVersion:receipt.expectedVersion,textLength:receipt.textLength,valueHash:receipt.valueHash});
const resultFailure=(error,{effectAttempted=false,status=effectAttempted?'execution_uncertain':'failed',data}={})=>({
  ok:false,verified:false,effectAttempted,status,error:typeof error==='string'?error:(error?.code??'WINDOWS_TEXT_TOOL_FAILED'),
  message:effectAttempted?'Текст мог измениться. Проверьте приложение перед повтором.':status==='stale'?'Состояние текстового поля изменилось. Нужно заново прочитать поля.':error?.code==='ABORTED'?'Выполнение остановлено.':'Не удалось прочитать или заменить текст.',
  ...(data?{data}:{}),
});

function validateSnapshot(snapshot,windowId){
  if(!plain(snapshot)||!validVersion(snapshot.version)||snapshot.windowId!==windowId||!Array.isArray(snapshot.fields)||!plain(snapshot.coverage))throw fail('WINDOWS_TEXT_INVALID_SNAPSHOT');
  const fields=[];const ids=new Set();
  for(const field of snapshot.fields){
    if(!plain(field)||!validId(field.id)||ids.has(field.id)||typeof field.label!=='string'||field.label.length>500||typeof field.value!=='string'||field.value.length>2000||field.truncated!==undefined&&typeof field.truncated!=='boolean'||secretToken.test(field.label)||secretToken.test(field.value))throw fail('WINDOWS_TEXT_INVALID_SNAPSHOT');
    ids.add(field.id);fields.push(field);
  }
  return {version:snapshot.version,windowId:snapshot.windowId,fields,coverage:snapshot.coverage};
}

/** Text fields use the native helper's own UIA snapshot and target-token map. */
export function createTextTools({desktop}={}){
  if(typeof desktop?.bridge?.request!=='function')throw new TypeError('desktop.bridge.request is required');
  let current=null,busy=false,uncertain=false;
  const guarded=fn=>async(args={},options={})=>{
    if(busy)return resultFailure('WINDOWS_TEXT_TOOL_BUSY');
    if(uncertain)return resultFailure('WINDOWS_OUTCOME_UNKNOWN',{effectAttempted:true});
    busy=true;
    try{const signal=options.signal??new AbortController().signal;gate(signal);return await fn(args,{...options,signal});}
    catch(error){
      const attempted=error?.details&&typeof error.details.effectAttempted==='boolean'?error.details.effectAttempted:false;
      return resultFailure(error,{effectAttempted:attempted,status:attempted?'execution_uncertain':error?.code==='STALE_TEXT_SNAPSHOT'?'stale':'failed'});
    }finally{busy=false;}
  };
  const read=guarded(async(args,{signal})=>{
    if(!exact(args,['windowId'],['windowId'])||!validId(args.windowId))throw fail('INVALID_TOOL_ARGUMENTS',{effectAttempted:false});
    const observed=desktop.lastSnapshot;
    if(!plain(observed)||!Array.isArray(observed.windows)||!observed.windows.some(window=>plain(window)&&window.id===args.windowId))return resultFailure('WINDOWS_OBSERVATION_REQUIRED');
    let snapshot;
    try{snapshot=validateSnapshot(await desktop.bridge.request('text_observe',{windowId:args.windowId},signal),args.windowId);gate(signal);}
    catch(error){return resultFailure(error,{effectAttempted:false,status:error?.code==='TEXT_WINDOW_NOT_OBSERVED'?'stale':'failed'});}
    current={snapshot,fields:new Map(snapshot.fields.map(field=>[field.id,field]))};
    return {ok:true,verified:true,effectAttempted:false,status:'observed',evidence:'text_fields_observed',message:'Прочитаны доступные текстовые поля.',data:snapshot};
  });
  const replace=guarded(async(args,{signal})=>{
    if(!exact(args,['snapshotVersion','fieldId','text'],['snapshotVersion','fieldId','text'])||!validVersion(args.snapshotVersion)||!validId(args.fieldId))throw fail('INVALID_TOOL_ARGUMENTS',{effectAttempted:false});
    const text=boundedText(args.text);
    if(!current||current.snapshot.version!==args.snapshotVersion)return resultFailure('STALE_TEXT_SNAPSHOT',{status:'stale'});
    const field=current.fields.get(args.fieldId);if(!field)return resultFailure('TEXT_TARGET_NOT_OBSERVED');
    let receipt;
    // A native verified receipt remains valid if cancellation arrives after the
    // one allowed mutation and readback have already completed.
    try{receipt=await desktop.bridge.request('text_replace',{targetId:args.fieldId,expectedVersion:args.snapshotVersion,text},signal);}
    catch(error){
      const attempted=error?.details&&typeof error.details.effectAttempted==='boolean'?error.details.effectAttempted:!preEffectCodes.has(error?.code);
      if(attempted)uncertain=true;
      return resultFailure(error,{effectAttempted:attempted,status:attempted?'execution_uncertain':error?.code==='STALE_TEXT_SNAPSHOT'?'stale':'failed'});
    }
    const expectedHash=hashText(text);
    const valid=plain(receipt)&&receipt.operation==='text_replace'&&receipt.targetId===args.fieldId&&receipt.expectedVersion===args.snapshotVersion&&receipt.verified===true&&receipt.effectAttempted===true&&receipt.evidence==='text_value_verified'&&receipt.textLength===text.length&&receipt.valueHash===expectedHash;
    if(!valid){uncertain=true;return resultFailure('WINDOWS_TEXT_INVALID_RECEIPT',{effectAttempted:true,status:'execution_uncertain',data:{receipt:plain(receipt)?publicReceipt(receipt):null}});}
    current=null;
    return {ok:true,verified:true,effectAttempted:true,status:'completed',evidence:'text_value_verified',message:'Текст заменён и точно прочитан обратно.',data:{fieldId:args.fieldId,snapshotVersion:args.snapshotVersion,receipt:publicReceipt(receipt)}};
  });
  return [
    {name:'windows_text_fields',title:'Прочитать текстовые поля',description:'Read bounded non-secret editable ValuePattern fields from one window ID returned by windows_observe. No focus change, keystrokes, URLs with executable schemes, terminals or developer consoles.',parameters:{type:'object',properties:{windowId:{type:'string'}},required:['windowId'],additionalProperties:false},effect:false,execute:read},
    {name:'windows_text_replace',title:'Заменить текст в поле',description:'Replace the entire value of one field from the latest windows_text_fields result. Uses UI Automation ValuePattern.SetValue with the supplied literal, including newline and tab; never presses Enter or sends keys.',parameters:{type:'object',properties:{snapshotVersion:{type:'string'},fieldId:{type:'string'},text:{type:'string',maxLength:2000}},required:['snapshotVersion','fieldId','text'],additionalProperties:false},effect:true,execute:replace},
  ];
}
