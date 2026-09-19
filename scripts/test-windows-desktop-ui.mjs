// Explicit opt-in integration test of this product's renderer, IPC, real model
// and real desktop backend. Never part of npm test. Runs only supplied commands.
import {app,BrowserWindow} from 'electron';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const commandIndex=process.argv.indexOf('--command');
if(!process.argv.includes('--live')||!process.argv.includes('--windows-smoke')||commandIndex<0||!process.argv[commandIndex+1]){
  console.error('Requires --live --windows-smoke --command <explicit task>');app.exit(2);
}else{
  void (async()=>{
  const command=process.argv[commandIndex+1];
  const directory=fileURLToPath(new URL(`../work/windows-desktop/ui-smoke-${Date.now()}/`,import.meta.url));
  const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  async function until(check,timeout=15000){const at=Date.now();while(Date.now()-at<timeout){if(await check())return;await pause(100);}throw new Error('UI_SMOKE_TIMEOUT');}
  let lab,report,window;
  try{
    ({lab}=await import('./desktop-lab/main.mjs'));
    await app.whenReady();await until(()=>BrowserWindow.getAllWindows().length===1);
    window=BrowserWindow.getAllWindows()[0];const js=source=>window.webContents.executeJavaScript(source,true);
    await until(async()=>!window.webContents.isLoadingMainFrame()&&await js('Boolean(window.lab && document.getElementById("command"))'));
    window.show();window.focus();
    await until(()=>window.isFocused(),5000);
    await js(`document.getElementById('command').value=${JSON.stringify(command)};document.getElementById('command').dispatchEvent(new Event('input'));document.getElementById('run').click();`);
    await until(()=>js('!document.getElementById("run").disabled && (()=>{try{const r=JSON.parse(document.getElementById("trace").textContent);return !!r.runId && r.status!=="running";}catch{return false;}})()'),100000);
    report=await js('JSON.parse(document.getElementById("trace").textContent)');
    const saved=await lab.readRun({runId:report.runId});
    if(saved.command!==command||saved.reason!==report.reason)throw new Error('JOURNAL_MISMATCH');
    await mkdir(directory,{recursive:true});
    await writeFile(directory+'report.json',JSON.stringify(report,null,2)+'\n');
    await js('window.scrollTo(0,0)');
    await writeFile(directory+'ui.png',(await window.webContents.capturePage()).toPNG());
    console.log(JSON.stringify({command,ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,runId:report.runId,completed:report.completed,calls:report.calls.map(c=>({choice:c.decision?.choice,probability:c.decision?.probability,confidence:c.decision?.confidence,goal:c.decision?.goalStatus,latencyMs:c.decision?.latencyMs})),directory}));
  }catch(error){console.error(error.message);process.exitCode=1;}
  finally{lab?.dispose();app.exit(process.exitCode??0);}
  })();
}
