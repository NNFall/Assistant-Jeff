import {createHash} from 'node:crypto';

export const WINDOWS_OPERATIONS=new Set(['inspect','activate','minimize','maximize','restore','close','select','invoke','toggle','expand','collapse','set_keyboard_language','replace_text']);
const fail=()=>Object.assign(new Error('WINDOWS_INVALID_SNAPSHOT'),{code:'WINDOWS_INVALID_SNAPSHOT'});
const riskyLabel=/(?:\b(?:delete|erase|remove|send|submit|pay|purchase|buy|install|password|sign.?in|log.?in|security|permission|format|reset|subscribe)\b|удал|стереть|отправ|оплат|купить|установить|парол|войти|безопасност|разрешени|форматир|сброс|подписат)/iu;
const exactAuthLabel=/^\s*вход[.!…]?\s*$/iu;
const verbs={inspect:'Прочитать элементы окна',activate:'Открыть / показать окно на переднем плане',minimize:'Свернуть окно',maximize:'Развернуть окно на весь экран',restore:'Восстановить обычный размер окна',close:'Закрыть окно',select:'Выбрать элемент',invoke:'Нажать кнопку',toggle:'Переключить состояние',expand:'Раскрыть',collapse:'Свернуть список'};
const digest=value=>createHash('sha256').update(value).digest('hex').slice(0,24);
export function replacementLiteral(command){
  const match=/^\s*замени текст на (?:«([^»]*)»|"([^"\n]*)")[.!]?\s*$/iu.exec(String(command));
  return match?(match[1]??match[2]):null;
}

export function validateWindowsSnapshot(value){
  if(!value||typeof value.version!=='string'||!/^[a-f0-9]{16,128}$/i.test(value.version)||!Array.isArray(value.elements)||value.elements.length>300||!Array.isArray(value.windows)||value.windows.length>64)throw fail();
  const seen=new Set();
  for(const e of value.elements){
    if(!e||typeof e.id!=='string'||!/^[A-Za-z][A-Za-z0-9_-]{0,95}$/.test(e.id)||seen.has(e.id)||typeof e.label!=='string'||e.label.length>500||!Array.isArray(e.capabilities)||e.capabilities.some(op=>!WINDOWS_OPERATIONS.has(op)))throw fail();
    seen.add(e.id);
  }
  const windowIds=new Set();
  for(const w of value.windows){
    if(!w||typeof w.id!=='string'||windowIds.has(w.id)||!value.elements.some(e=>e.id===w.id&&e.role==='Window')||typeof w.title!=='string'||w.title.length>500||typeof w.processName!=='string'||w.processName.length>200||!['minimized','maximized','active'].every(k=>typeof w[k]==='boolean'))throw fail();
    windowIds.add(w.id);
    if(w.stateVersion!==undefined&&(typeof w.stateVersion!=='string'||!/^[a-f0-9]{64}$/i.test(w.stateVersion)))throw fail();
  }
  if(!value.facts||typeof value.facts!=='object'||(value.facts.selectedWindowId!=null&&!windowIds.has(value.facts.selectedWindowId)))throw fail();
  if(value.elements.some(e=>e.role==='Window'&&!windowIds.has(e.id)))throw fail();
  return value;
}

/** Hierarchical access: choose a window, then its observed operations/controls. */
export function buildWindowsCandidates(snapshot,command,{page=0,apps=[]}={}){
  validateWindowsSnapshot(snapshot);
  const windowIds=new Set(snapshot.windows.map(w=>w.id));
  const words=String(command).toLocaleLowerCase().match(/[\p{L}\p{N}]{3,}/gu)??[];
  const selected=snapshot.facts?.selectedWindowId;
  const actions=[];
  const literal=replacementLiteral(command);
  for(const e of snapshot.elements){
    const isWindow=windowIds.has(e.id);
    for(const operation of e.capabilities){
      if(isWindow&&(e.id===selected?operation==='inspect':operation!=='inspect'))continue;
      // High-impact controls require a separate explicitly reviewed workflow.
      if(!isWindow&&(riskyLabel.test(e.name??e.label)||exactAuthLabel.test(e.name??e.label)))continue;
      const owner=snapshot.windows.find(w=>w.id===(isWindow?e.id:e.windowId));
      if(operation==='replace_text'&&(literal===null||e.role!=='Edit'||e.windowId!==selected||owner?.active!==true||e.hasKeyboardFocus!==true||e.isPassword!==false||e.readOnly!==false||e.enabled!==true||e.offscreen!==false||e.supportsValuePattern!==true))continue;
      if(operation==='set_keyboard_language'&&(!isWindow||owner?.active!==true))continue;
      const variants=operation==='set_keyboard_language'?[...new Set(owner?.availableKeyboardLanguages??[])].filter(l=>['English','Russian'].includes(l)).map(language=>({language})):[operation==='replace_text'?{text:literal}:null];
      for(const args of variants){
      const position=e.role==='TabItem'&&Number.isInteger(e.order)?`; visual order ${e.order}${e.orderIsPartial?' (among observed tabs; may be incomplete)':''}`:'';
      const identity=isWindow?'':` [${e.role}${position}; target ${e.id}]`;
      const verb=operation==='set_keyboard_language'?`Переключить раскладку на ${args.language}`:operation==='replace_text'?`Заменить всё содержимое сфокусированного поля на точный текст из команды (${literal.length} символов)` :verbs[operation];
      const label=`${verb}: ${e.label.slice(0,360)}${identity}`.slice(0,500);
      const relevance=words.reduce((sum,w)=>sum+(label.toLocaleLowerCase().includes(w)?3:0),0);
      actions.push({id:'a_'+digest(snapshot.version+'\0'+e.id+'\0'+operation+(args?'\0'+JSON.stringify(args):'')),targetId:e.id,operation,label,...(args?{args}:{}),
        score:relevance+(e.id===selected?8:0)+(isWindow&&operation==='inspect'?1:0),isWindow});
      }
    }
  }
  for(const app of apps){
    if(!app||!/^app_[a-f0-9]{16,64}$/.test(app.id??'')||typeof app.name!=='string'||!app.name.trim()||app.name.length>200||typeof app.processName!=='string')continue;
    if(snapshot.windows.some(w=>w.processName.toLocaleLowerCase()===app.processName.toLocaleLowerCase()))continue;
    const label=`Запустить установленное приложение: ${app.name}`;
    const relevance=words.reduce((sum,w)=>sum+(label.toLocaleLowerCase().includes(w)?3:0),0);
    actions.push({id:'a_'+digest(snapshot.version+'\0'+app.id+'\0launch'),targetId:app.id,operation:'launch',label,score:relevance,isWindow:false});
  }
  const inspections=actions.filter(a=>a.isWindow&&a.operation==='inspect');
  const rest=actions.filter(a=>!(a.isWindow&&a.operation==='inspect')).sort((a,b)=>b.score-a.score||a.id.localeCompare(b.id));
  const slots=Math.max(1,96-inspections.length);
  const pages=Math.max(1,Math.ceil(rest.length/slots));
  const index=Math.max(0,Math.min(pages-1,Number.isSafeInteger(page)?page:0));
  const candidates=[...inspections,...rest.slice(index*slots,(index+1)*slots)].map(({score,isWindow,...a})=>a);
  return {candidates,page:index,pages,total:actions.length,omitted:actions.length-candidates.length};
}

export function windowsObservation(snapshot,{omitted=0,candidates=[]}={}){
  const selected=snapshot.windows.find(w=>w.id===snapshot.facts?.selectedWindowId);
  const windows=snapshot.windows.map(w=>({id:w.id,title:w.title,app:w.processName,minimized:w.minimized,maximized:w.maximized,active:w.active,...(w.keyboardLanguage?{keyboardLanguage:w.keyboardLanguage,availableKeyboardLanguages:w.availableKeyboardLanguages}:{})}));
  const preferred=new Set(candidates.map(c=>c.targetId));
  const controls=snapshot.elements.filter(e=>!windows.some(w=>w.id===e.id)).sort((a,b)=>Number(preferred.has(b.id))-Number(preferred.has(a.id))||Number(b.selected===true)-Number(a.selected===true)).map(e=>({
    id:e.id,name:(e.name??e.label).slice(0,200),role:e.role,
    ...(typeof e.selected==='boolean'?{selected:e.selected}:{}),
    ...(e.toggleState!=null?{toggleState:e.toggleState}:{}),...(e.expandState!=null?{expandState:e.expandState}:{}),
    ...(Number.isInteger(e.order)?{order:e.order,orderIsPartial:!!e.orderIsPartial,group:e.group?.slice(0,80),tabGroupId:e.tabGroupId}:{}),
  }));
  // Keep complete JSON records and the coverage notice. Never cut in the middle
  // of an element or silently lose the end-of-observation warning.
  let omittedControls=0;
  const render=()=>[
    `Current windows: ${JSON.stringify(windows)}`,
    `Inspected window: ${selected?selected.title:'none; inspect the relevant window to see its controls.'}`,
    `Observed controls: ${JSON.stringify(controls)}`,
    `Provider: ${snapshot.metadata?.provider??'Windows UI Automation'}. ${snapshot.metadata?.truncated?'Observation is truncated. ':''}${omittedControls?`${omittedControls} control descriptions omitted from this summary. `:''}${omitted?`${omitted} further action options exist; absent candidate does not prove absent target. `:''}Only role TabItem is an existing tab; hyperlinks and bookmarks are not tabs. Tab order is visual order among the observed tab group, not candidate-array order. Partial coverage cannot prove the first matching tab in the whole group. An inspect action only reads controls; it does not focus, open a tab or start playback.`,
  ].join('\n');
  // Window inventory is necessary for subsequent access choices, so shorten
  // long titles before dropping control descriptions.
  if(JSON.stringify(windows).length>7500)for(const w of windows){w.title=w.title.slice(0,50);w.app=w.app.slice(0,25);}
  let summary=render();
  while(summary.length>16000&&controls.length){controls.pop();omittedControls++;summary=render();}
  if(summary.length>16000){for(const w of windows){w.title=w.title.slice(0,8);w.app=w.app.slice(0,8);}summary=render();}
  return {app:'Windows',summary};
}
