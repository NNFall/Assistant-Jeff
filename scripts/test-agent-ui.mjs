// Real Electron main/preload/renderer, Jev facade/loop and isolated SQLite.
// Every external boundary is replaced before main loads; no live providers,
// Windows actions or microphone. Run with electron.cmd ... --mock-only [--screenshots].
import assert from 'node:assert/strict';
import {app,BrowserWindow} from 'electron';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import childProcess from 'node:child_process';
import {syncBuiltinESMExports} from 'node:module';
import {WindowsBridge} from './windows-desktop/bridge.mjs';
import {WindowsDesktop} from './windows-desktop/controller.mjs';
import {InstalledApps} from '../desktop/automation/windows-apps.mjs';
import {GeminiGateway} from '../desktop/providers/gemini.mjs';
import {DenisVoice} from '../desktop/audio/denis.mjs';
import {Mp3Encoder} from '../desktop/audio/mp3.mjs';
import {VoiceSession} from '../desktop/audio/session.mjs';

if(!process.argv.includes('--mock-only')){
  console.error('Requires --mock-only. This harness must never use live providers.');
  app.exit(2);
}else void main();

async function main(){
  const root=fileURLToPath(new URL('../',import.meta.url));
  await mkdir(path.join(root,'work'),{recursive:true});
  const directory=await mkdtemp(path.join(root,'work','ui-smoke-agent-'));
  const data=path.join(directory,'data');
  const checks=[],screenshots=[],modelCalls=[],jevCalls=[],nativeCalls=[],reports=[],speech=[];
  const blocked={network:0,native:0,launch:0,microphone:0,encoder:0};
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const pass=(name,details={})=>checks.push({name,ok:true,...details});
  const forbid=counter=>async()=>{blocked[counter]++;throw new Error(`SMOKE_FORBIDDEN_${counter.toUpperCase()}`);};
  const snapshot={version:'a'.repeat(32),windows:[],elements:[],facts:{},metadata:{fixture:true}};
  const fixtureKey='ui-fixture-only-not-a-real-key';
  let desktopState={revision:1,selected:null,wrapped:false,minimized:false};
  const desktopSnapshot=()=>{
    const win={id:'win_smoke_editor',title:'Редактор проверки',processName:'smoke_editor',stateVersion:desktopState.revision.toString(16).padStart(64,'0'),active:!desktopState.minimized,minimized:desktopState.minimized,maximized:false};
    return {version:desktopState.revision.toString(16).padStart(32,'0'),windows:[win],elements:[
      {id:win.id,windowId:win.id,label:win.title,role:'Window',capabilities:['inspect','minimize']},
      ...(desktopState.selected?[{id:'el_smoke_wrap',windowId:win.id,label:'Перенос строк',name:'Перенос строк',role:'CheckBox',capabilities:['toggle'],toggleState:desktopState.wrapped?'On':'Off',enabled:true,offscreen:false}]:[]),
    ],facts:{selectedWindowId:desktopState.selected,surfaceStatus:desktopState.selected?'available':'not_selected'},metadata:{provider:'isolated UI fixture',truncated:false}};
  };
  let window,lab,db,js,currentScenario;
  async function until(check,label,timeout=15000){
    const started=Date.now();
    while(Date.now()-started<timeout){if(await check())return;await pause(40);}
    throw new Error(`AGENT_UI_SMOKE_TIMEOUT: ${label}`);
  }
  const toolResponses=payload=>payload.contents.flatMap(content=>content.parts??[]).filter(part=>part.functionResponse).map(part=>part.functionResponse);
  const latestResponse=(payload,name)=>{
    const response=toolResponses(payload).findLast(item=>item.name===name);
    assert.ok(response,`Missing ${name} function response`);
    return response;
  };
  const content=(name,args,id)=>({content:{role:'model',parts:[{functionCall:{name,args,id}}]},model:'gemini-ui-fixture',latencyMs:1,usage:{inputTokenCount:1,outputTokenCount:1}});
  const call=(name,args,id)=>()=>content(name,args,id);
  const events=report=>report.events??report.trace??[];
  function respond(payload,name,text){
    const response=latestResponse(payload,name);
    const evidenceId=response.response.toolCallId??response.response.evidenceId??response.id;
    assert.equal(typeof evidenceId,'string','Tool response exposes its evidence ID');
    return content('assistant_respond',{status:'completed',text,evidenceIds:[evidenceId]},`respond-${modelCalls.length}`);
  }
  async function capturePair(label){
    if(!process.argv.includes('--screenshots'))return;
    window.showInactive();
    try{
      for(const [width,height] of [[1100,800],[760,620]]){
        window.setContentSize(width,height);await pause(150);
        await js(label.includes('details')?'document.getElementById("details-dialog").scrollTop=0':'document.getElementById("task-card").scrollIntoView({block:"nearest",behavior:"instant"})');
        let timer;
        const image=await Promise.race([window.webContents.capturePage(undefined,{stayHidden:true,stayAwake:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('SCREENSHOT_TIMEOUT')),5000);})]).finally(()=>clearTimeout(timer));
        assert.equal(image.isEmpty(),false,'Screenshot must have pixels');
        const file=path.join(directory,`${label}-${width}x${height}.png`);await writeFile(file,image.toPNG());
        screenshots.push({label,width,height,file,actualSize:image.getSize()});
        assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'),true,`${label}: no horizontal overflow at ${width}`);
      }
    }finally{window.hide();window.setContentSize(1100,800);}
  }
  try{
    await mkdir(data,{recursive:true});
    process.env.JEFF_DATA_DIR=data;
    process.env.TYPESAFE_API_KEY=fixtureKey;
    process.argv.push('--windows-smoke');
    const setPath=app.setPath.bind(app);
    app.setPath=(name,value)=>setPath(name,name==='userData'?path.join(directory,'profile'):value);
    globalThis.fetch=async(url,options={})=>{
      if(url!=='https://api.typesafe.ai/v1/systemone'||options.method!=='POST')return forbid('network')();
      options.signal?.throwIfAborted();
      assert.equal(options.headers?.Authorization,`Bearer ${fixtureKey}`);
      assert.ok(currentScenario,'Unexpected Jev request outside a registered scenario');
      const request=JSON.parse(options.body);
      assert.equal(request.state.command,currentScenario.command);
      assert.deepEqual(Object.keys(request.questions),['next_step']);
      const routing=request.state.candidates.every(item=>item.operation==='route');
      let choice;
      if(routing){
        assert.equal(currentScenario.routeCalls++,0,'Exactly one Jev route call per command');
        choice=currentScenario.route;
        assert.ok(request.state.candidates.some(item=>item.id===choice));
      }else{
        assert.equal(currentScenario.route,'desktop','Only the desktop route may ask Jev for a UI step');
        const planned=currentScenario.desktopSteps[currentScenario.desktopCalls++];
        assert.ok(planned,'Unexpected additional Jev desktop decision');
        const candidate=planned==='done'?null:request.state.candidates.find(item=>item.operation===planned);
        assert.ok(planned==='done'||candidate,`Missing observed candidate ${planned}`);
        choice=candidate?.id??'done';
        assert.ok(nativeCalls.some(item=>item.method==='observe'),'A desktop choice follows a fresh observation');
        if(planned==='toggle')assert.equal(request.state.observation.inspected?.title,'Редактор проверки');
        if(planned==='minimize')assert.equal(request.state.observation.controls.find(item=>item.name==='Перенос строк')?.toggleState,'On');
        if(planned==='done'){
          assert.equal(request.state.observation.windows[0].minimized,true);
          assert.deepEqual(request.state.recentSteps.map(item=>item.operation),['inspect','toggle','minimize']);
        }
      }
      const labels=Object.keys(request.questions.next_step.criteria);
      const probabilities=Object.fromEntries(labels.map(label=>[label,label===choice ? .96 : .04/(labels.length-1)]));
      const response={model:'jev-ui-fixture',usage:{input_tokens:100,output_tokens:20},answers:{next_step:{type:'choice',choice,confidence:.91,probabilities}}};
      jevCalls.push({kind:routing?'route':'step',command:currentScenario.command,request:structuredClone(request),response:structuredClone(response)});
      await pause(15);options.signal?.throwIfAborted();
      return new Response(JSON.stringify(response),{status:200,headers:{'content-type':'application/json'}});
    };
    for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])childProcess[name]=()=>{blocked.launch++;throw new Error('SMOKE_FORBIDDEN_CHILD_PROCESS');};
    syncBuiltinESMExports();
    WindowsBridge.prototype.startProcess=forbid('native');
    WindowsBridge.prototype.request=async(method,args={},signal)=>{
      signal?.throwIfAborted();nativeCalls.push({method,args:structuredClone(args),command:currentScenario?.command??null});
      if(method==='observe'){
        if(currentScenario?.route!=='desktop')return structuredClone(snapshot);
        if(Object.hasOwn(args,'windowId')&&args.windowId!==desktopState.selected){
          assert.ok(args.windowId===null||args.windowId==='win_smoke_editor');desktopState.selected=args.windowId;desktopState.revision++;
        }
        return desktopSnapshot();
      }
      if(method==='audio_outputs_get')return {provider:'windows_coreaudio',verified:true,effectAttempted:false,devices:[],defaultDeviceId:null};
      if(method==='execute'&&currentScenario?.route==='desktop'){
        const before=desktopSnapshot();assert.equal(args.expectedVersion,before.version);
        assert.equal(nativeCalls.at(-2)?.method,'observe','A native effect follows immediate fresh inspection');
        if(args.operation==='toggle'){assert.equal(args.targetId,'el_smoke_wrap');assert.equal(desktopState.wrapped,false);desktopState.wrapped=true;}
        else if(args.operation==='minimize'){assert.equal(args.targetId,'win_smoke_editor');assert.equal(desktopState.wrapped,true);assert.equal(args.expectedWindowVersion,before.windows[0].stateVersion);desktopState.minimized=true;}
        else return forbid('native')();
        desktopState.revision++;await pause(20);
        return {operation:args.operation,targetId:args.targetId,verified:true,stateChanged:true,effectAttempted:true,evidence:args.operation==='toggle'?'toggle_state_verified':'window_minimized',before,after:desktopSnapshot()};
      }
      return forbid('native')();
    };
    WindowsDesktop.prototype.run=forbid('native');
    BrowserWindow.prototype.minimize=function(){blocked.native++;throw new Error('SMOKE_FORBIDDEN_NATIVE_MINIMIZE');};
    InstalledApps.prototype.launch=forbid('launch');
    InstalledApps.prototype.list=async()=>[];
    GeminiGateway.prototype.available=async()=>true;
    for(const name of ['connect','open','request','chat','transcribe','createTranscriptionStream'])GeminiGateway.prototype[name]=forbid('network');
    GeminiGateway.prototype.agentStep=async function(payload,{signal}={}){
      signal?.throwIfAborted();
      assert.ok(currentScenario,'Unexpected model call outside a registered scenario');
      assert.notEqual(currentScenario.route,'desktop','Gemini must never handle the desktop route');
      assert.ok(payload.tools.every(tool=>!/^windows_|^winapp_|^system_volume_|^assistant_minimize$/u.test(tool.name)),'Gemini receives data-only tools');
      const step=currentScenario.steps[currentScenario.calls++];
      assert.equal(typeof step,'function',`Unexpected extra model step for ${currentScenario.command}`);
      const copy=structuredClone(payload);modelCalls.push({command:currentScenario.command,payload:copy});
      currentScenario.requests.push(copy);
      return step(payload);
    };
    Mp3Encoder.prototype.available=async()=>true;
    Mp3Encoder.prototype.encode=forbid('encoder');
    VoiceSession.prototype.start=forbid('microphone');
    DenisVoice.prototype.status=async()=>({available:true,voice:'Денис'});
    DenisVoice.prototype.synthesize=async(text,{signal}={})=>{
      signal?.throwIfAborted();speech.push(text);
      const wav=Buffer.alloc(364);wav.write('RIFF');wav.writeUInt32LE(356,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(16000,24);wav.writeUInt32LE(32000,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(320,40);
      return {wav,mimeType:'audio/wav',durationMs:10};
    };
    app.on('browser-window-created',(_event,created)=>{created.hide();created.webContents.setAudioMuted(true);});
    ({lab}=await import('./desktop-lab/main.mjs'));
    await app.whenReady();
    await until(()=>BrowserWindow.getAllWindows().length===1,'one isolated app window');
    window=BrowserWindow.getAllWindows()[0];window.hide();
    js=source=>window.webContents.executeJavaScript(source,true);
    await until(async()=>!window.webContents.isLoadingMainFrame()&&await js('Boolean(window.lab && document.getElementById("new-conversation") && !document.getElementById("voice-manual").disabled)'),'agent UI ready');
    await js(`window.__agentSmoke={captures:0,plays:0,errors:[],reports:[],progress:[]};
      window.addEventListener('error',event=>window.__agentSmoke.errors.push(String(event.message)));
      window.addEventListener('unhandledrejection',event=>window.__agentSmoke.errors.push(String(event.reason)));
      navigator.mediaDevices.getUserMedia=async()=>{window.__agentSmoke.captures++;throw new Error('SMOKE_MICROPHONE_FORBIDDEN');};
      window.Audio=class {async play(){window.__agentSmoke.plays++;setTimeout(()=>this.onended?.(),20);}pause(){}};
      window.lab.onVoiceEvent(event=>{if(event.type==='result')window.__agentSmoke.reports.push(event.report);});
      window.lab.onProgress(event=>window.__agentSmoke.progress.push({...event,uiProvider:document.getElementById('task-provider').textContent,uiDecision:document.getElementById('task-decision').textContent}));void 0;`);
    db=new DatabaseSync(path.join(data,'assistant.sqlite'));
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n,0);
    assert.match(await js('document.getElementById("footer-status").textContent'),/выключен/u);
    const initialCapabilities=await js('window.lab.capabilities()');
    pass('Actual main/preload/renderer opens with empty isolated SQLite and microphone off');
    const roles=await js('document.querySelector(".provider-roles").textContent');
    for(const label of ['Управление Windows — Jev','Распознавание речи — Gemini','Заметки, напоминания и ответы — Gemini'])assert.ok(roles.includes(label),label);
    await js('document.querySelector("[data-view=settings]").click();');
    await until(()=>js('document.getElementById("provider-jev").textContent==="Jev настроен" && document.getElementById("provider-gemini").textContent==="Gemini настроен"'),'provider connection roles');
    await js('document.querySelector("[data-view=assistant]").click();');
    pass('Static roles and actual Jev/Gemini availability are visible without microphone activation');

    async function submit(command,steps,expectedReason,{route='memory',desktopSteps=[]}={}){
      const before=await js('window.__agentSmoke.reports.length');
      currentScenario={command,steps,calls:0,requests:[],route,routeCalls:0,desktopSteps,desktopCalls:0};
      await js(`document.getElementById('command').value=${JSON.stringify(command)};document.getElementById('command').dispatchEvent(new Event('input'));document.getElementById('run').click();`);
      await until(()=>js(`window.__agentSmoke.reports.length > ${before} && !document.getElementById('run').disabled && document.getElementById('task-card').getAttribute('aria-busy')==='false'`),`settled ${command}`);
      const report=await js('window.__agentSmoke.reports.at(-1)');reports.push(report);
      assert.equal(report.reason,expectedReason,JSON.stringify(report));
      assert.equal(currentScenario.calls,steps.length,'Each planned model step ran exactly once');
      assert.equal(currentScenario.routeCalls,1,'Jev selected the route exactly once');
      assert.equal(currentScenario.desktopCalls,desktopSteps.length,'Each planned desktop choice ran exactly once');
      assert.equal(report.routing.route,route);assert.equal(report.delegation.provider,route==='desktop'?'jev':'gemini');
      const saved=JSON.parse(await readFile(path.join(data,'logs','windows',`${report.runId}.json`),'utf8'));
      assert.equal(saved.status,'finished');assert.equal(saved.reason,report.reason);
      return {report,requests:currentScenario.requests};
    }
    const noteText='Купить чай для проверки агента';
    const created=await submit(`Запиши заметку: ${noteText}`,[
      call('note_create',{text:noteText},'provider-create-note'),
      payload=>respond(payload,'note_create','Заметка сохранена.'),
    ],'agent_completed');
    const note=db.prepare('SELECT * FROM notes').get();
    assert.equal(note.text,noteText);assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,1);
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'success');
    assert.equal(await js('document.getElementById("result-message").textContent'),'Заметка сохранена.');
    assert.ok(events(created.report).some(event=>event.phase==='agent_tool_call'&&event.toolCall?.name==='note_create'));
    pass('Agent creates one real isolated note and grounds completion in the tool receipt');
    await capturePair('note-created');

    const revised='Купить зелёный чай для проверки агента';
    const updated=await submit('Измени эту заметку: купи зелёный чай вместо обычного.',[
      call('note_update',{id:note.id,text:revised,expectedText:noteText},'provider-update-before-read'),
      payload=>{
        const prior=latestResponse(payload,'note_update').response;
        assert.equal(prior.ok,false);assert.equal(prior.effectAttempted,false);
        assert.equal(db.prepare('SELECT text FROM notes WHERE id=?').get(note.id).text,noteText);
        return content('note_get',{id:note.id},'provider-read-note');
      },
      payload=>{
        const prior=latestResponse(payload,'note_get').response;
        assert.equal(prior.ok,true);
        return content('note_update',{id:note.id,text:revised,expectedText:noteText},'provider-update-after-read');
      },
      payload=>respond(payload,'note_update','Заметка изменена: купить зелёный чай.'),
    ],'agent_completed');
    assert.equal(db.prepare('SELECT text FROM notes WHERE id=?').get(note.id).text,revised);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,1);
    assert.ok(JSON.stringify(updated.requests[0].contents).includes(noteText),'Follow-up includes prior conversation');
    pass('Follow-up preserves context; update before current read is rejected, then one verified update succeeds');

    await js('document.getElementById("show-details").click();');
    await until(()=>js('document.getElementById("details-dialog").open && !document.getElementById("readable-log").hidden'),'readable agent details');
    const readable=await js('document.getElementById("readable-log").innerText');
    const capabilityLabels=await js('Array.from(document.querySelectorAll("#capability-list .capability-title"),element=>element.textContent)');
    await capturePair('agent-details');
    await js('document.getElementById("close-details").click();');

    const correction=await submit('Сохрани заметку о звонке завтра.',[
      call('note_create',{text:17},'provider-invalid-note'),
      payload=>{
        const prior=latestResponse(payload,'note_create').response;
        assert.equal(prior.ok,false);assert.equal(prior.effectAttempted,false);
        return content('note_create',{text:'Позвонить завтра'},'provider-corrected-note');
      },
      payload=>respond(payload,'note_create','Заметка о звонке сохранена.'),
    ],'agent_completed');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notes').get().n,2);
    assert.ok(events(correction.report).some(event=>event.phase==='agent_tool_result'&&event.result?.ok===false));
    await js('document.getElementById("show-details").click();');
    await until(()=>js('document.getElementById("details-dialog").open'),'corrected arguments details');
    const correctionReadable=await js('document.getElementById("execution-steps").innerText');
    await js('document.getElementById("close-details").click();');
    pass('Wrong typed arguments are returned to the model and corrected without duplicate notes');

    await submit('Напомни завтра проверить чай.',[
      call('assistant_respond',{status:'clarification',text:'Во сколько завтра напомнить проверить чай?',evidenceIds:[]},'provider-clarify'),
    ],'clarification_required');
    assert.equal(await js('document.getElementById("result-message").textContent'),'Во сколько завтра напомнить проверить чай?');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM reminders').get().n,0);
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'neutral');
    pass('Generic clarification remains visible and does not invent a reminder time');
    await capturePair('clarification');

    const capabilities=await js('window.lab.capabilities()');
    assert.ok(Array.isArray(capabilities),'Capabilities IPC returns the real tool catalog');
    assert.ok(Array.isArray(initialCapabilities)&&initialCapabilities.length>0,'Capabilities are available before the first command');
    assert.deepEqual(initialCapabilities.map(item=>item.name),capabilities.map(item=>item.name),'Catalog does not depend on a previous successful command');
    for(const name of ['note_create','note_get','note_update','notes_search']){
      const tool=capabilities.find(item=>item.name===name);assert.ok(tool,name);assert.match(tool.title,/[А-Яа-яЁё]/u);
    }
    pass('Capabilities IPC exposes actual available tools with readable Russian labels',{count:capabilities.length});

    const beforeClear=await js('window.lab.history()');
    const savedNotes=db.prepare('SELECT id,text FROM notes ORDER BY id').all();
    await js('document.getElementById("new-conversation").click();');
    await until(()=>js('document.getElementById("task-card").hidden && document.getElementById("command").value===""'),'conversation view cleared');
    assert.deepEqual(db.prepare('SELECT id,text FROM notes ORDER BY id').all(),savedNotes);
    const afterClear=await js('window.lab.history()');
    assert.deepEqual(afterClear.runs.map(item=>item.runId).sort(),beforeClear.runs.map(item=>item.runId).sort());
    const fresh=await submit('Объясни, что такое оперативная память.',[
      call('assistant_respond',{status:'answer',text:'Оперативная память хранит данные запущенных программ.',evidenceIds:[]},'provider-fresh-answer'),
    ],'agent_answer',{route:'conversation'});
    assert.equal(fresh.requests[0].contents.length,1,'Clear conversation removes prior model context');
    assert.deepEqual(db.prepare('SELECT id,text FROM notes ORDER BY id').all(),savedNotes);
    pass('New conversation clears model/UI context while preserving notes and task history');

    const geminiBeforeDesktop=modelCalls.length;
    const command='Прочитай окно «Редактор проверки», включи перенос строк и сверни это окно.';
    desktopState={revision:1,selected:null,wrapped:false,minimized:false};
    const desktop=await submit(command,[],'goal_model_assessed',{route:'desktop',desktopSteps:['inspect','toggle','minimize','done']});
    assert.equal(modelCalls.length,geminiBeforeDesktop,'Desktop route makes no Gemini inference calls');
    assert.equal(desktop.report.mode,'JEV_DESKTOP');
    assert.equal(desktop.report.goalVerification,'model_assessed');
    assert.equal(desktop.report.effectVerification,'native_postconditions');
    assert.deepEqual(events(desktop.report).filter(event=>event.phase==='execute_request').map(event=>event.operation),['inspect','toggle','minimize']);
    assert.deepEqual(nativeCalls.filter(item=>item.command===command&&item.method==='execute').map(item=>item.args.operation),['toggle','minimize']);
    assert.deepEqual(desktop.report.completed.map(item=>item.operation),['toggle','minimize']);
    const desktopProgress=await js(`window.__agentSmoke.progress.filter(event=>event.runId===${JSON.stringify(desktop.report.runId)})`);
    const choices=desktopProgress.filter(event=>event.phase==='model_decision');
    assert.equal(choices.length,4,'Every child Jev decision reaches the root UI run');
    assert.ok(choices.every(event=>event.uiProvider==='Управление Windows — Jev'));
    assert.ok(choices.every(event=>/Jev:/.test(event.uiDecision)&&/вероятность/.test(event.uiDecision)&&/уверенность/.test(event.uiDecision)&&/ответ за/.test(event.uiDecision)));
    assert.ok(choices.every(event=>!/^Jev: step_\d/.test(event.uiDecision)));
    assert.equal(await js('document.getElementById("task-provider").textContent'),'Управление Windows — Jev');
    assert.equal(await js('document.getElementById("task-card").dataset.tone'),'warning');
    assert.equal(await js('document.getElementById("result-title").textContent'),'Завершено по оценке Jev');
    assert.match(await js('document.getElementById("result-message").textContent'),/Windows подтвердила выполненные шаги[\s\S]*Итог всей задачи отдельно не проверен/u);
    await capturePair('jev-desktop-result');
    pass('Real Jev facade and desktop loop inspect, toggle and minimize with fresh fixture observations and zero Gemini desktop calls',{decisions:choices.length,effects:desktop.report.completed.length});

    await js('document.getElementById("show-details").click();');
    await until(()=>js('document.getElementById("details-dialog").open'),'Jev details');
    const desktopLog=await js('({runtime:document.getElementById("detail-provider").textContent,goal:document.getElementById("goal-verification-message").textContent,actions:Array.from(document.querySelectorAll("#decision-steps .log-step-action"),element=>element.textContent),statuses:Array.from(document.querySelectorAll("#execution-steps .execution-status"),element=>element.textContent),payloads:Array.from(document.querySelectorAll("#decision-steps .model-payload pre"),element=>element.textContent)})');
    assert.equal(desktopLog.runtime,'Управление Windows — Jev');
    assert.equal(desktopLog.actions.length,5,'Route plus four Jev loop decisions are readable');
    assert.ok(desktopLog.actions.some(label=>label.includes('Перенос строк')));
    assert.ok(desktopLog.actions.some(label=>label==='Завершить по оценке Jev'));
    assert.ok(desktopLog.statuses.every(label=>label==='Шаг подтверждён Windows'));
    assert.match(desktopLog.goal,/итог всей задачи отдельно не проверен/u);
    assert.equal(desktopLog.payloads.length,10,'Every decision has a request and normalized response disclosure');
    assert.deepEqual(JSON.parse(desktopLog.payloads[0]),desktop.report.calls[0].request);
    assert.deepEqual(JSON.parse(desktopLog.payloads[1]),desktop.report.calls[0].decision);
    assert.ok(desktopLog.payloads.every(value=>!value.includes(fixtureKey)));
    await capturePair('jev-desktop-details');
    await js('document.getElementById("close-details").click();');
    pass('Jev details expose exact exchanges and native step receipts without claiming verified full-goal completion');

    await js('document.querySelector("[data-view=history]").click();');
    const history=await js('window.lab.history()');
    assert.ok(reports.every(report=>history.runs.some(item=>item.runId===report.runId)),'Every facade result is discoverable in history');
    assert.equal(history.runs.length,reports.length,'Child journals do not duplicate facade tasks in history');
    await until(()=>js(`document.querySelectorAll('#history-list button').length===${history.runs.length}`),'all persisted runs visible in history');
    const rootIndex=history.runs.findIndex(item=>item.runId===desktop.report.runId);
    await js(`document.querySelectorAll('#history-list button')[${rootIndex}].click();`);
    await until(()=>js('document.getElementById("details-dialog").open'),'persisted history details');
    assert.equal(await js('JSON.parse(document.getElementById("trace").textContent).runId'),desktop.report.runId);
    await js('document.getElementById("close-details").click();');
    pass('Every facade outcome is persisted and its root report opens through the real history UI',{visibleRuns:history.runs.length,rootRuns:reports.length});
    assert.match(readable,/заметк/iu);assert.match(readable,/прочит|чтен|Сначала/iu);
    assert.doesNotMatch(readable,/provider-update-before-read|provider-read-note|provider-update-after-read/u);
    assert.doesNotMatch(readable,/\b(?:note_update|note_get|assistant_respond|expectedText|evidenceIds|target_not_read|note_read)\b/u,'Readable details keep tool/schema identifiers in technical JSON only');
    assert.match(correctionReadable,/Исправ|параметр|аргумент/iu);
    assert.doesNotMatch(correctionReadable,/provider-invalid-note|provider-corrected-note/u);
    assert.ok(capabilityLabels.length>0,'Readable details include the actual tool catalog');
    assert.ok(capabilityLabels.every(label=>/[А-Яа-яЁё]/u.test(label)),'Capabilities have human-readable Russian labels');
    pass('Readable agent log shows tool meaning and repair without exposing internal call IDs');
    const renderer=await js('({captures:window.__agentSmoke.captures,plays:window.__agentSmoke.plays,errors:window.__agentSmoke.errors})');
    assert.equal(renderer.captures,0);assert.deepEqual(renderer.errors,[]);
    assert.deepEqual(blocked,{network:0,native:0,launch:0,microphone:0,encoder:0});
    pass('No live provider, native action, process launch, microphone, encoder or renderer failure');
    await writeFile(path.join(directory,'result.json'),JSON.stringify({ok:true,directory,data,checks,screenshots,blocked,renderer,speech,modelCallCount:modelCalls.length,jevCalls,nativeCalls,runIds:reports.map(report=>report.runId)},null,2)+'\n');
    console.log(JSON.stringify({ok:true,checks:checks.length,directory,blocked,screenshots:screenshots.length}));
  }catch(error){
    await writeFile(path.join(directory,'result.json'),JSON.stringify({ok:false,error:error.stack,checks,blocked,screenshots,directory,modelCalls,jevCalls,nativeCalls,reports},null,2)+'\n').catch(()=>{});
    if(window&&!window.isDestroyed()&&js)await js('({body:document.body.innerText,errors:window.__agentSmoke?.errors,reports:window.__agentSmoke?.reports})').then(state=>writeFile(path.join(directory,'failure-state.json'),JSON.stringify(state,null,2))).catch(()=>{});
    console.error(JSON.stringify({ok:false,error:String(error.message).slice(0,500),checks:checks.length,directory}));process.exitCode=1;
  }finally{db?.close();lab?.dispose();app.exit(process.exitCode??0);}
}
