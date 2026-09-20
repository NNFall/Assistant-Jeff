import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {discoverInstalledApps as discoverApps,InstalledApps} from '../desktop/automation/windows-apps.mjs';

const player={name:'Sample Player',exe:'C:\\Program Files\\Sample\\player.exe'};
const runnerFor=values=>async()=>({stdout:JSON.stringify(values)});
const options=values=>({platform:'test',runner:runnerFor(values),realpathImpl:async exe=>exe,statImpl:async()=>({isFile:()=>true})});
const discoverInstalledApps=options=>discoverApps({platform:'test',...options});

test('discovery uses a fixed hidden script and strips unknown fields',async()=>{
  let invocation;
  const apps=await discoverInstalledApps({runner:async(...args)=>{invocation=args;return {stdout:JSON.stringify([{...player,apiKey:'SECRET',id:'forged',processName:'cmd'}])};}});
  assert.match(invocation[0],/\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe$/i);
  assert.deepEqual(invocation[1].slice(0,3),['-NoProfile','-NonInteractive','-File']);
  assert.match(invocation[1][3],/scripts[\\/]windows-desktop[\\/]read-apps\.ps1$/);
  assert.equal(invocation[2].windowsHide,true);
  assert.equal(invocation[2].shell,false);
  assert.deepEqual(Object.keys(apps[0]).sort(),['exe','id','name','processName']);
  assert.equal(apps[0].processName,'player');
  assert.match(apps[0].id,/^app_[a-f0-9]{24}$/);
  assert.ok(Object.isFrozen(apps)&&Object.isFrozen(apps[0]));
  assert.ok(!JSON.stringify(apps).includes('SECRET'));
});

test('argument-dependent PWA/game shortcuts are discarded instead of mislabeled plain executables',async()=>{
  const values=[
    {name:'YouTube',exe:'C:\\Apps\\chrome.exe',Arguments:'--app=https://youtube.com --token SECRET'},
    {name:'A Game',exe:'C:\\Apps\\steam.exe',arguments:'-applaunch 123'},
    {...player,name:'Whitespace Arguments',Arguments:' '},
    {...player,Arguments:''},
  ];
  const apps=await discoverInstalledApps({runner:runnerFor(values)});
  assert.equal(apps.length,1);
  assert.equal(apps[0].name,player.name);
  assert.ok(!JSON.stringify(apps).includes('SECRET'));
  assert.ok(!Object.keys(apps[0]).some(key=>key.toLowerCase()==='arguments'));
});

test('discovery denies remote/device/script/traversal/argument paths and sensitive applications',async()=>{
  const paths=['\\\\server\\app.exe','\\\\?\\C:\\Apps\\app.exe','file:///C:/Apps/app.exe','C:app.exe',
    'C:\\Apps\\x.ps1','C:\\Apps\\x.cmd','C:\\Apps\\x.exe --token hi','C:\\Apps\\..\\x.exe','C:/Apps/app.exe',
    'C:\\Apps\\folder.\\x.exe','C:\\Apps\\x.exe:stream','C:\\Apps\\%USER%\\x.exe','C:\\Apps\\x\n.exe',
    'C:\\Windows\\notepad.exe','C:\\Apps\\cmd.exe','C:\\Apps\\NODE.EXE','C:\\Apps\\rundll32.exe',
    'C:\\Apps\\msiexec.exe','C:\\Apps\\settings.exe','C:\\Apps\\Codex.exe','C:\\Apps\\Bitwarden.exe',
    'C:\\Apps\\Update.exe','C:\\Apps\\unins000.exe','C:\\Apps\\WindowsTerminal.exe','C:\\Apps\\apikey_SECRET\\player.exe'];
  const names=['Uninstall Sample','Windows Security','PowerShell','Пароли','api_key_ABC','Bearer TOKEN','A'.repeat(50),'Invalid\nName','../Player'];
  const values=[...paths.map(exe=>({name:'Sample',exe})),...names.map(name=>({...player,name})),player];
  const apps=await discoverInstalledApps({runner:runnerFor(values)});
  assert.equal(apps.length,1);
  assert.equal(apps[0].name,player.name);
});

test('catalog deduplicates exact target and display name case-insensitively and limits 200 records',async()=>{
  const duplicated=await discoverInstalledApps({runner:runnerFor([player,player,{name:'sample player',exe:player.exe.toLowerCase()},{...player,name:'Player Alternate'}])});
  assert.equal(duplicated.length,2);
  const many=Array.from({length:250},(_,index)=>({name:`Player ${index}`,exe:`C:\\Apps\\player${index}.exe`}));
  assert.equal((await discoverInstalledApps({runner:runnerFor(many)})).length,200);
});

test('launch accepts only the discovered immutable id and has no shell or generated arguments',async()=>{
  let invocation,unrefs=0;
  const apps=new InstalledApps({...options([player]),spawnImpl:(...args)=>{
    invocation=args;const child=new EventEmitter();child.pid=123;child.unref=()=>unrefs++;
    queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  await assert.rejects(apps.launch('app_'+'a'.repeat(24)),{code:'APP_NOT_OBSERVED'});
  const [app]=await apps.list();
  assert.throws(()=>{app.exe='C:\\Apps\\cmd.exe';},TypeError);
  await assert.rejects(apps.launch(player.exe),{code:'APP_NOT_OBSERVED'});
  await assert.rejects(apps.launch({...app,id:app.id}),{code:'APP_NOT_OBSERVED'});
  const receipt=await apps.launch(app.id);
  assert.deepEqual(invocation,[player.exe,[],{shell:false,detached:true,windowsHide:false,cwd:'C:\\Program Files\\Sample',stdio:'ignore'}]);
  assert.deepEqual(receipt,{pid:123,appId:app.id,name:'Sample Player',processName:'player',launched:true});
  assert.equal(unrefs,1);
  assert.equal('verified' in receipt,false);
});

test('launch revalidates missing, directory and redirected executables before spawning',async()=>{
  let calls=0;
  for(const override of [
    {realpathImpl:async()=>{throw Object.assign(new Error('private path'),{code:'ENOENT'});}},
    {realpathImpl:async()=> 'C:\\Apps\\cmd.exe'},
    {realpathImpl:async()=> 'C:\\Apps\\another.exe'},
    {statImpl:async()=>({isFile:()=>false})},
  ]){
    const apps=new InstalledApps({...options([player]),...override,spawnImpl:()=>calls++});
    const [app]=await apps.list();
    await assert.rejects(apps.launch(app.id),error=>['APP_TARGET_CHANGED','APP_TARGET_MISSING'].includes(error.code)&&!error.message.includes('private path'));
  }
  assert.equal(calls,0);
});

test('refresh removes obsolete catalog IDs, discovery and launch errors do not leak command/output',async()=>{
  let values=[player];
  const apps=new InstalledApps({...options([]),runner:async()=>({stdout:JSON.stringify(values)}),spawnImpl:()=>{throw new Error('SECRET');}});
  const [app]=await apps.list();
  await assert.rejects(apps.launch(app.id),{code:'APP_LAUNCH_FAILED',message:'APP_LAUNCH_FAILED'});
  values=[];await apps.list();
  await assert.rejects(apps.launch(app.id),{code:'APP_NOT_OBSERVED'});
  await assert.rejects(discoverInstalledApps({runner:async()=>{throw new Error('SECRET');}}),{code:'APPS_DISCOVERY_FAILED',message:'APPS_DISCOVERY_FAILED'});
  await assert.rejects(discoverInstalledApps({runner:async()=>({stdout:'SECRET'})}),{code:'APPS_INVALID_CATALOG',message:'APPS_INVALID_CATALOG'});
});

test('cancellation prevents discovery/launch and is rechecked after filesystem validation',async()=>{
  const abort=new AbortController();abort.abort();let spawns=0,discovery=0;
  const apps=new InstalledApps({...options([player]),spawnImpl:()=>spawns++});
  await assert.rejects(discoverInstalledApps({signal:abort.signal,runner:async()=>{discovery++;}}),{code:'ABORTED'});
  const [app]=await apps.list();
  await assert.rejects(apps.launch(app.id,abort.signal),{code:'ABORTED'});
  const during=new AbortController();
  const other=new InstalledApps({...options([player]),realpathImpl:async exe=>{during.abort();return exe;},spawnImpl:()=>spawns++});
  const [otherApp]=await other.list();
  await assert.rejects(other.launch(otherApp.id,during.signal),{code:'ABORTED'});
  assert.equal(spawns,0);assert.equal(discovery,0);
});

test('cancellation while awaiting spawn rejects without killing the personal application',async()=>{
  const abort=new AbortController();let child,killed=0,unref=0;
  const apps=new InstalledApps({...options([player]),spawnImpl:()=>{
    child=new EventEmitter();child.pid=123;child.kill=()=>killed++;child.unref=()=>unref++;return child;
  }});
  const [app]=await apps.list();
  const pending=apps.launch(app.id,abort.signal);
  await new Promise(resolve=>setImmediate(resolve));abort.abort();
  await assert.rejects(pending,{code:'ABORTED'});
  child.emit('spawn');
  assert.equal(killed,0);assert.equal(unref,1);
});

test('read-only discovery rejects nonempty shortcut Arguments without storing or returning contents',async()=>{
  const script=await readFile(new URL('../scripts/windows-desktop/read-apps.ps1',import.meta.url),'utf8');
  assert.match(script,/CreateShortcut\(\$link\.FullName\)/);
  assert.match(script,/\$shortcut\.TargetPath/);
  assert.match(script,/if \(-not \[string\]::IsNullOrEmpty\(\[string\]\$shortcut\.Arguments\)\) \{ continue \}/);
  assert.equal((script.match(/\$shortcut\.Arguments/g)??[]).length,1);
  assert.match(script,/\[pscustomobject\]@\{ name = \$name; exe = \$full \}/);
  assert.doesNotMatch(script,/Start-Process|SendKeys|UIAutomation|Invoke-Expression/i);
  assert.doesNotMatch(script,/[^\x00-\x7f]/);
  assert.match(script,/\$drive\.DriveType -notin/);
});

test('Task Manager is a verified built-in even without any Start Menu links',async()=>{
  const checks=[];
  const apps=await discoverApps({...options([]),platform:'win32',systemRoot:'C:\\Windows',
    realpathImpl:async exe=>{checks.push(['realpath',exe]);return exe.toLowerCase();},
    statImpl:async exe=>{checks.push(['stat',exe]);return {isFile:()=>true};},
  });
  assert.equal(apps.length,1);
  assert.deepEqual(Object.keys(apps[0]).sort(),['exe','id','name','processName']);
  assert.equal(apps[0].exe,'C:\\Windows\\System32\\Taskmgr.exe');
  assert.equal(apps[0].name,'Диспетчер задач (Task Manager)');
  assert.equal(apps[0].processName,'Taskmgr');
  assert.ok(Object.isFrozen(apps[0]));
  assert.deepEqual(checks,[['realpath',apps[0].exe],['stat',apps[0].exe]]);
});

test('only the exact built-in path is excepted; aliases and all other system executables stay blocked',async()=>{
  for(const systemRoot of ['C:\\Windows','D:\\OperatingSystem']){
    const taskExe=systemRoot+'\\System32\\Taskmgr.exe';
    const values=[
      {name:'Arbitrary Task Alias',exe:taskExe},
      {name:'Task Manager',exe:systemRoot+'\\SysWOW64\\Taskmgr.exe'},
      {name:'Task Manager',exe:systemRoot+'\\System32\\Subfolder\\Taskmgr.exe'},
      {name:'Task Manager',exe:systemRoot+'\\System32\\..\\Taskmgr.exe'},
      {name:'Task Manager',exe:'C:\\Apps\\Taskmgr.exe'},
      {name:'Notepad',exe:systemRoot+'\\System32\\notepad.exe'},
      {name:'Control Panel',exe:systemRoot+'\\System32\\control.exe'},
      {name:'Command Processor',exe:systemRoot+'\\System32\\cmd.exe'},
      player,
    ];
    const apps=await discoverApps({...options(values),platform:'win32',systemRoot});
    assert.equal(apps.length,2);
    assert.equal(apps[0].exe,taskExe);
    assert.equal(apps[0].name,'Диспетчер задач (Task Manager)');
    assert.equal(apps[1].name,player.name);
  }
});

test('missing, redirected, non-Windows or invalid-root Task Manager is not advertised',async()=>{
  const base={...options([]),platform:'win32',systemRoot:'C:\\Windows'};
  for(const overrides of [
    {platform:'linux'},
    {systemRoot:'\\\\server\\Windows'},
    {systemRoot:'C:\\Windows\\..\\Elsewhere'},
    {realpathImpl:async()=>{throw Object.assign(new Error('private detail'),{code:'ENOENT'});}},
    {realpathImpl:async()=> 'C:\\Apps\\Taskmgr.exe'},
    {statImpl:async()=>({isFile:()=>false})},
  ])assert.deepEqual(await discoverApps({...base,...overrides}),[]);
});

test('Task Manager launch uses the canonical system executable with no arguments or shell',async()=>{
  let invocation;
  const catalog=new InstalledApps({...options([]),platform:'win32',systemRoot:'C:\\Windows',spawnImpl:(...args)=>{
    invocation=args;const child=new EventEmitter();child.pid=321;child.unref=()=>{};queueMicrotask(()=>child.emit('spawn'));return child;
  }});
  const [app]=await catalog.list();
  const result=await catalog.launch(app.id);
  assert.deepEqual(invocation,['C:\\Windows\\System32\\Taskmgr.exe',[],{shell:false,detached:true,windowsHide:false,cwd:'C:\\Windows\\System32',stdio:'ignore'}]);
  assert.equal(result.processName,'Taskmgr');
  assert.equal(result.launched,true);
  assert.equal(result.verified,undefined);
});

test('Task Manager is revalidated at launch and an elevation error never triggers escalation',async()=>{
  let canonical='C:\\Windows\\System32\\Taskmgr.exe',spawns=0;
  const catalog=new InstalledApps({...options([]),platform:'win32',systemRoot:'C:\\Windows',realpathImpl:async()=>canonical,spawnImpl:()=>{
    spawns++;const child=new EventEmitter();child.unref=()=>{};
    queueMicrotask(()=>child.emit('error',Object.assign(new Error('private command'),{errno:740})));
    return child;
  }});
  const [app]=await catalog.list();
  canonical='C:\\Windows\\SysWOW64\\Taskmgr.exe';
  await assert.rejects(catalog.launch(app.id),{code:'APP_TARGET_CHANGED'});
  assert.equal(spawns,0);
  canonical='C:\\Windows\\System32\\Taskmgr.exe';
  await assert.rejects(catalog.launch(app.id),{code:'APP_ELEVATION_REQUIRED',message:'APP_ELEVATION_REQUIRED'});
  assert.equal(spawns,1);
});

test('cancellation during built-in existence checks stops discovery',async()=>{
  const abort=new AbortController();
  await assert.rejects(discoverApps({...options([]),platform:'win32',systemRoot:'C:\\Windows',signal:abort.signal,
    realpathImpl:async exe=>{abort.abort();return exe;},
  }),{code:'ABORTED'});
});
