import {app,BrowserWindow,ipcMain,shell,Notification,Tray,Menu,nativeImage} from 'electron';
import {fileURLToPath} from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {WindowsDesktop} from '../windows-desktop/controller.mjs';
import {WindowsBridge} from '../windows-desktop/bridge.mjs';
import {InstalledApps} from '../../desktop/automation/windows-apps.mjs';
import {UnifiedCommands} from '../../desktop/automation/assistant-commands.mjs';
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
const progress=value=>{if(window&&!window.isDestroyed())window.webContents.send('lab:progress',value);};
function voiceEvent(value){
  if(value.type==='status'&&['stopped','error'].includes(value.state))allowCapture=false;
  if(window&&!window.isDestroyed())window.webContents.send('lab:voice',value);
  // Audio bytes are never stored. Command journals carry their own complete traces.
  const item=value.type==='speech'?{type:value.type,id:value.id,bytes:value.wav.byteLength}:value.type==='result'?{type:value.type,runId:value.report.runId,reason:value.report.reason}:value;
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
    commands=new UnifiedCommands({desktop:lab,store,chat:(text,options)=>gateway.chat(text,options),progress,directory:paths.logs});
    voice=new VoiceSession({paths,encoder:new Mp3Encoder({executablePath:paths.ffmpeg}),gateway,
      denis:new DenisVoice({executablePath:paths.piper,modelPath:paths.denis}),commands,getSettings:()=>settings,emit:voiceEvent});
    window=new BrowserWindow({width:1100,height:900,minWidth:760,minHeight:620,title:'Assistant Jeff',icon:path.join(root,'desktop','assets','icon.png'),
      webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
    window.removeMenu();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((contents,permission,callback,details)=>callback(contents===window.webContents&&permission==='media'&&allowCapture&&details.isMainFrame===true&&Array.isArray(details.mediaTypes)&&details.mediaTypes.length>0&&details.mediaTypes.every(type=>type==='audio')));
    window.webContents.session.setPermissionCheckHandler((contents,permission,_origin,details)=>contents===window.webContents&&permission==='media'&&allowCapture&&details.isMainFrame===true&&details.mediaType==='audio');
    for(const [name,handler] of Object.entries({start:()=>lab.start(),state:()=>lab.state(),
      run:async payload=>{if(voice.busy)throw Object.assign(new Error(),{code:'VOICE_BUSY'});if(voice.state==='waiting')await voice.stop();return commands.run(payload);},
      stop:()=>{commands.stop();return voice.stop();},
      history:()=>listRuns({directory:paths.logs,activeRunId:commands.activeRunId??lab.activeRunId}),
      readRun:payload=>readRun(payload?.runId,{directory:paths.logs,activeRunId:commands.activeRunId??lab.activeRunId}),
      openLogs:async()=>{fs.mkdirSync(paths.logs,{recursive:true});const error=await shell.openPath(paths.logs);return error?{error:'LOG_DIRECTORY_OPEN_FAILED'}:{opened:true};},
      voiceStatus:()=>voice.status(),voiceStart:async payload=>{const result=await voice.start(payload);allowCapture=result.ok===true;return result;},
      voiceStop:()=>{allowCapture=false;return voice.stop();},voiceActivate:()=>voice.activate(),voiceFinish:()=>voice.finish(),
      voiceSettings:patch=>{settings=saveVoiceSettings(paths,patch,settings);return {ok:true,settings};},speechEnded:payload=>voice.speechEnded(payload)}))register(name,handler);
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
      fs.writeFileSync(path.join(paths.data,'diagnostics.json'),JSON.stringify({ok:status.providers.encoder&&status.providers.denis&&status.providers.wake,state:status.state,providers:status.providers,windowCount:snapshot.snapshot.windows.length,version:app.getVersion(),microphoneActivated:false},null,2));
      quitting=true;app.quit();
    }
  }).catch(()=>{fs.mkdirSync(paths.data,{recursive:true});fs.writeFileSync(path.join(paths.data,'startup-error.log'),'Не удалось запустить Assistant Jeff. Проверьте установку и доступность папки данных.');app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>{quitting=true;allowCapture=false;clearInterval(poll);void voice?.stop();commands?.stop();lab.dispose();gateway?.close();});
  app.on('will-quit',()=>store?.close());
}
