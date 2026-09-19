using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

internal sealed class LabError : Exception { public readonly string Code; public LabError(string code) : base(code) { Code = code; } }
internal sealed class ActionTarget { public AutomationElement Element; public string[] Capabilities; }
internal sealed class LabHelper : IDisposable
{
    private readonly UIA3Automation automation = new UIA3Automation();
    private readonly Dictionary<string, string> stableIds = new Dictionary<string, string>();
    private Dictionary<string, ActionTarget> observed = new Dictionary<string, ActionTarget>();
    private readonly int pid;
    private readonly string executable;
    private readonly long started;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 20 };

    private LabHelper(int processId, string path)
    {
        pid = processId;
        executable = Path.GetFullPath(path);
        string permitted = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "JeffDesktopLabTarget.exe");
        if (!String.Equals(executable, Path.GetFullPath(permitted), StringComparison.OrdinalIgnoreCase)) throw new LabError("TARGET_PATH_DENIED");
        using (var process = ValidProcess()) started = process.StartTime.ToUniversalTime().Ticks;
    }
    private Process ValidProcess()
    {
        Process process;
        try { process = Process.GetProcessById(pid); } catch { throw new LabError("TARGET_NOT_RUNNING"); }
        try
        {
            if (process.HasExited) throw new LabError("TARGET_NOT_RUNNING");
            if (process.SessionId != Process.GetCurrentProcess().SessionId || !String.Equals(Path.GetFullPath(process.MainModule.FileName), executable, StringComparison.OrdinalIgnoreCase) || (started != 0 && process.StartTime.ToUniversalTime().Ticks != started)) throw new LabError("TARGET_IDENTITY_MISMATCH");
            return process;
        }
        catch (LabError) { process.Dispose(); throw; }
        catch { process.Dispose(); throw new LabError("TARGET_IDENTITY_MISMATCH"); }
    }
    private static string SafeText(string text) { return (text ?? "").Length > 160 ? text.Substring(0, 160) : text ?? ""; }
    private string LocalId(AutomationElement element)
    {
        string runtime = RuntimeId(element);
        // The Windows tab-item provider can expose an empty runtime ID. Anchor
        // virtual children to their real parent's runtime plus unique UIA name.
        if (runtime.Length == 0 && element.ControlType == ControlType.TabItem)
        {
            var parent = element.Parent; var parentId = RuntimeId(parent);
            if (parentId.Length == 0 || parent.FindAllChildren().Count(x => x.ControlType == ControlType.TabItem && x.Name == element.Name) != 1) throw new LabError("AMBIGUOUS_ELEMENT_IDENTITY");
            runtime = parentId + "/tab/" + element.Name;
        }
        if (runtime.Length == 0) throw new LabError("ELEMENT_IDENTITY_UNAVAILABLE");
        string id;
        if (!stableIds.TryGetValue(runtime, out id)) { if (stableIds.Count >= 2048) throw new LabError("SESSION_ELEMENT_LIMIT"); id = "el" + (stableIds.Count + 1); stableIds.Add(runtime, id); }
        return id;
    }
    private static string RuntimeId(AutomationElement element) { return String.Join(".", ((UIA3FrameworkAutomationElement)element.FrameworkAutomationElement).NativeElement.GetRuntimeId().Select(x => x.ToString()).ToArray()); }
    private AutomationElement TargetWindow()
    {
        IntPtr handle;
        using (var process = ValidProcess()) { handle = process.MainWindowHandle; if (handle == IntPtr.Zero) throw new LabError("TARGET_WINDOW_UNAVAILABLE"); }
        var root = automation.FromHandle(handle);
        if (root.Properties.ProcessId.Value != pid || root.Name != "Jeff Desktop Lab Target") throw new LabError("TARGET_WINDOW_MISMATCH");
        return root;
    }
    private static WindowVisualState WindowState(AutomationElement root)
    {
        if (!root.Patterns.Window.IsSupported) throw new LabError("TARGET_WINDOW_STATE_UNAVAILABLE");
        return root.Patterns.Window.Pattern.WindowVisualState.Value;
    }
    private object Prepare()
    {
        var root = TargetWindow(); var previous = WindowState(root);
        bool restored = previous == WindowVisualState.Minimized;
        if (restored)
        {
            using (var process = ValidProcess()) { if (root.Properties.ProcessId.Value != process.Id) throw new LabError("TARGET_IDENTITY_MISMATCH"); }
            root.Patterns.Window.Pattern.SetWindowVisualState(WindowVisualState.Normal);
        }
        for (int attempt = 0; ; attempt++)
        {
            try { return new { restored = restored, previousWindowState = previous.ToString(), snapshot = Observe() }; }
            catch (LabError error)
            {
                if (attempt >= 4 || (error.Code != "TARGET_WINDOW_MINIMIZED" && error.Code != "TARGET_SURFACE_MISSING")) throw;
                Thread.Sleep(100);
            }
        }
    }
    private Dictionary<string, object> Observe()
    {
        var root = TargetWindow(); var windowState = WindowState(root);
        if (windowState == WindowVisualState.Minimized) throw new LabError("TARGET_WINDOW_MINIMIZED");
        var surface = root.FindFirstDescendant(automation.ConditionFactory.ByName("Jeff lab actions"));
        if (surface == null || surface.Properties.ProcessId.Value != pid) throw new LabError("TARGET_SURFACE_MISSING");
        var next = new Dictionary<string, ActionTarget>();
        var elements = new List<object>();
        var queue = new Queue<KeyValuePair<AutomationElement, int>>(); queue.Enqueue(new KeyValuePair<AutomationElement, int>(surface, 0));
        string selectedTab = null, playback = null, language = null; int scanned = 0;
        while (queue.Count > 0)
        {
            var entry = queue.Dequeue(); var element = entry.Key;
            if (++scanned > 256 || entry.Value > 16) throw new LabError("TREE_LIMIT");
            if (element.Properties.ProcessId.Value != pid) continue;
            if (element.Properties.IsPassword.ValueOrDefault) continue;
            string label = SafeText(element.Name); var type = element.ControlType;
            if (type == ControlType.Text)
            {
                if (label == "Playback: playing" || label == "Playback: stopped") playback = label.Substring(10);
                if (label == "Mock language: English" || label == "Mock language: Russian") language = label.Substring(15);
            }
            var capabilities = new List<string>();
            bool? selected = null;
            if (element.IsEnabled && !element.IsOffscreen)
            {
                if (type == ControlType.TabItem && element.Patterns.SelectionItem.IsSupported)
                {
                    selected = element.Patterns.SelectionItem.Pattern.IsSelected.Value;
                    if (!selected.Value) capabilities.Add("select");
                    if (selected.Value && new[] { "Documentation", "VK feed", "Music", "VK video" }.Contains(label)) selectedTab = label;
                }
                if (type == ControlType.Button && element.Patterns.Invoke.IsSupported) capabilities.Add("click");
            }
            if (capabilities.Count > 0 || selected.HasValue)
            {
                if (next.Count >= 32) throw new LabError("ACTION_LIMIT");
                var id = LocalId(element); var caps = capabilities.ToArray();
                next.Add(id, new ActionTarget { Element = element, Capabilities = caps });
                int? ordinal = null;
                string group = null;
                if (type == ControlType.TabItem)
                {
                    group = SafeText(element.Parent.Name);
                    var siblings = element.Parent.FindAllChildren().Where(x => x.ControlType == ControlType.TabItem).OrderBy(x => x.BoundingRectangle.Top).ThenBy(x => x.BoundingRectangle.Left).ToArray();
                    ordinal = Array.FindIndex(siblings, x => x.Name == label) + 1;
                }
                elements.Add(new { id = id, label = ordinal.HasValue ? group + " / Tab " + ordinal.Value + ": " + label : label, name = label, group = group, role = type.ToString(), order = ordinal, selected = selected, capabilities = caps });
            }
            foreach (var child in element.FindAllChildren()) queue.Enqueue(new KeyValuePair<AutomationElement, int>(child, entry.Value + 1));
        }
        if (selectedTab == null || playback == null || language == null) throw new LabError("FIXTURE_FACTS_UNAVAILABLE");
        var facts = new { selectedTab = selectedTab, playing = playback == "playing", language = language };
        var semantic = Json.Serialize(new { elements = elements, facts = facts });
        string version;
        using (var hash = SHA256.Create()) version = BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(semantic))).Replace("-", "").ToLowerInvariant();
        observed = next;
        return new Dictionary<string, object> {
            { "version", version }, { "app", "Jeff Desktop Lab Target" },
            { "summary", "Observed UIA state: selected tab = " + selectedTab + "; playback = " + playback + "; MOCK in-app language = " + language + ". Tab ordinals follow visible UIA geometry within each tab group. Music controls are available only on the Music tab. Isolated test app; not a real browser, audio player or OS keyboard layout." },
            { "elements", elements }, { "facts", facts },
            { "metadata", new { processId = pid, windowState = windowState.ToString(), scannedElements = scanned, actionCount = next.Values.Count(x => x.Capabilities.Length > 0), monitorCount = Screen.AllScreens.Length, provider = "FlaUI.UIA3 5.0.0", isolated = true } }
        };
    }
    private object Execute(Dictionary<string, object> args)
    {
        string targetId = Required(args, "targetId"), operation = Required(args, "operation"), expected = Required(args, "expectedVersion");
        var current = Observe();
        if (!String.Equals(expected, (string)current["version"], StringComparison.Ordinal)) throw new LabError("STALE_SNAPSHOT");
        ActionTarget target;
        if (!observed.TryGetValue(targetId, out target)) throw new LabError("UNKNOWN_TARGET");
        if (!target.Capabilities.Contains(operation)) throw new LabError("OPERATION_DENIED");
        using (var process = ValidProcess()) { if (target.Element.Properties.ProcessId.Value != process.Id) throw new LabError("TARGET_IDENTITY_MISMATCH"); }
        if (operation == "select") target.Element.Patterns.SelectionItem.Pattern.Select();
        else if (operation == "click") target.Element.Patterns.Invoke.Pattern.Invoke();
        else throw new LabError("OPERATION_DENIED");
        Thread.Sleep(75);
        return new { executed = new { targetId = targetId, operation = operation }, snapshot = Observe() };
    }
    private static string Required(Dictionary<string, object> obj, string key) { object value; if (!obj.TryGetValue(key, out value) || !(value is string) || ((string)value).Length == 0 || ((string)value).Length > 256) throw new LabError("INVALID_ARGUMENT"); return (string)value; }
    private object Dispatch(string method, Dictionary<string, object> args) { if (method == "observe") return Observe(); if (method == "prepare") return Prepare(); if (method == "execute") return Execute(args); throw new LabError("UNKNOWN_METHOD"); }
    private static string ReadBoundedLine() { var builder = new StringBuilder(); bool overflow = false; int ch; while ((ch = Console.In.Read()) != -1 && ch != '\n') { if (builder.Length < 65536) builder.Append((char)ch); else overflow = true; } if (ch == -1 && builder.Length == 0) return null; if (overflow) return ""; return builder.ToString().TrimEnd('\r'); }
    public void Dispose() { automation.Dispose(); }
    [STAThread] private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length != 4 || args[0] != "--pid" || args[2] != "--exe") throw new LabError("INVALID_BINDING");
            int processId; if (!Int32.TryParse(args[1], out processId) || processId <= 0) throw new LabError("INVALID_BINDING");
            using (var helper = new LabHelper(processId, args[3]))
            {
                string line;
                while ((line = ReadBoundedLine()) != null)
                {
                    object id = null;
                    try
                    {
                        var request = Json.Deserialize<Dictionary<string, object>>(line); if (request == null) throw new LabError("INVALID_REQUEST");
                        object suppliedId; if (request.TryGetValue("id", out suppliedId) && (suppliedId is string || suppliedId is int)) id = suppliedId;
                        if (id is string && ((string)id).Length > 128) throw new LabError("INVALID_REQUEST");
                        string method = Required(request, "method"); object arg;
                        var parameters = request.TryGetValue("args", out arg) ? arg as Dictionary<string, object> : new Dictionary<string, object>();
                        if (parameters == null) throw new LabError("INVALID_ARGUMENT");
                        Console.WriteLine(Json.Serialize(new { id = id, ok = true, result = helper.Dispatch(method, parameters) }));
                    }
                    catch (Exception error) { Console.WriteLine(Json.Serialize(new { id = id, ok = false, error = new { code = error is LabError ? ((LabError)error).Code : "UIA_REQUEST_FAILED" } })); }
                }
            }
            return 0;
        }
        catch (Exception error) { Console.WriteLine(Json.Serialize(new { id = (object)null, ok = false, error = new { code = error is LabError ? ((LabError)error).Code : "HELPER_START_FAILED" } })); return 1; }
    }
}
