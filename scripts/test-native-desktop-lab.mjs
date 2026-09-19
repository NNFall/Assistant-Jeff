import {NativeLab} from './desktop-lab/controller.mjs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../work/desktop-lab/',import.meta.url));
const cases=[
  {scenario:'tabs',command:'Открой первую вкладку ВКонтакте в тестовом окне.'},
  {scenario:'music',command:'Включи воспроизведение музыки в тестовом окне.'},
];
const reports=[];
for(const task of cases){
  const lab=new NativeLab();
  try{
    const state=await lab.start();
    if(!state.snapshot.elements.length)throw new Error('No actual UIA controls');
    const report=await lab.run(task);reports.push(report);
    console.log(JSON.stringify({scenario:task.scenario,ok:report.ok,reason:report.reason,elapsedMs:report.elapsedMs,calls:report.calls.map(x=>({choice:x.decision?.choice,p:x.decision?.probability,confidence:x.decision?.confidence,latencyMs:x.decision?.latencyMs,error:x.error})),facts:report.final?.facts}));
    if(!report.ok)process.exitCode=1;
  }catch(error){reports.push({scenario:task.scenario,ok:false,reason:error.code??'SMOKE_FAILED'});process.exitCode=1;console.log(JSON.stringify(reports.at(-1)));}
  finally{lab.dispose();}
}
await mkdir(root,{recursive:true});
await writeFile(root+'native-smoke.json',JSON.stringify({mode:'REAL_API_REAL_NATIVE_FIXTURE',reports},null,2));
