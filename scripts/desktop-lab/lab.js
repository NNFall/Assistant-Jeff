'use strict';
import {VoiceClient} from './voice-client.mjs';
import {describeResult,describeError} from '../../desktop/automation/feedback.mjs';

const $=id=>document.getElementById(id);
const api=window.lab;
const examples={taskmgr:'Открой диспетчер задач.',reminder:'Напомни через 10 минут проверить чай.',note:'Заметка: купить хлеб.',question:'Объясни, что такое оперативная память.'};
let voice,voiceState={state:'off',enabled:false,busy:false,ready:false,settings:{activationBeep:true,denisReply:true,voiceAutoExecute:true},providers:{}};
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
function taskClock(){if(startedAt&&pending)text('task-time',duration(performance.now()-startedAt));}
function sync(){
  const active=busy();
  $('run').disabled=!api||active||!$('command').value.trim()||$('command').value.length>1024;
  $('command').disabled=active;
  $('voice-manual').disabled=!voiceState.ready||active;
  $('voice-finish').disabled=voiceState.state!=='recording'||stopping;hidden('voice-finish',voiceState.state!=='recording');
  $('stop').disabled=stopping;hidden('stop',!active);
  $('voice-wake').disabled=!voiceState.ready||active;
  $('voice-wake').setAttribute('aria-pressed',String(voiceState.enabled));
  text('voice-wake-label',voiceState.enabled?'Выключить Jarvis':'Включить Jarvis');
  text('counter',`${$('command').value.length} / 1024`);
  for(const button of document.querySelectorAll('[data-example]'))button.disabled=active;
  for(const id of ['voice-beep','voice-reply','voice-auto'])$(id).disabled=!voiceState.ready||active;
  text('voice-manual-label','Сказать команду');
  const voiceLabel=voiceState.source==='typed'&&!voiceState.enabled&&voiceState.state==='processing'?'Микрофон выключен':states[voiceState.state]||'Голосовой ввод';
  const headline=stopping?'Останавливаю':voiceState.state==='speaking'?voiceLabel:pending?$('activity').textContent||'Выполняю задачу':voiceState.enabled||voiceState.busy?voiceLabel:'Готов к задаче';
  text('status',headline);$('status-indicator').dataset.state=stopping?'stopping':active?'busy':voiceState.enabled?'listening':'idle';
  text('voice-state',voiceLabel);$('voice-state').dataset.active=String(voiceState.enabled||voiceState.state==='speaking');
  text('footer-status',voiceState.enabled?'Микрофон включён':voiceState.state==='speaking'?'Звучит ответ · микрофон выключен':'Микрофон выключен');
  $('voice-wave').dataset.state=voiceState.state;hidden('voice-wave',!['recording','transcribing','speaking'].includes(voiceState.state));
  text('hero-title',voiceState.state==='recording'?'Я слушаю':voiceState.state==='transcribing'?'Распознаю вашу команду':lastReport&&pending?'Результат готов':pending?'Занимаюсь вашей задачей':'Что нужно сделать?');
  text('hero-subtitle',voiceState.state==='recording'?'Говорите. После паузы в 2,5 секунды запись завершится.':voiceState.state==='transcribing'?'Запись закончена. Получаю текст из Gemini.':lastReport&&pending?'Ответ уже на экране. Озвучку можно остановить.':pending?'Показываю ход выполнения. Вы можете остановить меня.':'Скажите или напишите задачу — я покажу каждый шаг.');
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
  let label=phaseLabels[event.phase];
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
  text('task-command',report.command||$('task-command').textContent||'Задача');text('task-state',feedback.tone==='success'?'Готово':feedback.tone==='neutral'?'Завершено':feedback.tone==='warning'?'Нужна проверка':'Не получилось');
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
  voiceState=state;
  for(const [id,key] of [['voice-beep','activationBeep'],['voice-reply','denisReply'],['voice-auto','voiceAutoExecute']])$(id).checked=state.settings[key]===true;
  text('voice-status',state.message||(['off','stopped','idle'].includes(state.state)?'Нажмите «Сказать команду» для одной записи.':state.state==='waiting'?'Произнесите «Hey Jarvis», затем задачу.':state.state==='speaking'?'Результат уже доступен ниже.':states[state.state]||'Голосовой ввод'));text('voice-silence',duration(state.silenceMs));
  if(state.source==='voice'&&state.state==='processing'&&!pending&&activeSource!=='typed')startTask($('command').value,'voice');
  sync();
}
async function voiceEvent(event){
  if(event.type==='wake'){
    clearNotice();lastReport=null;activeSource='voice';text('voice-transcript','');hidden('voice-transcript',true);hidden('task-card',true);hidden('welcome',true);
  }else if(event.type==='transcript'&&event.final===true){
    $('command').value=event.text;hidden('voice-transcript',false);text('voice-transcript',event.autoExecute===false?'Команда распознана. Проверьте текст и нажмите «Выполнить».':'Команда распознана.');sync();
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
      button.append(heading,meta,outcome);button.addEventListener('click',async()=>{button.disabled=true;try{openDetails(checked(await api.readRun({runId:item.runId})));}catch(error){text('history-status',failure(error).message);}finally{button.disabled=false;}});row.append(button);$('history-list').append(row);
    }
  }catch(error){text('history-status',failure(error).message);}
  finally{historyLoading=false;$('history-refresh').disabled=false;}
}
function renderSnapshot(snapshot){
  $('windows').replaceChildren();$('elements').replaceChildren();
  if(!snapshot){text('summary','Наблюдение пока не запрашивалось.');text('facts','');return;}
  text('summary',`Доступно окон: ${snapshot.windows?.length??0}`);text('snapshot-version',snapshot.metadata?.truncated?'Наблюдение неполное':'');
  for(const win of snapshot.windows??[]){const li=document.createElement('li');li.textContent=`${win.title} — ${win.minimized?'свёрнуто':win.active?'на переднем плане':'открыто'}`;$('windows').append(li);}
  for(const element of snapshot.elements??[]){if(element.role==='Window')continue;const li=document.createElement('li');li.textContent=element.name||element.label||element.role;$('elements').append(li);}
  text('facts',pretty(snapshot));
}
function openDetails(report=lastReport){
  detailReport=report;
  text('detail-title',report?.command||'Подробности задачи');text('detail-summary',report?describeResult(report).message:'События текущей задачи');
  text('trace',pretty(report??{status:'running',runId:currentRunId,events:progressEvents}));renderSnapshot(report?.final??null);
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
$('voice-manual').addEventListener('click',async()=>{if(busy())return;clearNotice();lastReport=null;activeSource='voice';if(voiceState.enabled)await voice.activate();else await voice.start('manual');});
$('voice-wake').addEventListener('click',async()=>{if(!voice)return;if(voiceState.enabled||voiceState.busy)await stop();else{clearNotice();await voice.start('wake');}});
$('voice-finish').addEventListener('click',()=>void voice?.finish());
for(const [id,key] of [['voice-beep','activationBeep'],['voice-reply','denisReply'],['voice-auto','voiceAutoExecute']])$(id).addEventListener('change',()=>void voice?.setSettings({[key]:$(id).checked}));
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
