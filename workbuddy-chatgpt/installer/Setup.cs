using System;
using System.IO;
using System.IO.Compression;
using System.Diagnostics;
using System.Reflection;
using System.Security.Cryptography;
using System.Windows.Forms;
using System.Drawing;
using System.Threading.Tasks;

[assembly: AssemblyTitle("WorkBuddy ChatGPT Setup")]
[assembly: AssemblyDescription("WorkBuddy ChatGPT installer")]
[assembly: AssemblyVersion("0.4.3.0")]
[assembly: AssemblyFileVersion("0.4.3.0")]
class Setup {
    const string PayloadHash = "PAYLOAD_SHA256";
    [STAThread]
    static int Main(string[] args) {
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        if (args.Length == 1 && args[0] == "--verify") {
            try { return Install(true, null); }
            catch (Exception error) { File.WriteAllText(Assembly.GetExecutingAssembly().Location + ".verification.txt", "FAILED: " + error.Message); return 1; }
        }
        if (args.Length == 1 && args[0] == "--ui-check") {
            using (var wizard = new InstallWindow()) { wizard.ExportPreviews(); }
            return 0;
        }
        if (args.Length != 0) return 1;
        Application.Run(new InstallWindow());
        return 0;
    }
    public static int Install(bool verify, Action<int, string> report) {
        string temp = Path.Combine(Path.GetTempPath(), "WorkBuddyChatGPT-Setup-" + Guid.NewGuid().ToString("N"));
        try {
            Directory.CreateDirectory(temp);
            if (report != null) report(5, "正在准备安装文件…");
            byte[] bytes;
            using (Stream input = Assembly.GetExecutingAssembly().GetManifestResourceStream("payload.zip"))
            using (MemoryStream output = new MemoryStream()) { if (input == null) throw new Exception("安装数据缺失。"); input.CopyTo(output); bytes = output.ToArray(); }
            string digest;
            using (SHA256 sha = SHA256.Create()) digest = BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
            if (digest != PayloadHash) throw new Exception("安装数据校验失败，请重新获取安装器。");
            using (var memory = new MemoryStream(bytes))
            using (var archive = new ZipArchive(memory, ZipArchiveMode.Read)) {
                string prefix = Path.GetFullPath(temp) + Path.DirectorySeparatorChar;
                int extracted = 0;
                foreach (ZipArchiveEntry entry in archive.Entries) {
                    if (report != null) report(5 + 20 * extracted++ / Math.Max(1, archive.Entries.Count), "正在解包组件…");
                    string target = Path.GetFullPath(Path.Combine(temp, entry.FullName.Replace('/', Path.DirectorySeparatorChar)));
                    if (!target.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) throw new Exception("安装包路径校验失败。");
                    if (entry.Name.Length == 0) { Directory.CreateDirectory(target); continue; }
                    Directory.CreateDirectory(Path.GetDirectoryName(target));
                    using (Stream source = entry.Open()) using (Stream file = File.Create(target)) source.CopyTo(file);
                }
            }
            string root = Path.Combine(temp, "WorkBuddy-ChatGPT-0.4.3-preview");
            foreach (string file in new [] { "node.exe", "service.js", "install.ps1", "installer-entry.ps1", "uninstall.ps1", "node_modules/undici/package.json" }) if (!File.Exists(Path.Combine(root, file))) throw new Exception("安装数据不完整：" + file);
            if (verify) {
                var check = new ProcessStartInfo(Path.Combine(root, "node.exe"), "--version") { UseShellExecute = false, CreateNoWindow = true, RedirectStandardOutput = true, RedirectStandardError = true };
                string version;
                using (Process process = Process.Start(check)) { version = process.StandardOutput.ReadToEnd().Trim(); if (!process.WaitForExit(15000)) { process.Kill(); throw new Exception("运行时验证超时。"); } if (process.ExitCode != 0) throw new Exception("运行时验证失败。"); }
                File.WriteAllText(Assembly.GetExecutingAssembly().Location + ".verification.txt", "Payload SHA256: " + digest + "\r\nSafe extraction: passed\r\nBundled Node: " + version + "\r\nInstalled application modified: false\r\n");
                return 0;
            }
            if (report != null) report(25, "请允许管理员权限请求…");
            string statusFile = Path.Combine(temp, "progress.txt");
            string powershell = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.System), "WindowsPowerShell/v1.0/powershell.exe");
            var start = new ProcessStartInfo(powershell, "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(root, "installer-entry.ps1") + "\" -StatusFile \"" + statusFile + "\"") { UseShellExecute = true, Verb = "runas", WindowStyle = ProcessWindowStyle.Hidden, WorkingDirectory = root };
            string lastStatus = "";
            using (Process process = Process.Start(start)) {
                while (!process.WaitForExit(150)) {
                    try {
                        string current = File.Exists(statusFile) ? File.ReadAllText(statusFile) : "";
                        if (current != lastStatus && current.Contains("|")) {
                            int split = current.IndexOf('|'), percent;
                            if (Int32.TryParse(current.Substring(0, split), out percent) && percent >= 0 && report != null) report(percent, current.Substring(split + 1));
                            lastStatus = current;
                        }
                    } catch (IOException) { }
                }
                if (process.ExitCode != 0) {
                    string detail = File.Exists(statusFile) ? File.ReadAllText(statusFile) : "";
                    throw new Exception(detail.StartsWith("-1|") ? detail.Substring(3) : "安装未完成，请重试。");
                }
            }
            if (report != null) report(100, "安装完成");
            return 0;
        } finally {
            string resolved = Path.GetFullPath(temp);
            if (Directory.Exists(resolved) && String.Equals(Path.GetDirectoryName(resolved).TrimEnd('\\'), Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) && Path.GetFileName(resolved).StartsWith("WorkBuddyChatGPT-Setup-")) {
                try { Directory.Delete(resolved, true); } catch { }
            }
        }
    }
}

class InstallWindow : Form {
    Label heading, description, status, hint, step;
    ProgressBar progress;
    Button action;
    bool busy, finished;
    public InstallWindow() {
        Text = "安装 WorkBuddy ChatGPT";
        Font = new Font("Microsoft YaHei UI", 9F);
        ClientSize = new Size(560, 370);
        BackColor = Color.White;
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedSingle;
        MaximizeBox = false;
        heading = LabelAt("WorkBuddy ChatGPT", 32, 30, 496, 44, 22F, Color.FromArgb(25, 32, 46));
        description = LabelAt("在 WorkBuddy 中登录并使用 ChatGPT 模型。", 34, 85, 490, 30, 10F, Color.FromArgb(96, 106, 123));
        step = LabelAt("准备安装", 34, 143, 490, 26, 10F, Color.FromArgb(25, 32, 46));
        progress = new ProgressBar { Location = new Point(34, 183), Size = new Size(490, 8), Style = ProgressBarStyle.Continuous };
        Controls.Add(progress);
        status = LabelAt("请先退出 WorkBuddy，安装将保留登录和模型设置。", 34, 208, 490, 54, 9F, Color.FromArgb(96, 106, 123));
        hint = LabelAt("安装会备份并修改 WorkBuddy 文件，影响原厂签名校验。", 34, 303, 330, 42, 8F, Color.FromArgb(120, 128, 142));
        action = new Button { Text = "安装", Location = new Point(414, 300), Size = new Size(110, 38), FlatStyle = FlatStyle.Flat, BackColor = Color.FromArgb(42, 103, 229), ForeColor = Color.White, Cursor = Cursors.Hand };
        action.FlatAppearance.BorderSize = 0;
        action.Click += delegate { if (finished) Close(); else StartInstall(); };
        Controls.Add(action);
        AcceptButton = action;
        FormClosing += delegate(object sender, FormClosingEventArgs e) { if (busy) e.Cancel = true; };
    }
    Label LabelAt(string text, int x, int y, int width, int height, float size, Color color) {
        var label = new Label { Text = text, Location = new Point(x, y), Size = new Size(width, height), Font = new Font("Microsoft YaHei UI", size), ForeColor = color };
        Controls.Add(label); return label;
    }
    void SetProgress(int value, string message) {
        if (IsDisposed) return;
        if (InvokeRequired) { BeginInvoke(new Action<int,string>(SetProgress), value, message); return; }
        progress.Value = Math.Min(100, Math.Max(0, value));
        step.Text = value >= 100 ? "安装完成" : "正在安装  " + value + "%";
        status.Text = message;
    }
    void StartInstall() {
        busy = true; action.Enabled = false; action.Text = "安装中";
        hint.Text = "安装期间请保持此窗口打开。";
        Task.Factory.StartNew(delegate {
            try { Setup.Install(false, SetProgress); BeginInvoke(new Action(Complete)); }
            catch (Exception error) { BeginInvoke(new Action<string>(Failed), error is System.ComponentModel.Win32Exception && ((System.ComponentModel.Win32Exception)error).NativeErrorCode == 1223 ? "已取消权限请求，可点击重试。" : error.Message); }
        });
    }
    void Complete() {
        busy = false; finished = true; action.Enabled = true; action.Text = "完成";
        SetProgress(100, "打开 WorkBuddy → 设置 → 模型 → 登录ChatGPT。");
        hint.Text = "登录状态和模型设置已保留。";
    }
    void Failed(string message) {
        busy = false; action.Enabled = true; action.Text = "重试";
        step.Text = "暂时无法安装"; status.Text = message.Length > 160 ? "安装未完成，请检查 WorkBuddy 版本及安装权限。" : message;
        hint.Text = "处理提示的问题后，再点击重试。";
    }
    public void ExportPreviews() {
        ShowInTaskbar = false;
        StartPosition = FormStartPosition.Manual;
        Location = new Point(-2000, -2000);
        Show();
        Application.DoEvents();
        string prefix = Assembly.GetExecutingAssembly().Location;
        SavePreview(prefix + ".welcome.png");
        action.Text = "安装中"; action.Enabled = false; hint.Text = "安装期间请保持此窗口打开。";
        SetProgress(60, "正在安装登录入口…"); SavePreview(prefix + ".progress.png");
        Complete(); SavePreview(prefix + ".complete.png");
        finished = false; Failed("请先退出 WorkBuddy，再点击重试。"); SavePreview(prefix + ".error.png");
    }
    void SavePreview(string file) { Refresh(); Application.DoEvents(); using (var bitmap = new Bitmap(Width, Height)) { DrawToBitmap(bitmap, new Rectangle(0, 0, Width, Height)); bitmap.Save(file, System.Drawing.Imaging.ImageFormat.Png); } }
}
