// EnclaveSetup.cs -- set this PC up as an Enclave host (docs/design/windows-host-installer.md).
//
// Compiled TOGETHER with windows/tray/EnclaveTray.cs (build-setup.cmd, /main:Enclave.Setup.SetupProgram), so it is the
// tray's own theme, buttons, masthead and dialogs. C# 5, the in-box compiler, ASCII source, like the tray.
//
//   1. welcome
//   2. download the host bundle from get.enclave.host (latest.json names it and its sha256), check it, expand it
//   3. check this PC (install-host.ps1 -CheckOnly); if Hyper-V must be turned on, it is, and setup resumes after the
//      restart by itself (HKLM RunOnce)
//   4. the owner picks the host's NAME, checked live against the relay (GET /v1/hosts/name/<name>)
//   5. install (install-host.ps1 -Name, its JSON lines shown step by step)
//   6. done: open Enclave Hosting (the tray) to set the payout wallet
// It runs as administrator (requireAdministrator in its manifest): it turns on Hyper-V, installs services and writes to
// Program Files.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Win32;
using Enclave.Tray;

namespace Enclave.Setup
{
    static class SetupProgram
    {
        [System.Runtime.InteropServices.DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            try { SetProcessDPIAware(); } catch { }
            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);
            string resumeName = null;
            for (int i = 0; i < args.Length; i++) if (args[i] == "--resume" && i + 1 < args.Length) resumeName = args[i + 1];
            Application.Run(new SetupForm(resumeName));
            return 0;
        }
    }

    sealed class SetupForm : Form
    {
        const string Downloads = "https://get.enclave.host/windows/";
        const string Relay = "https://api.enclave.host";
        static readonly string WorkDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData), "Enclave-setup");
        static readonly int Wide = Theme.Px(460);

        // .NET Framework's default may still be TLS 1.0; get.enclave.host and the relay need 1.2. 1.3 only where this
        // framework knows it (setting an unknown protocol throws). Static: however the window is made, HTTPS works.
        static SetupForm()
        {
            ServicePointManager.SecurityProtocol = SecurityProtocolType.Tls12;
            try { ServicePointManager.SecurityProtocol |= (SecurityProtocolType)12288; } catch (NotSupportedException) { }
        }

        readonly Label heading = new Label(), body = new Label(), status = new Label(), nameNote = new Label();
        readonly TextBox nameBox = new TextBox();
        readonly FlowLayoutPanel steps = new FlowLayoutPanel(), nameRow = new FlowLayoutPanel();
        readonly ThemeButton primary = new ThemeButton("Start", true), secondary = new ThemeButton("Cancel", false);
        readonly System.Windows.Forms.Timer nameTimer = new System.Windows.Forms.Timer { Interval = 450 };
        readonly SynchronizationContext ui;
        readonly Dictionary<string, Label> stepRows = new Dictionary<string, Label>();
        string bundleDir, version, name, resumeName;
        bool nameOk, busy;
        Action onPrimary;

        public SetupForm(string resumeName)
        {
            this.resumeName = resumeName;
            Text = "Enclave setup";
            FormBorderStyle = FormBorderStyle.FixedSingle; MaximizeBox = false; StartPosition = FormStartPosition.CenterScreen;
            AutoScaleMode = AutoScaleMode.None; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            try { Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true,
                                             AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(Theme.Px(20)), BackColor = Theme.Bg };
            var mast = new Masthead("setup"); mast.Width = Wide; flow.Controls.Add(mast);
            flow.Controls.Add(new Panel { Size = new Size(Wide, 1), BackColor = Theme.Line, Margin = new Padding(3, Theme.Px(8), 3, Theme.Px(10)) });
            heading.AutoSize = true; heading.MaximumSize = new Size(Wide, 0); heading.Font = Theme.Mono(13f, FontStyle.Bold); heading.ForeColor = Theme.Text;
            body.AutoSize = true; body.MaximumSize = new Size(Wide, 0); body.ForeColor = Theme.Muted; body.Margin = new Padding(3, Theme.Px(8), 3, Theme.Px(6));
            flow.Controls.Add(heading); flow.Controls.Add(body);
            // the name row
            nameRow.FlowDirection = FlowDirection.TopDown; nameRow.AutoSize = true; nameRow.WrapContents = false; nameRow.BackColor = Theme.Bg;
            nameBox.Width = Theme.Px(300); nameBox.Font = Theme.Mono(11f, FontStyle.Regular); nameBox.BackColor = Theme.Surface2;
            nameBox.ForeColor = Theme.Text; nameBox.BorderStyle = BorderStyle.FixedSingle; nameBox.MaxLength = 32;
            nameBox.CharacterCasing = CharacterCasing.Lower; nameBox.Margin = new Padding(3, Theme.Px(6), 3, 0);
            nameNote.AutoSize = true; nameNote.MaximumSize = new Size(Wide, 0); nameNote.Font = Theme.Mono(8.5f, FontStyle.Regular);
            nameNote.Margin = new Padding(3, Theme.Px(6), 3, 0);
            nameRow.Controls.Add(nameBox); nameRow.Controls.Add(nameNote); nameRow.Visible = false;
            flow.Controls.Add(nameRow);
            // the steps
            steps.FlowDirection = FlowDirection.TopDown; steps.AutoSize = true; steps.WrapContents = false; steps.BackColor = Theme.Bg;
            steps.Margin = new Padding(3, Theme.Px(6), 3, 0); steps.MinimumSize = new Size(Wide, 0);
            flow.Controls.Add(steps);
            status.AutoSize = true; status.MaximumSize = new Size(Wide, 0); status.Font = Theme.Mono(8.5f, FontStyle.Regular);
            status.ForeColor = Theme.Dim; status.Margin = new Padding(3, Theme.Px(10), 3, 0);
            flow.Controls.Add(status);
            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, WrapContents = false, AutoSize = true, BackColor = Theme.Bg,
                                                MinimumSize = new Size(Wide, 0), Margin = new Padding(3, Theme.Px(18), 3, 0) };
            buttons.Controls.Add(primary); buttons.Controls.Add(secondary);
            flow.Controls.Add(buttons);
            Controls.Add(flow);
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            primary.Click += delegate { if (!busy && primary.Enabled && onPrimary != null) onPrimary(); };
            secondary.Click += delegate { if (!busy) Close(); };
            nameBox.TextChanged += delegate { nameOk = false; primary.Enabled = false; nameNote.ForeColor = Theme.Dim; nameNote.Text = "checking…"; nameTimer.Stop(); nameTimer.Start(); };
            nameTimer.Tick += delegate { nameTimer.Stop(); CheckName(nameBox.Text.Trim()); };
            if (resumeName != null) { name = resumeName; ResumeAfterRestart(); } else Welcome();
        }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Theme.DarkFrame(Handle); }

        void Page(string h, string b, string primaryText, Action next)
        {
            heading.Text = h; body.Text = b; primary.Text = primaryText; primary.FitText(); primary.Enabled = next != null; onPrimary = next;
        }
        void Post(Action a) { ui.Post(delegate { a(); }, null); }
        void Work(Action job) { busy = true; primary.Enabled = false; ThreadPool.QueueUserWorkItem(delegate { job(); }); }

        Label Step(string key, string text)
        {
            Label l;
            if (!stepRows.TryGetValue(key, out l))
            {
                l = new Label { AutoSize = true, MaximumSize = new Size(Wide, 0), Font = Theme.Mono(9f, FontStyle.Regular), Margin = new Padding(3, Theme.Px(3), 3, 0) };
                stepRows[key] = l; steps.Controls.Add(l);
            }
            l.Text = text;
            return l;
        }
        void StepState(string key, string state, string message)
        {
            string glyph = state == "ok" ? "✓" : state == "fail" ? "✗" : state == "warn" ? "!" : state == "reboot" ? "↻" : "…";
            var l = Step(key, glyph + "  " + message);
            l.ForeColor = state == "ok" ? Theme.Jade : state == "fail" ? Theme.Danger : state == "warn" || state == "reboot" ? Theme.Amber : Theme.Text;
        }

        // ---- 1. welcome ---------------------------------------------------------------------------------------------
        void Welcome()
        {
            Page("Host apps on this PC, and earn USDC.",
                 "Setup downloads Enclave (about 160 MB), checks that this PC can host (Windows 11 Pro, Secure Boot, an AMD processor's TPM, "
                 + "Hyper-V), and installs it. Apps run each in their own Enclave Shield partition. Joining the network costs you nothing: "
                 + "the first registration is paid for you once this PC proves its hardware.", "Start", Download);
        }

        // ---- 2. download ----------------------------------------------------------------------------------------------
        void Download()
        {
            Page("Downloading Enclave", "", "Next", null);
            StepState("download", "run", "asking get.enclave.host for the latest version");
            Work(delegate
            {
                try
                {
                    Directory.CreateDirectory(WorkDir);
                    var latest = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(new WebClient().DownloadString(Downloads + "latest.json"));
                    version = (string)latest["version"];
                    string file = (string)latest["file"], sha = ((string)latest["sha256"]).ToLowerInvariant();
                    string zip = Path.Combine(WorkDir, file);
                    if (!File.Exists(zip) || Sha256(zip) != sha)
                    {
                        var req = (HttpWebRequest)WebRequest.Create(Downloads + file);
                        using (var resp = req.GetResponse())
                        using (var src = resp.GetResponseStream())
                        using (var dst = File.Create(zip))
                        {
                            long total = resp.ContentLength, got = 0; var buf = new byte[1 << 16]; int n; int lastPct = -1;
                            while ((n = src.Read(buf, 0, buf.Length)) > 0)
                            {
                                dst.Write(buf, 0, n); got += n;
                                int pct = total > 0 ? (int)(got * 100 / total) : 0;
                                if (pct != lastPct) { lastPct = pct; long g2 = got; Post(delegate { StepState("download", "run", "downloading Enclave " + version + ": " + pct + "% (" + (g2 >> 20) + " MB)"); }); }
                            }
                        }
                    }
                    string got2 = Sha256(zip);
                    if (got2 != sha) throw new Exception("the download hashes " + got2.Substring(0, 16) + ", not the published " + sha.Substring(0, 16) + ": not installing it");
                    bundleDir = Path.Combine(WorkDir, version);
                    if (Directory.Exists(bundleDir)) Directory.Delete(bundleDir, true);
                    ZipFile.ExtractToDirectory(zip, bundleDir);
                    Post(delegate { busy = false; StepState("download", "ok", "Enclave " + version + " downloaded and checked (sha256 " + sha.Substring(0, 12) + "…)"); Check(); });
                }
                catch (Exception e) { Post(delegate { busy = false; StepState("download", "fail", "download failed: " + e.Message); Page("The download did not work", "Check the internet connection and try again.", "Try again", Download); }); }
            });
        }

        // ---- 3. checks (and Hyper-V) ------------------------------------------------------------------------------------
        void Check()
        {
            Page("Checking this PC", "", "Next", null);
            RunScript("-CheckOnly", delegate (int code)
            {
                if (code == 0) ChooseName();
                else if (code == 3010) NeedsRestart();
                else Page("This PC cannot host yet", "Fix what is marked above, then run setup again.", "Check again", Check);
            });
        }

        void NeedsRestart()
        {
            Page("Restart to finish turning on Hyper-V",
                 "Windows needs a restart for Hyper-V. Setup starts again by itself after you sign in.", "Restart now", delegate
            {
                string self = Path.Combine(WorkDir, "EnclaveSetup.exe");
                try { File.Copy(Application.ExecutablePath, self, true); } catch { }
                using (var k = Registry.LocalMachine.CreateSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\RunOnce"))
                    k.SetValue("EnclaveSetup", "\"" + self + "\" --resume " + (name ?? "-"));
                Process.Start(new ProcessStartInfo("shutdown.exe", "/r /t 5 /c \"Enclave setup: restarting to turn on Hyper-V\"") { CreateNoWindow = true, UseShellExecute = false });
                Close();
            });
        }

        void ResumeAfterRestart()
        {
            if (name == "-") name = null;
            StepState("resume", "ok", "Hyper-V is on: continuing setup");
            Download();
        }

        // ---- 4. the name ----------------------------------------------------------------------------------------------
        void ChooseName()
        {
            Page("Name this host",
                 "This is how the network knows this PC: 3 to 32 lowercase letters, digits and hyphens. You cannot change it later "
                 + "without setting the host up again.", "Install", delegate { name = nameBox.Text.Trim(); nameRow.Visible = false; Install(); });
            nameRow.Visible = true; primary.Enabled = false;
            if (name != null) nameBox.Text = name; else { nameBox.Text = Environment.MachineName.ToLowerInvariant().Replace('_', '-'); }
            nameBox.Focus(); nameBox.SelectAll();
        }

        void CheckName(string candidate)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                string reason = null; bool ok = false;
                try
                {
                    var j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(
                        new WebClient().DownloadString(Relay + "/v1/hosts/name/" + Uri.EscapeDataString(candidate)));
                    object a, r; ok = j.TryGetValue("available", out a) && a is bool && (bool)a;
                    reason = j.TryGetValue("reason", out r) ? r as string : null;
                }
                catch (Exception e) { reason = "could not check the name: " + e.Message; }
                Post(delegate
                {
                    if (nameBox.Text.Trim() != candidate) return;           // the owner typed on
                    nameOk = ok; primary.Enabled = ok;
                    nameNote.ForeColor = ok ? Theme.Jade : Theme.Amber;
                    nameNote.Text = ok ? "✓ '" + candidate + "' is available" : (reason ?? "not available");
                });
            });
        }

        // ---- 5. install -------------------------------------------------------------------------------------------------
        void Install()
        {
            Page("Installing '" + name + "'", "This takes a few minutes. Keep this PC on.", "Next", null);
            string owner = Environment.UserDomainName + "\\" + Environment.UserName;
            RunScript("-Name " + name + " -Owner \"" + owner + "\"", delegate (int code)
            {
                if (code == 0) Done();
                else if (code == 3010) NeedsRestart();
                else Page("Setup did not finish", "See the step marked above. Run setup again after fixing it: it carries on where it stopped.", "Try again", Install);
            });
        }

        void Done()
        {
            Page("'" + name + "' is an Enclave host",
                 "It starts with Windows and takes work from the network. Open Enclave Hosting to choose the wallet your earnings are paid to, "
                 + "and how much of this PC to offer.", "Open Enclave Hosting", delegate
            {
                string tray = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), @"Enclave\Tray\EnclaveTray.exe");
                try { Process.Start(tray); } catch { }
                Close();
            });
            secondary.Text = "Close"; secondary.FitText();
        }

        /// <summary>Run install-host.ps1 from the bundle with these arguments, showing its JSON lines as steps.</summary>
        void RunScript(string args, Action<int> done)
        {
            Work(delegate
            {
                int code = 1;
                try
                {
                    var psi = new ProcessStartInfo("powershell.exe",
                        "-NoProfile -ExecutionPolicy Bypass -File \"" + Path.Combine(bundleDir, "install-host.ps1") + "\" " + args)
                    { UseShellExecute = false, RedirectStandardOutput = true, RedirectStandardError = true, CreateNoWindow = true };
                    using (var p = Process.Start(psi))
                    {
                        var err = new StringBuilder();
                        p.ErrorDataReceived += (s, e) => { if (e.Data != null) err.AppendLine(e.Data); };
                        p.BeginErrorReadLine();
                        string line;
                        while ((line = p.StandardOutput.ReadLine()) != null)
                        {
                            Dictionary<string, object> j = null;
                            try { j = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line); } catch { }
                            if (j == null || !j.ContainsKey("step")) continue;
                            string step = (string)j["step"], state = (string)j["state"], msg = (string)j["message"];
                            Post(delegate { StepState(step, state, msg); });
                        }
                        p.WaitForExit(); code = p.ExitCode;
                        if (code != 0 && code != 3010 && err.Length > 0) { string e2 = err.ToString(); Post(delegate { status.Text = e2.Length > 600 ? e2.Substring(0, 600) : e2; }); }
                    }
                }
                catch (Exception e) { string m = e.Message; Post(delegate { StepState("setup", "fail", "setup could not run its installer: " + m); }); }
                int c = code;
                Post(delegate { busy = false; done(c); });
            });
        }

        static string Sha256(string path)
        {
            using (var s = File.OpenRead(path)) using (var h = SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(s)).Replace("-", "").ToLowerInvariant();
        }
    }
}
