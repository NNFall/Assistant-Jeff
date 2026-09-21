import {createWindowsTools} from './windows-tools.mjs';
import {validateWindowsSnapshot} from '../automation/windows-candidates.mjs';
import {buildVolumeCandidates} from '../core/natural-command.mjs';

const fail=code=>Object.assign(new Error(code),{code});
const gate=signal=>{if(signal?.aborted)throw fail('ABORTED');};
const clean=(value,max=250)=>typeof value==='string'?value.slice(0,max):'';
const normalize=value=>String(value??'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const readResult=(message,data={})=>({ok:true,verified:true,effectAttempted:false,status:'observed',message,data});
const safeCode=error=>/^[A-Z_]{1,64}$/.test(error?.code??'')?error.code:'WINDOWS_TOOL_FAILED';
const popupSurfaces=new Set(['flyout','shell_popup','start_menu','search']);

function taskbarRegion(element){
  if(typeof element?.className==='string'&&element.className.startsWith('SystemTray.'))return 'tray';
  if(/^(?:Start|Search)(?:Button|Box|GleamButton)?$/iu.test(element?.automationId??'')||/^(?:Start|Search)$|^Taskbar\.(?:Start|Search)/iu.test(element?.className??''))return 'start';
  if(element?.className||element?.automationId)return 'apps';
  return null;
}
const regionNames={tray:'Системный трей',start:'Пуск и поиск',apps:'Приложения и остальные кнопки панели задач'};
const regionDescriptions={tray:'звук, сеть, питание, часы и значки уведомлений',start:'кнопки меню Пуск и поиска Windows',apps:'кнопки закреплённых и запущенных приложений'};

function audioState(value){
  if(!value||value.provider!=='windows_coreaudio'||value.verified!==true||value.effectAttempted!==false||!Array.isArray(value.devices)||value.devices.length>256)throw fail('AUDIO_OUTPUT_INVALID');
  const ids=new Set();
  const devices=value.devices.map(device=>{
    if(!device||!/^audio_[a-f0-9]{24}$/.test(device.id??'')||ids.has(device.id)||typeof device.name!=='string'||device.name.length>500||typeof device.isDefault!=='boolean')throw fail('AUDIO_OUTPUT_INVALID');
    ids.add(device.id);return {id:device.id,name:device.name,isDefault:device.isDefault};
  });
  if(value.defaultDeviceId!==null&&!ids.has(value.defaultDeviceId))throw fail('AUDIO_OUTPUT_INVALID');
  if(devices.filter(d=>d.isDefault).length!==(value.defaultDeviceId===null?0:1)||devices.some(d=>d.isDefault&&d.id!==value.defaultDeviceId))throw fail('AUDIO_OUTPUT_INVALID');
  return {devices,defaultDeviceId:value.defaultDeviceId};
}

function audioGoal(command,audio){
  const requested=/^\s*(?:переключи|смени|выбери|установи)\s+(?:аудио\s*выход|устройство\s+вывода(?:\s+звука)?)\s+(?:на\s+)?(.+?)[.!]?\s*$/iu.exec(command);
  if(!requested)return {applicable:false,verified:false};
  if(!audio)return {applicable:true,verified:false,scope:'audio_output',evidence:'audio_readback_unavailable'};
  // Only a uniquely named ENTIRE target can prove this goal. A matching token
  // must not certify unperformed later clauses of a compound command.
  const targetName=normalize(requested[1]);
  const mentioned=audio.devices.filter(d=>targetName.length>=4&&normalize(d.name).includes(targetName));
  if(mentioned.length!==1)return {applicable:false,verified:false,scope:'audio_output',evidence:'target_device_not_uniquely_named'};
  const target=mentioned[0];return {applicable:true,verified:target.id===audio.defaultDeviceId,scope:'audio_output',evidence:target.id===audio.defaultDeviceId?'default_audio_output_verified':'default_audio_output_differs',target:target.name,current:audio.devices.find(d=>d.isDefault)?.name??null};
}

/** A run owns the mapping from Jev's readable choices to one exact native tool.
 * Jev never chooses an executor name, HWND, coordinate or native argument. */
export function createJevDesktopSession({desktop,systemTools,command=''}={}){
  if(typeof desktop?.bridge?.request!=='function')throw new TypeError('desktop.bridge is required');
  const tools=new Map(createWindowsTools({desktop,command,maxCandidates:86}).map(tool=>[tool.name,tool]));
  let initialized=false,page=0,appsPage=0,view='desktop',apps=null,current=null,mapping=new Map(),lastReceipt=null,audio=null,audioUnavailable=false;
  let region=null,regionWindow=null;
  const executed=new Set();
  const call=(name,args,signal)=>tools.get(name).execute(args,{signal});
  const readAudio=async signal=>{
    try{audio=audioState(await desktop.bridge.request('audio_outputs_get',{},signal));audioUnavailable=false;}
    catch(error){gate(signal);audio=null;audioUnavailable=true;}
  };
  const readApps=async signal=>{
    const raw=await desktop.apps.list(signal);gate(signal);
    if(!Array.isArray(raw)||raw.length>200)throw fail('APP_CATALOG_INVALID');
    apps=raw.filter(item=>/^app_[a-f0-9]{24}$/.test(item?.id??'')&&typeof item.name==='string'&&item.name.length<=200&&typeof item.processName==='string');
  };
  const sourceAction=(action,snapshot)=>{
    const element=snapshot.elements.find(e=>e.id===action.targetId);
    const owner=snapshot.windows.find(w=>w.id===(element?.windowId??action.targetId));
    const metadata=element?{role:element.role,...(typeof element.selected==='boolean'?{selected:element.selected}:{}),
      ...(element.toggleState!=null?{toggleState:element.toggleState}:{}),...(element.expandState!=null?{expandState:element.expandState}:{}),
      ...(element.group?{group:clean(element.group,100)}:{}),...(Number.isInteger(element.order)?{order:element.order,orderIsPartial:element.orderIsPartial===true}:{})}:{};
    let label=action.title.replace(/; target [^\]]+/u,'');
    if(action.op==='click'&&owner?.surfaceKind==='taskbar'&&element?.className==='SystemTray.OmniButtonCenter')
      label=`Нажать кнопку блока быстрых настроек Windows: ${clean(element.name??element.label,250)}`;
    if(action.op==='inspect'&&owner?.surfaceKind==='taskbar')label=owner.className==='Shell_SecondaryTrayWnd'
      ?'Прочитать панель задач дополнительного монитора'
      :'Прочитать основную панель задач и системный трей Windows — доступ к звуку, сети, Пуск и приложениям';
    if(action.op==='inspect'&&['flyout','shell_popup','start_menu','search'].includes(owner?.surfaceKind))label=`Прочитать системное меню: ${owner.title}`;
    return {label:clean(label,400),operation:action.op,effect:action.op!=='inspect',
      stableKey:`native:${action.targetId}:${action.op}${action.arguments?':'+JSON.stringify(action.arguments):''}`,target:metadata,
      ownerId:owner?.id,controlName:clean(element?.name??element?.label,100).replace(/\s+/gu,' '),region:owner?.surfaceKind==='taskbar'&&element?.role!=='Window'?taskbarRegion(element):null,
      execute:signal=>call('windows_execute',{snapshotVersion:current.snapshotVersion,actionId:action.id},signal)};
  };
  async function observe({signal}={}){
    gate(signal);mapping=new Map();
    if(!initialized){
      // A new command starts with the desktop hierarchy, not a stale window
      // selected by a previous command or by the diagnostics panel.
      await desktop.bridge.request('observe',{windowId:null},signal);initialized=true;
    }
    const result=await call('windows_observe',{page},signal);gate(signal);
    if(!result.ok)throw fail(result.error??'WINDOWS_OBSERVATION_FAILED');
    current=result.data;const snapshot=validateWindowsSnapshot(desktop.lastSnapshot);
    await readAudio(signal);
    const selected=snapshot.windows.find(w=>w.id===snapshot.facts.selectedWindowId);
    if(regionWindow!==selected?.id){region=null;regionWindow=selected?.id??null;}
    const windows=snapshot.windows.map(w=>({title:clean(w.title,130),app:w.processName,surface:w.surfaceKind??'application',...(w.className?{className:w.className}:{}),active:w.active,minimized:w.minimized,inspected:w.id===selected?.id}));
    const native=current.actions.map(action=>sourceAction(action,snapshot));
    const ordinal=/\b(?:first|last)\b|перв(?:ую|ая|ый|ое)|последн(?:юю|яя|ий|ее)/iu.test(command)&&/\btab\b|вклад/iu.test(command);
    let offered=[],regions=[];
    if(view==='apps'){
      if(!apps)await readApps(signal);
      const matching=apps.map(app=>({app,score:(command.toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[]).reduce((n,word)=>n+(app.name.toLocaleLowerCase().includes(word)?1:0),0)})).sort((a,b)=>b.score-a.score||a.app.name.localeCompare(b.app.name)).map(item=>item.app);
      const perPage=70;
      offered=matching.slice(appsPage*perPage,(appsPage+1)*perPage).map(app=>({label:`Открыть установленное приложение: ${app.name}`,operation:'launch',effect:true,stableKey:`app:${app.id}`,execute:async signal=>{
        const fresh=validateWindowsSnapshot(await desktop.bridge.request('observe',{},signal));gate(signal);
        const existing=fresh.windows.find(w=>w.processName.toLocaleLowerCase()===app.processName.toLocaleLowerCase());
        if(existing){view='desktop';await desktop.bridge.request('observe',{windowId:existing.id},signal);return {ok:true,verified:false,effectAttempted:false,status:'already_open',message:'Приложение уже запущено. Теперь нужно выбрать действие его окна.'};}
        let receipt;
        try{receipt=await desktop.launch({targetId:app.id,operation:'launch',label:app.name},fresh,signal);}
        catch(error){const attempted=error?.details?.effectAttempted===true||!['APP_LAUNCH_FAILED','APP_ELEVATION_REQUIRED','APP_NOT_OBSERVED','APP_TARGET_CHANGED','APP_TARGET_MISSING'].includes(error?.code);return {ok:false,verified:false,effectAttempted:attempted,status:attempted?'execution_uncertain':'failed',error:safeCode(error)};}
        view='desktop';
        if(!receipt||receipt.operation!=='launch'||receipt.targetId!==app.id||!receipt.after)return {ok:false,verified:false,effectAttempted:true,status:'execution_uncertain',error:'WINDOWS_INVALID_RECEIPT'};
        validateWindowsSnapshot(receipt.after);
        return {ok:receipt.verified===true,verified:receipt.verified===true,effectAttempted:true,status:receipt.verified?'completed':'execution_uncertain',evidence:receipt.evidence,message:receipt.verified?'Запуск приложения подтверждён.':'Процесс запущен; окно не подтверждено.',data:{receipt}};
      }}));
      if((appsPage+1)*perPage<matching.length)offered.push({label:'Посмотреть следующую страницу установленных программ',operation:'inspect',effect:false,stableKey:`apps_page:${appsPage+1}`,execute:async()=>{appsPage++;return readResult('Следующая страница приложений.');}});
      offered.push({label:'Вернуться к окнам и панели задач Windows',operation:'inspect',effect:false,stableKey:'desktop_root',execute:async signal=>{view='desktop';page=0;await desktop.bridge.request('observe',{windowId:null},signal);return readResult('Возвращаюсь к рабочему столу.');}});
    }else{
      // Partial order must not be mistaken for the first/last matching tab.
      // The model still sees why a choice is missing and can inspect another surface.
      offered=native.filter(action=>!(ordinal&&action.operation==='select'&&action.target.role==='TabItem'&&action.target.orderIsPartial));
      if(selected){
        // Stay within the surface the model chose. A newly opened system menu
        // remains inspectable; other windows are reached via the desktop root.
        offered=offered.filter(action=>action.ownerId===selected.id?action.operation!=='inspect':action.operation==='inspect'&&popupSurfaces.has(snapshot.windows.find(w=>w.id===action.ownerId)?.surfaceKind));
        if(selected.surfaceKind==='taskbar'){
          const grouped=new Map();
          for(const action of offered.filter(item=>item.ownerId===selected.id)){
            if(!action.region)continue;
            if(!grouped.has(action.region))grouped.set(action.region,[]);
            grouped.get(action.region).push(action);
          }
          regions=[...grouped].map(([id,members])=>({id,name:regionNames[id],buttons:members.map(item=>item.controlName).slice(0,8),count:members.length,selected:id===region}));
          if(region&&!grouped.has(region))region=null;
          // Old/custom taskbars without structural UIA metadata retain their
          // observed controls. Never infer membership from the user's command.
          if(grouped.size){
            offered=offered.filter(action=>action.ownerId!==selected.id||action.region===region||(!action.region&&region!==null));
            for(const group of regions.filter(group=>group.id!==region))offered.push({
              label:`Получить доступные действия кнопок: ${group.name} — ${regionDescriptions[group.id]}`,operation:'inspect',effect:false,
              target:{kind:'control_group',buttons:group.buttons,opensActionChoices:true},
              stableKey:`region:${selected.id}:${group.id}`,execute:async()=>{region=group.id;return readResult(`Выбрана область: ${group.name}.`);},
            });
          }
        }
      }else offered.push({label:'Посмотреть установленные приложения, чтобы открыть ещё не запущенную программу',operation:'inspect',effect:false,stableKey:'apps_catalog',execute:async signal=>{if(!apps)await readApps(signal);view='apps';appsPage=0;return readResult('Прочитан каталог установленных приложений.');}});
      if(current.coverage.pages>1)offered.push({label:`Прочитать другую группу кнопок этого окна (${page+1}/${current.coverage.pages})`,operation:'inspect',effect:false,stableKey:`controls_page:${(page+1)%current.coverage.pages}`,execute:async()=>{page=(page+1)%current.coverage.pages;return readResult('Следующая группа доступных кнопок.');}});
      if(selected)offered.push({label:'Прочитать весь список окон и системных областей заново',operation:'inspect',effect:false,stableKey:'desktop_root',execute:async signal=>{page=0;await desktop.bridge.request('observe',{windowId:null},signal);return readResult('Прочитан рабочий стол.');}});
      if(systemTools&&!selected){
        offered.push({label:'Прочитать текущую громкость Windows',operation:'inspect',effect:false,stableKey:'volume_read',execute:signal=>systemTools.executeSystemTool({kind:'get_system_volume'},{signal})});
        // Literal number candidates come from the user's command, not generated
        // arguments. Jev chooses whether any of them expresses a volume request.
        const values=[...new Set(buildVolumeCandidates(command).map(item=>item.percent))].slice(0,4);
        for(const percent of values)offered.push({label:`Установить системную громкость ${percent}% (число из команды)`,operation:'volume_set',effect:true,stableKey:`volume_set:${percent}`,execute:signal=>systemTools.executeSystemTool({kind:'volume',percent},{signal})});
        offered.push({label:'Свернуть окно самого помощника Jeff',operation:'self_minimize',effect:true,stableKey:'assistant_minimize',execute:signal=>systemTools.executeSystemTool({kind:'self_minimize'},{signal})});
      }
    }
    offered=offered.filter(action=>!action.effect||!executed.has(action.stableKey));
    if(offered.length>96)throw fail('JEV_CANDIDATE_LIMIT');
    const candidates=offered.map((action,index)=>{const id=`step_${String(index+1).padStart(2,'0')}`;mapping.set(id,action);const {execute,ownerId,controlName,region:internalRegion,...publicAction}=action;return {id,...publicAction};});
    const controls=snapshot.elements.filter(e=>e.role!=='Window'&&(e.selected===true||e.toggleState!=null||e.expandState!=null)).slice(0,40).map(e=>({name:clean(e.name??e.label,160),role:e.role,selected:e.selected,toggleState:e.toggleState,expandState:e.expandState}));
    const visibleWindows=selected?windows.filter(w=>w.inspected||popupSurfaces.has(w.surface)):windows;
    const goalState=audioGoal(command,audio);
    return {snapshot,observation:{view,windows:visibleWindows,...(selected?{otherWindowsAtDesktopRoot:windows.length-visibleWindows.length}:{}),inspected:selected?{title:clean(selected.title,160),surface:selected.surfaceKind??'application'}:null,controls,
      ...(regions.length?{regions,selectedRegion:region}:{}),
      coverage:{...current.coverage,...(ordinal&&snapshot.metadata?.tabOrderPartial?{ordinalSelectionBlocked:true}:{})},
      ...(audio?{audioOutputs:audio.devices.map(({name,isDefault})=>({name,isDefault}))}:{}),...(audioUnavailable?{audioReadback:'unavailable'}:{}),
      ...(goalState.applicable?{goalState}:{}),
      ...(lastReceipt?{lastResult:lastReceipt}:{}),
      navigation:(regions.length&&!region?'Choose a control_group to expose executable actions for its observed buttons. Region summaries are not actions yet. ':'')+'Inspect reads a surface without activating it. New menus appear as windows; inspect the newly visible menu to read its buttons. Candidate order is not visual tab order. Unseen controls are not evidence of absence.'},candidates};
  }
  async function execute(id,{signal}={}){
    gate(signal);const action=mapping.get(id);if(!action)throw fail('WINDOWS_ACTION_NOT_OBSERVED');
    mapping=new Map();
    if(action.effect&&executed.has(action.stableKey))throw fail('WINDOWS_REPEATED_EFFECT');
    const result=await action.execute(signal);
    // A dispatch with no native postcondition must never be repeated blindly.
    // Verified effects may be requested again after an inverse step; the loop
    // owns their bounded repetition policy across fresh observations.
    if(result.effectAttempted===true&&!(result.ok===true&&result.verified===true))executed.add(action.stableKey);
    if(action.effect||(action.operation==='inspect'&&action.stableKey.startsWith('native:')))page=0;
    lastReceipt={action:action.label,operation:action.operation,verified:result.verified===true,effectAttempted:result.effectAttempted===true,evidence:result.evidence??result.data?.receipt?.evidence??null,...(result.data?.after?{state:result.data.after}:{}),...(result.after?{state:result.after}:{}),...(result.error?{error:result.error}:{})};
    return {...result,operation:action.operation,label:action.label,stableKey:action.stableKey};
  }
  async function verifyGoal(_command,{signal}={}){
    // Generic UI goals remain a model assessment. For an explicitly named audio
    // endpoint we can additionally measure the actual Windows default device.
    if(!audioGoal(command,null).applicable)return {applicable:false,verified:false};
    await readAudio(signal);
    return audioGoal(command,audio);
  }
  return {observe,execute,verifyGoal,capabilities:()=>[
    {name:'jev_desktop',title:'Jev: окна, панель задач и меню Windows',available:true,effect:true},
    {name:'jev_apps',title:'Jev: запуск установленных приложений',available:typeof desktop.apps?.list==='function',effect:true},
    {name:'audio_readback',title:'Проверка фактического аудиовыхода',available:true,effect:false},
  ]};
}
