'use strict';
import {VoiceClient} from './voice-client.mjs';
import {describeResult,describeError} from '../../desktop/automation/feedback.mjs';
import {formatAgentProgress,formatLogView} from '../../desktop/automation/log-view.mjs';

const $=id=>document.getElementById(id);
const api=window.lab;
const examples={taskmgr:'Открой диспетчер задач.',reminder:'Напомни через 10 минут проверить чай.',note:'Заметка: купить хлеб.',question:'Объясни, что такое оперативная память.'};
let voice,voiceState={state:'off',enabled:false,busy:false,ready:false,silenceMs:2000,settings:{activationBeep:true,denisReply:true,voiceAutoExecute:true,transcriptionMode:'live'},providers:{}};
let pending=false,stopping=false,activeSource=null,currentRunId=null,lastFinishedRunId=null,lastReport=null,detailReport=null;
let serial=0,startedAt=0,ticker=null,progressEvents=[],activities=[],view='assistant',historyLoading=false,reminderQueue=[];
const states={off:'Микрофон выключен',stopped:'Микрофон выключен',idle:'Микрофон выключен',loading:'Готовлю микрофон',waiting:'Ожидаю Hey Jarvis',recording:'Слушаю команду',transcribing:'Распознаю речь',ready:'Команда распознана',processing:'Выполняю задачу',speaking:'Отвечает Денис',error:'Голос недоступен'};
const phaseLabels={desktop_start:'Смотрю открытые приложения',installed_apps:'Нашёл доступные приложения',installed_apps_unavailable:'Проверяю уже открытые окна',observe:'Проверяю состояние окна',model_request:'Выбираю следующий шаг',model_error:'Не удалось получить решение',stale:'Окно изменилось — проверяю ещё раз',candidate_page:'Ищу подходящий элемент',local_intent:'Проверяю вашу команду',local_execute_request:'Сохраняю',chat_request:'Готовлю ответ',chat_response:'Ответ получен'};
const operationLabels={inspect:'Проверяю нужное окно',activate:'Показываю окно',launch:'Открываю приложение',minimize:'Сворачиваю окно',maximize:'Разворачиваю окно',restore:'Восстанавливаю окно',close:'Закрываю окно',select:'Выбираю нужный элемент',invoke:'Нажимаю кнопку',toggle:'Переключаю настройку',expand:'Раскрываю список',collapse:'Сворачиваю список',set_keyboard_language:'Меняю раскладку',replace_text:'Заменяю текст в поле'};
const text=(id,value)=>{if($(id))$(id).textContent=value??'';};
const hidden=(id,value)=>{if($(id))$(id).hidden=value;};
const duration=ms=>Number.isFinite(ms)?`${(ms/1000).toLocaleString('ru-RU',{maximumFractionDigits:1})} с`:'';
const pretty=value=>JSON.stringify(value??null,null,2);
function busy(){return pending||voiceState.busy;}
function failure(error){return describeError(error?.code??error?.error??error?.name??'ASSISTANT_ERROR');}
function checked(result){if(result?.error||result?.ok===false&&!result?.reason)throw Object.assign(new Error(),{code:result.error??'ASSISTANT_ERROR'});return result;}
function note(notice){
  text('voice-notice-title',notice.title||'Не получилось обработать команду');text('voice-notice-message',notice.message||'Попробуйте ещё раз.');
  $('voice-notice').dataset.tone=notice.tone||'warning';hidden('voice-notice',false);
  if(notice.code==='NO_SPEECH'||notice.code==='EMPTY_TRANSCRIPT')text('voice-transcript','Распознанного текста нет.');
}
function clearNotice(){hidden('voice-notice',true);hidden('voice-metrics',true);}
function clearTranscript(){text('voice-transcript','');hidden('voice-transcript',true);delete $('voice-transcript').dataset.final;}
function resetConversationView(){
  serial++;lastReport=null;detailReport=null;lastFinishedRunId=null;currentRunId=null;activeSource=null;startedAt=0;progressEvents=[];activities=[];clearNotice();clearTranscript();
  $('command').value='';hidden('task-card',true);hidden('welcome',false);hidden('readable-log',true);hidden('result-actions',true);$('activity-list').replaceChildren();$('task-card').dataset.tone='neutral';$('task-card').setAttribute('aria-busy','false');text('trace','Запустите задачу, чтобы увидеть отчёт.');text('task-time','');text('task-command','');text('activity','');
  if($('details-dialog').open)$('details-dialog').close();
}
async function newConversation(){
  if(busy())return;const button=$('new-conversation');button.disabled=true;
  try{if(typeof api?.clearContext==='function')checked(await api.clearContext());resetConversationView();}
  catch(error){note(failure(error));}
  finally{button.disabled=false;sync();}
}
function taskClock(){if(startedAt&&pending)text('task-time',duration(performance.now()-startedAt));}
function sync(){
  const active=busy();
  $('run').disabled=!api||active||!$('command').value.trim()||$('command').value.length>1024;
  $('command').disabled=active;
  $('voice-manual').disabled=!voiceState.ready||active;
  $('voice-finish').disabled=voiceState.state!=='recording'||stopping;hidden('voice-finish',voiceState.state!=='recording');
  $('stop').disabled=stopping;hidden('stop',!active);hidden('new-conversation',active);
  $('voice-wake').disabled=!voiceState.ready||active;
  $('voice-wake').setAttribute('aria-pressed',String(voiceState.enabled));
  text('voice-wake-label',voiceState.enabled?'Выключить Jarvis':'Включить Jarvis');
  text('counter',`${$('command').value.length} / 1024`);
  for(const button of document.querySelectorAll('[data-example]'))button.disabled=active;
  for(const id of ['voice-beep','voice-reply','voice-auto','voice-mode'])$(id).disabled=!voiceState.ready||active;
  text('voice-manual-label','Сказать команду');
  const voiceLabel=voiceState.source==='typed'&&!voiceState.enabled&&voiceState.state==='processing'?'Микрофон выключен':states[voiceState.state]||'Голосовой ввод';
  const headline=stopping?'Останавливаю':voiceState.state==='speaking'?voiceLabel:pending?$('activity').textContent||'Выполняю задачу':voiceState.enabled||voiceState.busy?voiceLabel:'Готов к задаче';
  text('status',headline);$('status-indicator').dataset.state=stopping?'stopping':active?'busy':voiceState.enabled?'listening':'idle';
  text('voice-state',voiceLabel);$('voice-state').dataset.active=String(voiceState.enabled||voiceState.state==='speaking');
  text('footer-status',voiceState.enabled?'Микрофон включён':voiceState.state==='speaking'?'Звучит ответ · микрофон выключен':'Микрофон выключен');
  $('voice-wave').dataset.state=voiceState.state;hidden('voice-wave',!['recording','transcribing','speaking'].includes(voiceState.state));
  text('hero-title',voiceState.state==='recording'?'Я слушаю':voiceState.state==='transcribing'?'Распознаю вашу команду':lastReport&&pending?'Результат готов':pending?'Занимаюсь вашей задачей':'Что нужно сделать?');
  text('hero-subtitle',voiceState.state==='recording'?'Говорите. После паузы в 2 секунды запись завершится.':voiceState.state==='transcribing'?'Запись закончена. Уточняю распознанный текст.':lastReport&&pending?'Ответ уже на экране. Озвучку можно остановить.':pending?'Показываю ход выполнения. Вы можете остановить меня.':'Скажите или напишите задачу — я покажу каждый шаг.');
}
function navigate(next){
  if(!['assistant','history','settings'].includes(next))return;
  view=next;for(const name of ['assistant','history','settings'])hidden(`view-${name}`,name!==view);
  for(const button of document.querySelectorAll('[data-view]')){const selected=button.dataset.view===view;button.setAttribute('aria-current',selected?'page':'false');button.classList.toggle('active',selected);}
  if(view==='history')void loadHistory();
  if(view==='settings')void refreshProviders();
}
function startTask(command,source){
  activeSource=source;pending=true;stopping=false;currentRunId=null;lastReport=null;detailReport=null;progressEvents=[];activities=[];clearNotice();
  hidden('welcome',true);hidden('task-card',false);$('task-card').dataset.tone='working';$('task-card').setAttribute('aria-busy','true');
  text('task-command',command||'Голосовая команда');text('task-state','Выполняется');text('result-title','Приступаю');text('result-message','');text('activity','Проверяю задачу');
  text('trace','Ожидаем первые шаги');hidden('result-actions',true);hidden('activity-list',false);$('activity-list').replaceChildren();
  startedAt=performance.now();clearInterval(ticker);ticker=setInterval(taskClock,250);taskClock();sync();
}
function renderActivities(finalTone){
  $('activity-list').replaceChildren();
  const items=finalTone?activities.slice(-4):activities.slice(0,-1).slice(-3);
  for(const item of items){const li=document.createElement('li');li.dataset.state=finalTone&&finalTone!=='success'?'neutral':'done';li.textContent=item.label;$('activity-list').append(li);}
}
function activity(event){
  let label=String(event?.phase??'').startsWith('agent_')?formatAgentProgress(event):phaseLabels[event.phase];
  if(event.phase==='execute_request')label=operationLabels[event.operation??event.candidate?.operation]||'Выполняю действие';
  if(event.phase==='verify')label=event.outcome==='verified'?'Действие подтверждено':event.outcome==='observed_change'?'Проверяю изменения':'Результат действия требует проверки';
  if(event.phase==='local_execute_result')label=event.result?.ok?'Сохранено':'Не удалось сохранить';
  if(!label)return;
  if(activities.at(-1)?.label!==label)activities.push({label,time:new Date(event.time??Date.now())});
  renderActivities();text('activity',label);text('result-title','Выполняю задачу');sync();
}
function finishReport(report){
  if(!report||typeof report!=='object')return finishFailure({code:'ASSISTANT_ERROR'});
  if(report.error&&!report.reason)return finishFailure({code:report.error});
  if(report.runId&&lastFinishedRunId===report.runId)return;
  lastReport=report;detailReport=report;lastFinishedRunId=report.runId??null;
  const feedback=describeResult(report);
  hidden('task-card',false);hidden('welcome',true);$('task-card').dataset.tone=feedback.tone;$('task-card').setAttribute('aria-busy','false');
  text('task-command',report.command||$('task-command').textContent||'Задача');text('task-state',report.needsClarification===true?'Нужно уточнение':feedback.tone==='success'?'Готово':feedback.tone==='neutral'?'Завершено':feedback.tone==='warning'?'Нужна проверка':'Не получилось');
  text('result-title',feedback.title);text('result-message',feedback.message);text('activity','');text('task-time',duration(report.elapsedMs));
  hidden('activity-list',true);
  hidden('result-actions',false);$('edit-command').disabled=false;hidden('edit-command',report.mode==='GEMINI_CHAT'&&report.ok===true);
  text('trace',pretty(report));clearInterval(ticker);sync();
  if(view==='assistant')$('task-card').scrollIntoView({block:'nearest',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
}
function finishFailure(error){
  const report={ok:false,reason:error?.code??error?.error??'ASSISTANT_ERROR',command:$('command').value,trace:[...progressEvents],elapsedMs:startedAt?Math.round(performance.now()-startedAt):0};
  finishReport(report);return report;
}
async function run(){
  const command=$('command').value.trim();if(busy()||!command||command.length>1024)return;
  const token=++serial;startTask(command,'typed');
  try{const report=await api.run({command});if(token===serial)finishReport(report);}
  catch(error){if(token===serial)finishFailure(error);}
  finally{if(token===serial){pending=false;stopping=false;clearInterval(ticker);sync();}}
}
function acceptProgress(event){
  if(!pending||lastReport)return;
  if(event.runId&&event.runId===lastFinishedRunId)return;
  if(currentRunId&&event.runId&&currentRunId!==event.runId)return;
  if(event.runId)currentRunId=event.runId;
  progressEvents.push(event);text('trace',pretty({status:'running',runId:currentRunId,events:progressEvents}));activity(event);
}
function renderVoiceState(state){
  if(state.state==='recording'&&voiceState.state!=='recording'||['off','stopped','idle','waiting','error'].includes(state.state)&&$('voice-transcript').dataset.final==='false')clearTranscript();
  voiceState=state;
  for(const [id,key] of [['voice-beep','activationBeep'],['voice-reply','denisReply'],['voice-auto','voiceAutoExecute']])$(id).checked=state.settings[key]===true;
  $('voice-mode').value=state.settings.transcriptionMode??'live';
  const streamMessage=state.state==='recording'?(state.streamPhase==='connecting'?'Подключаю распознавание. Уже можно говорить.':state.streamPhase==='live'?'Текст появляется по мере речи.':''):state.state==='transcribing'&&state.streamPhase==='finalizing'?'Завершаю распознавание.':'';
  text('voice-status',streamMessage||state.message||(['off','stopped','idle'].includes(state.state)?'Нажмите «Сказать команду» для одной записи.':state.state==='waiting'?'Произнесите «Hey Jarvis», затем задачу.':state.state==='speaking'?'Результат уже доступен ниже.':states[state.state]||'Голосовой ввод'));text('voice-silence',duration(state.silenceMs));
  if(state.source==='voice'&&state.state==='processing'&&!pending&&activeSource!=='typed')startTask($('command').value,'voice');
  sync();
}
async function voiceEvent(event){
  if(event.type==='wake'){
    clearNotice();clearTranscript();lastReport=null;activeSource='voice';hidden('task-card',true);hidden('welcome',true);
  }else if(event.type==='transcript'&&event.final===false){
    if(!['recording','transcribing'].includes(voiceState.state)||typeof event.text!=='string')return;
    $('voice-transcript').dataset.final='false';text('voice-transcript',event.text);hidden('voice-transcript',!event.text.trim());
  }else if(event.type==='transcript'&&event.final===true){
    if(typeof event.text!=='string')return;
    $('voice-transcript').dataset.final='true';$('command').value=event.text;hidden('voice-transcript',false);text('voice-transcript',event.autoExecute===false?'Команда распознана. Проверьте текст и нажмите «Выполнить».':'Команда распознана.');sync();
  }else if(event.type==='voice_notice'){
    note(event);hidden('welcome',true);
    if(pending&&activeSource==='voice'&&!lastReport){finishFailure({code:event.code??'VOICE_PROCESSING_FAILED'});pending=false;stopping=false;sync();}
  }else if(event.type==='result'){
    const report=event.report;if(!report)return;
    if(currentRunId&&report.runId&&currentRunId!==report.runId)return;
    if(event.source==='voice'&&!pending&&!lastReport)startTask(report.command,'voice');
    finishReport(report);if(event.source!=='typed'){pending=false;stopping=false;}sync();
  }else if(event.type==='transcription_metrics'){
    hidden('voice-metrics',false);text('voice-metrics',`Распознано за ${duration(event.latencyMs)}`);
  }else if(event.type==='speech_warning'){
    note({tone:'warning',title:'Голосовой ответ недоступен',message:event.message||'Результат показан текстом.'});
  }else if(event.type==='reminder'&&Number.isSafeInteger(event.id)){
    if(!reminderQueue.some(item=>item.id===event.id))reminderQueue.push(event);renderReminder();
  }
}
function voiceError(error){
  if(stopping)return;
  note(failure(error));hidden('welcome',true);
  if(pending&&activeSource==='voice'&&!lastReport){finishFailure(error);pending=false;stopping=false;sync();}
}
function renderReminder(){const item=reminderQueue[0];hidden('reminder-card',!item);if(item)text('reminder-text',item.text);}
async function dismissReminder(){
  const item=reminderQueue[0];if(!item)return;
  $('reminder-dismiss').disabled=true;
  try{checked(await api.dismissReminder({id:item.id}));reminderQueue.shift();renderReminder();}
  catch(error){note(failure(error));}
  finally{$('reminder-dismiss').disabled=false;}
}
async function stop(){
  if(stopping)return;stopping=true;sync();
  try{if(voice)await voice.stop();else checked(await api.stop());}
  catch(error){note(failure(error));}
  finally{if(!pending)stopping=false;sync();}
}
async function loadHistory(){
  if(historyLoading)return;historyLoading=true;$('history-refresh').disabled=true;text('history-status','Загружаю историю…');
  try{
    const result=checked(await api.history());const items=Array.isArray(result)?result:result.runs??[];
    $('history-list').replaceChildren();hidden('history-empty',items.length>0);text('history-status',items.length?'Последние задачи. Выберите запись, чтобы увидеть подробности.':'Здесь появятся выполненные задачи.');
    for(const item of items){
      const row=document.createElement('li'),button=document.createElement('button'),heading=document.createElement('span'),meta=document.createElement('span'),outcome=document.createElement('span');
      row.className='history-item';button.type='button';heading.className='history-command';heading.textContent=item.command||'Задача';meta.className='history-meta';
      const stamp=new Date(item.createdAt??item.time??Number(String(item.runId).split('-')[0]));meta.textContent=[Number.isNaN(stamp.getTime())?'':stamp.toLocaleString('ru-RU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}),duration(item.elapsedMs)].filter(Boolean).join(' · ');
      const desc=item.feedback??describeResult(item);outcome.className='history-result';outcome.dataset.tone=desc.tone;outcome.textContent=desc.title;
      button.append(heading,meta,outcome);button.addEventListener('click',async()=>{button.disabled=true;try{await openDetails(checked(await api.readRun({runId:item.runId})));}catch(error){text('history-status',failure(error).message);}finally{button.disabled=false;}});row.append(button);$('history-list').append(row);
    }
  }catch(error){text('history-status',failure(error).message);}
  finally{historyLoading=false;$('history-refresh').disabled=false;}
}
const element=(tag, className)=>{const node=document.createElement(tag);if(className)node.className=className;return node;};
const percent=value=>Number.isFinite(value)?`${Math.round(value*100)} %`:'Нет данных';
function logMetric(label,value){const item=element('div','log-metric'),term=element('dt'),description=element('dd');term.textContent=label;description.textContent=value;item.append(term,description);return item;}
function renderDataSent(fields){
  const list=$('data-sent-list');if(!list)return;list.replaceChildren();
  for(const field of fields??[]){const item=element('li','log-fact'),label=element('span','log-fact-label'),value=element('span','log-fact-value');label.textContent=field.label;value.textContent=field.value;item.append(label,value);list.append(item);}
}
function renderCapabilities(capabilities,context){
  const panel=$('capability-panel'),list=$('capability-list'),contextNode=$('capability-context');if(!panel||!list)return;list.replaceChildren();hidden('capability-panel',!(capabilities?.length));if(contextNode){const turns=Number.isSafeInteger(context?.turns)&&context.turns>=0;const history=Number.isSafeInteger(context?.historyTurns)&&context.historyTurns>=0;const details=[];if(history)details.push(`Контекст прошлых ходов: ${context.historyTurns}.`);else if(turns)details.push(`В разговоре учтено ходов: ${context.turns}.`);if(Number.isSafeInteger(context?.toolCount)&&context.toolCount>=0)details.push(`Операций передано: ${context.toolCount}.`);contextNode.textContent=details.join(' ')||'Данные контекста не записаны в этом старом отчёте.';hidden('capability-context',!(capabilities?.length));}
  for(const capability of capabilities??[]){
    const item=element('li','capability-item'),copy=element('span','capability-copy'),title=element('strong','capability-title'),description=element('span','capability-description'),status=element('span','capability-status');
    title.textContent=capability.title;description.textContent=capability.description||'Описание не приложено к отчёту.';status.dataset.available=capability.available===null?'unknown':String(capability.available);status.textContent=capability.available===true?'Доступно':capability.available===false?'Недоступно':'Статус не указан';copy.append(title,description);
    if(capability.reason){const reason=element('span','capability-reason');reason.textContent=capability.reason;copy.append(reason);}item.append(copy,status);list.append(item);
  }
}
function renderDecisionSteps(steps){
  const list=$('decision-steps'),empty=$('decision-empty');if(!list)return;list.replaceChildren();hidden('decision-empty',Boolean(steps?.length));
  for(const step of steps??[]){
    const item=element('li','decision-step'),heading=element('div','log-step-heading'),number=element('span','log-step-number'),kind=element('span','log-step-kind'),action=element('strong','log-step-action'),metrics=element('dl','log-metrics');
    number.textContent=`Шаг ${step.index}`;kind.textContent=step.kind==='goal'?'Проверка цели':'Решение модели';action.textContent=step.selectedAction;heading.append(number,kind);item.append(heading,action);
    metrics.append(logMetric('Вероятность выбора',percent(step.probability)),logMetric('Уверенность модели',percent(step.confidence)));item.append(metrics);
    if(step.criterion){const detail=element('p','log-detail');detail.textContent=step.criterion;item.append(detail);}
    if((step.alternatives??[]).length>1){
      const disclosure=document.createElement('details');disclosure.className='log-options';const summary=document.createElement('summary');summary.textContent=`Все варианты (${step.alternatives.length})`;const table=document.createElement('table'),head=document.createElement('thead'),row=document.createElement('tr');
      for(const label of ['Вариант','Вероятность']){const cell=document.createElement('th');cell.textContent=label;row.append(cell);}head.append(row);const body=document.createElement('tbody');
      for(const alternative of step.alternatives){const optionRow=document.createElement('tr'),labelCell=document.createElement('td'),probabilityCell=document.createElement('td');labelCell.textContent=alternative.label;probabilityCell.textContent=percent(alternative.probability);optionRow.append(labelCell,probabilityCell);body.append(optionRow);}
      table.append(head,body);disclosure.append(summary,table);item.append(disclosure);
    }
    list.append(item);
  }
}
function renderDataTree(nodes) {
  const list = element('ul', 'result-data-tree');
  for (const node of nodes ?? []) {
    const item = element('li', 'result-data-node');
    const heading = element('span', 'result-data-label');
    heading.textContent = node.label || 'Данные';
    item.append(heading);
    if (node.value !== undefined) {
      const value = element('span', 'result-data-value');
      value.textContent = String(node.value);
      item.append(value);
    }
    if (node.children?.length) item.append(renderDataTree(node.children));
    list.append(item);
  }
  return list;
}
function renderExecutionSteps(steps){
  const list=$('execution-steps');if(!list)return;list.replaceChildren();hidden('execution-empty',Boolean(steps?.length));
  for(const step of steps??[]){
    const item=element('li','execution-step'),heading=element('div','log-step-heading'),number=element('span','log-step-number'),status=element('span','execution-status'),label=element('strong','log-step-action');
    item.dataset.status=step.status;number.textContent='Шаг '+step.index;status.dataset.status=step.status;status.textContent=step.statusLabel;label.textContent=step.label;heading.append(number,status);item.append(heading,label);
    if(step.message){const message=element('p','execution-message');message.textContent=step.message;item.append(message);}
    if(step.evidence){const evidence=element('p','execution-evidence');evidence.textContent='Проверка: '+step.evidence;item.append(evidence);}
    if(step.dataSent){const sent=element('p','execution-message');sent.textContent='Передано: '+step.dataSent;item.append(sent);}
    if(step.dataTree?.length){const disclosure=document.createElement('details');disclosure.className='execution-data';const summary=document.createElement('summary');summary.textContent='Данные результата';disclosure.append(summary,renderDataTree(step.dataTree));item.append(disclosure);}
    list.append(item);
  }
}
function observationMeta(label,value){const item=element('div','observation-meta-item'),name=element('span','observation-meta-label'),textNode=element('span','observation-meta-value');name.textContent=label;textNode.textContent=value;item.append(name,textNode);return item;}
function renderReadableObservation(observation){
  const meta=$('readable-observation-meta'),windows=$('readable-windows'),controls=$('readable-controls');if(!meta||!windows||!controls)return;meta.replaceChildren();windows.replaceChildren();controls.replaceChildren();
  hidden('readable-observation-empty',Boolean(observation?.available));
  if(!observation?.available)return;
  const available=observation.availableWindow?[observation.availableWindow.title,observation.availableWindow.app].filter(Boolean).join(' · '):'Не выбрано';
  meta.append(observationMeta('Охват наблюдения',observation.coverage),observationMeta('Доступное окно',available),observationMeta('Элементы окна',`${observation.controls.length}`));
  for(const win of observation.windows??[]){const item=element('li'),title=element('strong'),detail=element('small');title.textContent=win.title;detail.textContent=[win.app,win.active?'на переднем плане':'',win.minimized?'свёрнуто':''].filter(Boolean).join(' · ')||'Состояние окна не указано';item.append(title,detail);windows.append(item);}
  for(const control of observation.controls??[]){const item=element('li'),title=element('strong'),detail=element('small');title.textContent=control.name;detail.textContent=[control.role,control.selected===true?'выбрано':'',control.toggleState,control.expandState].filter(Boolean).join(' · ')||'Состояние элемента не указано';item.append(title,detail);controls.append(item);}
  if(!observation.windows?.length){const item=element('li');item.textContent='Окон в снимке нет.';windows.append(item);}
  if(!observation.controls?.length){const item=element('li');item.textContent='Элементы текущего окна не наблюдались.';controls.append(item);}
}
function renderAgentResponses(responses){
  const panel=$('agent-response-panel'),list=$('agent-responses');if(!panel||!list)return;list.replaceChildren();hidden('agent-response-panel',!(responses?.length));
  for(const response of responses??[]){const item=element('li');item.textContent=response.text;list.append(item);}
}
function renderReadableLog(report){
  const panel=$('readable-log');if(!panel)return;const model=formatLogView(report??{});hidden('readable-log',false);text('readable-log-intro',model.agentMode?'Здесь показано, какие данные получил Jeff, какие операции выполнил и что было подтверждено.':'Здесь показаны выбранные варианты, вероятность выбора и уверенность модели отдельно. Идентификаторы вариантов оставлены только в технических данных ниже.');renderDataSent(model.dataSent);renderCapabilities(model.capabilities,model.context);renderDecisionSteps(model.decisions);renderExecutionSteps(model.executions);renderReadableObservation(model.observation);renderAgentResponses(model.agentResponses);
}
async function hydrateCapabilities(report){
  const hasCapabilities=Array.isArray(report?.capabilities)||Array.isArray(report?.capabilities?.capabilities);
  if(hasCapabilities||typeof api?.capabilities!=='function')return;
  try{
    const capabilities=checked(await api.capabilities());
    if(detailReport!==report)return;
    detailReport={...report,capabilities};renderReadableLog(detailReport);
  }catch{}
}
function renderSnapshot(snapshot){
  $('windows').replaceChildren();$('elements').replaceChildren();
  if(!snapshot){text('summary','Наблюдение пока не запрашивалось.');text('facts','');return;}
  text('summary',`Доступно окон: ${snapshot.windows?.length??0}`);text('snapshot-version',snapshot.metadata?.truncated?'Наблюдение неполное':'');
  for(const win of snapshot.windows??[]){const li=document.createElement('li');li.textContent=`${win.title} — ${win.minimized?'свёрнуто':win.active?'на переднем плане':'открыто'}`;$('windows').append(li);}
  for(const element of snapshot.elements??[]){if(element.role==='Window')continue;const li=document.createElement('li');li.textContent=element.name||element.label||element.role;$('elements').append(li);}
  text('facts',pretty(snapshot));
}
async function openDetails(report=lastReport){
  detailReport=report;
  text('detail-title',report?.command||'Подробности задачи');text('detail-summary',report?describeResult(report).message:'События текущей задачи');
  const detailsReport=report??{status:'running',runId:currentRunId,events:progressEvents};
  renderReadableLog(detailsReport);text('trace',pretty(detailsReport));renderSnapshot(report?.final??null);await hydrateCapabilities(detailsReport);
  if(!$('details-dialog').open)$('details-dialog').showModal();
}
async function refreshProviders(){
  try{
    const result=checked(await api.voiceStatus());
    for(const [id,key,label] of [['provider-gemini','gemini','Gemini'],['provider-denis','denis','Денис'],['provider-wake','wake','Hey Jarvis']]){
      text(id,result.providers?.[key]===true?`${label} настроен`:`${label} недоступен`);$(id).dataset.available=String(result.providers?.[key]===true);
    }
    text('version-label',result.version?`Версия ${result.version}`:'Assistant Jeff');
  }catch(error){text('provider-gemini',failure(error).message);}
}
for(const button of document.querySelectorAll('[data-view]'))button.addEventListener('click',()=>navigate(button.dataset.view));
for(const button of document.querySelectorAll('[data-example]'))button.addEventListener('click',()=>{$('command').value=examples[button.dataset.example]??'';sync();$('command').focus();});
$('command').addEventListener('input',()=>{hidden('voice-transcript',true);sync();});$('command').addEventListener('keydown',event=>{if(event.key==='Enter'&&(event.ctrlKey||event.metaKey)){event.preventDefault();void run();}});
$('run').addEventListener('click',()=>void run());$('stop').addEventListener('click',()=>void stop());
$('new-conversation').addEventListener('click',()=>void newConversation());
$('voice-manual').addEventListener('click',async()=>{if(busy())return;clearNotice();clearTranscript();lastReport=null;activeSource='voice';if(voiceState.enabled)await voice.activate();else await voice.start('manual');});
$('voice-wake').addEventListener('click',async()=>{if(!voice)return;if(voiceState.enabled||voiceState.busy)await stop();else{clearNotice();await voice.start('wake');}});
$('voice-finish').addEventListener('click',()=>void voice?.finish());
for(const [id,key] of [['voice-beep','activationBeep'],['voice-reply','denisReply'],['voice-auto','voiceAutoExecute']])$(id).addEventListener('change',()=>void voice?.setSettings({[key]:$(id).checked}));
$('voice-mode').addEventListener('change',()=>void voice?.setSettings({transcriptionMode:$('voice-mode').value}));
$('edit-command').addEventListener('click',()=>{if(busy())return;if(lastReport?.command)$('command').value=lastReport.command;sync();$('command').focus();$('command').scrollIntoView({block:'center',behavior:'smooth'});});
$('show-details').addEventListener('click',()=>openDetails());$('close-details').addEventListener('click',()=>$('details-dialog').close());
$('history-refresh').addEventListener('click',()=>void loadHistory());$('reminder-dismiss').addEventListener('click',()=>void dismissReminder());
$('open-logs').addEventListener('click',async()=>{try{checked(await api.openLogs());}catch(error){text('history-status',failure(error).message);}});
$('start').addEventListener('click',async()=>{$('start').disabled=true;try{renderSnapshot(checked(await api.state()).snapshot);}catch(error){text('summary',failure(error).message);}finally{$('start').disabled=false;}});
if(api){
  voice=new VoiceClient(api,{onState:renderVoiceState,onEvent:event=>{void voiceEvent(event).catch(voiceError);},onError:voiceError});
  const unsubscribe=api.onProgress(acceptProgress);void voice.initialize();void refreshProviders();
  window.addEventListener('beforeunload',()=>{clearInterval(ticker);unsubscribe();void voice.dispose();},{once:true});
}else{
  note({tone:'error',title:'Не удалось подключиться к Jeff',message:'Откройте приложение через установленный ярлык.'});
  for(const id of ['run','voice-manual','voice-wake','history-refresh'])$(id).disabled=true;
}
sync();
