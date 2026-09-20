// Source Electron regression smoke: real main/preload/renderer and local journals,
// fake desktop/provider/audio boundaries. Never opens a microphone or calls an API.
// Run: .\node_modules\.bin\electron.cmd scripts/test-friendly-ui.mjs --mock-only [--screenshots]
import assert from 'node:assert/strict';
import {app,BrowserWindow} from 'electron';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WindowsBridge} from './windows-desktop/bridge.mjs';
import {InstalledApps} from '../desktop/automation/windows-apps.mjs';
import {GeminiGateway} from '../desktop/providers/gemini.mjs';
import {DenisVoice} from '../desktop/audio/denis.mjs';
import {Mp3Encoder} from '../desktop/audio/mp3.mjs';
import {RunJournal} from './desktop-lab/journal.mjs';
import {UnifiedCommands} from '../desktop/automation/assistant-commands.mjs';

if(!process.argv.includes('--mock-only')){
  console.error('Requires --mock-only. This harness must never use live providers.');
  app.exit(2);
}else void main();

async function main(){
  const root=fileURLToPath(new URL('../',import.meta.url));
  const directory=path.join(root,'work',`ui-smoke-friendly-${Date.now()}`);
  const data=path.join(directory,'data');
  const checks=[],speech=[],screenshots=[],blocked={desktop:0,launch:0,network:0,microphone:0};
  let nextTranscript=null,syntheticTranscriptions=0,desktopExecutions=0;
  const clarificationCommand='Напомни завтра проверить чай.';
  const controls=new Map();
  const snapshot={version:'fixture-v1',windows:[],elements:[],facts:{},metadata:{fixture:true}};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const pass=(name,details={})=>checks.push({name,ok:true,...details});
  let lab,window,db,js;
  async function until(check,label,timeout=15000){
    const started=Date.now();
    while(Date.now()-started<timeout){if(await check())return;await pause(40);}
    throw new Error(`UI_SMOKE_TIMEOUT: ${label}`);
  }
  function forbidden(counter){return async()=>{blocked[counter]++;throw new Error(`SMOKE_FORBIDDEN_${counter.toUpperCase()}`);};}
  async function capturePair(label){
    if(!process.argv.includes('--screenshots'))return;
    // Chromium on Windows may never paint a window that has remained hidden.
    // Screenshot mode briefly shows only this isolated fixture window, without
    // stealing focus; the normal regression run remains hidden throughout.
    window.showInactive();
    for(const [width,height] of [[1100,800],[760,620]]){
      let timer;
      try{
        window.setContentSize(width,height);await pause(200);
        await js(label==='failed'?'document.getElementById("task-card").scrollIntoView({block:"nearest",behavior:"instant"})':'window.scrollTo(0,0)');
        const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SCREENSHOT_TIMEOUT')),4000);})]);
        assert.equal(image.isEmpty(),false,'Screenshot is non-empty');
        const file=path.join(directory,`${label}-${width}x${height}.png`);await writeFile(file,image.toPNG());
        screenshots.push({label,width,height,file,actualSize:image.getSize(),ok:true});
      }catch(error){screenshots.push({label,width,height,ok:false,error:error.message});}
      finally{clearTimeout(timer);}
    }
    window.hide();window.setContentSize(1100,800);
  }
  try{
    await mkdir(data,{recursive:true});
    process.env.JEFF_DATA_DIR=data;
    if(!process.argv.includes('--windows-smoke'))process.argv.push('--windows-smoke');
    // Main sets the smoke profile; give each run its own isolated profile too.
    const setPath=app.setPath.bind(app);
    app.setPath=(name,value)=>setPath(name,name==='userData'?path.join(directory,'profile'):value);
    WindowsBridge.prototype.startProcess=forbidden('desktop');
    WindowsBridge.prototype.request=async function(method){
      if(method==='observe')return structuredClone(snapshot);
      blocked.desktop++;throw new Error('SMOKE_FORBIDDEN_DESKTOP_EFFECT');
    };
    InstalledApps.prototype.launch=forbidden('launch');
    InstalledApps.prototype.list=async()=>[];
    const runCommands=UnifiedCommands.prototype.run;
    UnifiedCommands.prototype.run=function(payload){
      this.interpret=async(text,{onEvent})=>{
        await onEvent({phase:'intent_request',kind:'intent_route',callIndex:0,request:{state:{latest_user_command:text}}});
        const result=text===clarificationCommand?{route:'reminder',needsClarification:true,message:'Во сколько завтра?',clarification:{field:'time',day:'завтра',text:'проверить чай'}}:{route:'desktop',decision:{choice:'desktop',confidence:.99,probability:.99}};
        await onEvent({phase:'intent_response',kind:'intent_route',callIndex:0,response:result,latencyMs:1});return result;
      };
      return runCommands.call(this,payload);
    };
    GeminiGateway.prototype.available=async()=>true;
    for(const name of ['connect','request','chat','createTranscriptionStream'])GeminiGateway.prototype[name]=forbidden('network');
    GeminiGateway.prototype.transcribe=async()=>{
      assert.notEqual(nextTranscript,null,'Unexpected transcription attempt');
      const text=nextTranscript;nextTranscript=null;syntheticTranscriptions++;
      return {text,model:'fixture-transcribe',latencyMs:1};
    };
    Mp3Encoder.prototype.available=async()=>true;
    Mp3Encoder.prototype.encode=async()=>Buffer.from('ID3-synthetic-fixture');
    DenisVoice.prototype.status=async()=>({available:true,voice:'Денис'});
    DenisVoice.prototype.synthesize=async(text,{signal}={})=>{
      signal?.throwIfAborted();speech.push(text);
      const wav=Buffer.alloc(364);wav.write('RIFF');wav.writeUInt32LE(356,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(320,40);
      return {wav,mimeType:'audio/wav',durationMs:10};
    };
    app.on('browser-window-created',(_event,created)=>{created.hide();created.webContents.setAudioMuted(true);});
    ({lab}=await import('./desktop-lab/main.mjs'));
    lab.run=async function({command,signal}){
      const control=controls.get(command);assert.ok(control,`Unregistered fixture command: ${command}`);
      desktopExecutions++;
      this.running=true;
      const started=performance.now();
      const journal=await RunJournal.create(command,{directory:this.directory});
      this.activeRunId=journal.runId;control.started=true;
      if(control.holdProgress)await new Promise(resolve=>{control.sendProgress=resolve;signal?.addEventListener('abort',resolve,{once:true});});
      const event=await journal.record('desktop_start',{message:'Fixture desktop state received.'});this.progress(event);
      await new Promise(resolve=>{control.release=resolve;if(signal?.aborted)resolve();else signal?.addEventListener('abort',resolve,{once:true});});
      const reason=signal?.aborted?'aborted':control.reason;
      const report={mode:'REAL_WINDOWS_DESKTOP',command,runId:journal.runId,logPath:journal.jsonPath,createdAt:new Date().toISOString(),ok:reason==='goal_verified',reason,elapsedMs:Math.round(performance.now()-started),calls:[],trace:journal.events,events:journal.events,completed:[],final:structuredClone(snapshot)};
      const result=await journal.record('result',{ok:report.ok,reason});this.progress(result);
      await journal.finish(report);control.report=report;
      this.running=false;this.activeRunId=null;
      return report;
    };
    await app.whenReady();
    await until(()=>BrowserWindow.getAllWindows().length===1,'one isolated app window');
    window=BrowserWindow.getAllWindows()[0];window.hide();
    js=source=>window.webContents.executeJavaScript(source,true);
    await until(async()=>!window.webContents.isLoadingMainFrame()&&await js('Boolean(window.lab && document.getElementById("task-card") && !document.getElementById("voice-manual").disabled)'),'new UI ready');
    await js(`(async()=>{window.__smoke={plays:0,pauses:0,captures:0,speechEvents:[],autoEnd:true,audios:[],errors:[]};
      window.addEventListener('error',event=>window.__smoke.errors.push(String(event.message)));
      window.addEventListener('unhandledrejection',event=>window.__smoke.errors.push(String(event.reason)));
      navigator.mediaDevices.getUserMedia=async()=>{window.__smoke.captures++;throw new Error('SMOKE_MICROPHONE_FORBIDDEN');};
      window.Audio=class {constructor(){window.__smoke.audios.push(this);} async play(){window.__smoke.plays++;if(window.__smoke.autoEnd)setTimeout(()=>this.onended?.(),80);}pause(){window.__smoke.pauses++;}};
      window.lab.onVoiceEvent(event=>{if(event.type==='speech')window.__smoke.speechEvents.push({id:event.id,source:event.source,operationId:event.operationId,bytes:event.wav?.length});});
      const {Microphone}=await import(new URL('../../desktop/renderer/audio.js',location.href).href);
      Microphone.prototype.start=async function(){};Microphone.prototype.stop=async function(){};})();`);
    const loaded=await js('({footer:document.getElementById("footer-status").textContent,runDisabled:document.getElementById("run").disabled,noticeHidden:document.getElementById("voice-notice").hidden})');
    assert.match(loaded.footer,/выключен/u);assert.equal(loaded.runDisabled,true);assert.equal(loaded.noticeHidden,true);
    pass('Initial state: microphone off, empty command disabled, no error notice');
    await capturePair('initial');
    async function submit(command,reason,options={}){
      const control={reason,...options};controls.set(command,control);
      await js(`document.getElementById('command').value=${JSON.stringify(command)};document.getElementById('command').dispatchEvent(new Event('input'));document.getElementById('run').click();`);
      await until(()=>control.started&&(control.holdProgress||typeof control.release==='function'),'mock command started');
      assert.equal(await js('document.getElementById("run").disabled && document.getElementById("command").disabled && !document.getElementById("stop").hidden && document.getElementById("task-card").getAttribute("aria-busy")==="true"'),true);
      return control;
    }
    async function settled(){await until(()=>js('!document.getElementById("run").disabled && document.getElementById("task-card").getAttribute("aria-busy")==="false"'),'task and narration settled');}
    const success=await submit('Проверка успешной задачи.','goal_verified');
    await until(()=>js('document.getElementById("activity").textContent==="Смотрю открытые приложения"'),'desktop child progress under semantic parent');
    pass('Nested desktop progress remains visible under the semantic parent task');
    success.release();await settled();
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'success');
    assert.match(await js('document.getElementById("result-message").textContent'),/выполнена/u);
    pass('Typed success: run → busy → confirmed result');
    await js('window.__smoke.autoEnd=false;');
    const failure=await submit('Проверка недоступного приложения.','APP_ELEVATION_REQUIRED');failure.release();
    await until(()=>js('window.__smoke.plays===2'),'typed failure playback started');
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'error');
    assert.match(await js('document.getElementById("result-title").textContent'),/Не получилось/u);
    assert.match(await js('document.getElementById("result-message").textContent'),/администратора/u);
    assert.equal(await js('document.getElementById("run").disabled'),true);
    assert.match(await js('document.getElementById("footer-status").textContent'),/микрофон выключен/ui);
    assert.equal(speech.at(-1),'Не получилось открыть приложение.');
    assert.equal(await js('window.__smoke.speechEvents.at(-1).source'),'typed');
    pass('Typed failure: useful visible reason and speech delivered with microphone off');
    await js('window.__smoke.autoEnd=true;window.__smoke.audios.at(-1).onended?.();');await settled();
    assert.equal(await js('window.__smoke.plays'),2);
    pass('Speech acknowledgement releases controls without duplicate playback');
    await capturePair('failed');
    const stopped=await submit('Проверка остановки задачи.','goal_verified');
    await js('document.getElementById("stop").click();');await settled();
    assert.equal(stopped.report.reason,'aborted');
    assert.match(await js('document.getElementById("result-title").textContent'),/остановлено/u);
    assert.equal(await js('window.__smoke.plays'),2);
    pass('Stop: executor aborted, final stopped result, no late success narration');
    const staleControl=await submit('Проверка запоздалого результата.','goal_verified',{holdProgress:true});
    const oldOperation=await js('window.__smoke.speechEvents[0].operationId');
    window.webContents.send('lab:voice',{type:'result',source:'typed',operationId:oldOperation,report:success.report});
    await pause(120);
    assert.equal(await js('document.getElementById("task-card").getAttribute("aria-busy")'),'true','An old result must not finish the newly started task before its first progress event');
    assert.equal(await js('document.getElementById("task-command").textContent'),'Проверка запоздалого результата.');
    pass('Late result from an older operation cannot replace a new task before its first progress');
    staleControl.sendProgress();await until(()=>typeof staleControl.release==='function','delayed fixture progress released');
    await js('window.__smoke.autoEnd=false;');staleControl.release();
    await until(()=>js('window.__smoke.plays===3'),'success narration started for stop test');
    await js('document.getElementById("stop").click();');await settled();
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'success','Stopping narration preserves an already confirmed result');
    assert.equal(await js('window.__smoke.plays'),3);
    assert.match(await js('document.getElementById("footer-status").textContent'),/выключен/u);
    pass('Stop during narration cancels playback and preserves the confirmed task outcome');
    const savedTitle=await js('document.getElementById("result-title").textContent');
    window.webContents.send('lab:progress',{phase:'model_request',runId:success.report.runId,message:'Late progress must not replace the result.'});
    window.webContents.send('lab:voice',{type:'status',source:'typed',operationId:oldOperation,state:'speaking',message:'Late speech status.'});
    await pause(120);
    assert.equal(await js('document.getElementById("result-title").textContent'),savedTitle);
    assert.equal(await js('document.getElementById("run").disabled'),false);
    pass('Late progress and speech status cannot revive a finished task');
    await js('window.__smoke.autoEnd=true;document.getElementById("voice-beep").checked=false;document.getElementById("voice-beep").dispatchEvent(new Event("change"));');
    await until(()=>js('window.lab.voiceStatus().then(status=>status.settings.activationBeep===false)'),'beep disabled for synthetic capture');
    assert.equal(await js('document.getElementById("voice-mode").value'),'live');
    for(const mode of ['batch','live','batch']){
      await js(`document.getElementById('voice-mode').value=${JSON.stringify(mode)};document.getElementById('voice-mode').dispatchEvent(new Event('change'));`);
      await until(()=>js(`window.lab.voiceStatus().then(status=>status.settings.transcriptionMode===${JSON.stringify(mode)})`),'transcription mode persisted');
      assert.equal(await js('document.getElementById("voice-mode").value'),mode);
    }
    pass('Settings: live defaults and live/batch selection round-trips through main');
    const executionsBeforePartialStop=desktopExecutions;
    await js('document.getElementById("voice-manual").click();');
    await until(()=>js('document.getElementById("voice-state").textContent==="Слушаю команду"'),'capture for partial cancellation');
    window.webContents.send('lab:voice',{type:'transcript',source:'voice',text:'Незаконченная команда',final:false});
    await until(()=>js('!document.getElementById("voice-transcript").hidden'),'partial caption before Stop');
    await js('document.getElementById("stop").click();');
    await until(()=>js('!document.getElementById("voice-manual").disabled'),'capture cancelled');
    window.webContents.send('lab:voice',{type:'transcript',source:'voice',text:'Запоздалая команда',final:false});
    await pause(80);
    assert.equal(await js('document.getElementById("voice-transcript").hidden'),true);assert.equal(desktopExecutions,executionsBeforePartialStop);
    pass('Stop clears unfinished caption and rejects late partial speech without execution');
    async function recordSynthetic(text,{speechFrames=true,preview=false}={}){
      nextTranscript=text;
      await js('document.getElementById("voice-manual").click();');
      await until(()=>js('document.getElementById("voice-state").textContent==="Слушаю команду"'),'synthetic manual recording started');
      assert.equal(await js('document.getElementById("voice-transcript").hidden'),true,'New capture clears the previous caption');
      if(preview){
        const before=await js('document.getElementById("command").value'),executions=desktopExecutions;
        window.webContents.send('lab:voice',{type:'stream_status',source:'voice',state:'connecting'});
        await until(()=>js('document.getElementById("voice-status").textContent.includes("Уже можно говорить")'),'friendly connecting phase');
        window.webContents.send('lab:voice',{type:'stream_status',source:'voice',state:'live'});
        window.webContents.send('lab:voice',{type:'transcript',source:'voice',text:'Промежуточная фраза',final:false});
        await until(()=>js('document.getElementById("voice-transcript").textContent==="Промежуточная фраза"'),'partial caption shown');
        assert.equal(await js('document.getElementById("command").value'),before);assert.equal(desktopExecutions,executions);
        assert.equal(await js('document.getElementById("run").disabled'),true);
        assert.equal(await js('document.getElementById("voice-mode").disabled'),true);
        pass('Partial speech is visible while executable command stays untouched and execution remains blocked');
      }
      if(speechFrames)await js('for(let i=0;i<4;i++)window.lab.audioChunk(new Int16Array(1280).fill(2000));void 0;');
      await js('document.getElementById("voice-finish").click();');
    }
    const voiceCommand='Проверка остановки голосовой задачи.';
    const voiceControl={reason:'goal_verified'};controls.set(voiceCommand,voiceControl);
    await recordSynthetic(voiceCommand,{preview:true});await until(()=>voiceControl.started,'synthetic voice command executing');
    assert.equal(await js('document.getElementById("task-card").getAttribute("aria-busy")'),'true');
    const playsBeforeVoiceStop=await js('window.__smoke.plays');
    await js('document.getElementById("stop").click();');await settled();
    assert.equal(voiceControl.report.reason,'aborted');
    assert.match(await js('document.getElementById("result-title").textContent'),/остановлено/u);
    assert.equal(await js('window.__smoke.plays'),playsBeforeVoiceStop);
    pass('Voice Stop: synthetic PCM → final transcript → stopped execution releases pending UI without speech');
    const executionsBeforeNotices=controls.size;
    await recordSynthetic(null,{speechFrames:false});
    await until(()=>js('!document.getElementById("voice-manual").disabled && document.getElementById("footer-status").textContent.includes("выключен")'),'no-speech recording stopped');
    await pause(120);
    assert.equal(await js('document.getElementById("voice-notice").hidden'),false);
    assert.match(await js('document.getElementById("voice-notice-title").textContent'),/Не услышал/u);
    assert.match(await js('document.getElementById("voice-transcript").textContent'),/нет/u);
    pass('No-speech notice remains visible after manual microphone state returns to off');
    await recordSynthetic('');
    await until(()=>js('!document.getElementById("voice-manual").disabled && document.getElementById("footer-status").textContent.includes("выключен")'),'empty-transcript recording stopped');
    await pause(120);
    assert.equal(await js('document.getElementById("voice-notice").hidden'),false);
    assert.match(await js('document.getElementById("voice-notice-title").textContent'),/разобрать речь/u);
    assert.equal(controls.size,executionsBeforeNotices);
    pass('Empty transcript shows persistent explanation without executing a command');
    await js('document.getElementById("voice-auto").checked=false;document.getElementById("voice-auto").dispatchEvent(new Event("change"));');
    await until(()=>js('window.lab.voiceStatus().then(status=>status.settings.voiceAutoExecute===false)'),'review-only setting persisted');
    const playsBeforeReview=await js('window.__smoke.plays');
    await recordSynthetic('Проверьте этот текст перед выполнением.');
    await until(()=>js('!document.getElementById("voice-manual").disabled && document.getElementById("footer-status").textContent.includes("выключен")'),'review-only recording stopped');
    assert.equal(await js('document.getElementById("command").value'),'Проверьте этот текст перед выполнением.');
    assert.equal(await js('document.getElementById("run").disabled'),false);
    assert.equal(await js('window.__smoke.plays'),playsBeforeReview);
    assert.equal(controls.size,executionsBeforeNotices);
    pass('Review-only transcription leaves editable command, capture off, no execution or narration');
    await js('document.querySelector("[data-view=history]").click();');
    await until(()=>js('document.querySelectorAll("#history-list button").length>=5'),'saved history entries');
    await js('document.querySelector("#history-list button").click();');
    await until(()=>js('document.getElementById("details-dialog").open'),'history details open');
    const detail=await js('JSON.parse(document.getElementById("trace").textContent)');
    assert.equal(detail.reason,'aborted');assert.ok(detail.events.some(event=>event.phase==='desktop_start'));
    pass('History: all five outcomes saved; entry opens full event details');
    await js('document.getElementById("close-details").click();document.querySelector("[data-view=assistant]").click();');
    db=new DatabaseSync(path.join(data,'assistant.sqlite'));
    const reminder=Number(db.prepare('INSERT INTO reminders(text,due_at,created_at) VALUES(?,?,?)').run('Тестовое напоминание интерфейса',1,1).lastInsertRowid);
    window.webContents.send('lab:voice',{type:'reminder',id:reminder,text:'Тестовое напоминание интерфейса'});
    await until(()=>js('!document.getElementById("reminder-card").hidden'),'reminder notice shown');
    await js('document.getElementById("reminder-dismiss").click();');
    await until(()=>js('document.getElementById("reminder-card").hidden'),'reminder dismissed');
    assert.ok(db.prepare('SELECT delivered_at FROM reminders WHERE id=?').get(reminder).delivered_at>0);
    pass('Reminder dismissal persists delivered_at in isolated SQLite');
    const executionsBeforeClarification=desktopExecutions;
    await js(`document.getElementById('command').value=${JSON.stringify(clarificationCommand)};document.getElementById('command').dispatchEvent(new Event('input'));document.getElementById('run').click();`);
    await until(()=>js('document.getElementById("result-message").textContent==="Во сколько завтра?"'),'semantic clarification shown');
    await settled();await pause(100);
    assert.equal(await js('document.getElementById("result-message").textContent'),'Во сколько завтра?');
    assert.equal(await js('document.getElementById("task-state").textContent'),'Нужно уточнение');
    assert.equal(await js('document.getElementById("task-card").hidden'),false);assert.equal(desktopExecutions,executionsBeforeClarification);
    assert.equal(speech.at(-1),'Во сколько завтра?');
    pass('Clarification remains visible after narration and off status without desktop execution');
    await js('document.querySelector("[data-view=settings]").click();');
    await until(()=>js('document.getElementById("provider-gemini").textContent.includes("настроен")'),'mock provider status shown in settings');
    await js('document.getElementById("voice-mode").value="live";document.getElementById("voice-mode").dispatchEvent(new Event("change"));');
    await until(()=>js('window.lab.voiceStatus().then(status=>status.settings.transcriptionMode==="live")'),'live mode restored for settings preview');
    await capturePair('settings');
    const renderer=await js('({plays:window.__smoke.plays,pauses:window.__smoke.pauses,captures:window.__smoke.captures,speechEvents:window.__smoke.speechEvents,errors:window.__smoke.errors})');blocked.microphone=renderer.captures;
    assert.deepEqual(blocked,{desktop:0,launch:0,network:0,microphone:0});assert.deepEqual(renderer.errors,[]);
    pass('No desktop effects, process launch, network API, microphone capture or renderer exceptions');
    const result={ok:true,checks,speech,screenshots,blocked,syntheticTranscriptions,directory,data,renderer:{plays:renderer.plays,pauses:renderer.pauses,speechEvents:renderer.speechEvents,errors:renderer.errors}};
    await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify({ok:true,checks:checks.length,directory,blocked}));
  }catch(error){
    const result={ok:false,error:error.stack,checks,speech,blocked,directory};
    await writeFile(path.join(directory,'result.json'),JSON.stringify(result,null,2)+'\n').catch(()=>{});
    if(window&&!window.isDestroyed()){
      if(js)await js('({body:document.body.innerText,errors:window.__smoke?.errors,plays:window.__smoke?.plays})').then(state=>writeFile(path.join(directory,'failure-state.json'),JSON.stringify(state,null,2))).catch(()=>{});
    }
    console.error(JSON.stringify({ok:false,error:error.message,checks:checks.length,directory}));process.exitCode=1;
  }finally{db?.close();lab?.dispose();app.exit(process.exitCode??0);}
}
