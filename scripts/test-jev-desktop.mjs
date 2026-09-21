import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {WindowsDesktop} from './windows-desktop/controller.mjs';
import {JevCommands} from '../desktop/agent/jev-commands.mjs';
import {createJevDesktopSession} from '../desktop/agent/jev-desktop-session.mjs';
import {createSystemTools} from '../desktop/automation/system-tools.mjs';
import {chooseJevStep,buildJevStepRequest} from '../desktop/providers/jev-step.mjs';
import {readProtected} from '../desktop/secrets.mjs';

// Explicit opt-in for real effects; default only observes and asks Jev once.
const args=process.argv.slice(2),at=args.indexOf('--command');
const command=at>=0?args[at+1]:null;
if(!command)throw new Error('Usage: node scripts/test-jev-desktop.mjs --command "..." [--execute]');
const root=fileURLToPath(new URL('../',import.meta.url));
const directory=path.join(root,'work','jev-desktop-checks');
const apiKeyResolver=async()=>process.env.TYPESAFE_API_KEY||await readProtected(path.join(process.env.APPDATA,'Assistant Jeff','secrets','typesafe.dpapi'))||await readProtected(path.join(root,'data','secrets','typesafe.dpapi'));
const desktop=new WindowsDesktop(()=>{},{directory,apiKeyResolver});
const systemTools=createSystemTools({bridge:desktop.bridge});
const events=[];
try{
  if(args.includes('--execute')){
    const commands=new JevCommands({directory,apiKeyResolver,createSession:({command})=>createJevDesktopSession({desktop,systemTools,command}),
      progress:event=>{
        events.push(event);
        if(['model_decision','execute_request','verify','result','goal_verification'].includes(event.phase))console.log(JSON.stringify({phase:event.phase,step:event.step,message:event.message,label:event.label??event.candidate?.label,
          choice:event.choice??event.decision?.choice,probability:event.probability??event.decision?.probability,confidence:event.confidence??event.decision?.confidence,latencyMs:event.latencyMs??event.decision?.latencyMs,reason:event.reason}));
      }});
    const result=await commands.run({command});
    console.log(JSON.stringify({ok:result.ok,reason:result.reason,elapsedMs:result.elapsedMs,goalVerification:result.goalVerification,logPath:result.logPath,
      decisions:result.calls.map(call=>({choice:call.decision?.choice,probability:call.decision?.probability,confidence:call.decision?.confidence,latencyMs:call.decision?.latencyMs})),
      completed:result.completed.map(step=>({label:step.label,operation:step.operation,outcome:step.outcome,evidence:step.evidence}))}));
    process.exitCode=result.ok?0:2;
  }else{
    const session=createJevDesktopSession({desktop,systemTools,command});
    const current=await session.observe();
    const input={command,observation:current.observation,candidates:current.candidates.map(({stableKey,...rest})=>rest),recentSteps:[]};
    const result=await chooseJevStep(input,{apiKey:await apiKeyResolver()});
    console.log(JSON.stringify({effects:false,choice:result.choice,label:input.candidates.find(c=>c.id===result.choice)?.label,probability:result.probability,confidence:result.confidence,latencyMs:result.latencyMs,usage:result.usage,requestBytes:Buffer.byteLength(JSON.stringify(buildJevStepRequest(input)))}));
  }
}catch(error){console.error(JSON.stringify({error:/^[A-Z_]{1,64}$/.test(error.code??'')?error.code:'JEV_CHECK_FAILED'}));process.exitCode=1;}
finally{desktop.dispose();}
