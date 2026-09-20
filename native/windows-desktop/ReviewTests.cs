using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Threading;

internal static class ReviewTests
{
    private static int checks;
    private static void Check(bool value, string name) { if (!value) throw new Exception(name); checks++; Console.WriteLine("PASS " + name); }
    private static Dictionary<string, object> Snapshot(string name, bool truncated, string status)
    {
        var elements = new List<Dictionary<string, object>> { new Dictionary<string, object> {
            {"id","el_test"},{"windowId","win_test"},{"name",name},{"role","Button"},{"selected",null},{"toggleState",null},{"expandState",null},{"bounds","geometry ignored"},{"capabilities",new[]{"invoke"}}
        }};
        return new Dictionary<string, object> { {"elements",elements}, {"facts",new Dictionary<string, object>{{"selectedWindowId","win_test"},{"surfaceStatus",status}}}, {"metadata",new Dictionary<string, object>{{"truncated",truncated}}} };
    }
    private static bool Rejected(MethodInfo method, object target)
    {
        try { method.Invoke(null, new[]{target}); return false; }
        catch (TargetInvocationException error) { return error.InnerException.Message == "ELEMENT_IDENTITY_CHANGED"; }
    }
    private static Dictionary<string,object> Tab(string id,string group,int x,int y,int width=80,int height=24)
    {
        return new Dictionary<string,object>{{"id",id},{"role","TabItem"},{"tabGroupId",group},{"offscreen",false},{"bounds",new Dictionary<string,object>{{"x",x},{"y",y},{"width",width},{"height",height}}}};
    }
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
    [STAThread] private static int Main(string[] args)
    {
        object helper = null; Process fixture = null;
        try
        {
            var assembly = Assembly.LoadFrom(args[0]); var helperType = assembly.GetType("WindowsDesktopHelper");
            using (var timeoutHelper = (IDisposable)Activator.CreateInstance(helperType, BindingFlags.NonPublic | BindingFlags.Instance, null, new object[]{0,0}, null))
            {
                var automation = helperType.GetField("automation",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(timeoutHelper);
                var timeoutProperty = automation.GetType().GetProperty("TransactionTimeout");
                var withTimeout = helperType.GetMethod("WithMutationTimeout",BindingFlags.NonPublic|BindingFlags.Instance);
                int calls=0; bool bounded=false,failed=false;
                Action throwingMutation=delegate {calls++;bounded=(TimeSpan)timeoutProperty.GetValue(automation,null)==TimeSpan.FromMilliseconds(2000);throw new InvalidOperationException("EXPECTED_TEST_EXCEPTION");};
                try {withTimeout.Invoke(timeoutHelper,new object[]{throwingMutation});}
                catch(TargetInvocationException error){failed=error.InnerException.Message=="EXPECTED_TEST_EXCEPTION";}
                Check(failed && calls==1 && bounded,"mutation timeout permits exactly one 2000ms attempt");
                Check((TimeSpan)timeoutProperty.GetValue(automation,null)==TimeSpan.FromMilliseconds(650),"read timeout restored after mutation exception");
                withTimeout.Invoke(timeoutHelper,new object[]{(Action)delegate {calls++;}});
                Check(calls==2 && (TimeSpan)timeoutProperty.GetValue(automation,null)==TimeSpan.FromMilliseconds(650),"successful mutation runs once and restores read timeout");
            }
            var limitedIdentity = helperType.GetMethod("ReadLimitedProcessIdentity", BindingFlags.NonPublic | BindingFlags.Static);
            using (var own = Process.GetCurrentProcess())
            {
                var ownIdentity = limitedIdentity.Invoke(null,new object[]{own.Id});
                Check(ownIdentity!=null,"limited-information query identifies own process");
                var type=ownIdentity.GetType();
                Check((int)type.GetField("Pid").GetValue(ownIdentity)==own.Id && (int)type.GetField("Session").GetValue(ownIdentity)==own.SessionId,"limited-information query preserves PID and session");
                Check((long)type.GetField("Started").GetValue(ownIdentity)==own.StartTime.ToUniversalTime().Ticks,"limited-information creation time matches process identity");
                Check(String.Equals((string)type.GetField("Path").GetValue(ownIdentity),Path.GetFullPath(own.MainModule.FileName),StringComparison.OrdinalIgnoreCase),"limited-information path matches actual executable");
            }
            Check(limitedIdentity.Invoke(null,new object[]{0})==null,"limited-information query rejects invalid PID");
            var taskManagerPath = helperType.GetMethod("IsTaskManagerPath", BindingFlags.NonPublic | BindingFlags.Static);
            string canonicalTaskManager = Path.Combine(Environment.SystemDirectory,"Taskmgr.exe");
            Check((bool)taskManagerPath.Invoke(null,new object[]{canonicalTaskManager}),"canonical System32 Task Manager path allowed");
            Check((bool)taskManagerPath.Invoke(null,new object[]{canonicalTaskManager.ToUpperInvariant()}),"canonical Task Manager path is case-insensitive");
            Check(!(bool)taskManagerPath.Invoke(null,new object[]{Path.Combine(Environment.SystemDirectory,"elsewhere","Taskmgr.exe")}),"Task Manager filename under another directory rejected");
            Check(!(bool)taskManagerPath.Invoke(null,new object[]{Path.Combine(Environment.SystemDirectory,"Taskmgr-copy.exe")}),"different System32 filename rejected");
            Check(!(bool)taskManagerPath.Invoke(null,new object[]{null}),"missing Task Manager path rejected");
            var replacementText = helperType.GetMethod("ReplacementText", BindingFlags.NonPublic | BindingFlags.Static);
            Check((string)replacementText.Invoke(null,new object[]{new Dictionary<string,object>{{"text","literal\r\n\t😀"}}})=="literal\r\n\t😀","literal replacement preserves allowed Unicode and whitespace");
            Check((string)replacementText.Invoke(null,new object[]{new Dictionary<string,object>{{"text",""}}})=="","explicit empty replacement accepted");
            foreach (object invalid in new object[]{null,123,new string('x',4097),"\0","\u001b","\ud800","\udc00"})
            {
                bool rejected=false;try {replacementText.Invoke(null,new object[]{new Dictionary<string,object>{{"text",invalid}}});}
                catch(TargetInvocationException error){rejected=error.InnerException.Message=="INVALID_TEXT_PAYLOAD";}
                Check(rejected,"invalid replacement payload rejected");
            }
            var rank=helperType.GetMethod("AssignTabOrder",BindingFlags.NonPublic|BindingFlags.Static);
            var groupType=assembly.GetType("TabGroupState");var groupDictionaryType=typeof(Dictionary<,>).MakeGenericType(typeof(string),groupType);
            var groups=(IDictionary)Activator.CreateInstance(groupDictionaryType);var coverage=Activator.CreateInstance(groupType);
            groupType.GetField("Expected").SetValue(coverage,3);groupType.GetField("Complete").SetValue(coverage,true);groups.Add("groupA",coverage);
            var left=Tab("left","groupA",20,12);var middle=Tab("middle","groupA",110,11);var right=Tab("right","groupA",200,10);
            var tabs=new List<Dictionary<string,object>>{right,middle,left};
            rank.Invoke(null,new object[]{tabs,groups,false});
            Check((int)left["order"]==1&&(int)middle["order"]==2&&(int)right["order"]==3,"same-row visual order ignores provider reversal and small y offsets");
            Check(!(bool)left["orderIsPartial"]&&!(bool)left["visualOrderIsPartial"],"complete sibling coverage gives full ranks");
            rank.Invoke(null,new object[]{tabs,groups,true});Check(!(bool)left["orderIsPartial"]&&(bool)left["visualOrderIsPartial"],"unrelated tree truncation preserves local rank but marks global partial");
            groupType.GetField("Expected").SetValue(coverage,4);rank.Invoke(null,new object[]{tabs,groups,false});Check((bool)left["orderIsPartial"],"missing sibling marks rank partial");
            groupType.GetField("Expected").SetValue(coverage,3);groupType.GetField("Complete").SetValue(coverage,false);rank.Invoke(null,new object[]{tabs,groups,false});Check((bool)left["orderIsPartial"],"incomplete sibling enumeration marks partial");
            groupType.GetField("Complete").SetValue(coverage,true);right["offscreen"]=true;rank.Invoke(null,new object[]{tabs,groups,false});Check(right["order"]==null&&(bool)left["orderIsPartial"],"offscreen tabs have no invented visual rank");right["offscreen"]=false;
            ((Dictionary<string,object>)middle["bounds"])["y"]=70;rank.Invoke(null,new object[]{tabs,groups,false});Check((int)left["order"]==1&&(int)right["order"]==2&&(int)middle["order"]==3,"separate visible rows remain separate");
            var button=new Dictionary<string,object>{{"id","button"},{"role","Button"},{"order",null}};tabs.Insert(0,button);rank.Invoke(null,new object[]{tabs,groups,false});Check(button["order"]==null&&(int)left["order"]==1,"non-tab children never consume tab ranks");
            var invoke = helperType.GetMethod("InvokeEvidence", BindingFlags.NonPublic | BindingFlags.Static);
            var before = Snapshot("Play", false, "available"); var after = Snapshot("Pause", false, "available");
            Check((string)invoke.Invoke(null,new object[]{before,after,"win_test"}) == "state_changed","complete semantic change");
            Check((string)invoke.Invoke(null,new object[]{before,Snapshot("Play",false,"available"),"win_test"}) == "invoked_without_observable_change","unchanged complete state");
            Check((string)invoke.Invoke(null,new object[]{before,Snapshot("Pause",true,"available"),"win_test"}) == "effect_outcome_unknown","truncated after cannot prove invoke");
            Check((string)invoke.Invoke(null,new object[]{Snapshot("Play",true,"available"),after,"win_test"}) == "effect_outcome_unknown","truncated before cannot prove invoke");
            Check((string)invoke.Invoke(null,new object[]{before,Snapshot("Pause",false,"provider_unavailable"),"win_test"}) == "effect_outcome_unknown","unavailable after cannot prove invoke");
            Check((string)invoke.Invoke(null,new object[]{before,null,"win_test"}) == "effect_outcome_unknown","absent after cannot prove invoke");
            if(args.Length>2 && args[2]=="--pure") { Console.WriteLine("PASSED " + checks);return 0; }
            fixture = Process.Start(new ProcessStartInfo(args[1]) { UseShellExecute = false }); Thread.Sleep(700);
            helper = Activator.CreateInstance(helperType, BindingFlags.NonPublic | BindingFlags.Instance, null, new object[]{0,fixture.Id}, null);
            var observe = helperType.GetMethod("Observe",BindingFlags.NonPublic|BindingFlags.Instance);
            var initial = (Dictionary<string,object>)observe.Invoke(helper,new object[]{null,false});
            var windows = (List<Dictionary<string,object>>)initial["windows"]; Check(windows.Count==1,"fixture-only observation");
            string windowId=(string)windows[0]["id"];
            observe.Invoke(helper,new object[]{windowId,true});
            var observed=(IDictionary)helperType.GetField("observed",BindingFlags.NonPublic|BindingFlags.Instance).GetValue(helper);
            object target=null; Dictionary<string,object> state=null;
            foreach(object entry in observed.Values) {
                var value=(Dictionary<string,object>)entry.GetType().GetField("State").GetValue(entry);
                if((string)value["name"]=="Music") {target=entry;state=value;break;}
            }
            Check(target!=null,"controlled target resolved");
            var validate=helperType.GetMethod("ValidateCurrentElement",BindingFlags.NonPublic|BindingFlags.Static);
            validate.Invoke(null,new[]{target});Check(true,"unchanged target validates");
            object original=state["name"];state["name"]="Different label";Check(Rejected(validate,target),"changed name rejected before effect");state["name"]=original;
            original=state["selected"];state["selected"]=!(bool)original;Check(Rejected(validate,target),"changed selected state rejected before effect");state["selected"]=original;
            original=state["toggleState"];state["toggleState"]="On";Check(Rejected(validate,target),"changed toggle state rejected before effect");state["toggleState"]=original;
            original=state["expandState"];state["expandState"]="Expanded";Check(Rejected(validate,target),"changed expansion state rejected before effect");state["expandState"]=original;
            var identity=target.GetType().GetField("Window").GetValue(target);
            var handle=(IntPtr)identity.GetType().GetField("Handle").GetValue(identity);
            ShowWindow(handle,0);Thread.Sleep(100);
            var hidden=helperType.GetMethod("OriginalWindowHidden",BindingFlags.NonPublic|BindingFlags.Static);
            var absent=helperType.GetMethod("OriginalWindowAbsent",BindingFlags.NonPublic|BindingFlags.Static);
            Check((bool)hidden.Invoke(null,new[]{identity}),"hidden original window with running process identified");
            Check(!(bool)absent.Invoke(null,new[]{identity}),"hidden window never misreported as destroyed");
            ShowWindow(handle,1);
            Console.WriteLine("PASSED " + checks);return 0;
        }
        catch(Exception error) { Console.Error.WriteLine(error); return 1; }
        finally { if(helper is IDisposable)((IDisposable)helper).Dispose();if(fixture!=null && !fixture.HasExited) {fixture.CloseMainWindow();fixture.WaitForExit(1000);if(!fixture.HasExited)fixture.Kill();} }
    }
}
