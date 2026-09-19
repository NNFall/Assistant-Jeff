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
  assert.equal(await js('document.getElementById("command").readOnly'),false);
  await js('document.getElementById("start").click()');
  await until(()=>js('document.getElementById("elements").children.length > 0 && !document.getElementById("start").disabled'));
  const cases=[
    {command:'Включи музыку в тестовом окне.',expected:'goal_verified',facts:{playing:true}},
    {command:'Выбери русский язык внутри тестового окна.',expected:'goal_verified',facts:{language:'Russian'}},
    {command:'Поставь воспроизведение на паузу.',expected:'goal_verified',facts:{playing:false}},
    {command:'Объясни, что означает «включи музыку».',expected:'no_request'},
    {command:'Открой Chrome и включи музыку.',expected:['unsupported','goal_low_confidence']},
  ];
  for(const task of (observeOnly?[]:cases)){
    await js(`document.getElementById('command').value=${JSON.stringify(task.command)}; document.getElementById('command').dispatchEvent(new Event('input')); document.getElementById('run').click();`);
    await until(()=>js('!document.getElementById("run").disabled && (()=>{try{const r=JSON.parse(document.getElementById("trace").textContent);return typeof r.runId==="string" && r.status!=="running";}catch{return false;}})()'),65000);
    const report=await js('JSON.parse(document.getElementById("trace").textContent)');
    reports.push(report);
    console.log(JSON.stringify({command:task.command,ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,goal:report.goal,calls:report.calls?.map(({kind,decision:d,error})=>({kind,choice:d?.choice,p:d?.probability,confidence:d?.confidence,latencyMs:d?.latencyMs,error})),facts:report.final?.facts,runId:report.runId}));
    if (!(Array.isArray(task.expected)?task.expected:[task.expected]).includes(report.reason))exitCode=1;
    if(task.facts)for(const [key,value]of Object.entries(task.facts)){if(report.final?.facts?.[key]!==value)exitCode=1;}
    else assert.equal(report.completed.length,0,'Rejected command must not execute');
    const stored=await lab.readRun({runId:report.runId});
    assert.equal(stored.command,task.command);assert.equal(stored.reason,report.reason);
    assert.ok(stored.events.some(event=>event.phase==='model_request'));
    assert.equal(stored.events.at(-1).phase,'result');
  }
  await js('document.getElementById("history").click()');
  await until(()=>js('document.getElementById("history-list").children.length > 0'));
  await js('document.querySelector("#history-list button").click()');
  await until(()=>js('document.getElementById("history-json").textContent.includes("runId")'));
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
