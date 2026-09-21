import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {buildWindowsCandidates,validateWindowsSnapshot} from '../desktop/automation/windows-candidates.mjs';

const root=fileURLToPath(new URL('../',import.meta.url));
const work=path.join(root,'work','windows-desktop');
const helper=path.join(work,'bin','JeffWindowsDesktopHelper.exe');

test('shell roots expose inspection and observed UIA controls without application window effects',()=>{
  const windows=[{id:'win_taskbar',title:'Панель задач',processName:'explorer',surfaceKind:'taskbar',className:'Shell_TrayWnd',minimized:false,maximized:false,active:false}];
  const snapshot={version:'0123456789abcdef0123456789abcdef',windows,elements:[
    {id:'win_taskbar',windowId:'win_taskbar',label:'Панель задач',role:'Window',capabilities:['inspect']},
    {id:'el_audio',windowId:'win_taskbar',label:'Динамики',name:'Динамики',role:'Button',processName:'ShellExperienceHost',capabilities:['click']},
  ],facts:{selectedWindowId:'win_taskbar',surfaceStatus:'available'},metadata:{truncated:false,inventoryTruncated:false}};
  validateWindowsSnapshot(snapshot);
  const controls=buildWindowsCandidates(snapshot,'Открой выбор устройства звука').candidates;
  assert.deepEqual(controls.map(c=>[c.targetId,c.operation]),[['el_audio','click']]);
  for(const operation of ['activate','close','minimize','maximize','restore'])assert.deepEqual(buildWindowsCandidates(snapshot,'',{scope:{operation}}).candidates,[]);
  snapshot.facts.selectedWindowId=null;
  snapshot.elements=snapshot.elements.slice(0,1);
  assert.equal(buildWindowsCandidates(snapshot,'Панель задач').candidates[0].operation,'inspect');
});

test('native shell trust, process binding and new-surface evidence policies',{
  skip:process.platform!=='win32'||!fs.existsSync(helper)?'Build the native Windows helper to exercise its policy methods.':false,
},()=>{
  // Reflection exercises pure native policy methods. It never starts a helper,
  // observes personal windows, opens a UI fixture or dispatches a desktop action.
  const directory=fs.mkdtempSync(path.join(work,'shell-policy-'));
  const source=path.join(directory,'ShellPolicyTests.cs');
  const executable=path.join(directory,'ShellPolicyTests.exe');
  fs.writeFileSync(source,String.raw`
using System;
using System.Collections;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Reflection;
internal static class ShellPolicyTests {
 static Assembly assembly; static Type helper; static int checks;
 static object Call(string method, params object[] args) { return helper.GetMethod(method,BindingFlags.NonPublic|BindingFlags.Static).Invoke(null,args); }
 static void Check(bool condition,string label) { if(!condition)throw new Exception(label);checks++; }
 static object Record(string type,params object[] pairs) { var value=Activator.CreateInstance(assembly.GetType(type));for(int i=0;i<pairs.Length;i+=2)value.GetType().GetField((string)pairs[i]).SetValue(value,pairs[i+1]);return value; }
 static string WindowsPath(string relative) { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.Windows),relative); }
 static string Kind(string process,string relative,string cls,string title,bool tool) { return (string)Call("ClassifySurface",process,WindowsPath(relative),cls,title,tool); }
 static Dictionary<string,object> Win(string id,string kind) { return new Dictionary<string,object>{{"id",id},{"surfaceKind",kind}}; }
 static Dictionary<string,object> Snapshot(string sourceKind,string addedKind=null,bool incompleteTree=false,bool incompleteInventory=false) {
  var windows=new List<Dictionary<string,object>>{Win("source",sourceKind)};if(addedKind!=null)windows.Add(Win("new",addedKind));
  return new Dictionary<string,object>{{"windows",windows},{"elements",new List<Dictionary<string,object>>()},{"facts",new Dictionary<string,object>{{"selectedWindowId","source"},{"surfaceStatus","available"}}},{"metadata",new Dictionary<string,object>{{"truncated",incompleteTree},{"inventoryTruncated",incompleteInventory}}}};
 }
 static string Evidence(Dictionary<string,object> before,Dictionary<string,object> after) { return (string)Call("InvokeEvidence",before,after,"source"); }
 static int Main(string[] args) {
  try {
   assembly=Assembly.LoadFrom(args[0]);helper=assembly.GetType("WindowsDesktopHelper");
   Check((bool)Call("ConfigureDpiAwareness"),"native UIA thread establishes per-monitor physical coordinates");
   Check((bool)Call("PhysicalCoordinatesAvailable"),"physical coordinate context verified before click candidates");
   Check(Kind("explorer","explorer.exe","Shell_TrayWnd","",true)=="taskbar","canonical untitled tool-window taskbar");
   Check(Kind("explorer","explorer.exe","Shell_SecondaryTrayWnd","",true)=="taskbar","secondary taskbar");
   Check(Kind("explorer","explorer.exe","Progman","Program Manager",false)=="desktop","desktop root");
   Check(Kind("explorer","explorer.exe","WorkerW","",true)=="desktop","worker desktop root");
   Check(Kind("explorer","Temp\\explorer.exe","Shell_TrayWnd","",true)==null,"copied explorer cannot impersonate taskbar");
   Check(Kind("editor","explorer.exe","Shell_TrayWnd","",true)==null,"process-name mismatch denied");
   Check(Kind("explorer","explorer.exe","CabinetWClass","Files",false)=="application","file explorer remains an app window");
   Check(Kind("explorer","explorer.exe","NotifyIconOverflowWindow","",true)=="shell_popup","notification overflow");
   Check(Kind("shellexperiencehost",@"SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe","Windows.UI.Core.CoreWindow","",true)=="shell_popup","canonical shell host");
   Check(Kind("shellhost",@"System32\ShellHost.exe","ControlCenterWindow","",true)=="shell_popup","canonical modern shell host");
   Check(Kind("shellhost",@"Temp\ShellHost.exe","ControlCenterWindow","",true)==null,"copied modern shell host denied");
   Check(Kind("startmenuexperiencehost",@"SystemApps\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\StartMenuExperienceHost.exe","Windows.UI.Core.CoreWindow","",true)=="start_menu","canonical Start host");
   Check(Kind("searchhost",@"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe","Windows.UI.Core.CoreWindow","",true)=="search","canonical search host");
   Check(Kind("textinputhost",@"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe","Windows.UI.Core.CoreWindow","",true)=="shell_popup","canonical input host");
   Check(Kind("systemsettings",@"ImmersiveControlPanel\SystemSettings.exe","ApplicationFrameWindow","Параметры",false)=="settings","ordinary Windows Settings admitted");
   Check(Kind("applicationframehost",@"System32\ApplicationFrameHost.exe","ApplicationFrameWindow","Settings",false)=="settings","settings application frame");
   Check(Kind("editor",@"System32\untrusted.exe","Palette","Palette",true)==null,"ordinary tool windows remain excluded");
   Check(Kind("editor",@"System32\untrusted.exe","Window","",false)==null,"ordinary untitled windows remain excluded");
   foreach(string kind in new[]{"taskbar","desktop","start_menu","search","shell_popup"}) {
    var caps=(IList)Call("WindowCapabilities",Record("WindowIdentity","SurfaceKind",kind));
    Check(caps.Count==1&&(string)caps[0]=="inspect","shell roots are inspect-only: "+kind);
   }
   var sensitive=(System.Text.RegularExpressions.Regex)helper.GetField("SensitiveWindow",BindingFlags.NonPublic|BindingFlags.Static).GetValue(null);
   Check(!sensitive.IsMatch("Параметры звука")&&!sensitive.IsMatch("Быстрые настройки")&&!sensitive.IsMatch("Sound settings"),"settings labels are not credential labels");
   foreach(string label in new[]{"Password","Sign in","Security","Пароль","Учетные записи","Безопасность"})Check(sensitive.IsMatch(label),"sensitive guard retained: "+label);
   var window=Record("WindowIdentity","Pid",11,"Session",1,"Started",10L,"Path",WindowsPath("explorer.exe"),"ProcessName","explorer","SurfaceKind","taskbar");
   var embedded=Record("ProcessIdentityInfo","Pid",12,"Session",1,"Started",20L,"Path",WindowsPath(@"SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe"),"ProcessName","ShellExperienceHost");
   Check((bool)Call("AllowedEmbeddedProcess",window,embedded),"trusted shell cross-process embedding");
   embedded.GetType().GetField("Session").SetValue(embedded,2);Check(!(bool)Call("AllowedEmbeddedProcess",window,embedded),"cross-session embedding denied");embedded.GetType().GetField("Session").SetValue(embedded,1);
   embedded.GetType().GetField("Path").SetValue(embedded,WindowsPath(@"Temp\ShellExperienceHost.exe"));Check(!(bool)Call("AllowedEmbeddedProcess",window,embedded),"copied shell child denied");
   embedded.GetType().GetField("Path").SetValue(embedded,WindowsPath(@"SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe"));window.GetType().GetField("SurfaceKind").SetValue(window,"application");Check(!(bool)Call("AllowedEmbeddedProcess",window,embedded),"arbitrary app cross-process tree remains denied");
   var first=Record("ProcessIdentityInfo","Pid",12,"Session",1,"Started",20L,"Path",WindowsPath(@"SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe"),"ProcessName","ShellExperienceHost");
   Check((bool)Call("SameProcessIdentity",first,embedded),"stable child identity accepted");
   embedded.GetType().GetField("Started").SetValue(embedded,21L);Check(!(bool)Call("SameProcessIdentity",first,embedded),"reused child PID rejected");
   var clickPolicy=helper.GetMethod("IsObservedShellClickTarget",BindingFlags.NonPublic|BindingFlags.Static);
   var roleType=clickPolicy.GetParameters()[1].ParameterType;var buttonRole=Enum.Parse(roleType,"Button");var editRole=Enum.Parse(roleType,"Edit");var linkRole=Enum.Parse(roleType,"Hyperlink");
   window.GetType().GetField("SurfaceKind").SetValue(window,"taskbar");
   Check((bool)clickPolicy.Invoke(null,new object[]{window,buttonRole,"42.17"}),"observed taskbar Button may click");
   foreach(string kind in new[]{"shell_popup","start_menu"}) {window.GetType().GetField("SurfaceKind").SetValue(window,kind);Check((bool)clickPolicy.Invoke(null,new object[]{window,buttonRole,"42.17"}),"observed shell Button may click: "+kind);}
   foreach(string kind in new[]{"application","desktop","settings","search"}) {window.GetType().GetField("SurfaceKind").SetValue(window,kind);Check(!(bool)clickPolicy.Invoke(null,new object[]{window,buttonRole,"42.17"}),"click policy does not expand to: "+kind);}
   window.GetType().GetField("SurfaceKind").SetValue(window,"taskbar");
   Check(!(bool)clickPolicy.Invoke(null,new object[]{window,editRole,"42.17"})&&!(bool)clickPolicy.Invoke(null,new object[]{window,linkRole,"42.17"}),"only Button role may click");
   Check(!(bool)clickPolicy.Invoke(null,new object[]{window,buttonRole,""}),"click requires a runtime identity");
   window.GetType().GetField("Path").SetValue(window,WindowsPath(@"Temp\explorer.exe"));Check(!(bool)clickPolicy.Invoke(null,new object[]{window,buttonRole,"42.17"}),"click denies copied shell image");
   Check((bool)Call("HasClickBounds",new Rectangle(-500,10,80,30)),"negative monitor origin is valid geometry");
   foreach(var bounds in new[]{Rectangle.Empty,new Rectangle(1,1,0,30),new Rectangle(1,1,80,-1),new Rectangle(Int32.MaxValue-2,1,20,30)})Check(!(bool)Call("HasClickBounds",bounds),"empty or overflowing click geometry rejected");
   var composed=Record("WindowIdentity","ProcessName","ShellHost","Path",WindowsPath(@"System32\ShellHost.exe"),"SurfaceKind","shell_popup","ClassName","ControlCenterWindow");
   Check((bool)Call("CanInspectUiaOnlyShell",composed),"canonical composition popup may establish visibility through UIA");
   composed.GetType().GetField("ClassName").SetValue(composed,"DesktopWindowXamlSource");Check(!(bool)Call("CanInspectUiaOnlyShell",composed),"hidden XAML helper does not inherit popup visibility exception");
   composed.GetType().GetField("ClassName").SetValue(composed,"ControlCenterWindow");composed.GetType().GetField("Path").SetValue(composed,WindowsPath(@"Temp\ShellHost.exe"));Check(!(bool)Call("CanInspectUiaOnlyShell",composed),"copied composition host denied");
   foreach(string cls in new[]{"Shell_TrayWnd","Shell_SecondaryTrayWnd"})Check((bool)Call("CanInspectUiaOnlyShell",Record("WindowIdentity","ProcessName","explorer","Path",WindowsPath("explorer.exe"),"SurfaceKind","taskbar","ClassName",cls)),"taskbar transition may use observed UIA visibility: "+cls);
   Check(!(bool)Call("CanInspectUiaOnlyShell",Record("WindowIdentity","ProcessName","explorer","Path",WindowsPath("explorer.exe"),"SurfaceKind","application","ClassName","CabinetWClass")),"hidden app does not inherit shell visibility exception");
   var screen=new Rectangle(0,0,1920,1200);
   Check((bool)Call("HasVisibleShellBounds",new Rectangle(1440,0,480,1140),screen),"real composition popup has meaningful screen intersection");
   Check((bool)Call("HasVisibleShellBounds",new Rectangle(-400,20,200,300),new Rectangle(-1920,0,1920,1080)),"shell bounds support negative monitor origins");
   foreach(var bounds in new[]{Rectangle.Empty,new Rectangle(0,0,1,1),new Rectangle(0,0,1,1140),new Rectangle(1920,0,480,1140),new Rectangle(-479,0,480,1140),new Rectangle(Int32.MaxValue-2,1,20,30)})Check(!(bool)Call("HasVisibleShellBounds",bounds,screen),"stub, offscreen or invalid shell bounds cannot establish visibility");
   var rootHandle=new IntPtr(175);
   var shellRoot=Record("WindowIdentity","Handle",rootHandle,"Pid",17,"ProcessName","ShellHost","Path",WindowsPath(@"System32\ShellHost.exe"),"SurfaceKind","shell_popup","ClassName","ControlCenterWindow");
   Check((bool)Call("IsObservedShellRoot",shellRoot,17,rootHandle,"ControlCenterWindow"),"UIA direct shell root can supplement an omitted native inventory window");
   Check(!(bool)Call("IsObservedShellRoot",shellRoot,18,rootHandle,"ControlCenterWindow"),"UIA supplementary root must match native owning process");
   Check(!(bool)Call("IsObservedShellRoot",shellRoot,17,new IntPtr(176),"ControlCenterWindow"),"UIA supplementary root must match native HWND");
   Check(!(bool)Call("IsObservedShellRoot",shellRoot,17,rootHandle,"DesktopWindowXamlSource"),"UIA supplementary root must match native class");
   shellRoot.GetType().GetField("SurfaceKind").SetValue(shellRoot,"application");Check(!(bool)Call("IsObservedShellRoot",shellRoot,17,rootHandle,"ControlCenterWindow"),"supplementary inventory does not broaden to ordinary application windows");
   shellRoot.GetType().GetField("SurfaceKind").SetValue(shellRoot,"shell_popup");shellRoot.GetType().GetField("Path").SetValue(shellRoot,WindowsPath(@"Temp\ShellHost.exe"));Check(!(bool)Call("IsObservedShellRoot",shellRoot,17,rootHandle,"ControlCenterWindow"),"supplementary inventory rejects copied shell hosts");
   using(var instance=(IDisposable)Activator.CreateInstance(helper,BindingFlags.NonPublic|BindingFlags.Instance,null,new object[]{0,0},null)) {
    foreach(string coordinate in new[]{"x","y","point","coordinates"}) {
     bool denied=false;try {helper.GetMethod("Execute",BindingFlags.NonPublic|BindingFlags.Instance).Invoke(instance,new object[]{new Dictionary<string,object>{{"expectedVersion","0123456789abcdef"},{"targetId","el_test"},{"operation","click"},{coordinate,10}}});}
     catch(TargetInvocationException error){denied=error.InnerException.Message=="INVALID_ARGUMENT"&&(bool?)error.InnerException.GetType().GetField("EffectAttempted").GetValue(error.InnerException)==false;}
     Check(denied,"model coordinate field rejected before observation: "+coordinate);
    }
   }
   var before=Snapshot("taskbar");
   Check(Evidence(before,Snapshot("taskbar","shell_popup"))=="state_changed","fresh flyout inventory establishes UI change");
   Check(Evidence(before,Snapshot("taskbar","start_menu"))=="state_changed","fresh Start inventory establishes UI change");
   Check(Evidence(before,Snapshot("taskbar","settings"))=="state_changed","fresh Settings inventory establishes UI change");
   Check(Evidence(before,Snapshot("taskbar","shell_popup",true))=="state_changed","complete inventory establishes new popup despite source provider truncation");
   Check(Evidence(before,Snapshot("taskbar","shell_popup",true,true))=="effect_outcome_unknown","incomplete inventory cannot establish transition");
   Check(Evidence(Snapshot("taskbar",null,true),Snapshot("taskbar","shell_popup"))=="state_changed","complete inventories establish popup despite unrelated source-control failure");
   var unavailable=Snapshot("taskbar");((Dictionary<string,object>)unavailable["facts"])["surfaceStatus"]="provider_unavailable";
   Check(Evidence(unavailable,Snapshot("taskbar","shell_popup"))=="effect_outcome_unknown","unavailable source remains uncertain");
   Check(Evidence(before,Snapshot("taskbar","application"))=="invoked_without_observable_change","unrelated app does not prove shell effect");
   Check(Evidence(Snapshot("application"),Snapshot("application","shell_popup"))=="invoked_without_observable_change","unrelated shell change does not prove app effect");
   Check(Evidence(Snapshot("taskbar","shell_popup"),Snapshot("taskbar","shell_popup"))=="invoked_without_observable_change","pre-existing popup is not new evidence");
   Check(Evidence(before,null)=="effect_outcome_unknown","missing after remains uncertain");
   Check((bool)Call("ShouldContinueReadback","click","taskbar",0,200L,false,false,"effect_outcome_unknown"),"partial first shell read does not end passive popup waiting");
   Check((bool)Call("ShouldContinueReadback","invoke","shell_popup",2,850L,false,false,"effect_outcome_unknown"),"delayed nested shell popup gets another passive read");
   Check(!(bool)Call("ShouldContinueReadback","click","taskbar",1,1200L,false,false,"effect_outcome_unknown"),"shell passive waiting respects time budget");
   Check(!(bool)Call("ShouldContinueReadback","click","taskbar",5,800L,false,false,"effect_outcome_unknown"),"shell passive waiting respects read count");
   Check(!(bool)Call("ShouldContinueReadback","click","taskbar",0,200L,false,true,"state_changed"),"observed change stops passive waiting");
   Check(!(bool)Call("ShouldContinueReadback","invoke","application",0,200L,false,false,"effect_outcome_unknown"),"ordinary uncertain invoke preserves original stop boundary");
   Check(!(bool)Call("ShouldContinueReadback","inspect","taskbar",0,200L,true,false,"window_inspected"),"inspection does not wait for effects");
   Console.WriteLine("PASSED "+checks+" shell policy checks");return 0;
  } catch(Exception error) { Console.Error.WriteLine(error);return 1; }
 }
}`,'utf8');
  try{
    const compiler=path.join(process.env.WINDIR,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    const built=spawnSync(compiler,['/nologo','/target:exe','/platform:x64','/codepage:65001','/reference:System.Drawing.dll',`/out:${executable}`,source],{cwd:root,windowsHide:true,encoding:'utf8',timeout:20000});
    assert.equal(built.status,0,built.stdout+built.stderr);
    const result=spawnSync(executable,[helper],{cwd:root,windowsHide:true,encoding:'utf8',timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/PASSED \d+ shell policy checks/);
  }finally{
    const actual=fs.realpathSync(directory),boundary=fs.realpathSync(work)+path.sep;
    assert.ok(actual.toLowerCase().startsWith(boundary.toLowerCase()),'cleanup must stay within native work directory');
    fs.rmSync(actual,{recursive:true,force:true});
  }
});
