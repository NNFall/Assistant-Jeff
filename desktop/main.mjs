import {app,BrowserWindow,ipcMain,Menu,Tray,nativeImage,Notification,session,shell} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import {Store} from './core/index.mjs';
import {AssistantService} from './service.mjs';
import {VoiceController} from './audio/controller.mjs';
import {getKeys,legacyAssemblyKey} from './secrets.mjs';
import {GeminiGateway} from './providers/gemini.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const project=path.dirname(here);
const isolated=!!process.env.JEFF_DATA_DIR;
const dataDir=process.env.JEFF_DATA_DIR || path.join(app.getPath('appData'),'Assistant Jeff');
const modelsDir=app.isPackaged?path.join(process.resourcesPath,'models'):path.join(project,'models');
const defaults={wakeWord:'hey_jarvis',wakeThreshold:0.5,speakReplies:true,autoStart:false,microphoneId:'',cloudEnabled:true};
let window,tray,store,voice,service,gateway,keys,settings,tts,quitting=false,commandBusy=false,poll,allowCapture=false;
const announced=new Set();
const speechQueue=[];
let announcing=false,pollFailed=false;
const emit=event=>{if(window&&!window.isDestroyed())window.webContents.send('jeff:event',event);};
const changed=()=>emit({type:'changed'});
function initializeData(){
  fs.mkdirSync(dataDir,{recursive:true});
  const legacy=path.join(project,'data');
  const target=path.join(dataDir,'assistant.sqlite');
  if(!isolated&&!fs.existsSync(target)&&fs.existsSync(path.join(legacy,'assistant.sqlite'))){
    const db=new DatabaseSync(path.join(legacy,'assistant.sqlite'),{readOnly:true});
    try{db.exec(`VACUUM INTO '${target.replaceAll("'","''")}'`);}finally{db.close();}
  }
  if(!isolated){
    for(const name of ['typesafe.dpapi','assemblyai.dpapi','gateway-key.dpapi','gateway-token.dpapi']){
      const source=path.join(legacy,'secrets',name),dest=path.join(dataDir,'secrets',name);
      if(fs.existsSync(source)&&!fs.existsSync(dest)){fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(source,dest);}
    }
    if(fs.existsSync(path.join(legacy,'gateway.json'))&&!fs.existsSync(path.join(dataDir,'gateway.json')))fs.copyFileSync(path.join(legacy,'gateway.json'),path.join(dataDir,'gateway.json'));
  }
  settings={...defaults};
  try{settings={...defaults,...JSON.parse(fs.readFileSync(path.join(dataDir,'settings.json'),'utf8'))};}catch{}
}
function saveSettings(patch){
  if(!patch||typeof patch!=='object')throw new Error('Неверные настройки.');
  const next={...settings};
  for(const key of ['speakReplies','autoStart','cloudEnabled'])if(key in patch){if(typeof patch[key]!=='boolean')throw new Error('Неверные настройки.');next[key]=patch[key];}
  if('wakeWord'in patch){if(!['hey_jarvis','alexa','hey_mycroft','hey_rhasspy'].includes(patch.wakeWord))throw new Error('Неизвестное имя.');next.wakeWord=patch.wakeWord;}
  if('wakeThreshold'in patch){if(!Number.isFinite(patch.wakeThreshold)||patch.wakeThreshold<.1||patch.wakeThreshold>.95)throw new Error('Порог должен быть от 0.1 до 0.95.');next.wakeThreshold=patch.wakeThreshold;}
  if('microphoneId'in patch){if(typeof patch.microphoneId!=='string'||patch.microphoneId.length>512)throw new Error('Неверный микрофон.');next.microphoneId=patch.microphoneId;}
  const temp=path.join(dataDir,'settings.json.tmp');fs.writeFileSync(temp,JSON.stringify(next,null,2));fs.renameSync(temp,path.join(dataDir,'settings.json'));settings=next;
  if(app.isPackaged)app.setLoginItemSettings({openAtLogin:settings.autoStart,args:['--background']});
  return {ok:true};
}
function speak(text){
  if(!settings.speakReplies||process.env.JEFF_NO_TTS==='1')return Promise.resolve();
  return new Promise(resolve=>{
    const script="Add-Type -AssemblyName System.Speech; $v=New-Object System.Speech.Synthesis.SpeechSynthesizer; try { $v.SelectVoice('Microsoft Irina Desktop') } catch {}; $v.Speak([Console]::In.ReadToEnd()); $v.Dispose()";
    const child=spawn('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,stdio:['pipe','ignore','ignore']});tts=child;
    child.on('error',resolve);child.on('exit',()=>{if(tts===child)tts=null;resolve();});child.stdin.on('error',()=>{});child.stdin.end(String(text).slice(0,2000));
  });
}
async function openApp(id){
  const windows=process.env.SystemRoot || 'C:\\Windows';
  if(id==='browser'){await shell.openExternal('https://www.google.com/');return;}
  const executables={calculator:path.join(windows,'System32','calc.exe'),notepad:path.join(windows,'System32','notepad.exe'),explorer:path.join(windows,'explorer.exe')};
  if(!executables[id])throw new Error('Это приложение пока не поддерживается.');
  await new Promise((resolve,reject)=>{const child=spawn(executables[id],[],{detached:true,stdio:'ignore',shell:false});child.once('spawn',()=>{child.unref();resolve();});child.once('error',()=>reject(new Error('Не удалось открыть приложение.')));});
}
async function execute(text,options={}){
  if(commandBusy)return {ok:false,kind:'error',message:'Дождитесь завершения текущей команды.'};
  commandBusy=true;
  try{const result=await service.execute(text,options);changed();return result;}finally{commandBusy=false;}
}
function validateSender(event){return window&&!window.isDestroyed()&&event.sender===window.webContents&&event.senderFrame===window.webContents.mainFrame;}
function register(name,handler){ipcMain.handle(`jeff:${name}`,async(event,...args)=>{
  if(!validateSender(event))throw new Error('Недоступно.');
  try{return await handler(...args);}catch{return {ok:false,message:'Не удалось выполнить действие. Проверьте данные и подключение.'};}
});}
function pollReminders(){
  try{const due=store.due();pollFailed=false;for(const item of due){if(announced.has(item.id))continue;announced.add(item.id);emit({type:'reminder',...item});
    if(Notification.isSupported()){const n=new Notification({title:'Jeff · Напоминание',body:item.text,silent:false});n.on('click',()=>{window?.show();window?.focus();});n.show();}
    speechQueue.push(item);
  }
  if(!announcing&&speechQueue.length&&['off','waiting'].includes(voice.state)){
    const next=speechQueue[0];
    if(!due.some(item=>item.id===next.id)){speechQueue.shift();return;}
    announcing=true;
    void voice.announce(`Напоминание. ${next.text}`).then(done=>{if(done)speechQueue.shift();}).finally(()=>{announcing=false;});
  }
  }catch{if(!pollFailed)emit({type:'reminder-error',message:'Не удалось проверить напоминания. Повторю через секунду.'});pollFailed=true;}
}
if(!app.requestSingleInstanceLock()){app.quit();}else{
app.on('second-instance',()=>{window?.show();window?.focus();});
app.whenReady().then(async()=>{
app.setAppUserModelId('ai.nnfall.assistant-jeff');
initializeData();store=new Store(path.join(dataDir,'assistant.sqlite'));keys=await getKeys(dataDir);
if(!isolated&&!keys.assemblyai)keys.assemblyai=await legacyAssemblyKey();
gateway=new GeminiGateway(dataDir);
service=new AssistantService({store,settings:()=>settings,keys:()=>keys,chat:(text,options)=>gateway.chat(text,options),openApp});
voice=new VoiceController({modelsDir,getSettings:()=>settings,getAssemblyKey:async()=>keys.assemblyai,emit,onCommand:async(text,options)=>{const result=await execute(text,options);if(!options?.signal?.aborted)emit({type:'reply',...result});return result;},speak});
session.defaultSession.setPermissionRequestHandler((contents,permission,callback)=>callback(contents===window?.webContents&&permission==='media'&&allowCapture));
session.defaultSession.setPermissionCheckHandler((contents,permission)=>contents===window?.webContents&&permission==='media'&&allowCapture);
window=new BrowserWindow({width:1160,height:820,minWidth:800,minHeight:640,show:false,title:'Assistant Jeff',icon:path.join(here,'assets','icon.png'),backgroundColor:'#f5f5f8',autoHideMenuBar:true,webPreferences:{preload:path.join(here,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
window.webContents.on('will-navigate',e=>e.preventDefault());
window.on('close',event=>{if(!quitting){event.preventDefault();window.hide();}});
const icon=nativeImage.createFromPath(path.join(here,'assets','icon.png')).resize({width:32,height:32});
tray=new Tray(icon);tray.setToolTip('Assistant Jeff');tray.setContextMenu(Menu.buildFromTemplate([{label:'Открыть Jeff',click:()=>window.show()},{label:'Выключить микрофон',click:async()=>{allowCapture=false;await voice.stop();emit({type:'stop-capture'});}},{type:'separator'},{label:'Выход',click:()=>{quitting=true;app.quit();}}]));tray.on('double-click',()=>window.show());
register('snapshot',async()=>({notes:store.notes().reverse(),reminders:store.pending(),settings,providers:{typesafe:!!keys.typesafe,assemblyai:!!keys.assemblyai,gemini:await gateway.available()},version:app.getVersion()}));
register('command',execute);
register('addNote',text=>{const id=store.addNote(text);changed();return {ok:true,id};});
register('addReminder',item=>{if(!item||typeof item.text!=='string')throw new Error();const dueAt=typeof item.dueAt==='string'?Date.parse(item.dueAt)/1000:item.dueAt;if(!Number.isFinite(dueAt)||dueAt<=Date.now()/1000||dueAt>Date.now()/1000+365*86400)throw new Error();const id=store.addReminder(item.text,dueAt);changed();return {ok:true,id};});
for(const action of ['deleteNote','deleteReminder','completeReminder'])register(action,id=>{store[action](id);announced.delete(id);changed();return {ok:true};});
register('updateSettings',async patch=>{allowCapture=false;tts?.kill();await voice.stop();return saveSettings(patch);});
register('startVoice',async()=>{allowCapture=true;await voice.start();return voice.state==='waiting'?{ok:true}:{ok:false,message:'Не удалось включить локальное распознавание имени.'};});
register('stopVoice',async()=>{allowCapture=false;tts?.kill();await voice.stop();return {ok:true};});
register('finishVoice',()=>{voice.finish();return {ok:true};});register('activateVoice',()=>voice.activate());
ipcMain.on('jeff:audio',(event,pcm)=>{if(validateSender(event)&&allowCapture&&pcm instanceof Int16Array&&pcm.length===1280)void voice.accept(pcm);});
await window.loadFile(path.join(here,'renderer','index.html'));
if(!process.argv.includes('--background'))window.show();
else if(settings.autoStart)emit({type:'auto-start'});
poll=setInterval(pollReminders,1000);
app.on('before-quit',()=>{quitting=true;allowCapture=false;clearInterval(poll);tts?.kill();gateway.close();void voice.stop();});
app.on('will-quit',()=>store.close());
if(isolated&&process.argv.includes('--diagnostics')){
  try{await (await import('./diagnostics.mjs')).runDiagnostics(window,store,dataDir);quitting=true;app.quit();}
  catch{fs.writeFileSync(path.join(dataDir,'diagnostics.json'),JSON.stringify({ok:false,message:'Packaged diagnostics failed'}));quitting=true;app.exit(1);}
}
}).catch(()=>{fs.mkdirSync(dataDir,{recursive:true});fs.writeFileSync(path.join(dataDir,'startup-error.log'),'Не удалось запустить Assistant Jeff. Проверьте установку и доступность папки данных.');app.exit(1);});
}
