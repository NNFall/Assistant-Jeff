using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
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

internal sealed class DesktopError : Exception
{
    public readonly string Code; public readonly string Stage; public readonly string ProviderCode; public readonly bool? EffectAttempted;
    public DesktopError(string code) : base(code) { Code = code; }
    public DesktopError(string code, bool effectAttempted) : base(code) { Code = code; EffectAttempted = effectAttempted; }
    public DesktopError(string code, string stage, Exception provider, bool effectAttempted) : base(code)
    {
        Code = code; Stage = stage; ProviderCode = "0x" + Marshal.GetHRForException(provider).ToString("X8"); EffectAttempted = effectAttempted;
    }
}
internal sealed class WindowIdentity
{
    public IntPtr Handle; public int Pid; public int Session; public long Started; public string Path; public string ProcessName; public string Id; public string Title;
    public string ClassName; public string SurfaceKind;
}
internal sealed class ProcessIdentityInfo
{
    public int Pid; public int Session; public long Started; public string Path; public string ProcessName; public string Source;
}
internal sealed class DesktopTarget
{
    public WindowIdentity Window; public AutomationElement Element; public string[] Capabilities; public Dictionary<string, object> State; public string Runtime; public string SemanticIdentity; public string NameFingerprint; public bool IsFocusedEdit;
    public ProcessIdentityInfo ElementProcess;
}
internal sealed class TextTarget
{
    public WindowIdentity Window; public AutomationElement Element; public string Runtime; public long ProcessStart; public string WindowFingerprint; public string ValueHash; public string Version; public string Id;
}
internal sealed class WalkEntry
{
    public AutomationElement Element; public int Depth; public string ParentKey; public string Group; public int Order; public int Priority; public int Sequence; public ControlType? KnownRole;
}
internal sealed class TabGroupState { public int Expected; public bool Complete; }

// This is a product backend. It never executes model-generated code, types
// arbitrary keys or accepts model-supplied screen coordinates. Trusted shell
// buttons may be clicked at a fresh UIA point after an exact element hit-test.
// General window
// observations do not read text/value contents; the dedicated text_* methods
// read bounded non-secret ValuePattern values after their own UIA guards.
internal sealed class WindowsDesktopHelper : IDisposable
{
    private const int MaxWindows = 64, MaxElements = 160, MaxScanned = 480, MaxDepth = 12, ObserveBudgetMs = 1800, MaxTextValue = 2000;
    private UIA3Automation desktopAutomation;
    private UIA3Automation automation
    {
        get
        {
            if (desktopAutomation == null)
            {
                desktopAutomation = new UIA3Automation();
                desktopAutomation.ConnectionTimeout = TimeSpan.FromMilliseconds(500);
                desktopAutomation.TransactionTimeout = TimeSpan.FromMilliseconds(650);
            }
            return desktopAutomation;
        }
    }
    private readonly int sessionId = Process.GetCurrentProcess().SessionId;
    private readonly int ownPid = Process.GetCurrentProcess().Id;
    private readonly int ownerPid;
    private readonly int fixturePid;
    private readonly long fixtureStart;
    private readonly string fixturePath;
    private string selectedWindowId;
    private Dictionary<string, DesktopTarget> observed = new Dictionary<string, DesktopTarget>();
    private Dictionary<string, TextTarget> textObserved = new Dictionary<string, TextTarget>();
    private string textObservationVersion;
    private string textObservationWindowId;
    private static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 4194304, RecursionLimit = 32 };
    private static readonly Regex SensitiveWindow = new Regex(@"password|passkey|sign[ -]?in|log[ -]?in|authentication|authorization|two.factor|security|credential|парол|войти|вход в|авторизац|аутентификац|безопасност|учетн|учётн", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex SecretText = new Regex(@"apikey_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{16,}|Bearer\s+\S+", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex BlockedTextContext = new Regex(@"(?:^\s*(?:javascript:|data:|file:)|developer\s*(?:tools?|console)|command\s*prompt|powershell|windows\s*terminal|(?:^|[ ._-])terminal(?:$|[ ._-])|cmd(?:\.exe)?|shell)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly Regex BlockedTextPayload = new Regex(@"^\s*(?:javascript:|data:|file:)", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    private static readonly HashSet<string> BlockedProcesses = new HashSet<string>(StringComparer.OrdinalIgnoreCase) {
        "codex", "chatgpt", "windowsterminal", "powershell", "pwsh", "cmd", "conhost", "openconsole", "mintty", "bash", "wsl", "wt",
        "credentialuibroker", "logonui", "consent", "winlogon", "lockapp", "systemsettings", "sechealthui", "securityhealthsystray", "mmc", "regedit",
        "1password", "bitwarden", "keepass", "keepassxc", "lastpass", "dashlane", "protonpass", "jeffwindowsdesktophelper", "jeffdesktoplabhelper", "assistant jeff",
        "textinputhost", "shellhost", "shellexperiencehost", "startmenuexperiencehost", "searchhost", "searchapp", "nvidia overlay", "nvidia share", "gamebar", "gamebarftserver", "gamebarpresencewriter", "taskmgr"
    };

    private WindowsDesktopHelper(int excludedOwner, int restrictedFixture)
    {
        ownerPid = excludedOwner; fixturePid = restrictedFixture;
        if (fixturePid > 0)
        {
            // The fixture restriction exists only to test the real backend
            // without observing any personal window or application.
            string fixtureBase = Path.GetFullPath(Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location), "..", ".."));
            string labFixture = Path.Combine(fixtureBase, "desktop-lab", "bin", "JeffDesktopLabTarget.exe");
            string inputFixture = Path.Combine(fixtureBase, "windows-desktop", "input-fixture", "JeffWindowsInputFixture.exe");
            using (var process = Process.GetProcessById(fixturePid))
            {
                string actualPath = Path.GetFullPath(process.MainModule.FileName);
                if (process.SessionId != sessionId || (!String.Equals(actualPath, labFixture, StringComparison.OrdinalIgnoreCase) && !String.Equals(actualPath, inputFixture, StringComparison.OrdinalIgnoreCase))) throw new DesktopError("INVALID_FIXTURE_BINDING");
                fixturePath = actualPath;
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
        if (window.Pid == ownPid || window.Pid == ownerPid) return true;
        if (IsTaskManagerPath(window.Path)) return false; // Window-level only; Observe never traverses this app.
        if (BlockedProcesses.Contains(window.ProcessName) && TrustedWindowsProcess(window.ProcessName, window.Path) == null) return true;
        string path = window.Path.ToLowerInvariant(), title = window.Title;
        if (path.Contains("\\codex\\") || path.Contains("\\chatgpt\\") || path.Contains("\\1password\\") || path.Contains("\\bitwarden\\") || path.Contains("\\keepass")) return true;
        if (SensitiveWindow.IsMatch(title) || BlockedTextContext.IsMatch(title) || title.IndexOf("Codex", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("ChatGPT", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("Jeff Windows", StringComparison.OrdinalIgnoreCase) >= 0 || title.IndexOf("Assistant Jeff", StringComparison.OrdinalIgnoreCase) >= 0) return true;
        return false;
    }
    private static bool IsTaskManagerPath(string path)
    {
        try { return String.Equals(Path.GetFullPath(path), Path.Combine(Environment.SystemDirectory, "Taskmgr.exe"), StringComparison.OrdinalIgnoreCase); }
        catch { return false; }
    }
    private static string TrustedWindowsProcess(string processName, string path)
    {
        // Shell names are not authority: only the canonical Windows image paths
        // may bypass the ordinary application/window filters. Copied executables
        // and similarly named programs retain the original restrictions.
        if (String.IsNullOrEmpty(processName) || String.IsNullOrEmpty(path)) return null;
        string windows = Environment.GetFolderPath(Environment.SpecialFolder.Windows);
        string relative = null, kind = null;
        switch (processName.ToLowerInvariant())
        {
            case "explorer": relative = "explorer.exe"; kind = "explorer"; break;
            case "shellhost": relative = @"System32\ShellHost.exe"; kind = "shell"; break;
            case "shellexperiencehost": relative = @"SystemApps\ShellExperienceHost_cw5n1h2txyewy\ShellExperienceHost.exe"; kind = "shell"; break;
            case "startmenuexperiencehost": relative = @"SystemApps\Microsoft.Windows.StartMenuExperienceHost_cw5n1h2txyewy\StartMenuExperienceHost.exe"; kind = "start"; break;
            case "searchhost": relative = @"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\SearchHost.exe"; kind = "search"; break;
            case "searchapp": relative = @"SystemApps\Microsoft.Windows.Search_cw5n1h2txyewy\SearchApp.exe"; kind = "search"; break;
            case "textinputhost": relative = @"SystemApps\MicrosoftWindows.Client.CBS_cw5n1h2txyewy\TextInputHost.exe"; kind = "input"; break;
            case "systemsettings": relative = @"ImmersiveControlPanel\SystemSettings.exe"; kind = "settings"; break;
            case "applicationframehost": relative = @"System32\ApplicationFrameHost.exe"; kind = "frame"; break;
            default: return null;
        }
        try { return String.Equals(Path.GetFullPath(path), Path.Combine(windows, relative), StringComparison.OrdinalIgnoreCase) ? kind : null; }
        catch { return null; }
    }
    private static string ClassifySurface(string processName, string path, string className, string title, bool toolWindow)
    {
        string trusted = TrustedWindowsProcess(processName, path);
        bool taskbar = className == "Shell_TrayWnd" || className == "Shell_SecondaryTrayWnd";
        bool desktop = className == "Progman" || className == "WorkerW";
        if (taskbar || desktop) return trusted == "explorer" ? (taskbar ? "taskbar" : "desktop") : null;
        if (trusted == "start") return "start_menu";
        if (trusted == "search") return "search";
        if (trusted == "shell" || trusted == "input") return "shell_popup";
        if (trusted == "settings" || (trusted == "frame" && Regex.IsMatch(title ?? "", @"^(?:Параметры|Настройки|Settings)$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant))) return "settings";
        if (trusted == "explorer" && (toolWindow || String.IsNullOrEmpty(title) || className == "NotifyIconOverflowWindow" || className == "TopLevelWindowForOverflowXamlIsland")) return "shell_popup";
        if (toolWindow || String.IsNullOrEmpty(title)) return null;
        return "application";
    }
    private static bool IsShellSurfaceKind(string kind)
    {
        return kind == "taskbar" || kind == "desktop" || kind == "start_menu" || kind == "search" || kind == "shell_popup";
    }
    private static string SurfaceTitle(string kind)
    {
        switch (kind)
        {
            case "taskbar": return "Панель задач";
            case "desktop": return "Рабочий стол";
            case "start_menu": return "Пуск";
            case "search": return "Поиск Windows";
            case "settings": return "Параметры Windows";
            default: return "Системная панель Windows";
        }
    }
    private static bool AllowedEmbeddedProcess(WindowIdentity window, ProcessIdentityInfo process)
    {
        if (process == null || process.Session != window.Session || process.Started <= 0) return false;
        if (process.Pid == window.Pid) return process.Started == window.Started && String.Equals(process.Path, window.Path, StringComparison.OrdinalIgnoreCase);
        // Windows composes shell/settings trees from several trusted hosts. Do
        // not generalize that exception to arbitrary cross-process app content.
        return (IsShellSurfaceKind(window.SurfaceKind) || window.SurfaceKind == "settings") &&
            TrustedWindowsProcess(window.ProcessName, window.Path) != null && TrustedWindowsProcess(process.ProcessName, process.Path) != null;
    }
    private static bool SameProcessIdentity(ProcessIdentityInfo first, ProcessIdentityInfo second)
    {
        return first != null && second != null && first.Pid == second.Pid && first.Session == second.Session && first.Started == second.Started &&
            String.Equals(first.Path, second.Path, StringComparison.OrdinalIgnoreCase) && String.Equals(first.ProcessName, second.ProcessName, StringComparison.OrdinalIgnoreCase);
    }
    private static bool IsObservedShellClickTarget(WindowIdentity window, ControlType role, string runtime)
    {
        return window != null && role == ControlType.Button && !String.IsNullOrEmpty(runtime) &&
            (window.SurfaceKind == "taskbar" || window.SurfaceKind == "shell_popup" || window.SurfaceKind == "start_menu") &&
            TrustedWindowsProcess(window.ProcessName, window.Path) != null;
    }
    private static bool HasClickBounds(Rectangle bounds)
    {
        return bounds.Width > 0 && bounds.Height > 0 && bounds.Right > bounds.Left && bounds.Bottom > bounds.Top;
    }
    private static bool CanInspectUiaOnlyShell(WindowIdentity window)
    {
        if (window == null) return false;
        string trusted = TrustedWindowsProcess(window.ProcessName, window.Path);
        return (trusted == "explorer" && window.SurfaceKind == "taskbar" &&
                (window.ClassName == "Shell_TrayWnd" || window.ClassName == "Shell_SecondaryTrayWnd")) ||
            (trusted == "shell" && window.SurfaceKind == "shell_popup" && window.ClassName == "ControlCenterWindow");
    }
    private static bool HasVisibleShellBounds(Rectangle bounds, Rectangle screen)
    {
        if (!HasClickBounds(bounds) || bounds.Width <= 1 || bounds.Height <= 1) return false;
        var visible = Rectangle.Intersect(bounds, screen);
        return visible.Width > 1 && visible.Height > 1;
    }
    private bool IsUiaShellVisible(WindowIdentity window)
    {
        // Windows composition can show Quick Settings, or retain the taskbar
        // during that transition, without WS_VISIBLE on its root HWND. This
        // exception permits inspection only; each control action still needs
        // its own fresh identity, geometry and hit-test. Hidden 1px XAML stubs
        // and ordinary application/tool windows do not qualify.
        if (!CanInspectUiaOnlyShell(window) || !PhysicalCoordinatesAvailable()) return false;
        var root = automation.FromHandle(window.Handle);
        if (root.Properties.ProcessId.Value != window.Pid || root.Properties.NativeWindowHandle.Value != window.Handle ||
            root.Properties.ClassName.ValueOrDefault != window.ClassName || root.IsOffscreen || RuntimeId(root).Length == 0) return false;
        var bounds = root.BoundingRectangle;
        return Screen.AllScreens.Any(screen => HasVisibleShellBounds(bounds, screen.Bounds));
    }
    private static bool PhysicalCoordinatesAvailable()
    {
        try { return GetAwarenessFromDpiAwarenessContext(GetThreadDpiAwarenessContext()) == 2; }
        catch (EntryPointNotFoundException) { return false; }
    }
    private static bool ConfigureDpiAwareness()
    {
        // This standalone UIA client must use the same physical coordinate
        // space for provider geometry, screen bounds, hit tests and mouse input.
        // Set the process default before any DPI-sensitive API; the explicit
        // STA context also handles an already configured host in native tests.
        try
        {
            SetProcessDpiAwarenessContext(new IntPtr(-4)); // PER_MONITOR_AWARE_V2
            SetThreadDpiAwarenessContext(new IntPtr(-4));
            return PhysicalCoordinatesAvailable();
        }
        catch (EntryPointNotFoundException) { return false; }
    }
    private static bool ShouldContinueReadback(string operation, string surfaceKind, int attempt, long elapsedMs, bool verified, bool stateChanged, string evidence)
    {
        if (verified || stateChanged || operation == "inspect" || operation == "replace_text") return false;
        bool shellTransition = (operation == "invoke" || operation == "click") && IsShellSurfaceKind(surfaceKind);
        if (shellTransition) return attempt < 5 && elapsedMs < 1200;
        return attempt < 3 && evidence != "effect_outcome_unknown";
    }
    private static string KeyboardLanguage(IntPtr layout)
    {
        int language = (int)(layout.ToInt64() & 0x3ff);
        return language == 0x09 ? "English" : language == 0x19 ? "Russian" : "Other";
    }
    private static IntPtr[] InstalledLayouts()
    {
        int count = GetKeyboardLayoutList(0, null); if (count < 1) return new IntPtr[0];
        var layouts = new IntPtr[Math.Min(count, 128)]; int written = GetKeyboardLayoutList(layouts.Length, layouts);
        return layouts.Take(Math.Max(0, Math.Min(written, layouts.Length))).ToArray();
    }
    private static string[] AvailableKeyboardLanguages()
    {
        return InstalledLayouts().Select(KeyboardLanguage).Where(x => x == "English" || x == "Russian").Distinct().OrderBy(x => x, StringComparer.Ordinal).ToArray();
    }
    private static ProcessIdentityInfo ReadLimitedProcessIdentity(int pid)
    {
        if (pid <= 0) return null;
        // Query-only access works for ordinary elevated apps without enabling
        // privileges or requesting VM/module access. Missing evidence still
        // fails closed; an executable name alone is never sufficient.
        IntPtr process = OpenProcess(0x1000, false, (uint)pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (process == IntPtr.Zero) return null;
        try
        {
            var image = new StringBuilder(32768); int length = image.Capacity;
            long created, exited, kernel, user; uint session, exitCode;
            if (!QueryFullProcessImageName(process, 0, image, ref length) ||
                !GetProcessTimes(process, out created, out exited, out kernel, out user) || created <= 0 || exited != 0 ||
                !ProcessIdToSessionId((uint)pid, out session) || session > Int32.MaxValue ||
                !GetExitCodeProcess(process, out exitCode) || exitCode != 259) return null;
            string path = Path.GetFullPath(image.ToString());
            return new ProcessIdentityInfo { Pid = pid, Session = (int)session, Started = DateTime.FromFileTimeUtc(created).Ticks, Path = path, ProcessName = Path.GetFileNameWithoutExtension(path), Source = "limited_information" };
        }
        catch { return null; }
        finally { CloseHandle(process); }
    }
    private static ProcessIdentityInfo ReadProcessIdentity(int pid)
    {
        try
        {
            using (var process = Process.GetProcessById(pid))
            {
                if (process.HasExited) return null;
                string path = Path.GetFullPath(process.MainModule.FileName);
                return new ProcessIdentityInfo { Pid = process.Id, Session = process.SessionId, Started = process.StartTime.ToUniversalTime().Ticks, Path = path, ProcessName = process.ProcessName, Source = "process_api" };
            }
        }
        catch { return ReadLimitedProcessIdentity(pid); }
    }
    private WindowIdentity Identity(IntPtr handle)
    {
        if (handle == IntPtr.Zero || !IsWindow(handle)) return null;
        bool nativeVisible = IsWindowVisible(handle);
        var className = new StringBuilder(256); GetClassName(handle, className, className.Capacity);
        // Preserve the cheap rejection of all unrelated hidden HWNDs before
        // process/module and UIA reads in the bounded desktop inventory.
        if (!nativeVisible && className.ToString() != "ControlCenterWindow" && className.ToString() != "Shell_TrayWnd" && className.ToString() != "Shell_SecondaryTrayWnd") return null;
        bool toolWindow = (GetWindowLongPtr(handle, -20).ToInt64() & 0x00000080L) != 0;
        int cloaked; if (DwmGetWindowAttribute(handle, 14, out cloaked, 4) == 0 && cloaked != 0) return null;
        uint nativePid; GetWindowThreadProcessId(handle, out nativePid);
        if (nativePid == 0 || nativePid > Int32.MaxValue || (fixturePid > 0 && nativePid != fixturePid)) return null;
        try
        {
            var process = ReadProcessIdentity((int)nativePid);
            if (process == null || process.Session != sessionId) return null;
            string title = WindowTitle(handle);
            string surfaceKind = ClassifySurface(process.ProcessName, process.Path, className.ToString(), title, toolWindow);
            if (surfaceKind == null) return null;
            if (IsShellSurfaceKind(surfaceKind))
            {
                NativeRect bounds;
                if (!GetWindowRect(handle, out bounds) || bounds.Right <= bounds.Left || bounds.Bottom <= bounds.Top) return null;
            }
            if (title.Length == 0) title = SurfaceTitle(surfaceKind);
            uint currentPid; GetWindowThreadProcessId(handle, out currentPid); if (currentPid != nativePid) return null;
            if (fixturePid > 0 && (process.Started != fixtureStart || !String.Equals(process.Path, fixturePath, StringComparison.OrdinalIgnoreCase))) return null;
            var window = new WindowIdentity { Handle = handle, Pid = process.Pid, Session = process.Session, Started = process.Started, Path = process.Path, ProcessName = process.ProcessName, Title = title, ClassName = className.ToString(), SurfaceKind = surfaceKind };
            if (IsProtected(window) || (!nativeVisible && !IsUiaShellVisible(window))) return null;
            // Recheck the native owner after UIA reads: composition HWNDs may
            // disappear while a flyout is dismissed or recreated.
            GetWindowThreadProcessId(handle, out currentPid); if (currentPid != nativePid || !IsWindow(handle)) return null;
            window.Id = "win_" + Hash(window.Pid + ":" + window.Started + ":" + window.Session + ":" + window.Path.ToLowerInvariant() + ":" + handle.ToInt64()).Substring(0, 24);
            return window;
        }
        catch { return null; }
    }
    private WindowIdentity Revalidate(WindowIdentity previous)
    {
        var current = Identity(previous.Handle);
        if (current == null || current.Id != previous.Id || current.Path != previous.Path || current.Started != previous.Started || current.ClassName != previous.ClassName || current.SurfaceKind != previous.SurfaceKind) throw new DesktopError("TARGET_IDENTITY_CHANGED");
        return current;
    }
    private static Dictionary<string, object> WindowState(WindowIdentity window)
    {
        uint ignoredPid; uint thread = GetWindowThreadProcessId(window.Handle, out ignoredPid); var layout = GetKeyboardLayout(thread);
        var state = new Dictionary<string, object> {
            { "id", window.Id }, { "title", window.Title }, { "processName", window.ProcessName }, { "processId", window.Pid },
            { "surfaceKind", window.SurfaceKind }, { "className", window.ClassName },
            { "minimized", IsIconic(window.Handle) }, { "maximized", IsZoomed(window.Handle) }, { "active", GetForegroundWindow() == window.Handle },
            { "keyboardLanguage", KeyboardLanguage(layout) }, { "keyboardLayoutId", "0x" + layout.ToInt64().ToString("X16") }, { "availableKeyboardLanguages", AvailableKeyboardLanguages() }
        };
        state["stateVersion"] = Hash(Json.Serialize(state)); return state;
    }
    private static List<string> WindowCapabilities(WindowIdentity window)
    {
        // Closing, minimizing, focusing or changing the input layout of a shell
        // infrastructure HWND is not an ordinary application operation.
        if (IsShellSurfaceKind(window.SurfaceKind)) return new List<string> { "inspect" };
        var caps = new List<string> { "inspect", "activate" }; long style = GetWindowLongPtr(window.Handle, -16).ToInt64();
        if (!IsIconic(window.Handle) && (style & 0x00020000L) != 0) caps.Add("minimize");
        if (!IsZoomed(window.Handle) && (style & 0x00010000L) != 0) caps.Add("maximize");
        if (IsIconic(window.Handle) || IsZoomed(window.Handle)) caps.Add("restore");
        if ((style & 0x00080000L) != 0) caps.Add("close");
        if (GetForegroundWindow() == window.Handle && !IsTaskManagerPath(window.Path) && AvailableKeyboardLanguages().Length > 0) caps.Add("set_keyboard_language");
        return caps;
    }
    private static bool IsObservedShellRoot(WindowIdentity window, int processId, IntPtr handle, string className)
    {
        return window != null && handle != IntPtr.Zero && window.Handle == handle && window.Pid == processId &&
            window.ClassName == className && IsShellSurfaceKind(window.SurfaceKind) &&
            TrustedWindowsProcess(window.ProcessName, window.Path) != null;
    }
    private void AddUiaShellWindows(List<WindowIdentity> windows, Stopwatch watch, List<Dictionary<string, object>> errors, ref bool truncated)
    {
        if (fixturePid > 0) return; // Fixture observations never inspect the real desktop UIA tree.
        // Modern composition surfaces (including the primary taskbar while a
        // flyout is open) can be missing from EnumWindows altogether. Supplement
        // only direct UIA desktop children owned by canonical Windows hosts.
        // They retain the exact native HWND/process identity and shell guards.
        var handles = new HashSet<IntPtr>(windows.Select(window => window.Handle));
        var processes = new Dictionary<int, ProcessIdentityInfo>();
        try
        {
            var walker = automation.TreeWalkerFactory.GetRawViewWalker();
            var child = walker.GetFirstChild(automation.GetDesktop()); int roots = 0;
            while (child != null)
            {
                if (roots++ >= MaxWindows * 2 || watch.ElapsedMilliseconds >= ObserveBudgetMs || windows.Count >= MaxWindows) { truncated = true; break; }
                try
                {
                    IntPtr handle = child.Properties.NativeWindowHandle.ValueOrDefault;
                    if (handle != IntPtr.Zero && !handles.Contains(handle))
                    {
                        int pid = child.Properties.ProcessId.Value;
                        ProcessIdentityInfo process;
                        if (!processes.TryGetValue(pid, out process)) { process = ReadProcessIdentity(pid); processes[pid] = process; }
                        if (process != null && process.Session == sessionId && TrustedWindowsProcess(process.ProcessName, process.Path) != null)
                        {
                            var window = Identity(handle);
                            if (IsObservedShellRoot(window, pid, handle, child.Properties.ClassName.ValueOrDefault))
                            {
                                windows.Add(window); handles.Add(handle);
                            }
                        }
                    }
                }
                catch (Exception error) { ProviderError(errors, "shell_inventory_element", error); truncated = true; }
                child = walker.GetNextSibling(child);
            }
        }
        catch (Exception error) { ProviderError(errors, "shell_inventory", error); truncated = true; }
    }
    private Dictionary<string, object> Observe(string requestedWindow, bool explicitlyRequested)
    {
        var watch = Stopwatch.StartNew(); var windows = new List<WindowIdentity>(); bool truncated = false;
        var providerErrors = new List<Dictionary<string, object>>();
        EnumWindows(delegate(IntPtr handle, IntPtr ignored) {
            var window = Identity(handle);
            if (window != null) { if (windows.Count >= MaxWindows) { truncated = true; return false; } windows.Add(window); }
            return true;
        }, IntPtr.Zero);
        AddUiaShellWindows(windows, watch, providerErrors, ref truncated);
        bool inventoryTruncated = truncated;
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
                { "windowId", window.Id }, { "processName", window.ProcessName }, { "processId", window.Pid }, { "minimized", state["minimized"] }, { "maximized", state["maximized"] }, { "active", state["active"] }, { "stateVersion", state["stateVersion"] },
                { "surfaceKind", window.SurfaceKind }, { "className", window.ClassName },
                { "keyboardLanguage", state["keyboardLanguage"] }, { "keyboardLayoutId", state["keyboardLayoutId"] }, { "availableKeyboardLanguages", state["availableKeyboardLanguages"] }
            };
            elements.Add(element); next[window.Id] = new DesktopTarget { Window = window, Capabilities = caps, State = element };
        }
        int scanned = 0, skippedCrossProcess = 0; string surfaceStatus = "not_inspected";
        var selectedWindow = windows.FirstOrDefault(x => x.Id == selectedWindowId);
        if (selectedWindow != null)
        {
            if (IsTaskManagerPath(selectedWindow.Path)) surfaceStatus = "restricted_system_window";
            else if (IsIconic(selectedWindow.Handle)) surfaceStatus = "window_minimized";
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
            { "metadata", new Dictionary<string, object> { { "provider", "FlaUI.UIA3 5.0.0" }, { "monitorCount", Screen.AllScreens.Length }, { "coordinateSpace", PhysicalCoordinatesAvailable() ? "physical" : "unavailable_for_click" }, { "truncated", truncated }, { "inventoryTruncated", inventoryTruncated }, { "scannedElements", scanned }, { "fixtureRestricted", fixturePid > 0 }, { "surfaceStatus", surfaceStatus }, { "providerErrors", providerErrors }, { "skippedCrossProcess", skippedCrossProcess }, { "tabOrderPartial", elements.Any(x => (string)x["role"] == "TabItem" && Boolean(x, "visualOrderIsPartial")) } } }
        };
    }
    private Dictionary<string, object> ObserveText(string windowId)
    {
        DesktopTarget observedWindow;
        if (!observed.TryGetValue(windowId, out observedWindow) || observedWindow.Element != null) throw new DesktopError("TEXT_WINDOW_NOT_OBSERVED", false);
        var window = Revalidate(observedWindow.Window);
        if (IsTaskManagerPath(window.Path) || IsIconic(window.Handle)) throw new DesktopError("TEXT_WINDOW_UNAVAILABLE", false);

        textObserved = new Dictionary<string, TextTarget>(); textObservationVersion = null; textObservationWindowId = null;
        var watch = Stopwatch.StartNew(); var fields = new List<Dictionary<string, object>>(); var targets = new List<TextTarget>();
        var errors = new List<Dictionary<string, object>>(); int scanned = 0, omitted = 0, passwordOmitted = 0, secretOmitted = 0, readOnlyOmitted = 0; bool truncated = false;
        try { ReadTextSurface(window, fields, targets, errors, ref scanned, ref omitted, ref passwordOmitted, ref secretOmitted, ref readOnlyOmitted, ref truncated, watch); }
        catch (DesktopError) { throw; }
        catch (Exception error) { ProviderError(errors, "text_surface", error); truncated = true; }

        var semantic = Json.Serialize(new { windowId = window.Id, fields = fields.Select(x => new { id = x["id"], label = x["label"], value = x["value"], truncated = x.ContainsKey("truncated") ? x["truncated"] : null }).ToList() });
        string version = Hash(semantic);
        foreach (var target in targets) { target.Version = version; textObserved[target.Id] = target; }
        textObservationVersion = version; textObservationWindowId = window.Id;
        var coverage = new Dictionary<string, object> {
            { "scanned", scanned }, { "maxScanned", MaxScanned }, { "maxDepth", MaxDepth }, { "elapsedMs", (int)Math.Min(Int32.MaxValue, watch.ElapsedMilliseconds) },
            { "truncated", truncated }, { "fieldCount", fields.Count }, { "omittedFields", omitted }, { "passwordFieldsOmitted", passwordOmitted },
            { "secretFieldsOmitted", secretOmitted }, { "readOnlyFieldsOmitted", readOnlyOmitted }, { "providerErrors", errors }
        };
        return new Dictionary<string, object> { { "version", version }, { "windowId", window.Id }, { "fields", fields }, { "coverage", coverage } };
    }
    private void ReadTextSurface(WindowIdentity window, List<Dictionary<string, object>> fields, List<TextTarget> targets, List<Dictionary<string, object>> errors,
        ref int scanned, ref int omitted, ref int passwordOmitted, ref int secretOmitted, ref int readOnlyOmitted, ref bool truncated, Stopwatch watch)
    {
        Revalidate(window); var root = automation.FromHandle(window.Handle);
        if (root.Properties.ProcessId.Value != window.Pid) throw new DesktopError("TARGET_IDENTITY_CHANGED", false);
        var walker = automation.TreeWalkerFactory.GetControlViewWalker(); var queue = new List<WalkEntry>();
        queue.Add(new WalkEntry { Element = root, Depth = 0, ParentKey = window.Id, Group = "Text fields", Priority = 0, Sequence = 0 });
        int sequence = 0;
        while (queue.Count > 0)
        {
            if (watch.ElapsedMilliseconds >= ObserveBudgetMs || scanned >= MaxScanned) { truncated = true; break; }
            var entry = queue.OrderBy(x => x.Priority).ThenBy(x => x.Depth).ThenBy(x => x.Sequence).First(); queue.Remove(entry); var element = entry.Element; scanned++;
            if (entry.Depth > MaxDepth) { truncated = true; continue; }
            ControlType role;
            if (entry.Depth > 0)
            {
                try
                {
                    if (element.Properties.ProcessId.Value != window.Pid) { omitted++; continue; }
                    role = entry.KnownRole.HasValue ? entry.KnownRole.Value : element.ControlType;
                    bool password;
                    // IsPassword must be known false before reading Name or Value.
                    if (!element.Properties.IsPassword.TryGetValue(out password)) { omitted++; continue; }
                    if (password) { omitted++; passwordOmitted++; continue; }
                    if (role == ControlType.Edit)
                    {
                        bool enabled = element.IsEnabled, offscreen = element.IsOffscreen;
                        if (!enabled || offscreen || !element.Patterns.Value.IsSupported) { omitted++; continue; }
                        bool readOnly;
                        try { readOnly = element.Patterns.Value.Pattern.IsReadOnly.Value; }
                        catch (Exception error) { ProviderError(errors, "text_readonly", error); omitted++; readOnlyOmitted++; continue; }
                        if (readOnly) { omitted++; readOnlyOmitted++; continue; }
                        string runtime = RuntimeId(element); if (runtime.Length == 0) { omitted++; continue; }
                        string rawLabel = element.Name ?? "";
                        if (BlockedTextContext.IsMatch(window.Title) || BlockedTextContext.IsMatch(rawLabel)) { omitted++; continue; }
                        string value = element.Patterns.Value.Pattern.Value ?? "";
                        if (SecretText.IsMatch(value) || BlockedTextPayload.IsMatch(value)) { omitted++; if (SecretText.IsMatch(value)) secretOmitted++; continue; }
                        string id = "txt_" + Hash(window.Id + ":" + runtime + ":" + Hash(value)).Substring(0, 24);
                        string label = Text(rawLabel, 500); if (label.Length == 0) label = "Editable text field";
                        bool valueTruncated = value.Length > MaxTextValue;
                        var field = new Dictionary<string, object> {
                            { "id", id }, { "windowId", window.Id }, { "label", label }, { "value", valueTruncated ? value.Substring(0, MaxTextValue) : value },
                            { "role", "Edit" }, { "enabled", true }, { "offscreen", false }, { "readOnly", false }, { "writable", true }, { "supportsValuePattern", true }
                        };
                        if (valueTruncated) field["truncated"] = true;
                        fields.Add(field); targets.Add(new TextTarget { Id = id, Window = window, Element = element, Runtime = runtime, ProcessStart = window.Started,
                            WindowFingerprint = window.Id + ":" + window.Pid + ":" + window.Started + ":" + window.Path, ValueHash = Hash(value) });
                        continue; // Do not traverse an Edit's descendants.
                    }
                }
                catch (Exception error) { ProviderError(errors, "text_element", error); omitted++; truncated = true; continue; }
            }
            if (entry.Depth == MaxDepth) { truncated = true; continue; }
            try
            {
                var children = new List<AutomationElement>(); var child = walker.GetFirstChild(element); bool completeChildren = true;
                while (child != null)
                {
                    if (children.Count >= MaxElements || queue.Count + children.Count >= MaxScanned || watch.ElapsedMilliseconds >= ObserveBudgetMs) { truncated = true; completeChildren = false; break; }
                    children.Add(child); try { child = walker.GetNextSibling(child); } catch (Exception error) { ProviderError(errors, "text_next_sibling", error); truncated = true; completeChildren = false; break; }
                }
                int ordinal = 0;
                foreach (var descendant in children)
                {
                    ControlType? childRole = null; try { childRole = descendant.ControlType; } catch (Exception error) { ProviderError(errors, "text_child_role", error); truncated = true; completeChildren = false; }
                    queue.Add(new WalkEntry { Element = descendant, Depth = entry.Depth + 1, ParentKey = entry.ParentKey, Group = entry.Group, Order = ++ordinal,
                        KnownRole = childRole, Priority = TraversalPriority(childRole), Sequence = ++sequence });
                }
                if (!completeChildren) truncated = true;
            }
            catch (Exception error) { ProviderError(errors, "text_children", error); truncated = true; }
        }
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
        // The trusted Control Center composition root may be absent from the
        // Control view even while its Raw view contains the visible buttons.
        // Existing role/password/process guards also apply to this bounded walk.
        var walker = CanInspectUiaOnlyShell(window) && window.ClassName == "ControlCenterWindow"
            ? automation.TreeWalkerFactory.GetRawViewWalker() : automation.TreeWalkerFactory.GetControlViewWalker();
        var queue = new List<WalkEntry>();
        var tabGroups = new Dictionary<string, TabGroupState>();
        var processes = new Dictionary<int, ProcessIdentityInfo>();
        processes[window.Pid] = new ProcessIdentityInfo { Pid = window.Pid, Session = window.Session, Started = window.Started, Path = window.Path, ProcessName = window.ProcessName };
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
                ProcessIdentityInfo elementProcess = null;
                try
                {
                    int elementPid = element.Properties.ProcessId.Value;
                    if (!processes.TryGetValue(elementPid, out elementProcess))
                    {
                        elementProcess = ReadProcessIdentity(elementPid);
                        if (AllowedEmbeddedProcess(window, elementProcess)) processes[elementPid] = elementProcess;
                    }
                    if (!AllowedEmbeddedProcess(window, elementProcess)) { skippedCrossProcess++; continue; }
                    role = entry.KnownRole.HasValue ? entry.KnownRole.Value : element.ControlType;
                    if (role == ControlType.Edit)
                    {
                        if (elementPid != window.Pid) { skippedCrossProcess++; continue; }
                        int inputErrors = errors.Count;
                        ObserveFocusedEdit(window, element, next, elements, errors, ref uiCount);
                        if (errors.Count > inputErrors) truncated = true;
                        continue; // Never read this Edit's Name, Value, Text or descendants.
                    }
                    if (element.Properties.IsPassword.ValueOrDefault || role == ControlType.Text) continue;
                }
                catch (Exception error) { ProviderError(errors, "sensitive_identity_guard", error); truncated = true; continue; }
                // Password/edit subtrees are omitted. A document can contain
                // accessible buttons; traverse it without reading its own text.
                int errorsBefore = errors.Count;
                string rawName = role == ControlType.Document ? "" : Optional(() => element.Name, "", "name", errors), runtime = RuntimeId(element);
                name = Text(rawName, 500);
                if (SensitiveWindow.IsMatch(name)) continue;
                string automationId = Text(Optional(() => element.Properties.AutomationId.ValueOrDefault, "", "automation_id", errors), 200);
                string className = Text(Optional(() => element.Properties.ClassName.ValueOrDefault, "", "class_name", errors), 200);
                string identity = role.ToString() + ":" + automationId;
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
                if (enabled && !offscreen && PhysicalCoordinatesAvailable() && IsObservedShellClickTarget(window, role, runtime) &&
                    Optional(() => HasClickBounds(element.BoundingRectangle), false, "click_bounds", errors))
                {
                    // Some Windows shell buttons advertise Invoke but do not
                    // open their UI through it. Offer one observed action, not
                    // competing click/invoke/toggle routes for the same button.
                    caps.Clear(); caps.Add("click");
                }
                if (role != ControlType.Document && name.Length > 0 && (caps.Count > 0 || selected.HasValue || toggled != null || expanded != null))
                {
                    string processBinding = elementProcess.Pid + ":" + elementProcess.Started + ":" + elementProcess.Path.ToLowerInvariant();
                    string id = "el_" + Hash(window.Id + ":" + processBinding + ":" + key).Substring(0, 24);
                    if (!next.ContainsKey(id))
                    {
                        object bounds = Optional<object>(() => { var rectangle = element.BoundingRectangle; return new Dictionary<string, object> { { "x", rectangle.Left }, { "y", rectangle.Top }, { "width", rectangle.Width }, { "height", rectangle.Height } }; }, null, "bounds", errors);
                        var state = new Dictionary<string, object> {
                            { "id", id }, { "windowId", window.Id }, { "label", Text((entry.Group.Length > 0 ? entry.Group + " / " : "") + name, 500) }, { "name", name }, { "role", role.ToString() },
                            { "automationId", automationId }, { "className", className },
                            { "processId", elementProcess.Pid }, { "processName", elementProcess.ProcessName },
                            { "capabilities", caps.ToArray() }, { "selected", selected }, { "toggleState", toggled }, { "expandState", expanded }, { "enabled", enabled }, { "offscreen", offscreen },
                            { "group", Text(entry.Group, 500) }, { "order", null },
                            { "tabGroupId", role == ControlType.TabItem ? "tabgrp_" + Hash(window.Id + ":" + entry.ParentKey).Substring(0, 24) : null },
                            { "bounds", bounds }
                        };
                        elements.Add(state); next[id] = new DesktopTarget { Window = window, Element = element, Capabilities = caps.ToArray(), State = state, Runtime = runtime, SemanticIdentity = identity, NameFingerprint = Hash(rawName ?? ""), ElementProcess = elementProcess }; uiCount++;
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
    private void ObserveFocusedEdit(WindowIdentity window, AutomationElement element, Dictionary<string, DesktopTarget> next, List<Dictionary<string, object>> elements, List<Dictionary<string, object>> errors, ref int count)
    {
        if (GetForegroundWindow() != window.Handle || IsTaskManagerPath(window.Path)) return;
        bool password;
        if (!element.Properties.IsPassword.TryGetValue(out password) || password || !element.Properties.HasKeyboardFocus.ValueOrDefault) return;
        string runtime = RuntimeId(element); if (runtime.Length == 0) return;
        // Names of Edit controls may contain their current value. Even the
        // focused candidate uses a fixed description rather than reading Name.
        bool supports = Optional(() => element.Patterns.Value.IsSupported, false, "value_supported", errors);
        bool? readOnly = supports ? Optional<bool?>(() => element.Patterns.Value.Pattern.IsReadOnly.Value, null, "value_readonly", errors) : null;
        bool enabled = Optional(() => element.IsEnabled, false, "input_enabled", errors), offscreen = Optional(() => element.IsOffscreen, true, "input_offscreen", errors);
        string automationId = Optional(() => element.Properties.AutomationId.ValueOrDefault, "", "input_automation_id", errors);
        string id = "el_" + Hash(window.Id + ":" + runtime).Substring(0, 24);
        string[] caps = supports && readOnly.HasValue && !readOnly.Value && enabled && !offscreen ? new[] { "replace_text" } : new string[0];
        var state = new Dictionary<string, object> {
            { "id", id }, { "windowId", window.Id }, { "label", "Focused editable field" }, { "name", "Focused editable field" }, { "role", "Edit" }, { "capabilities", caps },
            { "selected", null }, { "toggleState", null }, { "expandState", null }, { "enabled", enabled }, { "offscreen", offscreen }, { "group", "Focused input" }, { "order", null }, { "bounds", null },
            { "supportsValuePattern", supports }, { "readOnly", readOnly }, { "isPassword", false }, { "hasKeyboardFocus", true }
        };
        if (!next.ContainsKey(id))
        {
            elements.Add(state); next[id] = new DesktopTarget { Window = window, Element = element, Capabilities = caps, State = state, Runtime = runtime, IsFocusedEdit = true, SemanticIdentity = "Edit:" + Text(automationId, 200) }; count++;
        }
    }
    private static void ExactArguments(Dictionary<string, object> args, params string[] keys)
    {
        if (args == null || args.Count != keys.Length || keys.Any(key => !args.ContainsKey(key))) throw new DesktopError("INVALID_ARGUMENT", false);
    }
    private static string TextIdentifier(Dictionary<string, object> args, string key)
    {
        object value; if (!args.TryGetValue(key, out value) || !(value is string)) throw new DesktopError("INVALID_ARGUMENT", false);
        string text = (string)value; bool version = key == "expectedVersion"; if (text.Length < (version ? 16 : 1) || text.Length > 128 || !Regex.IsMatch(text, version ? "^[a-f0-9]{16,128}$" : "^[A-Za-z][A-Za-z0-9_-]{0,127}$", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase)) throw new DesktopError("INVALID_ARGUMENT", false);
        return text;
    }
    private static string TextReplacement(Dictionary<string, object> args)
    {
        object supplied; if (!args.TryGetValue("text", out supplied) || !(supplied is string)) throw new DesktopError("INVALID_TEXT_PAYLOAD", false);
        string text = (string)supplied; if (text.Length > MaxTextValue || BlockedTextPayload.IsMatch(text)) throw new DesktopError("INVALID_TEXT_PAYLOAD", false);
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i]; if (Char.IsControl(ch) && ch != '\r' && ch != '\n' && ch != '\t') throw new DesktopError("INVALID_TEXT_PAYLOAD", false);
            if (Char.IsHighSurrogate(ch)) { if (i + 1 >= text.Length || !Char.IsLowSurrogate(text[i + 1])) throw new DesktopError("INVALID_TEXT_PAYLOAD", false); i++; }
            else if (Char.IsLowSurrogate(ch)) throw new DesktopError("INVALID_TEXT_PAYLOAD", false);
        }
        return text;
    }
    private string ValidateTextTarget(TextTarget target, string expectedVersion)
    {
        if (target == null || textObservationVersion == null || textObservationWindowId == null || target.Version != expectedVersion || expectedVersion != textObservationVersion) throw new DesktopError("STALE_TEXT_SNAPSHOT", false);
        WindowIdentity window;
        try { window = Revalidate(target.Window); }
        catch (DesktopError) { throw new DesktopError("TEXT_TARGET_IDENTITY_CHANGED", false); }
        if (window.Id != textObservationWindowId || window.Started != target.ProcessStart || target.WindowFingerprint != window.Id + ":" + window.Pid + ":" + window.Started + ":" + window.Path) throw new DesktopError("TEXT_TARGET_IDENTITY_CHANGED", false);
        var element = target.Element; bool password;
        if (element == null || element.Properties.ProcessId.Value != window.Pid || element.ControlType != ControlType.Edit || !element.Properties.IsPassword.TryGetValue(out password) || password) throw new DesktopError("TEXT_TARGET_UNAVAILABLE", false);
        if (RuntimeId(element) != target.Runtime || !element.IsEnabled || element.IsOffscreen || !element.Patterns.Value.IsSupported) throw new DesktopError("TEXT_TARGET_UNAVAILABLE", false);
        bool readOnly; try { readOnly = element.Patterns.Value.Pattern.IsReadOnly.Value; } catch (Exception error) { throw new DesktopError("TEXT_TARGET_UNAVAILABLE", "validate_text", error, false); }
        if (readOnly) throw new DesktopError("TEXT_TARGET_READ_ONLY", false);
        string current = element.Patterns.Value.Pattern.Value ?? "";
        if (SecretText.IsMatch(current) || BlockedTextPayload.IsMatch(current)) throw new DesktopError("TEXT_TARGET_SENSITIVE", false);
        if (Hash(current) != target.ValueHash) throw new DesktopError("TEXT_VALUE_CHANGED", false);
        return current;
    }
    private object ReplaceText(Dictionary<string, object> args)
    {
        ExactArguments(args, "targetId", "expectedVersion", "text"); string targetId = TextIdentifier(args, "targetId"), expectedVersion = TextIdentifier(args, "expectedVersion"); string replacement = TextReplacement(args);
        TextTarget target; if (!textObserved.TryGetValue(targetId, out target)) throw new DesktopError("TEXT_TARGET_NOT_OBSERVED", false);
        try { ValidateTextTarget(target, expectedVersion); }
        catch (DesktopError) { throw; }
        catch (Exception error) { throw new DesktopError("TEXT_TARGET_UNAVAILABLE", "validate_text", error, false); }
        try { WithMutationTimeout(delegate { target.Element.Patterns.Value.Pattern.SetValue(replacement); }); }
        catch (DesktopError) { throw; }
        catch (Exception error) { throw new DesktopError("TEXT_OUTCOME_UNKNOWN", "apply_text", error, true); }
        string actual;
        try { actual = target.Element.Patterns.Value.Pattern.Value ?? ""; }
        catch (Exception error) { throw new DesktopError("TEXT_OUTCOME_UNKNOWN", "verify_text", error, true); }
        string actualHash = Hash(actual);
        if (actual != replacement) return new Dictionary<string, object> {
            { "operation", "text_replace" }, { "targetId", targetId }, { "verified", false }, { "effectAttempted", true }, { "evidence", "text_value_mismatch" },
            { "expectedVersion", expectedVersion }, { "textLength", replacement.Length }, { "valueHash", actualHash }
        };
        return new Dictionary<string, object> {
            { "operation", "text_replace" }, { "targetId", targetId }, { "verified", true }, { "effectAttempted", true }, { "evidence", "text_value_verified" },
            { "expectedVersion", expectedVersion }, { "textLength", replacement.Length }, { "valueHash", actualHash }
        };
    }
    private void ValidateFocusedEdit(DesktopTarget target)
    {
        var element = target.Element; bool password;
        if (!target.IsFocusedEdit || IsTaskManagerPath(target.Window.Path) || GetForegroundWindow() != target.Window.Handle ||
            element.Properties.ProcessId.Value != target.Window.Pid || element.ControlType != ControlType.Edit ||
            !element.Properties.IsPassword.TryGetValue(out password) || password || !element.Properties.HasKeyboardFocus.ValueOrDefault ||
            !element.IsEnabled || element.IsOffscreen) throw new DesktopError("FOCUSED_EDIT_NOT_AVAILABLE");
        var focused = automation.FocusedElement();
        if (focused == null || focused.Properties.ProcessId.Value != target.Window.Pid || RuntimeId(focused) != target.Runtime || RuntimeId(element) != target.Runtime ||
            "Edit:" + Text(element.Properties.AutomationId.ValueOrDefault, 200) != target.SemanticIdentity) throw new DesktopError("FOCUSED_EDIT_CHANGED");
        if (!element.Patterns.Value.IsSupported || element.Patterns.Value.Pattern.IsReadOnly.Value) throw new DesktopError("EDIT_NOT_WRITABLE");
    }
    private static string ReplacementText(Dictionary<string, object> args)
    {
        object supplied; if (!args.TryGetValue("text", out supplied) || !(supplied is string)) throw new DesktopError("INVALID_TEXT_PAYLOAD");
        string text = (string)supplied; if (text.Length > 4096) throw new DesktopError("INVALID_TEXT_PAYLOAD");
        for (int i = 0; i < text.Length; i++)
        {
            char ch = text[i]; if (Char.IsControl(ch) && ch != '\r' && ch != '\n' && ch != '\t') throw new DesktopError("INVALID_TEXT_PAYLOAD");
            if (Char.IsHighSurrogate(ch)) { if (i + 1 >= text.Length || !Char.IsLowSurrogate(text[i + 1])) throw new DesktopError("INVALID_TEXT_PAYLOAD"); i++; }
            else if (Char.IsLowSurrogate(ch)) throw new DesktopError("INVALID_TEXT_PAYLOAD");
        }
        return text;
    }
    private static bool SetKeyboardLanguage(WindowIdentity window, string language)
    {
        if (language != "English" && language != "Russian") throw new DesktopError("INVALID_KEYBOARD_LANGUAGE");
        if (IsTaskManagerPath(window.Path) || GetForegroundWindow() != window.Handle) throw new DesktopError("ACTIVE_WINDOW_REQUIRED");
        uint pid; uint thread = GetWindowThreadProcessId(window.Handle, out pid);
        if (thread == 0 || pid != window.Pid) throw new DesktopError("TARGET_IDENTITY_CHANGED");
        if (KeyboardLanguage(GetKeyboardLayout(thread)) == language) return false;
        var desired = InstalledLayouts().FirstOrDefault(layout => KeyboardLanguage(layout) == language);
        if (desired == IntPtr.Zero) throw new DesktopError("KEYBOARD_LANGUAGE_NOT_INSTALLED");
        IntPtr destination = window.Handle;
        var gui = new GuiThreadInfo { Size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (GetGUIThreadInfo(thread, ref gui) && gui.Focus != IntPtr.Zero)
        {
            uint focusPid; uint focusThread = GetWindowThreadProcessId(gui.Focus, out focusPid);
            if (focusPid == window.Pid && focusThread == thread && GetAncestor(gui.Focus, 2) == window.Handle) destination = gui.Focus;
        }
        if (!PostMessage(destination, 0x0050, IntPtr.Zero, desired)) throw new DesktopError("KEYBOARD_LANGUAGE_REQUEST_FAILED");
        return true;
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
        // Taskbar/Start invokes commonly create a separate hosted HWND without
        // changing the source subtree. A newly observed trusted surface is UI
        // change evidence only, never proof that the user's goal was achieved.
        if (NewShellSurfaceObserved(before, after, windowId)) return "state_changed";
        if (!CompleteSurface(before, windowId) || !CompleteSurface(after, windowId)) return "effect_outcome_unknown";
        return SurfaceState(before, windowId) != SurfaceState(after, windowId) ? "state_changed" : "invoked_without_observable_change";
    }
    private static bool NewShellSurfaceObserved(Dictionary<string, object> before, Dictionary<string, object> after, string windowId)
    {
        if (before == null || after == null) return false;
        object previousRaw, currentRaw, previousMetadataRaw, currentMetadataRaw, previousFactsRaw;
        if (!before.TryGetValue("windows", out previousRaw) || !after.TryGetValue("windows", out currentRaw) ||
            !before.TryGetValue("metadata", out previousMetadataRaw) || !after.TryGetValue("metadata", out currentMetadataRaw) || !before.TryGetValue("facts", out previousFactsRaw)) return false;
        var previous = previousRaw as List<Dictionary<string, object>>; var current = currentRaw as List<Dictionary<string, object>>;
        var previousMetadata = previousMetadataRaw as Dictionary<string, object>; var currentMetadata = currentMetadataRaw as Dictionary<string, object>;
        var previousFacts = previousFactsRaw as Dictionary<string, object>;
        if (previous == null || current == null || previousMetadata == null || currentMetadata == null ||
            previousFacts == null || Field(previousFacts, "selectedWindowId") != windowId || Field(previousFacts, "surfaceStatus") != "available" ||
            !previousMetadata.ContainsKey("inventoryTruncated") || !(previousMetadata["inventoryTruncated"] is bool) || Boolean(previousMetadata, "inventoryTruncated") ||
            !currentMetadata.ContainsKey("inventoryTruncated") || !(currentMetadata["inventoryTruncated"] is bool) || Boolean(currentMetadata, "inventoryTruncated")) return false;
        var source = previous.FirstOrDefault(x => Field(x, "id") == windowId);
        if (source == null || (!IsShellSurfaceKind(Field(source, "surfaceKind")) && Field(source, "surfaceKind") != "settings")) return false;
        // The inventories are independently complete. Optional source-control
        // provider failures need not hide the appearance of another real HWND.
        var previousIds = new HashSet<string>(previous.Select(x => Field(x, "id")), StringComparer.Ordinal);
        return current.Any(x => !previousIds.Contains(Field(x, "id")) &&
            (Field(x, "surfaceKind") == "shell_popup" || Field(x, "surfaceKind") == "start_menu" || Field(x, "surfaceKind") == "search" || Field(x, "surfaceKind") == "settings"));
    }
    private static void ValidateCurrentElement(DesktopTarget target)
    {
        var element = target.Element; var prior = target.State;
        int elementPid = element.Properties.ProcessId.Value;
        if (elementPid != (target.ElementProcess == null ? target.Window.Pid : target.ElementProcess.Pid) || element.Properties.IsPassword.ValueOrDefault || !element.IsEnabled || element.IsOffscreen) throw new DesktopError("ELEMENT_NO_LONGER_AVAILABLE");
        if (target.ElementProcess != null)
        {
            var currentProcess = ReadProcessIdentity(elementPid);
            if (!SameProcessIdentity(target.ElementProcess, currentProcess) || !AllowedEmbeddedProcess(target.Window, currentProcess)) throw new DesktopError("ELEMENT_IDENTITY_CHANGED");
        }
        string name = element.Name ?? "", currentIdentity = element.ControlType.ToString() + ":" + Text(element.Properties.AutomationId.ValueOrDefault, 200);
        string selected = element.Patterns.SelectionItem.IsSupported ? element.Patterns.SelectionItem.Pattern.IsSelected.Value.ToString() : null;
        string toggled = element.Patterns.Toggle.IsSupported ? element.Patterns.Toggle.Pattern.ToggleState.Value.ToString() : null;
        string expanded = element.Patterns.ExpandCollapse.IsSupported ? element.Patterns.ExpandCollapse.Pattern.ExpandCollapseState.Value.ToString() : null;
        if (currentIdentity != target.SemanticIdentity || Text(name, 500) != Field(prior, "name") || Hash(name) != target.NameFingerprint ||
            selected != Field(prior, "selected") || toggled != Field(prior, "toggleState") || expanded != Field(prior, "expandState") ||
            (target.Runtime.Length > 0 && RuntimeId(element) != target.Runtime)) throw new DesktopError("ELEMENT_IDENTITY_CHANGED");
    }
    private bool ClickHitMatchesTarget(DesktopTarget target, Point point)
    {
        var hit = automation.FromPoint(point); var walker = automation.TreeWalkerFactory.GetRawViewWalker();
        int expectedPid = target.ElementProcess == null ? target.Window.Pid : target.ElementProcess.Pid;
        var watch = Stopwatch.StartNew();
        for (int depth = 0; hit != null && depth <= MaxDepth && watch.ElapsedMilliseconds < 1000; depth++)
        {
            // A glyph nested inside the same button is acceptable. An overlay,
            // a sibling, or a different process is not the observed target.
            if (hit.Properties.ProcessId.Value != expectedPid || hit.Properties.IsPassword.ValueOrDefault) return false;
            if (RuntimeId(hit) == target.Runtime) return true;
            hit = walker.GetParent(hit);
        }
        return false;
    }
    private Point ResolveObservedClickPoint(DesktopTarget target)
    {
        if (!PhysicalCoordinatesAvailable()) throw new DesktopError("CLICK_DPI_CONTEXT_UNAVAILABLE", false);
        if (target.Element == null || !IsObservedShellClickTarget(target.Window, target.Element.ControlType, target.Runtime)) throw new DesktopError("CLICK_TARGET_DENIED", false);
        Revalidate(target.Window); ValidateCurrentElement(target);
        var bounds = target.Element.BoundingRectangle;
        if (!HasClickBounds(bounds)) throw new DesktopError("CLICK_POINT_UNAVAILABLE", false);
        Point point;
        if (!target.Element.TryGetClickablePoint(out point)) point = new Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
        if (!bounds.Contains(point) || !Screen.AllScreens.Any(screen => screen.Bounds.Contains(point))) throw new DesktopError("CLICK_POINT_UNAVAILABLE", false);
        // Recheck after acquiring the point, then hit-test immediately before
        // dispatch. No focus, mouse movement or input occurs in these checks.
        Revalidate(target.Window); ValidateCurrentElement(target);
        if (!target.Element.BoundingRectangle.Contains(point) || !ClickHitMatchesTarget(target, point)) throw new DesktopError("CLICK_TARGET_OBSCURED", false);
        return point;
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
    private void WithMutationTimeout(Action mutation)
    {
        var readTimeout = automation.TransactionTimeout;
        try
        {
            automation.TransactionTimeout = TimeSpan.FromMilliseconds(2000);
            mutation(); // Exactly one invocation; outcome-unknown calls are never repeated.
        }
        finally { automation.TransactionTimeout = readTimeout; }
    }
    private object Execute(Dictionary<string, object> args)
    {
        string expected = Required(args, "expectedVersion"), targetId = Required(args, "targetId"), operation = Required(args, "operation");
        if (operation == "click" && args.Keys.Any(key => key != "expectedVersion" && key != "targetId" && key != "operation" && key != "expectedWindowVersion")) throw new DesktopError("INVALID_ARGUMENT", false);
        string expectedWindow = args.ContainsKey("expectedWindowVersion") ? Required(args, "expectedWindowVersion") : null;
        Point? clickPoint = null;
        string replacement = operation == "replace_text" ? ReplacementText(args) : null;
        string keyboardLanguage = operation == "set_keyboard_language" ? Required(args, "language") : null;
        if (keyboardLanguage != null && keyboardLanguage != "English" && keyboardLanguage != "Russian") throw new DesktopError("INVALID_KEYBOARD_LANGUAGE");
        // Resolve exclusively from a new observation; never execute a stale
        // AutomationElement retained from the model's earlier observation.
        var before = Observe(null, false);
        // A changed or truncated observation can legitimately omit the old
        // target. Classify the stale full-snapshot request before looking it up,
        // so callers can re-observe after a definite pre-effect rejection.
        if (expectedWindow == null && !String.Equals(expected, (string)before["version"], StringComparison.Ordinal)) throw new DesktopError("STALE_SNAPSHOT");
        DesktopTarget target;
        if (!observed.TryGetValue(targetId, out target)) throw new DesktopError("UNKNOWN_TARGET");
        if (expectedWindow != null)
        {
            if (target.Element != null) throw new DesktopError("WINDOW_VERSION_REQUIRES_WINDOW_TARGET");
            if (!String.Equals(expectedWindow, Field(target.State, "stateVersion"), StringComparison.Ordinal)) throw new DesktopError("STALE_SNAPSHOT");
        }
        if (!target.Capabilities.Contains(operation)) throw new DesktopError("OPERATION_DENIED");
        var window = Revalidate(target.Window); var prior = target.State; bool effectAttempted = operation != "inspect";
        if (target.Element == null)
        {
            if (operation == "inspect") selectedWindowId = window.Id;
            else if (operation == "activate") { if (IsIconic(window.Handle)) ShowWindowAsync(window.Handle, 9); SetForegroundWindow(window.Handle); }
            else if (operation == "minimize") ShowWindowAsync(window.Handle, 6);
            else if (operation == "maximize") ShowWindowAsync(window.Handle, 3);
            else if (operation == "restore") ShowWindowAsync(window.Handle, 1);
            else if (operation == "close") { if (!PostMessage(window.Handle, 0x0010, IntPtr.Zero, IntPtr.Zero)) throw new DesktopError("WINDOW_CLOSE_FAILED"); }
            else if (operation == "set_keyboard_language") effectAttempted = SetKeyboardLanguage(window, keyboardLanguage);
            else throw new DesktopError("OPERATION_DENIED");
        }
        else
        {
            try
            {
                if (operation == "replace_text") ValidateFocusedEdit(target);
                else ValidateCurrentElement(target);
                if (operation == "click") clickPoint = ResolveObservedClickPoint(target);
            }
            catch (DesktopError) { throw; }
            catch (Exception error) { throw new DesktopError("UIA_REQUEST_FAILED", "validate_element", error, false); }
            try
            {
                WithMutationTimeout(delegate {
                    if (operation == "replace_text") target.Element.Patterns.Value.Pattern.SetValue(replacement);
                    else if (operation == "select") target.Element.Patterns.SelectionItem.Pattern.Select();
                    else if (operation == "invoke") target.Element.Patterns.Invoke.Pattern.Invoke();
                    else if (operation == "click") FlaUI.Core.Input.Mouse.LeftClick(clickPoint.Value);
                    else if (operation == "toggle") target.Element.Patterns.Toggle.Pattern.Toggle();
                    else if (operation == "expand") target.Element.Patterns.ExpandCollapse.Pattern.Expand();
                    else if (operation == "collapse") target.Element.Patterns.ExpandCollapse.Pattern.Collapse();
                    else throw new DesktopError("OPERATION_DENIED");
                });
            }
            catch (DesktopError) { throw; }
            catch (Exception error) { throw new DesktopError("UIA_REQUEST_FAILED", "apply_" + operation, error, true); }
        }
        Dictionary<string, object> after = null; bool verified = false, stateChanged = false; string evidence = "not_verified";
        var readbackWatch = Stopwatch.StartNew(); int readbackAttempts = 0;
        bool shellTransition = (operation == "invoke" || operation == "click") && IsShellSurfaceKind(window.SurfaceKind);
        for (int attempt = 0; attempt < (shellTransition ? 6 : 4); attempt++)
        {
            if (attempt > 0 && shellTransition && readbackWatch.ElapsedMilliseconds >= 1200) break;
            if (operation != "inspect") Thread.Sleep(attempt == 0 ? 120 : shellTransition ? (int)Math.Min(180, Math.Max(0, 1200 - readbackWatch.ElapsedMilliseconds)) : 160);
            if (attempt > 0 && shellTransition && readbackWatch.ElapsedMilliseconds >= 1200) break;
            readbackAttempts++;
            try { after = Observe(null, false); }
            catch { return new { operation = operation, targetId = targetId, before = before, after = (object)null, verified = false, stateChanged = false, effectAttempted = effectAttempted, evidence = "effect_outcome_unknown", textLength = replacement == null ? (int?)null : replacement.Length, readbackAttempts = readbackAttempts, readbackElapsedMs = readbackWatch.ElapsedMilliseconds, clickPoint = clickPoint.HasValue ? new { x = clickPoint.Value.X, y = clickPoint.Value.Y, source = "fresh_uia", hitTestVerified = true } : null }; }
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
            else if (operation == "set_keyboard_language") { verified = Field(result, "keyboardLanguage") == keyboardLanguage; evidence = verified ? "keyboard_language_verified" : "keyboard_language_not_changed"; }
            else if (operation == "replace_text") { verified = false; evidence = "text_set_unverified"; }
            else if (operation == "select") { verified = Boolean(result, "selected"); evidence = verified ? "element_selected" : "not_verified"; }
            else if (operation == "toggle") { verified = result != null && Field(result, "toggleState") != Field(prior, "toggleState"); evidence = verified ? "toggle_state_changed" : "not_verified"; }
            else if (operation == "expand" || operation == "collapse") { verified = Field(result, "expandState") == (operation == "expand" ? "Expanded" : "Collapsed"); evidence = verified ? "expansion_state_changed" : "not_verified"; }
            else if (operation == "invoke" || operation == "click") { evidence = InvokeEvidence(before, after, window.Id); stateChanged = evidence == "state_changed"; }
            // Only passive observations repeat. The input dispatch above is
            // outside this loop and is never repeated after an unknown effect.
            if (!ShouldContinueReadback(operation, window.SurfaceKind, attempt, readbackWatch.ElapsedMilliseconds, verified, stateChanged, evidence)) break;
        }
        return new { operation = operation, targetId = targetId, before = before, after = after, verified = verified, stateChanged = stateChanged, effectAttempted = effectAttempted, evidence = evidence, textLength = replacement == null ? (int?)null : replacement.Length, readbackAttempts = readbackAttempts, readbackElapsedMs = readbackWatch.ElapsedMilliseconds, clickPoint = clickPoint.HasValue ? new { x = clickPoint.Value.X, y = clickPoint.Value.Y, source = "fresh_uia", hitTestVerified = true } : null };
    }
    private object Dispatch(string method, Dictionary<string, object> args)
    {
        if (method == "volume_get" || method == "volume_set" || method == "audio_outputs_get")
        {
            if (fixturePid > 0) throw new DesktopError("SYSTEM_VOLUME_UNAVAILABLE_IN_FIXTURE");
            return SystemVolume.Execute(method, args);
        }
        if (method == "observe")
        {
            object value; bool hasWindow = args.TryGetValue("windowId", out value);
            if (hasWindow && value != null && (!(value is string) || ((string)value).Length > 100)) throw new DesktopError("INVALID_ARGUMENT");
            return Observe(value as string, hasWindow);
        }
        if (method == "text_observe") { ExactArguments(args, "windowId"); return ObserveText(TextIdentifier(args, "windowId")); }
        if (method == "text_replace") return ReplaceText(args);
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
    public void Dispose() { if (desktopAutomation != null) desktopAutomation.Dispose(); }
    [STAThread] private static int Main(string[] args)
    {
        ConfigureDpiAwareness();
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
                    catch (Exception error)
                    {
                        var typed = error as DesktopError;
                        Console.WriteLine(Json.Serialize(new { id = id, ok = false, error = new { code = typed == null ? "UIA_REQUEST_FAILED" : typed.Code, stage = typed == null ? null : typed.Stage, providerCode = typed == null ? null : typed.ProviderCode, effectAttempted = typed == null ? (bool?)null : typed.EffectAttempted } }));
                    }
                }
            }
            return 0;
        }
        catch (Exception error) { Console.WriteLine(Json.Serialize(new { id = (object)null, ok = false, error = new { code = error is DesktopError ? ((DesktopError)error).Code : "HELPER_START_FAILED" } })); return 1; }
    }
    private delegate bool EnumWindowsDelegate(IntPtr handle, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] private struct NativeRect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] private struct GuiThreadInfo { public int Size; public int Flags; public IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret; public NativeRect CaretBounds; }
    [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowsDelegate callback, IntPtr parameter);
    [DllImport("user32.dll")] private static extern bool IsWindow(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern IntPtr GetThreadDpiAwarenessContext();
    [DllImport("user32.dll")] private static extern int GetAwarenessFromDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr handle, out NativeRect bounds);
    [DllImport("user32.dll")] private static extern bool IsIconic(IntPtr handle);
    [DllImport("user32.dll")] private static extern bool IsZoomed(IntPtr handle);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr handle, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr handle, StringBuilder text, int length);
    [DllImport("dwmapi.dll")] private static extern int DwmGetWindowAttribute(IntPtr handle, int attribute, out int value, int size);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint pid);
    [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] private static extern int GetKeyboardLayoutList(int count, [Out] IntPtr[] layouts);
    [DllImport("user32.dll")] private static extern bool GetGUIThreadInfo(uint threadId, ref GuiThreadInfo info);
    [DllImport("user32.dll")] private static extern IntPtr GetAncestor(IntPtr handle, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] private static extern IntPtr GetWindowLongPtr(IntPtr handle, int index);
    [DllImport("user32.dll")] private static extern bool ShowWindowAsync(IntPtr handle, int command);
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr handle);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool PostMessage(IntPtr handle, uint message, IntPtr wParam, IntPtr lParam);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr OpenProcess(uint access, bool inheritHandle, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] private static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int size);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetProcessTimes(IntPtr process, out long created, out long exited, out long kernel, out long user);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)] private static extern bool ProcessIdToSessionId(uint processId, out uint sessionId);
    [DllImport("kernel32.dll")] private static extern bool CloseHandle(IntPtr handle);
}
