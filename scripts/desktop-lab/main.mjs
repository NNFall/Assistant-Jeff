import {app,BrowserWindow,ipcMain,shell,Notification,Tray,Menu,nativeImage} from 'electron';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WindowsDesktop} from '../windows-desktop/controller.mjs';
import {WindowsBridge} from '../windows-desktop/bridge.mjs';
import {InstalledApps} from '../../desktop/automation/windows-apps.mjs';
import {AgentCommands} from '../../desktop/agent/commands.mjs';
import {JevAssistant} from '../../desktop/agent/jev-assistant.mjs';
import {JevCommands} from '../../desktop/agent/jev-commands.mjs';
import {createJevDesktopSession} from '../../desktop/agent/jev-desktop-session.mjs';
import {createDataTools} from '../../desktop/agent/data-tools.mjs';
import {createSystemTools} from '../../desktop/automation/system-tools.mjs';
import {Store} from '../../desktop/core/index.mjs';
import {readProtected} from '../../desktop/secrets.mjs';
import {GeminiGateway} from '../../desktop/providers/gemini.mjs';
import {Mp3Encoder} from '../../desktop/audio/mp3.mjs';
import {DenisVoice} from '../../desktop/audio/denis.mjs';
import {VoiceSession} from '../../desktop/audio/session.mjs';
import {runtimePaths,initializeRuntime,saveVoiceSettings} from '../../desktop/runtime.mjs';
import {listRuns,readRun,redact} from './journal.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const smoke=process.argv.includes('--windows-smoke');
const isolated=!!process.env.JEFF_DATA_DIR;
export const paths=runtimePaths({root,packaged:app.isPackaged,resourcesPath:process.resourcesPath,appData:app.getPath('appData'),dataOverride:process.env.JEFF_DATA_DIR});
app.setName('Assistant Jeff');
app.setPath('userData',smoke?path.join(root,'work','windows-desktop','ui-smoke-profile'):paths.data);
let window,tray,store,commands,voice,gateway,settings,poll,quitting=false,allowCapture=false;
let voiceLogQueue=Promise.resolve();
const progress=value=>{
  const parent=commands?.activeRunId;
  const visible=parent&&value.runId&&value.runId!==parent?{...value,childRunId:value.runId,runId:parent}:value;
  if(window&&!window.isDestroyed())window.webContents.send('lab:progress',visible);
};
function voiceEvent(value){
  if(value.type==='status'&&['stopped','error'].includes(value.state))allowCapture=false;
  if(window&&!window.isDestroyed())window.webContents.send('lab:voice',value);
  // Interim hypotheses are visible immediately; only the final command belongs
  // in the persistent journal. Latency events retain the streaming measurements.
  if(value.type==='transcript'&&value.final!==true)return;
  // Audio bytes are never stored. Command journals carry their own complete traces.
  const context={source:value.source,operationId:value.operationId};
  const item=value.type==='speech'?{...context,type:value.type,id:value.id,bytes:value.wav.byteLength}:value.type==='result'?{...context,type:value.type,runId:value.report.runId,reason:value.report.reason,ok:value.report.ok}:value;
  const line=JSON.stringify(redact({at:new Date().toISOString(),...item}))+'\n';
  voiceLogQueue=voiceLogQueue.then(async()=>{const dir=path.join(paths.data,'logs','voice');await fs.promises.mkdir(dir,{recursive:true});await fs.promises.appendFile(path.join(dir,`${new Date().toISOString().slice(0,10)}.jsonl`),line);}).catch(()=>{});
}
export const lab=new WindowsDesktop(progress,{bridge:new WindowsBridge({helper:paths.helper}),
  apps:new InstalledApps(app.isPackaged?{scriptPath:path.join(process.resourcesPath,'windows-desktop','read-apps.ps1')}:{}),directory:paths.logs,
  apiKeyResolver:async()=>process.env.TYPESAFE_API_KEY||await readProtected(path.join(paths.data,'secrets','typesafe.dpapi'))});
const validSender=event=>window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame;
function register(name,handler){ipcMain.handle(`lab:${name}`,async(event,payload)=>{
  if(!validSender(event))throw new Error('Invalid sender');
  try{return await handler(payload);}catch(error){return {ok:false,error:/^[A-Z_]{1,64}$/.test(error.code??'')?error.code:'ASSISTANT_ERROR',message:'Не удалось выполнить действие. Проверьте журнал и подключение.',running:commands?.running??false};}
});}
function initializeStore(){
  const target=path.join(paths.data,'assistant.sqlite'),source=path.join(root,'data','assistant.sqlite');
  if(!isolated&&!fs.existsSync(target)&&fs.existsSync(source)){
    const db=new DatabaseSync(source,{readOnly:true});try{db.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);}finally{db.close();}
  }
  return new Store(target);
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    settings=initializeRuntime(paths,root,{isolated});store=initializeStore();gateway=new GeminiGateway(paths.data);
    const systemTools=createSystemTools({bridge:lab.bridge,minimizeAssistant:async({signal}={})=>{
      signal?.throwIfAborted();
      if(!window||window.isDestroyed())throw Object.assign(new Error(),{code:'ASSISTANT_WINDOW_UNAVAILABLE'});
      const before={minimized:window.isMinimized()};
      if(!before.minimized)await new Promise(resolve=>{
        let timer;const finish=()=>{clearTimeout(timer);window?.removeListener('minimize',finish);resolve();};
        window.once('minimize',finish);timer=setTimeout(finish,750);window.minimize();
      });
      const after={minimized:!!window&&!window.isDestroyed()&&window.isMinimized()};
      return {verified:after.minimized,effectAttempted:!before.minimized,before,after};
    }});
    // Jev owns every desktop choice. Gemini's separate data assistant cannot
    // call a Windows executor, even if a model returns a desktop tool name.
    const dataCommands=new AgentCommands({progress,directory:paths.logs,
      modelStep:(payload,options)=>gateway.agentStep(payload,options),
      createTools:()=>createDataTools({store})});
    const desktopCommands=new JevCommands({progress,directory:paths.logs,apiKeyResolver:lab.apiKeyResolver,
      createSession:({command})=>createJevDesktopSession({desktop:lab,systemTools,command})});
    commands=new JevAssistant({progress,directory:paths.logs,apiKeyResolver:lab.apiKeyResolver,desktopCommands,dataCommands});
    voice=new VoiceSession({paths,encoder:new Mp3Encoder({executablePath:paths.ffmpeg}),gateway,
      denis:new DenisVoice({executablePath:paths.piper,modelPath:paths.denis}),commands,getSettings:()=>settings,emit:voiceEvent});
    window=new BrowserWindow({width:1100,height:800,minWidth:760,minHeight:620,title:'Assistant Jeff',icon:path.join(root,'desktop','assets','icon.png'),
      webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    window.removeMenu();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window.webContents&&permission==='media'&&allowCapture&&details.isMainFrame===true&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio')));
    window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window.webContents&&permission==='media'&&allowCapture&&details.isMainFrame===true&&details.mediaType==='audio');
    for(const [name,handler] of Object.entries({start:()=>lab.start(),state:()=>lab.state(),
      run:payload=>voice.runTyped(payload),
      capabilities:()=>commands.capabilities(),
      clearContext:()=>commands.clearContext(),
      stop:()=>{commands.stop();return voice.stop();},
      history:()=>listRuns({directory:paths.logs,activeRunIds:[commands.activeRunId,desktopCommands.activeRunId,dataCommands.activeRunId,lab.activeRunId].filter(Boolean),excludeRunIds:[desktopCommands.activeRunId,dataCommands.activeRunId].filter(Boolean)}),
      readRun:payload=>readRun(payload?.runId,{directory:paths.logs,activeRunIds:[commands.activeRunId,desktopCommands.activeRunId,dataCommands.activeRunId,lab.activeRunId].filter(Boolean)}),
      openLogs:async()=>{fs.mkdirSync(paths.logs,{recursive:true});const error=await shell.openPath(paths.logs);return error?{error:'LOG_DIRECTORY_OPEN_FAILED'}:{opened:true};},
      voiceStatus:async()=>{const status=await voice.status();let jev=false;try{jev=Boolean(await lab.apiKeyResolver());}catch{}return {...status,providers:{...status.providers,jev},version:app.getVersion()};},voiceStart:async payload=>{const result=await voice.start(payload);allowCapture=result.ok===true;return result;},
      voiceStop:()=>{allowCapture=false;return voice.stop();},voiceActivate:()=>voice.activate(),voiceFinish:()=>voice.finish(),
      voiceSettings:patch=>{settings=saveVoiceSettings(paths,patch,settings);return {ok:true,settings};},speechEnded:payload=>voice.speechEnded(payload),
      dismissReminder:payload=>{if(!Number.isSafeInteger(payload?.id)||payload.id<=0)throw Object.assign(new Error(),{code:'INVALID_REMINDER_ID'});store.completeReminder(payload.id);return {ok:true,id:payload.id};}}))register(name,handler);
    ipcMain.on('lab:audio',(event,pcm)=>{if(validSender(event)&&allowCapture&&pcm instanceof Int16Array&&pcm.length===1280)voice.accept(pcm);});
    await window.loadFile(fileURLToPath(new URL('./lab.html',import.meta.url)));
    app.setAppUserModelId('ai.nnfall.assistant-jeff');
    if(!smoke){
      const icon=nativeImage.createFromPath(path.join(root,'desktop','assets','icon.png')).resize({width:32,height:32});
      tray=new Tray(icon);tray.setToolTip('Assistant Jeff');tray.setContextMenu(Menu.buildFromTemplate([
        {label:'Открыть Jeff',click:()=>{window.show();window.focus();}},
        {label:'Выключить микрофон',click:()=>{allowCapture=false;void voice.stop();}},
        {type:'separator'},{label:'Выход',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>{window.show();window.focus();});
      window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
      const announced=new Set();
      poll=setInterval(()=>{try{for(const item of store.due())if(!announced.has(item.id)){
        announced.add(item.id);voiceEvent({type:'reminder',id:item.id,text:item.text});
        if(Notification.isSupported())new Notification({title:'Jeff · Напоминание',body:item.text}).show();
      }}catch{}},1000);
    }
    if(isolated&&process.argv.includes('--diagnostics')){
      const status=await voice.status();const snapshot=await lab.state();
      const capabilities=commands.capabilities();
      fs.writeFileSync(path.join(paths.data,'diagnostics.json'),JSON.stringify({ok:status.providers.encoder&&status.providers.denis&&status.providers.wake&&fs.existsSync(paths.winapp),state:status.state,providers:status.providers,windowCount:snapshot.snapshot.windows.length,version:app.getVersion(),microphoneActivated:false,agent:{toolCount:capabilities.length,available:capabilities.filter(tool=>tool.available).map(tool=>tool.name),winappInstalled:fs.existsSync(paths.winapp)}},null,2));
      quitting=true;app.quit();
    }
  }).catch(()=>{fs.mkdirSync(paths.data,{recursive:true});fs.writeFileSync(path.join(paths.data,'startup-error.log'),'Не удалось запустить Assistant Jeff. Проверьте установку и доступность папки данных.');app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{quitting=true;allowCapture=false;clearInterval(poll);void voice?.stop();commands?.stop();lab.dispose();gateway?.close();});
  app.on('will-quit',()=>store?.close());
}
