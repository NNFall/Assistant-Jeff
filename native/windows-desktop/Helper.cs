using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using FlaUI.Core.AutomationElements;
using FlaUI.Core.Definitions;
using FlaUI.UIA3;

internal sealed class DesktopError : Exception { public readonly string Code; public DesktopError(string code) : base(code) { Code = code; } }
internal sealed class WindowIdentity
{
    public IntPtr Handle; public int Pid; public int Session; public long Started; public string Path; public string ProcessName; public string Id; public string Title;
}
internal sealed class DesktopTarget
{
    public WindowIdentity Window; public AutomationElement Element; public string[] Capabilities; public Dictionary<string, object> State; public string Runtime; public string SemanticIdentity; public string NameFingerprint;
}
internal sealed class WalkEntry
{
    public AutomationElement Element; public int Depth; public string ParentKey; public string Group; public int Order; public int Priority; public int Sequence; public ControlType? KnownRole;
}
internal sealed class TabGroupState { public int Expected; public bool Complete; }

// This is a product backend. It never executes model-generated code, reads
// text/value patterns, types arbitrary keys or falls back to screen coordinates.
internal sealed class WindowsDesktopHelper : IDisposable
{
    private const int MaxWindows = 64, MaxElements = 160, MaxScanned = 480, MaxDepth = 12, ObserveBudgetMs = 1800;
    private readonly UIA3Automation automation = new UIA3Automation();
    private readonly int sessionId = Process.GetCurrentProcess().SessionId;
    private readonly int ownPid = Process.GetCurrentProcess().Id;
    private readonly int ownerPid;
    private readonly int fixturePid;
    private readonly long fixtureStart;
    private readonly string fixturePath;
    private string selectedWindowId;
    private Dictionary<string, DesktopTarget> observed = new Dictionary<string, DesktopTarget>();
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304, RecursionLimit = 32 };
    private static readonly Regex SensitiveWindow = new Regex(@"password|passkey|sign[ -]?in|log[ -]?in|authentication|authorization|two.factor|security|credential|парол|войти|вход в|авторизац|аутентификац|безопасност|настройки|параметры|settings|учетн|учётн", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex SecretText = new Regex(@"apikey_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> BlockedProcesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "codex", "chatgpt", "windowsterminal", "powershell", "pwsh", "cmd", "conhost", "openconsole", "mintty", "bash", "wsl", "wt",
        "credentialuibroker", "logonui", "consent", "winlogon", "lockapp", "systemsettings", "sechealthui", "securityhealthsystray", "mmc", "regedit",
        "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "protonpass", "jeffwindowsdesktophelper", "jeffdesktoplabhelper", "assistant jeff",
        "textinputhost", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp", "nvidia overlay", "nvidia share", "gamebar", "gamebarftserver", "gamebarpresencewriter"
    };

    private WindowsDesktopHelper(int excludedOwner, int restrictedFixture)
    {
        ownerPid = excludedOwner; fixturePid = restrictedFixture;
        automation.ConnectionTimeout = TimeSpan.FromMilliseconds(500);
        automation.TransactionTimeout = TimeSpan.FromMilliseconds(650);
        if (fixturePid > 0)
        {
            // The fixture restriction exists only to test the real backend
            // without observing any personal window or application.
            fixturePath = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "..", "..", "desktop-lab", "bin", "JeffDesktopLabTarget.exe"));
            using (var process = Process.GetProcessById(fixturePid))
            {
                if (process.SessionId != sessionId || !String.Equals(Path.GetFullPath(process.MainModule.FileName), fixturePath, StringComparison.OrdinalIgnoreCase)) throw new DesktopError("INVALID_FIXTURE_BINDING");
                fixtureStart = process.StartTime.ToUniversalTime().Ticks;
            }
        }
    }

    private static string Text(string value, int limit) { value = SecretText.Replace(value ?? "", "[redacted]"); return value.Length > limit ? value.Substring(0, limit) : value; }
    private static string Hash(string value) { using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(value))).Replace("-", "").ToLowerInvariant(); }
    private static string RuntimeId(AutomationElement element)
    {
        try { var raw = ((UIA3FrameworkAutomationElement)element.FrameworkAutomationElement).NativeElement.GetRuntimeId(); return raw == null ? "" : String.Join(".", raw.Select(x => x.ToString()).ToArray()); } catch { return ""; }
    }
    private static string WindowTitle(IntPtr handle)
    {
        var title = new StringBuilder(1025); GetWindowText(handle, title, title.Capacity); return Text(title.ToString(), 500);
    }
    private bool IsProtected(WindowIdentity window)
    {
        if (window.Pid == ownPid || window.Pid == ownerPid || BlockedProcesses.Contains(window.ProcessName)) return true;
        string path = window.Path.ToLowerInvariant(), title = window.Title;
        if (path.Contains("\\codex\\") || path.Contains("\\chatgpt\\") || path.Contains("\\1password\\") || path.Contains("\\bitwarden\\") || path.Contains("\\keepass")) return true;
        if (SensitiveWindow.IsMatch(title) || title.IndexOf("Codex", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("Jeff Windows", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("Assistant Jeff", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }
    private WindowIdentity Identity(IntPtr handle)
    {
        if (handle == IntPtr.Zero || !IsWindow(handle) || !IsWindowVisible(handle)) return null;
        var className = new StringBuilder(256); GetClassName(handle, className, className.Capacity);
        if (new[] { "Progman", "WorkerW", "Shell_TrayWnd", "Shell_SecondaryTrayWnd" }.Contains(className.ToString())) return null;
        if ((GetWindowLongPtr(handle, -20).ToInt64() & 0x00000080L) != 0) return null; // WS_EX_TOOLWINDOW: overlays/palettes, not ordinary app windows.
        int cloaked; if (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0) return null;
        uint nativePid; GetWindowThreadProcessId(handle, out nativePid);
        if (nativePid == 0 || nativePid > Int32.MaxValue || (fixturePid > 0 && nativePid != fixturePid)) return null;
        try
        {
            using (var process = Process.GetProcessById((int)nativePid))
            {
                if (process.HasExited || process.SessionId != sessionId) return null;
                string path = Path.GetFullPath(process.MainModule.FileName), title = WindowTitle(handle);
                if (title.Length == 0) return null;
                long started = process.StartTime.ToUniversalTime().Ticks;
                if (fixturePid > 0 && (started != fixtureStart || !String.Equals(path, fixturePath, StringComparison.OrdinalIgnoreCase))) return null;
                var window = new WindowIdentity { Handle = handle, Pid = process.Id, Session = process.SessionId, Started = started, Path = path, ProcessName = process.ProcessName, Title = title };
                window.Id = "win_" + Hash(window.Pid + ":" + started + ":" + window.Session + ":" + path.ToLowerInvariant() + ":" + handle.ToInt64()).Substring(0, 24);
                return IsProtected(window) ? null : window;
            }
        }
        catch { return null; }
    }
    private WindowIdentity Revalidate(WindowIdentity previous)
    {
        var current = Identity(previous.Handle);
        if (current == null || current.Id != previous.Id || current.Path != previous.Path || current.Started != previous.Started) throw new DesktopError("TARGET_IDENTITY_CHANGED");
        return current;
    }
    private static Dictionary<string, object> WindowState(WindowIdentity window)
    {
        var state = new Dictionary<string, object> {
            { "id", window.Id }, { "title", window.Title }, { "processName", window.ProcessName }, { "processId", window.Pid },
            { "minimized", IsIconic(window.Handle) }, { "maximized", IsZoomed(window.Handle) }, { "active", GetForegroundWindow() == window.Handle }
        };
        state["stateVersion"] = Hash(Json.Serialize(state)); return state;
    }
    private static List<string> WindowCapabilities(WindowIdentity window)
    {
        var caps = new List<string> { "inspect", "activate" }; long style = GetWindowLongPtr(window.Handle, -16).ToInt64();
        if (!IsIconic(window.Handle) && (style & 0x00020000L) != 0) caps.Add("minimize");
        if (!IsZoomed(window.Handle) && (style & 0x00010000L) != 0) caps.Add("maximize");
        if (IsIconic(window.Handle) || IsZoomed(window.Handle)) caps.Add("restore");
        if ((style & 0x00080000L) != 0) caps.Add("close");
        return caps;
    }
    private Dictionary<string, object> Observe(string requestedWindow, bool explicitlyRequested)
    {
        var watch = Stopwatch.StartNew(); var windows = new List<WindowIdentity>(); bool truncated = false;
        EnumWindows(delegate(IntPtr handle, IntPtr ignored) {
            var window = Identity(handle);
            if (window != null) { if (windows.Count >= MaxWindows) { truncated = true; return false; } windows.Add(window); }
            return true;
        }, IntPtr.Zero);
        windows = windows.OrderBy(x => x.Id, StringComparer.Ordinal).ToList();
        if (explicitlyRequested)
        {
            if (requestedWindow != null && !windows.Any(x => x.Id == requestedWindow)) throw new DesktopError("WINDOW_NOT_AVAILABLE");
            selectedWindowId = requestedWindow;
        }
        if (selectedWindowId != null && !windows.Any(x => x.Id == selectedWindowId)) selectedWindowId = null;
        var next = new Dictionary<string, DesktopTarget>(); var elements = new List<Dictionary<string, object>>(); var inventory = new List<Dictionary<string, object>>();
        foreach (var window in windows)
        {
            var state = WindowState(window); var caps = WindowCapabilities(window).ToArray(); inventory.Add(state);
            var element = new Dictionary<string, object> {
                { "id", window.Id }, { "label", Text(window.ProcessName + ": " + window.Title, 500) }, { "name", window.Title }, { "role", "Window" }, { "capabilities", caps },
                { "windowId", window.Id }, { "processName", window.ProcessName }, { "processId", window.Pid }, { "minimized", state["minimized"] }, { "maximized", state["maximized"] }, { "active", state["active"] }, { "stateVersion", state["stateVersion"] }
            };
            elements.Add(element); next[window.Id] = new DesktopTarget { Window = window, Capabilities = caps, State = element };
        }
        int scanned = 0, skippedCrossProcess = 0; string surfaceStatus = "not_inspected"; var providerErrors = new List<Dictionary<string, object>>();
        var selectedWindow = windows.FirstOrDefault(x => x.Id == selectedWindowId);
        if (selectedWindow != null)
        {
            if (IsIconic(selectedWindow.Handle)) surfaceStatus = "window_minimized";
            else
            {
                surfaceStatus = "available";
                try { ReadSurface(selectedWindow, next, elements, watch, providerErrors, ref scanned, ref skippedCrossProcess, ref truncated); }
                catch (Exception error) { ProviderError(providerErrors, "surface_root", error); surfaceStatus = "provider_unavailable"; }
            }
        }
        var facts = new Dictionary<string, object> { { "selectedWindowId", selectedWindowId }, { "surfaceStatus", surfaceStatus } };
        var semantic = Json.Serialize(new { windows = inventory, elements = elements, facts = facts });
        var summary = new StringBuilder("Real Windows desktop. " + windows.Count + " eligible windows. ");
        foreach (var window in inventory) { if (summary.Length >= 3300) break; summary.Append(window["id"] + " " + window["processName"] + ": " + window["title"] + "; "); }
        summary.Append("Inspected window: " + (selectedWindowId ?? "none") + ". Surface: " + surfaceStatus + ". Only listed capabilities are available. Web document, edit and password contents are omitted.");
        observed = next;
        return new Dictionary<string, object> {
            { "version", Hash(semantic) }, { "app", "Windows" }, { "summary", Text(summary.ToString(), 4000) }, { "elements", elements }, { "windows", inventory }, { "facts", facts },
            { "metadata", new Dictionary<string, object> { { "provider", "FlaUI.UIA3 5.0.0" }, { "monitorCount", Screen.AllScreens.Length }, { "truncated", truncated }, { "scannedElements", scanned }, { "fixtureRestricted", fixturePid > 0 }, { "surfaceStatus", surfaceStatus }, { "providerErrors", providerErrors }, { "skippedCrossProcess", skippedCrossProcess }, { "tabOrderPartial", elements.Any(x => (string)x["role"] == "TabItem" && Boolean(x, "visualOrderIsPartial")) } } }
        };
    }
    private static void ProviderError(List<Dictionary<string, object>> errors, string stage, Exception error)
    {
        string code = "0x" + Marshal.GetHRForException(error).ToString("X8");
        if (errors.Count < 16 && !errors.Any(x => (string)x["stage"] == stage && (string)x["code"] == code)) errors.Add(new Dictionary<string, object> { { "stage", stage }, { "code", code } });
    }
    private static T Optional<T>(Func<T> read, T fallback, string stage, List<Dictionary<string, object>> errors)
    {
        try { return read(); } catch (Exception error) { ProviderError(errors, stage, error); return fallback; }
    }
    private void ReadSurface(WindowIdentity window, Dictionary<string, DesktopTarget> next, List<Dictionary<string, object>> elements, Stopwatch watch, List<Dictionary<string, object>> errors, ref int scanned, ref int skippedCrossProcess, ref bool truncated)
    {
        Revalidate(window); var root = automation.FromHandle(window.Handle);
        if (root.Properties.ProcessId.Value != window.Pid) throw new DesktopError("TARGET_IDENTITY_CHANGED");
        var walker = automation.TreeWalkerFactory.GetControlViewWalker(); var queue = new List<WalkEntry>();
        var tabGroups = new Dictionary<string, TabGroupState>();
        queue.Add(new WalkEntry { Element = root, Depth = 0, ParentKey = window.Id, Group = window.Title, Priority = 0, Sequence = 0 });
        int uiCount = 0, sequence = 0;
        while (queue.Count > 0)
        {
            if (watch.ElapsedMilliseconds >= ObserveBudgetMs || scanned >= MaxScanned || uiCount >= MaxElements) { truncated = true; break; }
            var entry = queue.OrderBy(x => x.Priority).ThenBy(x => x.Depth).ThenBy(x => x.Sequence).First(); queue.Remove(entry); var element = entry.Element; scanned++;
            if (entry.Depth > MaxDepth) { truncated = true; continue; }
            var role = ControlType.Window; string name = window.Title, key = window.Id;
            if (entry.Depth > 0)
            {
                try
                {
                    if (element.Properties.ProcessId.Value != window.Pid) { skippedCrossProcess++; continue; }
                    role = entry.KnownRole.HasValue ? entry.KnownRole.Value : element.ControlType;
                    if (element.Properties.IsPassword.ValueOrDefault || role == ControlType.Edit || role == ControlType.Text) continue;
                }
                catch (Exception error) { ProviderError(errors, "sensitive_identity_guard", error); truncated = true; continue; }
                // Password/edit subtrees are omitted. A document can contain
                // accessible buttons; traverse it without reading its own text.
                int errorsBefore = errors.Count;
                string rawName = role == ControlType.Document ? "" : Optional(() => element.Name, "", "name", errors), runtime = RuntimeId(element);
                name = Text(rawName, 500);
                if (SensitiveWindow.IsMatch(name)) continue;
                string identity = role.ToString() + ":" + Text(Optional(() => element.Properties.AutomationId.ValueOrDefault, "", "automation_id", errors), 200);
                key = runtime.Length > 0 ? runtime : entry.ParentKey + ":" + identity + ":" + name + ":" + entry.Order;
                bool enabled = Optional(() => element.IsEnabled, false, "enabled", errors), offscreen = Optional(() => element.IsOffscreen, true, "offscreen", errors);
                bool? selected = null; string toggled = null, expanded = null;
                var caps = new List<string>();
                if (Optional(() => element.Patterns.SelectionItem.IsSupported, false, "selection_supported", errors))
                {
                    selected = Optional<bool?>(() => element.Patterns.SelectionItem.Pattern.IsSelected.Value, null, "selection_state", errors);
                    if (enabled && !offscreen && selected.HasValue && !selected.Value) caps.Add("select");
                }
                if (Optional(() => element.Patterns.Toggle.IsSupported, false, "toggle_supported", errors))
                {
                    toggled = Optional(() => element.Patterns.Toggle.Pattern.ToggleState.Value.ToString(), (string)null, "toggle_state", errors);
                    if (enabled && !offscreen && toggled != null) caps.Add("toggle");
                }
                if (Optional(() => element.Patterns.ExpandCollapse.IsSupported, false, "expand_supported", errors))
                {
                    expanded = Optional(() => element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.Value.ToString(), (string)null, "expand_state", errors);
                    if (enabled && !offscreen && expanded != null && expanded != "LeafNode") caps.Add(expanded == "Expanded" ? "collapse" : "expand");
                }
                if (enabled && !offscreen && Optional(() => element.Patterns.Invoke.IsSupported, false, "invoke_supported", errors)) caps.Add("invoke");
                if (role != ControlType.Document && name.Length > 0 && (caps.Count > 0 || selected.HasValue || toggled != null || expanded != null))
                {
                    string id = "el_" + Hash(window.Id + ":" + key).Substring(0, 24);
                    if (!next.ContainsKey(id))
                    {
                        object bounds = Optional<object>(() => { var rectangle = element.BoundingRectangle; return new Dictionary<string, object> { { "x", rectangle.Left }, { "y", rectangle.Top }, { "width", rectangle.Width }, { "height", rectangle.Height } }; }, null, "bounds", errors);
                        var state = new Dictionary<string, object> {
                            { "id", id }, { "windowId", window.Id }, { "label", Text((entry.Group.Length > 0 ? entry.Group + " / " : "") + name, 500) }, { "name", name }, { "role", role.ToString() },
                            { "capabilities", caps.ToArray() }, { "selected", selected }, { "toggleState", toggled }, { "expandState", expanded }, { "enabled", enabled }, { "offscreen", offscreen },
                            { "group", Text(entry.Group, 500) }, { "order", null },
                            { "tabGroupId", role == ControlType.TabItem ? "tabgrp_" + Hash(window.Id + ":" + entry.ParentKey).Substring(0, 24) : null },
                            { "bounds", bounds }
                        };
                        elements.Add(state); next[id] = new DesktopTarget { Window = window, Element = element, Capabilities = caps.ToArray(), State = state, Runtime = runtime, SemanticIdentity = identity, NameFingerprint = Hash(rawName ?? "") }; uiCount++;
                    }
                }
                if (errors.Count > errorsBefore) truncated = true;
            }
            if (entry.Depth == MaxDepth) { truncated = true; continue; }
            // Root capability/property support is irrelevant: it already exists
            // in the Win32 inventory. Always try its children independently.
            try
            {
                // Walk one child at a time: FindAllDescendants could traverse an
                // unbounded provider-owned document before enforcing a limit.
                var children = new List<AutomationElement>(); var child = walker.GetFirstChild(element); bool completeChildren = true;
                while (child != null)
                {
                    if (children.Count >= MaxElements || queue.Count + children.Count >= MaxScanned || watch.ElapsedMilliseconds >= ObserveBudgetMs) { truncated = true; completeChildren = false; break; }
                    children.Add(child);
                    try { child = walker.GetNextSibling(child); }
                    catch (Exception error) { ProviderError(errors, "next_sibling", error); truncated = true; completeChildren = false; break; }
                }
                string childTabGroup = "tabgrp_" + Hash(window.Id + ":" + key).Substring(0, 24);
                var groupState = new TabGroupState { Complete = completeChildren };
                tabGroups[childTabGroup] = groupState;
                int ordinal = 0;
                foreach (var descendant in children)
                {
                    if (watch.ElapsedMilliseconds >= ObserveBudgetMs) { groupState.Complete = false; truncated = true; break; }
                    ControlType? childRole = null;
                    try { childRole = descendant.ControlType; }
                    catch (Exception error) { ProviderError(errors, "child_role", error); truncated = true; groupState.Complete = false; }
                    if (childRole == ControlType.TabItem) groupState.Expected++;
                    // Keep the provider's structural ordinal only for missing
                    // runtime-ID fallback. It is never exposed as tab order.
                    queue.Add(new WalkEntry { Element = descendant, Depth = entry.Depth + 1, ParentKey = key, Group = name.Length > 0 ? name : entry.Group, Order = ++ordinal, KnownRole = childRole, Priority = TraversalPriority(childRole), Sequence = ++sequence });
                }
            }
            catch (Exception error) { ProviderError(errors, "children", error); truncated = true; }
        }
        AssignTabOrder(elements, tabGroups, truncated || skippedCrossProcess > 0);
    }
    private static int TraversalPriority(ControlType? role)
    {
        if (role == ControlType.Tab || role == ControlType.TabItem) return 0;
        if (role == ControlType.ToolBar) return 1;
        if (!role.HasValue || role == ControlType.Pane || role == ControlType.Group || role == ControlType.Custom || role == ControlType.Window) return 2;
        if (role == ControlType.Document) return 5;
        if (role == ControlType.Menu || role == ControlType.MenuBar || role == ControlType.MenuItem) return 4;
        return 3;
    }
    private static double Coordinate(Dictionary<string, object> item, string key)
    {
        var bounds = item["bounds"] as Dictionary<string, object>; object value;
        if (bounds == null || !bounds.TryGetValue(key, out value)) return Double.NaN;
        try { return Convert.ToDouble(value); } catch { return Double.NaN; }
    }
    private static bool HasVisualBounds(Dictionary<string, object> item)
    {
        return !Boolean(item, "offscreen") && !Double.IsNaN(Coordinate(item, "x")) && !Double.IsNaN(Coordinate(item, "y")) && Coordinate(item, "width") > 0 && Coordinate(item, "height") > 0;
    }
    private static List<Dictionary<string, object>> VisualTabs(IEnumerable<Dictionary<string, object>> tabs)
    {
        // Cluster visibly overlapping rows first. A 1-3 px top inset should not
        // put a right-hand tab before a left-hand tab on the same strip.
        var rows = new List<List<Dictionary<string, object>>>();
        foreach (var tab in tabs.Where(HasVisualBounds).OrderBy(x => Coordinate(x, "y")).ThenBy(x => Coordinate(x, "x")))
        {
            double top = Coordinate(tab, "y"), height = Coordinate(tab, "height");
            var row = rows.FirstOrDefault(items => {
                var anchor = items[0]; double anchorTop = Coordinate(anchor, "y"), anchorHeight = Coordinate(anchor, "height");
                double overlap = Math.Min(top + height, anchorTop + anchorHeight) - Math.Max(top, anchorTop);
                return overlap >= Math.Min(height, anchorHeight) * 0.5;
            });
            if (row == null) { row = new List<Dictionary<string, object>>(); rows.Add(row); }
            row.Add(tab);
        }
        return rows.OrderBy(row => row.Min(x => Coordinate(x, "y"))).SelectMany(row => row.OrderBy(x => Coordinate(x, "x")).ThenBy(x => (string)x["id"], StringComparer.Ordinal)).ToList();
    }
    private static void AssignTabOrder(List<Dictionary<string, object>> elements, Dictionary<string, TabGroupState> groups, bool globallyPartial)
    {
        var tabs = elements.Where(x => (string)x["role"] == "TabItem").ToList();
        foreach (var grouped in tabs.GroupBy(x => (string)x["tabGroupId"]))
        {
            var members = grouped.ToList(); var sorted = VisualTabs(members); TabGroupState coverage;
            bool partial = !groups.TryGetValue(grouped.Key, out coverage) || !coverage.Complete || coverage.Expected != members.Count || sorted.Count != members.Count;
            foreach (var tab in members) { tab["order"] = null; tab["orderIsPartial"] = partial; tab["visualOrder"] = null; }
            for (int i = 0; i < sorted.Count; i++) sorted[i]["order"] = i + 1;
        }
        var all = VisualTabs(tabs); bool visualPartial = globallyPartial || all.Count != tabs.Count || tabs.Any(x => Boolean(x, "orderIsPartial"));
        foreach (var tab in tabs) tab["visualOrderIsPartial"] = visualPartial;
        for (int i = 0; i < all.Count; i++) all[i]["visualOrder"] = i + 1;
    }
    private static Dictionary<string, object> FindElement(Dictionary<string, object> snapshot, string id)
    {
        return ((List<Dictionary<string, object>>)snapshot["elements"]).FirstOrDefault(x => (string)x["id"] == id);
    }
    private static bool Boolean(Dictionary<string, object> item, string key) { object value; return item != null && item.TryGetValue(key, out value) && value is bool && (bool)value; }
    private static string Field(Dictionary<string, object> item, string key) { object value; return item != null && item.TryGetValue(key, out value) && value != null ? value.ToString() : null; }
    private static string SurfaceState(Dictionary<string, object> snapshot, string windowId)
    {
        // Geometry, visibility and enabled/capability changes can follow a
        // foreground transition. They do not establish an invoked app effect.
        return Json.Serialize(((List<Dictionary<string, object>>)snapshot["elements"]).Where(x => (string)x["windowId"] == windowId && (string)x["role"] != "Window").Select(x => new {
            id = x["id"], name = x["name"], role = x["role"], selected = x["selected"], toggleState = x["toggleState"], expandState = x["expandState"]
        }).ToList());
    }
    private static bool CompleteSurface(Dictionary<string, object> snapshot, string windowId)
    {
        if (snapshot == null) return false;
        var facts = snapshot["facts"] as Dictionary<string, object>; var metadata = snapshot["metadata"] as Dictionary<string, object>;
        return facts != null && metadata != null && Field(facts, "selectedWindowId") == windowId && Field(facts, "surfaceStatus") == "available" && metadata.ContainsKey("truncated") && metadata["truncated"] is bool && !Boolean(metadata, "truncated");
    }
    private static string InvokeEvidence(Dictionary<string, object> before, Dictionary<string, object> after, string windowId)
    {
        if (!CompleteSurface(before, windowId) || !CompleteSurface(after, windowId)) return "effect_outcome_unknown";
        return SurfaceState(before, windowId) != SurfaceState(after, windowId) ? "state_changed" : "invoked_without_observable_change";
    }
    private static void ValidateCurrentElement(DesktopTarget target)
    {
        var element = target.Element; var prior = target.State;
        if (element.Properties.ProcessId.Value != target.Window.Pid || element.Properties.IsPassword.ValueOrDefault || !element.IsEnabled || element.IsOffscreen) throw new DesktopError("ELEMENT_NO_LONGER_AVAILABLE");
        string name = element.Name ?? "", currentIdentity = element.ControlType.ToString() + ":" + Text(element.Properties.AutomationId.ValueOrDefault, 200);
        string selected = element.Patterns.SelectionItem.IsSupported ? element.Patterns.SelectionItem.Pattern.IsSelected.Value.ToString() : null;
        string toggled = element.Patterns.Toggle.IsSupported ? element.Patterns.Toggle.Pattern.ToggleState.Value.ToString() : null;
        string expanded = element.Patterns.ExpandCollapse.IsSupported ? element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.Value.ToString() : null;
        if (currentIdentity != target.SemanticIdentity || Text(name, 500) != Field(prior, "name") || Hash(name) != target.NameFingerprint ||
            selected != Field(prior, "selected") || toggled != Field(prior, "toggleState") || expanded != Field(prior, "expandState") ||
            (target.Runtime.Length > 0 && RuntimeId(element) != target.Runtime)) throw new DesktopError("ELEMENT_IDENTITY_CHANGED");
    }
    private static bool OriginalWindowAbsent(WindowIdentity window)
    {
        if (!IsWindow(window.Handle)) return true;
        uint pid; GetWindowThreadProcessId(window.Handle, out pid);
        if (pid != window.Pid) return true;
        try { using (var process = Process.GetProcessById(window.Pid)) return process.HasExited || process.StartTime.ToUniversalTime().Ticks != window.Started; }
        catch (ArgumentException) { return true; }
        catch { return false; }
    }
    private static bool OriginalWindowHidden(WindowIdentity window)
    {
        if (!IsWindow(window.Handle) || IsWindowVisible(window.Handle)) return false;
        uint pid; GetWindowThreadProcessId(window.Handle, out pid); if (pid != window.Pid) return false;
        try { using (var process = Process.GetProcessById(window.Pid)) return !process.HasExited && process.SessionId == window.Session && process.StartTime.ToUniversalTime().Ticks == window.Started && String.Equals(Path.GetFullPath(process.MainModule.FileName), window.Path, StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    private object Execute(Dictionary<string, object> args)
    {
        string expected = Required(args, "expectedVersion"), targetId = Required(args, "targetId"), operation = Required(args, "operation");
        string expectedWindow = args.ContainsKey("expectedWindowVersion") ? Required(args, "expectedWindowVersion") : null;
        // Resolve exclusively from a new observation; never execute a stale
        // AutomationElement retained from the model's earlier observation.
        var before = Observe(null, false);
        DesktopTarget target;
        if (!observed.TryGetValue(targetId, out target)) throw new DesktopError("UNKNOWN_TARGET");
        if (expectedWindow != null)
        {
            if (target.Element != null) throw new DesktopError("WINDOW_VERSION_REQUIRES_WINDOW_TARGET");
            if (!String.Equals(expectedWindow, Field(target.State, "stateVersion"), StringComparison.Ordinal)) throw new DesktopError("STALE_SNAPSHOT");
        }
        else if (!String.Equals(expected, (string)before["version"], StringComparison.Ordinal)) throw new DesktopError("STALE_SNAPSHOT");
        if (!target.Capabilities.Contains(operation)) throw new DesktopError("OPERATION_DENIED");
        var window = Revalidate(target.Window); var prior = target.State;
        if (target.Element == null)
        {
            if (operation == "inspect") selectedWindowId = window.Id;
            else if (operation == "activate") { if (IsIconic(window.Handle)) ShowWindowAsync(window.Handle, 9); SetForegroundWindow(window.Handle); }
            else if (operation == "minimize") ShowWindowAsync(window.Handle, 6);
            else if (operation == "maximize") ShowWindowAsync(window.Handle, 3);
            else if (operation == "restore") ShowWindowAsync(window.Handle, 1);
            else if (operation == "close") { if (!PostMessage(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new DesktopError("WINDOW_CLOSE_FAILED"); }
            else throw new DesktopError("OPERATION_DENIED");
        }
        else
        {
            ValidateCurrentElement(target);
            if (operation == "select") target.Element.Patterns.SelectionItem.Pattern.Select();
            else if (operation == "invoke") target.Element.Patterns.Invoke.Pattern.Invoke();
            else if (operation == "toggle") target.Element.Patterns.Toggle.Pattern.Toggle();
            else if (operation == "expand") target.Element.Patterns.ExpandCollapse.Pattern.Expand();
            else if (operation == "collapse") target.Element.Patterns.ExpandCollapse.Pattern.Collapse();
            else throw new DesktopError("OPERATION_DENIED");
        }
        Dictionary<string, object> after = null; bool verified = false, stateChanged = false; string evidence = "not_verified";
        for (int attempt = 0; attempt < 4; attempt++)
        {
            if (operation != "inspect") Thread.Sleep(attempt == 0 ? 120 : 160);
            try { after = Observe(null, false); }
            catch { return new { operation = operation, targetId = targetId, before = before, after = (object)null, verified = false, stateChanged = false, effectAttempted = true, evidence = "effect_outcome_unknown" }; }
            var result = FindElement(after, targetId);
            if (operation == "inspect") { verified = selectedWindowId == window.Id; evidence = verified ? "window_inspected" : "not_verified"; }
            else if (operation == "close")
            {
                verified = OriginalWindowAbsent(window); evidence = verified ? "window_absent" : "window_still_present";
                // Closing normally can briefly hide the HWND before destroying
                // it. Give that transition the observation grace period before
                // reporting persistent hide-to-tray behavior.
                if (!verified && attempt == 3 && OriginalWindowHidden(window)) { verified = true; evidence = "window_hidden_process_running"; }
            }
            else if (operation == "activate") { verified = Boolean(result, "active"); evidence = verified ? "window_active" : "foreground_not_granted"; }
            else if (operation == "minimize") { verified = Boolean(result, "minimized"); evidence = verified ? "window_minimized" : "not_verified"; }
            else if (operation == "maximize") { verified = Boolean(result, "maximized"); evidence = verified ? "window_maximized" : "not_verified"; }
            else if (operation == "restore") { verified = result != null && !Boolean(result, "minimized") && !Boolean(result, "maximized"); evidence = verified ? "window_restored" : "not_verified"; }
            else if (operation == "select") { verified = Boolean(result, "selected"); evidence = verified ? "element_selected" : "not_verified"; }
            else if (operation == "toggle") { verified = result != null && Field(result, "toggleState") != Field(prior, "toggleState"); evidence = verified ? "toggle_state_changed" : "not_verified"; }
            else if (operation == "expand" || operation == "collapse") { verified = Field(result, "expandState") == (operation == "expand" ? "Expanded" : "Collapsed"); evidence = verified ? "expansion_state_changed" : "not_verified"; }
            else if (operation == "invoke") { evidence = InvokeEvidence(before, after, window.Id); stateChanged = evidence == "state_changed"; }
            if (verified || stateChanged || evidence == "effect_outcome_unknown" || operation == "inspect") break;
        }
        return new { operation = operation, targetId = targetId, before = before, after = after, verified = verified, stateChanged = stateChanged, effectAttempted = operation != "inspect", evidence = evidence };
    }
    private object Dispatch(string method, Dictionary<string, object> args)
    {
        if (method == "observe")
        {
            object value; bool hasWindow = args.TryGetValue("windowId", out value);
            if (hasWindow && value != null && (!(value is string) || ((string)value).Length > 100)) throw new DesktopError("INVALID_ARGUMENT");
            return Observe(value as string, hasWindow);
        }
        if (method == "execute") return Execute(args);
        throw new DesktopError("UNKNOWN_METHOD");
    }
    private static string Required(Dictionary<string, object> values, string key) { object value; if (!values.TryGetValue(key, out value) || !(value is string) || ((string)value).Length < 1 || ((string)value).Length > 256) throw new DesktopError("INVALID_ARGUMENT"); return (string)value; }
    private static string ReadBoundedLine()
    {
        var text = new StringBuilder(); bool overflow = false; int ch;
        while ((ch = Console.In.Read()) != -1 && ch != '\n') { if (text.Length < 65536) text.Append((char)ch); else overflow = true; }
        if (ch == -1 && text.Length == 0) return null; return overflow ? "" : text.ToString().TrimEnd('\r');
    }
    public void Dispose() { automation.Dispose(); }
    [STAThread] private static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false); Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            int owner = 0, fixture = 0;
            for (int i = 0; i < args.Length; i += 2)
            {
                int value; if (i + 1 >= args.Length || !Int32.TryParse(args[i + 1], out value) || value < 1) throw new DesktopError("INVALID_BINDING");
                if (args[i] == "--owner-pid") owner = value; else if (args[i] == "--fixture-pid") fixture = value; else throw new DesktopError("INVALID_BINDING");
            }
            using (var helper = new WindowsDesktopHelper(owner, fixture))
            {
                string line;
                while ((line = ReadBoundedLine()) != null)
                {
                    object id = null;
                    try
                    {
                        var request = Json.Deserialize<Dictionary<string, object>>(line); if (request == null) throw new DesktopError("INVALID_REQUEST");
                        object requestId; if (request.TryGetValue("id", out requestId) && (requestId is string || requestId is int)) id = requestId;
                        if (id is string && ((string)id).Length > 128) throw new DesktopError("INVALID_REQUEST");
                        string method = Required(request, "method"); object raw; var parameters = request.TryGetValue("args", out raw) ? raw as Dictionary<string, object> : new Dictionary<string, object>();
                        if (parameters == null) throw new DesktopError("INVALID_ARGUMENT");
                        Console.WriteLine(Json.Serialize(new { id = id, ok = true, result = helper.Dispatch(method, parameters) }));
                    }
                    catch (Exception error) { Console.WriteLine(Json.Serialize(new { id = id, ok = false, error = new { code = error is DesktopError ? ((DesktopError)error).Code : "UIA_REQUEST_FAILED" } })); }
                }
            }
            return 0;
        }
        catch (Exception error) { Console.WriteLine(Json.Serialize(new { id = (object)null, ok = false, error = new { code = error is DesktopError ? ((DesktopError)error).Code : "HELPER_START_FAILED" } })); return 1; }
    }
    private delegate bool EnumWindowsDelegate(IntPtr handle, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsDelegate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int length);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
}
