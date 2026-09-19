using System;
using System.Drawing;
using System.Windows.Forms;

// A deliberately isolated, visible target for native UI Automation tests.
// No web content, audio playback, keyboard layout changes or external effects.
internal sealed class LabTarget : Form
{
    private readonly TabControl tabs = new TabControl();
    private readonly TabControl language = new TabControl();
    private readonly Label playback = new Label();
    private readonly Label languageFact = new Label();
    private readonly Button play = new Button();
    private bool playing;

    private LabTarget()
    {
        Text = "Jeff Desktop Lab Target"; Name = "JeffDesktopLabTarget";
        AccessibleName = Text; StartPosition = FormStartPosition.CenterScreen;
        ClientSize = new Size(740, 540); MinimumSize = new Size(680, 540);
        BackColor = Color.FromArgb(246, 246, 250); Font = new Font("Segoe UI", 10);
        var surface = new Panel { Name = "LabSurface", AccessibleName = "Jeff lab actions", AccessibleRole = AccessibleRole.Grouping, Dock = DockStyle.Fill, Padding = new Padding(26) };
        Controls.Add(surface);
        var title = new Label { Text = "Jeff · native desktop lab", AutoSize = true, Location = new Point(26, 24), Font = new Font("Segoe UI", 19, FontStyle.Bold) };
        var notice = new Label { Text = "ISOLATED TEST APP — no real browser, music or OS keyboard changes", AutoSize = true, Location = new Point(28, 69), ForeColor = Color.DimGray };
        surface.Controls.Add(title); surface.Controls.Add(notice);
        tabs.Name = "ContentTabs"; tabs.AccessibleName = "Content tabs"; tabs.SetBounds(26, 110, 685, 190); tabs.Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right;
        foreach (var name in new[] { "Documentation", "VK feed", "Music", "VK video" })
        {
            var page = new TabPage(name) { Name = "Page" + name.Replace(" ", ""), AccessibleName = name, BackColor = Color.White };
            page.Controls.Add(new Label { Text = "Local fixture page: " + name + "\r\nOnly this test application's controls can be operated.", AutoSize = true, Location = new Point(18, 24) });
            tabs.TabPages.Add(page);
        }
        surface.Controls.Add(tabs);
        play.Name = "PlayMusic"; play.AccessibleName = "Play music"; play.Text = "Play music"; play.SetBounds(18, 100, 145, 36);
        play.Click += delegate { playing = !playing; RenderPlayback(); };
        playback.Name = "PlaybackState"; playback.SetBounds(190, 326, 300, 24);
        tabs.TabPages[2].Controls.Add(play); surface.Controls.Add(playback);
        var languageTitle = new Label { Text = "MOCK in-app language selector (not OS keyboard layout)", AutoSize = true, Location = new Point(26, 376) };
        surface.Controls.Add(languageTitle);
        language.Name = "MockLanguageTabs"; language.AccessibleName = "Mock in-app language"; language.SetBounds(26, 406, 280, 65);
        language.TabPages.Add(new TabPage("English") { AccessibleName = "English" });
        language.TabPages.Add(new TabPage("Russian") { AccessibleName = "Russian" });
        language.SelectedIndexChanged += delegate { RenderLanguage(); };
        languageFact.Name = "LanguageState"; languageFact.SetBounds(326, 424, 280, 25);
        surface.Controls.Add(language); surface.Controls.Add(languageFact);
        var reset = new Button { Name = "ResetLab", AccessibleName = "Reset lab", Text = "Reset lab", Location = new Point(26, 487), Size = new Size(145, 32) };
        reset.Click += delegate { tabs.SelectedIndex = 0; language.SelectedIndex = 0; playing = false; RenderPlayback(); RenderLanguage(); };
        surface.Controls.Add(reset); RenderPlayback(); RenderLanguage();
    }

    private void RenderPlayback() { playback.Text = playing ? "Playback: playing" : "Playback: stopped"; playback.AccessibleName = playback.Text; play.Text = playing ? "Pause music" : "Play music"; play.AccessibleName = play.Text; }
    private void RenderLanguage() { languageFact.Text = "Mock language: " + (language.SelectedIndex == 1 ? "Russian" : "English"); languageFact.AccessibleName = languageFact.Text; }
    [STAThread] private static void Main() { Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false); Application.Run(new LabTarget()); }
}
