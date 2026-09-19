import {createHash} from 'node:crypto';
import {execFile,spawn} from 'node:child_process';
import {realpath,stat} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import path from 'node:path';

const SCRIPT=fileURLToPath(new URL('../../scripts/windows-desktop/read-apps.ps1',import.meta.url));
const POWERSHELL=path.win32.join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
const runFile=promisify(execFile);
const failure=code=>Object.assign(new Error(code),{code});
const aborted=signal=>{if(signal?.aborted)throw failure('ABORTED');};
const blocked=/(?:uninstall|unins\d*|updat(?:e|er|ing)|setup|installer|maintenance|repair|codex|antigravity|password|keepass|bitwarden|1password|lastpass|dashlane|nordpass|security|defender|antivirus|credential|settings|control panel|terminal|powershell|command prompt|удалени|деинстал|обновлен|установщик|парол|безопасност|параметры|командная строка)/iu;
const blockedExecutable=/^(?:cmd|powershell|pwsh|conhost|wt|windowsterminal|bash|wsl|sh|python\d*|pythonw\d*|node|deno|bun|ruby|perl|cscript|wscript|mshta|rundll32|regsvr32|regedit|mmc|control|taskmgr|procexp\d*|processhacker|runas|java|javaw|electron|msiexec|schtasks|sc|net|netsh|bcdedit|diskpart|format|services|secpol|gpedit|mstsc|ssh|putty|openconsole)$/i;

function allowedExecutable(exe){
  return typeof exe==='string'&&exe.length<=1024&&/^[a-z]:\\/i.test(exe)&&/\.exe$/i.test(exe)
    &&!/[\x00-\x1f\x7f"<>|?*%]/.test(exe)&&!exe.slice(2).includes(':')&&!exe.includes('/')
    &&path.win32.normalize(exe)===exe&&!exe.split('\\').some(part=>/[. ]$/.test(part))
    &&!/(?:^|\\)Windows(?:\\|$)/i.test(exe)&&!blocked.test(exe)&&!/(?:api[_-]?key|bearer\s)/i.test(exe)
    &&!blockedExecutable.test(path.win32.basename(exe).replace(/\.exe$/i,''));
}
function record(value){
  if(!value||typeof value.name!=='string'||!allowedExecutable(value.exe))return null;
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

/** Read local Start Menu metadata. Never return shortcut arguments or raw stderr. */
export async function discoverInstalledApps({signal,runner=runFile}={}){
  aborted(signal);
  let output;
  try {
    output=await runner(POWERSHELL,['-NoProfile','-NonInteractive','-File',SCRIPT],{
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
  const seen=new Set(),apps=[];
  for(const value of values){
    const app=record(value);
    if(!app||seen.has(app.id))continue;
    seen.add(app.id);apps.push(app);
    if(apps.length===200)break;
  }
  return Object.freeze(apps);
}

/** Only IDs from this instance's discovered catalog can launch an application. */
export class InstalledApps {
  #apps=new Map();
  constructor({runner=runFile,spawnImpl=spawn,realpathImpl=realpath,statImpl=stat}={}){
    this.runner=runner;this.spawnImpl=spawnImpl;this.realpathImpl=realpathImpl;this.statImpl=statImpl;
  }
  async list(signal){
    const values=await discoverInstalledApps({signal,runner:this.runner});
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
      if(!allowedExecutable(canonical)||canonical.toLowerCase()!==app.exe.toLowerCase()||!info.isFile())throw failure('APP_TARGET_CHANGED');
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
        child.once('error',()=>finishError('APP_LAUNCH_FAILED'));
        child.once('spawn',()=>{
          child.unref();
          if(settled)return;
          settled=true;cleanup();
          resolve({pid:child.pid,appId:app.id,name:app.name,processName:app.processName,launched:true});
        });
      } catch {finishError(signal?.aborted?'ABORTED':'APP_LAUNCH_FAILED');}
    });
  }
}
