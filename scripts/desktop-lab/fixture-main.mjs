import {app,BrowserWindow,ipcMain,shell} from 'electron';
import {fileURLToPath} from 'node:url';
import {mkdirSync} from 'node:fs';
import {NativeLab} from './controller.mjs';

app.setName('Jeff Windows Lab');
const profile=fileURLToPath(new URL('../../work/desktop-lab/fixture-profile/',import.meta.url));
mkdirSync(profile,{recursive:true});
app.setPath('userData',profile);
let window;
export const lab=new NativeLab(value=>{if(window&&!window.isDestroyed())window.webContents.send('lab:progress',value);});
if(!app.requestSingleInstanceLock()){app.quit();}else{
  app.on('second-instance',()=>{window?.show();window?.focus();});
  app.whenReady().then(async()=>{
    window=new BrowserWindow({width:1000,height:790,minWidth:760,minHeight:620,title:'Jeff Windows Lab',
      webPreferences:{preload:fileURLToPath(new URL('./preload.cjs',import.meta.url)),contextIsolation:true,nodeIntegration:false,sandbox:true}});
    window.removeMenu();
    window.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    window.webContents.on('will-navigate',event=>event.preventDefault());
    window.webContents.session.setPermissionRequestHandler((_contents,_permission,callback)=>callback(false));
    for(const [name,handler] of Object.entries({start:()=>lab.start(),state:()=>lab.state(),run:payload=>lab.run(payload),stop:()=>lab.stop(),history:()=>lab.history(),readRun:payload=>lab.readRun(payload),openLogs:async()=>{mkdirSync(lab.logDirectory,{recursive:true});const error=await shell.openPath(lab.logDirectory);return error?{error:'LOG_DIRECTORY_OPEN_FAILED'}:{opened:true};}})){
      ipcMain.handle(`lab:${name}`,async(event,payload)=>{
        if(event.sender!==window.webContents||event.senderFrame!==window.webContents.mainFrame)throw new Error('Invalid sender');
        try{return await handler(payload);}catch(error){return {error:/^[A-Z_]{1,60}$/.test(error.code)?error.code:'LAB_ERROR',running:lab.running};}
      });
    }
    await window.loadFile(fileURLToPath(new URL('./fixture/lab.html',import.meta.url)));
  });
  app.on('window-all-closed',()=>app.quit());
  app.on('before-quit',()=>lab.dispose());
}
