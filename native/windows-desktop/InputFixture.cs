using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

// Disposable, synthetic-only input fixture. The test channel is intentionally
// separate from UI Automation: it can verify writes without making the product
// backend read or report field contents. Nothing outside this process is read.
internal sealed class InputFixture : Form
{
    private readonly TextBox normal = new TextBox();
    private readonly TextBox password = new TextBox();
    private readonly TextBox readOnly = new TextBox();
    private readonly Button neutral = new Button();
    private readonly JavaScriptSerializer json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    private IntPtr originalLayout;
    private bool closing;

    private InputFixture()
    {
        Text = "Jeff Native Input Fixture"; Name = "JeffNativeInputFixture";
        AccessibleName = Text; StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(630, 315); Font = new Font("Segoe UI", 10);
        AddField(normal, "Writable synthetic field", "PRIVATE_FIELD_NAME_NORMAL", "INITIAL_NORMAL_SENTINEL_92a6", 30);
        normal.Multiline = true;
        AddField(password, "Protected synthetic field", "PRIVATE_FIELD_NAME_PASSWORD", "INITIAL_PASSWORD_SENTINEL_1b3d", 100);
        password.UseSystemPasswordChar = true;
        AddField(readOnly, "Read-only synthetic field", "PRIVATE_FIELD_NAME_READONLY", "INITIAL_READONLY_SENTINEL_6f5a", 170);
        readOnly.ReadOnly = true;
        neutral.Text = "Neutral focus"; neutral.Name = "NeutralFocus"; neutral.AccessibleName = "Neutral focus";
        neutral.SetBounds(25, 252, 150, 32); Controls.Add(neutral);
        Shown += delegate {
            originalLayout = GetKeyboardLayout(GetCurrentThreadId());
            normal.Focus();
            var reader = new Thread(ReadCommands) { IsBackground = true, Name = "Fixture command channel" };
            reader.Start();
        };
        FormClosing += delegate { closing = true; RestoreLayout(); };
    }

    private void AddField(TextBox field, string caption, string privateName, string initialText, int top)
    {
        Controls.Add(new Label { Text = caption, AutoSize = true, Location = new Point(25, top - 10) });
        field.Name = privateName; field.AccessibleName = privateName; field.Text = initialText;
        field.SetBounds(25, top + 14, 575, 28); Controls.Add(field);
    }

    private static string LayoutId(IntPtr layout) { return "0x" + unchecked((ulong)layout.ToInt64()).ToString("x16"); }
    private object State()
    {
        return new {
            normalText = normal.Text, passwordText = password.Text, readOnlyText = readOnly.Text,
            focusedField = normal.Focused ? "normal" : password.Focused ? "password" : readOnly.Focused ? "readonly" : neutral.Focused ? "none" : "unknown",
            foreground = GetForegroundWindow() == Handle,
            keyboardLayoutId = LayoutId(GetKeyboardLayout(GetCurrentThreadId())), originalKeyboardLayoutId = LayoutId(originalLayout)
        };
    }
    private void RestoreLayout() { if (originalLayout != IntPtr.Zero) ActivateKeyboardLayout(originalLayout, 0); }
    private object Dispatch(string method, Dictionary<string, object> args)
    {
        if (method == "status") return State();
        if (method == "focus")
        {
            object requested; string field = args.TryGetValue("field", out requested) ? requested as string : null;
            Control target = field == "normal" ? normal : field == "password" ? password : field == "readonly" ? readOnly : field == "none" ? (Control)neutral : null;
            if (target == null) throw new InvalidOperationException("INVALID_FIELD");
            Activate(); SetForegroundWindow(Handle); target.Focus();
            return State();
        }
        if (method == "restore_layout") { RestoreLayout(); return State(); }
        if (method == "close") { BeginInvoke(new Action(Close)); return new { closing = true }; }
        throw new InvalidOperationException("UNKNOWN_FIXTURE_METHOD");
    }
    private void ReadCommands()
    {
        string line;
        while (!closing && (line = Console.ReadLine()) != null)
        {
            object id = null;
            try
            {
                if (line.Length > 65536) throw new InvalidOperationException("REQUEST_TOO_LARGE");
                var request = json.Deserialize<Dictionary<string, object>>(line);
                if (request == null) throw new InvalidOperationException("INVALID_FIXTURE_REQUEST");
                request.TryGetValue("id", out id);
                object methodValue, argsValue;
                if (!request.TryGetValue("method", out methodValue) || !(methodValue is string)) throw new InvalidOperationException("INVALID_FIXTURE_REQUEST");
                var args = request.TryGetValue("args", out argsValue) ? argsValue as Dictionary<string, object> : new Dictionary<string, object>();
                if (args == null) throw new InvalidOperationException("INVALID_FIXTURE_REQUEST");
                object result = Invoke(new Func<object>(() => Dispatch((string)methodValue, args)));
                Console.WriteLine(json.Serialize(new { id = id, ok = true, result = result }));
            }
            catch { Console.WriteLine(json.Serialize(new { id = id, ok = false, error = new { code = "FIXTURE_REQUEST_FAILED" } })); }
        }
        if (!closing && IsHandleCreated) BeginInvoke(new Action(Close));
    }
    [STAThread] private static void Main()
    {
        // A windowed executable has no console code page. Use its redirected
        // pipe handles directly, so tests do not create a competing console.
        Console.SetIn(new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false)));
        Console.SetOut(new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true });
        Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new InputFixture());
    }
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern IntPtr GetKeyboardLayout(uint threadId);
    [DllImport("user32.dll")] private static extern IntPtr ActivateKeyboardLayout(IntPtr layout, uint flags);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr window);
}
