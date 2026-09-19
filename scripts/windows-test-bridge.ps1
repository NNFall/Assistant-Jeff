# Narrow integration-test executor. No generated commands, arbitrary paths or clicks.
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

public class JeffTestWindow {
    public string handle;
    public int pid;
    public string started;
    public string appId;
    public string appName;
    public bool minimized;
}
public static class JeffWindowTest {
    delegate bool EnumProc(IntPtr hwnd, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr data);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool ShowWindowAsync(IntPtr hwnd, int cmd);
    [DllImport("user32.dll", SetLastError=true)] static extern bool PostMessage(IntPtr hwnd, uint msg, IntPtr wparam, IntPtr lparam);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd, uint cmd);

    static JeffTestWindow Describe(IntPtr hwnd) {
        if (!IsWindow(hwnd) || !IsWindowVisible(hwnd) || GetWindow(hwnd, 4) != IntPtr.Zero) return null;
        uint pid; GetWindowThreadProcessId(hwnd, out pid);
        try {
            using (Process p = Process.GetProcessById((int)pid)) {
                string app = p.ProcessName.ToLowerInvariant();
                if (app != "chrome" && app != "happ") return null;
                string expected = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles),
                    app == "chrome" ? @"Google\Chrome\Application\chrome.exe" : @"FlyFrogLLC\Happ\Happ.exe");
                if (!String.Equals(p.MainModule.FileName, expected, StringComparison.OrdinalIgnoreCase)) return null;
                return new JeffTestWindow { handle=hwnd.ToInt64().ToString(), pid=(int)pid,
                    started=p.StartTime.ToUniversalTime().Ticks.ToString(), appId=app,
                    appName=app == "chrome" ? "Google Chrome" : "HAPP", minimized=IsIconic(hwnd) };
            }
        } catch { return null; }
    }
    public static JeffTestWindow[] Snapshot() {
        var windows = new List<JeffTestWindow>();
        EnumWindows((h,d) => { var w=Describe(h); if (w != null) windows.Add(w); return true; }, IntPtr.Zero);
        return windows.ToArray();
    }
    public static string Apply(string op, string handle, int pid, string started) {
        long value; if (!Int64.TryParse(handle, out value)) throw new Exception("INVALID_HANDLE");
        IntPtr hwnd = new IntPtr(value);
        var before = Describe(hwnd);
        if (before == null || before.pid != pid || before.started != started) throw new Exception("STALE_WINDOW");
        // This experiment is authorized only to minimize Chrome and close the HAPP window.
        if (!((op == "minimize" && before.appId == "chrome") || (op == "close" && before.appId == "happ")))
            throw new Exception("ACTION_NOT_AUTHORIZED");
        if (op == "minimize" && before.minimized) return "already_minimized";
        bool sent = op == "minimize" ? ShowWindowAsync(hwnd, 6) : PostMessage(hwnd, 0x0010, IntPtr.Zero, IntPtr.Zero);
        if (!sent) throw new Exception("WINDOW_ACTION_REJECTED");
        var timer=Stopwatch.StartNew();
        while (timer.ElapsedMilliseconds < 3000) {
            if (op == "minimize" && IsWindow(hwnd) && IsIconic(hwnd)) return "minimized";
            if (op == "close" && (!IsWindow(hwnd) || !IsWindowVisible(hwnd))) {
                try { using (var p=Process.GetProcessById(pid)) {
                    if (p.StartTime.ToUniversalTime().Ticks.ToString() == started && !p.HasExited)
                        return "window_closed_process_running";
                } } catch { }
                return "process_exited";
            }
            Thread.Sleep(40);
        }
        return "not_verified";
    }
}
'@
[Console]::Out.WriteLine('{"ready":true}')
while ($null -ne ($line = [Console]::In.ReadLine())) {
    $requestId = $null
    try {
        $request = $line | ConvertFrom-Json
        $requestId = $request.id
        if ($request.operation -eq 'quit') { break }
        $timer = [Diagnostics.Stopwatch]::StartNew()
        if ($request.operation -eq 'snapshot') {
            $result = @{windows=@([JeffWindowTest]::Snapshot())}
        } elseif ($request.operation -eq 'minimize' -or $request.operation -eq 'close') {
            $outcome = [JeffWindowTest]::Apply($request.operation, [string]$request.target.handle, [int]$request.target.pid, [string]$request.target.started)
            $result = @{outcome=$outcome; windows=@([JeffWindowTest]::Snapshot())}
        } else { throw 'UNSUPPORTED_OPERATION' }
        $timer.Stop()
        @{id=$requestId; ok=$true; nativeMs=$timer.ElapsedMilliseconds; result=$result} | ConvertTo-Json -Depth 6 -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
    } catch {
        # Do not echo arbitrary input, process paths or exception details.
        @{id=$requestId; ok=$false; error='WINDOW_TEST_FAILED'} | ConvertTo-Json -Compress | ForEach-Object { [Console]::Out.WriteLine($_) }
    }
}
