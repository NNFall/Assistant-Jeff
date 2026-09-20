import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import path from 'node:path';

const SCRIPT=fileURLToPath(new URL('../../scripts/windows-desktop/read-apps.ps1',import.meta.url));
const SYSTEM_ROOT=process.env.SystemRoot||'C:\\Windows';
const POWERSHELL=path.win32.join(SYSTEM_ROOT,'System32','WindowsPowerShell','v1.0','powershell.exe');
const runFile=promisify(execFile);
const failure=code=>Object.assign(new Error(code),{code});
const aborted=signal=>{if(signal?.aborted)throw failure('ABORTED');};
const blocked=/(?:uninstall|unins\d*|updat(?:e|er|ing)|setup|installer|maintenance|repair|codex|antigravity|password|keepass|bitwarden|1password|lastpass|dashlane|nordpass|security|defender|antivirus|credential|settings|control panel|terminal|powershell|command prompt|удалени|деинстал|обновлен|установщик|парол|безопасност|параметры|командная строка)/iu;
const blockedExecutable=/^(?:cmd|powershell|pwsh|conhost|wt|windowsterminal|bash|wsl|sh|python\d*|pythonw\d*|node|deno|bun|ruby|perl|cscript|wscript|mshta|rundll32|regsvr32|regedit|mmc|control|taskmgr|procexp\d*|processhacker|runas|java|javaw|electron|msiexec|schtasks|sc|net|netsh|bcdedit|diskpart|format|services|secpol|gpedit|mstsc|ssh|putty|openconsole)$/i;

function localPath(value){
  return typeof value==='string'&&value.length<=1024&&/^[a-z]:\\/i.test(value)
    &&!/[\x00-\x1f\x7f"<>|?*%]/.test(value)&&!value.slice(2).includes(':')&&!value.includes('/')
    &&path.win32.normalize(value)===value&&!value.split('\\').some(part=>/[. ]$/.test(part));
}
function taskManagerPath(platform,systemRoot){
  return platform==='win32'&&localPath(systemRoot)?path.win32.join(systemRoot,'System32','Taskmgr.exe'):null;
}
function allowedExecutable(exe,{systemRoot=SYSTEM_ROOT,taskManagerExe=null}={}){
  if(!localPath(exe)||!/\.exe$/i.test(exe))return false;
  if(taskManagerExe&&exe.toLowerCase()===taskManagerExe.toLowerCase())return true;
  const underSystemRoot=localPath(systemRoot)&&exe.toLowerCase().startsWith(systemRoot.toLowerCase().replace(/\\$/,'')+'\\');
  return !underSystemRoot&&!/(?:^|\\)Windows(?:\\|$)/i.test(exe)&&!blocked.test(exe)&&!/(?:api[_-]?key|bearer\s)/i.test(exe)
    &&!blockedExecutable.test(path.win32.basename(exe).replace(/\.exe$/i,''));
}
function record(value,policy){
  if(!value||typeof value.name!=='string'||!allowedExecutable(value.exe,policy))return null;
  // Defense in depth for alternate/injected discovery runners. Production's
  // PowerShell reader drops these shortcuts before serializing any metadata.
  if(Object.keys(value).some(key=>key.toLowerCase()==='arguments'&&value[key]!==''&&value[key]!=null))return null;
  const name=value.name.trim();
  if(name.length<2||name.length>100||!/[\p{L}]/u.test(name)||/[\x00-\x1f\x7f\\/:<>|]/.test(name)
    ||blocked.test(name)||/(?:api[_-]?key|bearer\s|[a-z0-9_-]{40,})/i.test(name))return null;
  const exe=value.exe;
  const id='app_'+createHash('sha256').update(exe.toLowerCase()+'\0'+name.toLocaleLowerCase()).digest('hex').slice(0,24);
  return Object.freeze({id,name,exe,processName:path.win32.basename(exe).replace(/\.exe$/i,'')});
}

async function builtinTaskManager({platform,systemRoot,realpathImpl,statImpl,signal}){
  const exe=taskManagerPath(platform,systemRoot);
  if(!exe)return null;
  try {
    const [canonical,info]=await Promise.all([realpathImpl(exe),statImpl(exe)]);
    aborted(signal);
    if(!localPath(canonical)||canonical.toLowerCase()!==exe.toLowerCase()||!info.isFile())return null;
    return record({name:'Диспетчер задач (Task Manager)',exe},{systemRoot,taskManagerExe:exe});
  } catch {aborted(signal);return null;}
}
const launchFailure=error=>[error?.code,error?.errno,error?.win32Code,error?.nativeErrorCode].some(code=>[740,-740,'740','ERROR_ELEVATION_REQUIRED','ELEVATION_REQUIRED'].includes(code))?'APP_ELEVATION_REQUIRED':'APP_LAUNCH_FAILED';

/** Read local Start Menu metadata plus explicitly supported Windows built-ins. */
export async function discoverInstalledApps({signal,runner=runFile,scriptPath=SCRIPT,platform=process.platform,systemRoot=SYSTEM_ROOT,realpathImpl=realpath,statImpl=stat}={}){
  aborted(signal);
  let output;
  try {
    output=await runner(POWERSHELL,['-NoProfile','-NonInteractive','-File',scriptPath],{
      windowsHide:true,shell:false,encoding:'utf8',timeout:12000,maxBuffer:512*1024,signal,
    });
  } catch {aborted(signal);throw failure('APPS_DISCOVERY_FAILED');}
  aborted(signal);
  let values;
  try {
    if(typeof output?.stdout!=='string'||output.stdout.length>512*1024)throw new Error();
    values=JSON.parse(output.stdout.replace(/^\uFEFF/,''));
    if(!Array.isArray(values)||values.length>2000)throw new Error();
  } catch {throw failure('APPS_INVALID_CATALOG');}
  const builtin=await builtinTaskManager({platform,systemRoot,realpathImpl,statImpl,signal});
  aborted(signal);
  const seen=new Set(builtin?[builtin.id]:[]),apps=builtin?[builtin]:[];
  for(const value of values){
    // The exact system exception is created above, never named by a shortcut.
    const app=record(value,{systemRoot});
    if(!app||seen.has(app.id))continue;
    seen.add(app.id);apps.push(app);
    if(apps.length===200)break;
  }
  return Object.freeze(apps);
}

/** Only IDs from this instance's discovered catalog can launch an application. */
export class InstalledApps {
  #apps=new Map();
  constructor({runner=runFile,spawnImpl=spawn,realpathImpl=realpath,statImpl=stat,scriptPath=SCRIPT,platform=process.platform,systemRoot=SYSTEM_ROOT}={}){
    this.runner=runner;this.spawnImpl=spawnImpl;this.realpathImpl=realpathImpl;this.statImpl=statImpl;
    this.platform=platform;this.systemRoot=systemRoot;this.scriptPath=scriptPath;
  }
  async list(signal){
    const values=await discoverInstalledApps({signal,runner:this.runner,scriptPath:this.scriptPath,platform:this.platform,systemRoot:this.systemRoot,realpathImpl:this.realpathImpl,statImpl:this.statImpl});
    aborted(signal);
    this.#apps=new Map(values.map(app=>[app.id,app]));
    return values;
  }
  async launch(id,signal){
    aborted(signal);
    if(typeof id!=='string'||!/^app_[a-f0-9]{24}$/.test(id)||!this.#apps.has(id))throw failure('APP_NOT_OBSERVED');
    const app=this.#apps.get(id);
    try {
      const [canonical,info]=await Promise.all([this.realpathImpl(app.exe),this.statImpl(app.exe)]);
      aborted(signal);
      if(!allowedExecutable(canonical,{systemRoot:this.systemRoot,taskManagerExe:taskManagerPath(this.platform,this.systemRoot)})||canonical.toLowerCase()!==app.exe.toLowerCase()||!info.isFile())throw failure('APP_TARGET_CHANGED');
    } catch(error){aborted(signal);throw failure(error?.code==='APP_TARGET_CHANGED'?'APP_TARGET_CHANGED':'APP_TARGET_MISSING');}
    aborted(signal);
    return new Promise((resolve,reject)=>{
      let child,settled=false;
      const cleanup=()=>signal?.removeEventListener('abort',cancel);
      const finishError=code=>{if(settled)return;settled=true;cleanup();reject(failure(code));};
      const cancel=()=>finishError('ABORTED');
      signal?.addEventListener('abort',cancel,{once:true});
      // Cancellation stops the pending workflow; it never kills a newly opened
      // personal app. The controller observes the actual window after spawning.
      try {
        aborted(signal);
        child=this.spawnImpl(app.exe,[],{shell:false,detached:true,windowsHide:false,cwd:path.win32.dirname(app.exe),stdio:'ignore'});
        child.once('error',error=>finishError(launchFailure(error)));
        child.once('spawn',()=>{
          child.unref();
          if(settled)return;
          settled=true;cleanup();
          resolve({pid:child.pid,appId:app.id,name:app.name,processName:app.processName,launched:true});
        });
      } catch(error) {finishError(signal?.aborted?'ABORTED':launchFailure(error));}
    });
  }
}
