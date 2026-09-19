// Run explicitly with Electron. Real API calls and effects only in our own fixture.
import {app, BrowserWindow} from 'electron';
import {mkdir, writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';

const directory=fileURLToPath(new URL(`../work/desktop-lab/ui-smoke-${new Date().toISOString().replace(/[:.]/g,'-')}/`,import.meta.url));
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(test,timeout=15000){
  const start=Date.now();
  while(Date.now()-start<timeout){if(await test())return;await pause(100);}
  throw new Error('UI_SMOKE_TIMEOUT');
}
const reports=[];
const observeOnly=process.argv.includes('--observe-only');
let exitCode=0;
let lab;
async function run() {
try {
  ({lab}=await import('./desktop-lab/main.mjs'));
  await app.whenReady();
  await until(()=>BrowserWindow.getAllWindows().length===1);
  const window=BrowserWindow.getAllWindows()[0];
  const js=source=>window.webContents.executeJavaScript(source);
  await until(async()=>!window.webContents.isLoadingMainFrame()&&await js('Boolean(window.lab && document.getElementById("start"))'));
  assert.equal(await js('document.getElementById("command").readOnly'),true);
  await js('document.getElementById("start").click()');
  await until(()=>js('document.getElementById("elements").children.length > 0 && !document.getElementById("run").disabled'));
  for(const scenario of (observeOnly?[]:['tabs','music'])){
    await js(`document.getElementById('scenario').value='${scenario}'; document.getElementById('scenario').dispatchEvent(new Event('change')); document.getElementById('run').click();`);
    await until(()=>js('!document.getElementById("run").disabled && document.getElementById("trace").textContent.startsWith("{")'),60000);
    const report=await js('JSON.parse(document.getElementById("trace").textContent)');
    reports.push(report);
    console.log(JSON.stringify({scenario,ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,calls:report.calls?.map(({decision:d,error})=>({choice:d?.choice,p:d?.probability,confidence:d?.confidence,latencyMs:d?.latencyMs,error})),facts:report.final?.facts}));
    if (report.ok !== true || report.reason !== 'goal_verified') exitCode=1;
  }
  if (reports[0]?.ok) assert.equal(reports[0].calls.length,1,'Tab scenario must select an observed tab');
  if (reports[1]?.ok) {
    assert.equal(reports[1].calls.length,2,'Music scenario must observe after tab selection, then play');
    assert.equal(reports[1].completed.length,2);
  }
  await mkdir(directory,{recursive:true});
  window.setSize(1180,1000);
  await js('window.scrollTo(0,0)');await pause(300);
  assert.equal(await js('document.documentElement.scrollWidth <= window.innerWidth'),true,'No horizontal overflow');
  await writeFile(directory+'lab.png',(await window.webContents.capturePage()).toPNG());
} catch(error) {
  exitCode=1;
  console.error(error.message);
} finally {
  lab?.dispose();
  await mkdir(directory,{recursive:true});
  await writeFile(directory+'reports.json',JSON.stringify({mode:observeOnly?'REAL_UIA_OBSERVE_ONLY_NO_MODEL':'REAL_ELECTRON_UI_REAL_JEV_REAL_NATIVE_FIXTURE',passed:exitCode===0,reports},null,2)+'\n');
  console.log(JSON.stringify({artifacts:directory,passed:exitCode===0}));
  app.exit(exitCode);
}
}
void run();
