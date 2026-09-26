// EnclaveTray.cs -- the box owner's hosting controls, in the notification area of the Windows node (nucbox-k11).
//
// Two sliders: the most of this machine's CPU, and of its GPU, that the node offers to hosting. They set the node's
// hosting caps through its LOCAL API (windows/node/hosting.mjs: GET/PUT http://127.0.0.1:9610/v1/local/hosting with the
// bearer token the node writes to %ProgramData%\Enclave\hosting-admin.token). The node enforces them; this app only
// shows and sets them. Lowering a cap below what is in use stops nothing: new work waits until use drops below it.
//
// Built by build.cmd with the csc.exe that ships with Windows (.NET Framework 4.x, the C# 5 compiler), so the syntax
// here is C# 5 and the source is ASCII. It never talks to anything but 127.0.0.1, and holds no secret of its own: it
// re-reads the token file on every call, because the node mints a new one each time it starts.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Globalization;
using System.IO;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Enclave.Tray
{
    /// <summary>tray-config.json beside the exe; every key optional. The defaults are the node's own.</summary>
    sealed class TrayConfig
    {
        public int Port = 9610;
        public string TokenFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                                               "Enclave", "hosting-admin.token");
        public string LogsFolder = "";          // empty: the folder the node reports (its agent.log), else the tray's own

        public static TrayConfig Load(string path, out string error)
        {
            var c = new TrayConfig();
            error = null;
            if (!File.Exists(path)) return c;
            try
            {
                var o = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path)) as Dictionary<string, object>;
                if (o == null) throw new FormatException("not a JSON object");
                object v;
                if (o.TryGetValue("port", out v) && v != null) c.Port = Convert.ToInt32(v, CultureInfo.InvariantCulture);
                if (o.TryGetValue("tokenFile", out v) && v is string && ((string)v).Length > 0) c.TokenFile = Environment.ExpandEnvironmentVariables((string)v);
                if (o.TryGetValue("logsFolder", out v) && v is string) c.LogsFolder = Environment.ExpandEnvironmentVariables((string)v);
                if (c.Port < 1 || c.Port > 65535) throw new FormatException("port " + c.Port + " is not a port");
            }
            catch (Exception e)
            {
                error = "tray-config.json was not used (" + e.Message + "); using the defaults";
                return new TrayConfig();
            }
            return c;
        }
    }

    /// <summary>What GET /v1/local/hosting answers, read defensively: a missing field is a default, never a crash.</summary>
    sealed class HostingView
    {
        public double CpuCap, GpuCap, CpuInUse, GpuInUse, CpuFree, GpuFree, Reserved;
        public int Served, WaitingForCap;
        public string Backend = "", GpuWhy = "", CapsError = "", LogsDir = "";
        public bool GpuConsumer, AppsEnabled;

        public static HostingView From(Dictionary<string, object> o)
        {
            var v = new HostingView();
            var caps = Obj(o, "caps"); var inUse = Obj(o, "inUse"); var free = Obj(o, "free"); var gpu = Obj(o, "gpu");
            v.CpuCap = Num(caps, "cpuShare", 0); v.GpuCap = Num(caps, "gpuShare", 0);
            v.CpuInUse = Num(inUse, "cpuShare", 0); v.GpuInUse = Num(inUse, "gpuShare", 0);
            v.CpuFree = Num(free, "cpuShare", 0); v.GpuFree = Num(free, "gpuShare", 0);
            v.Reserved = Num(o, "reservedShare", 0);
            v.Served = (int)Num(o, "deploymentsServed", 0); v.WaitingForCap = (int)Num(o, "waitingForCap", 0);
            v.Backend = Str(o, "backend"); v.CapsError = Str(o, "capsError"); v.LogsDir = Str(o, "logsDir");
            v.GpuConsumer = Bool(gpu, "consumer"); v.GpuWhy = Str(gpu, "why"); v.AppsEnabled = Bool(o, "appsEnabled");
            return v;
        }
        static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }
        static double Num(Dictionary<string, object> d, string k, double dflt)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null || v is string || v is bool) return dflt;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return dflt; }
        }
        static string Str(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : "";
        }
        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
    }

    sealed class NodeException : Exception { public NodeException(string m) : base(m) { } }

    /// <summary>The node's local API. Loopback, no proxy, the token read fresh each call.</summary>
    sealed class NodeClient
    {
        readonly TrayConfig cfg;
        public NodeClient(TrayConfig c) { cfg = c; }

        public HostingView Get() { return HostingView.From(Send("GET", null)); }

        public HostingView Put(double cpuShare, double gpuShare)
        {
            return HostingView.From(Send("PUT", string.Format(CultureInfo.InvariantCulture,
                "{{\"cpuShare\":{0:0.00},\"gpuShare\":{1:0.00}}}", cpuShare, gpuShare)));
        }

        string ReadToken()
        {
            try
            {
                var t = File.ReadAllText(cfg.TokenFile).Trim();
                if (t.Length == 0) throw new NodeException("the token file " + cfg.TokenFile + " is empty: the node is still starting, or could not make it private");
                return t;
            }
            catch (UnauthorizedAccessException)
            {
                throw new NodeException("this account (" + Environment.UserDomainName + "\\" + Environment.UserName + ") cannot read "
                    + cfg.TokenFile + ": the node grants it to the account named in HOSTING_TRAY_USER");
            }
            catch (FileNotFoundException) { throw new NodeException("there is no token file at " + cfg.TokenFile + ": is the node running?"); }
            catch (DirectoryNotFoundException) { throw new NodeException("there is no token file at " + cfg.TokenFile + ": is the node running?"); }
            catch (IOException e) { throw new NodeException("the token file " + cfg.TokenFile + " could not be read: " + e.Message); }
        }

        Dictionary<string, object> Send(string method, string body)
        {
            string token = ReadToken();
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + cfg.Port.ToString(CultureInfo.InvariantCulture) + "/v1/local/hosting");
            req.Method = method;
            req.Proxy = null;
            req.Timeout = 5000; req.ReadWriteTimeout = 5000;
            req.KeepAlive = false;
            req.Headers[HttpRequestHeader.Authorization] = "Bearer " + token;
            try
            {
                if (body != null)
                {
                    var bytes = Encoding.UTF8.GetBytes(body);
                    req.ContentType = "application/json";
                    req.ContentLength = bytes.Length;
                    using (var s = req.GetRequestStream()) s.Write(bytes, 0, bytes.Length);
                }
                using (var resp = (HttpWebResponse)req.GetResponse()) return Parse(ReadAll(resp));
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r == null) throw new NodeException("the node is not answering on 127.0.0.1:" + cfg.Port + " (" + e.Status + ")");
                string text; using (r) text = ReadAll(r);
                string why = null;
                try { var o = Parse(text); object m; if (o != null && o.TryGetValue("message", out m) && m is string) why = (string)m; } catch { }
                throw new NodeException("the node answered HTTP " + (int)r.StatusCode + ": " + (why ?? (text.Length > 200 ? text.Substring(0, 200) : text)));
            }
        }
        static string ReadAll(HttpWebResponse r)
        {
            using (var s = r.GetResponseStream()) using (var rd = new StreamReader(s, Encoding.UTF8)) return rd.ReadToEnd();
        }
        static Dictionary<string, object> Parse(string text)
        {
            var o = new JavaScriptSerializer().DeserializeObject(text) as Dictionary<string, object>;
            if (o == null) throw new NodeException("the node's answer is not a JSON object");
            return o;
        }
    }

    /// <summary>The panel: two sliders, what they mean right now, and whether the node is there at all.</summary>
    sealed class ControlPanel : Form
    {
        public readonly TrackBar Cpu = Slider(), Gpu = Slider();
        readonly Label cpuLine = Line(), gpuLine = Line(), cpuNote = Note(), gpuNote = Note(), status = Line(), error = Note();
        public event EventHandler ApplyRequested;
        readonly System.Windows.Forms.Timer debounce = new System.Windows.Forms.Timer { Interval = 500 };
        bool dragging, setting;
        HostingView view;

        public bool Busy { get { return dragging || debounce.Enabled; } }

        public ControlPanel()
        {
            Text = "Enclave hosting";
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.Font; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
            KeyPreview = true;
            var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true,
                                             AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(10) };
            flow.Controls.Add(Title("CPU share offered to hosting"));
            flow.Controls.Add(Cpu); flow.Controls.Add(cpuLine); flow.Controls.Add(cpuNote);
            flow.Controls.Add(Title("GPU share offered to hosting"));
            flow.Controls.Add(Gpu); flow.Controls.Add(gpuLine); flow.Controls.Add(gpuNote);
            flow.Controls.Add(status); flow.Controls.Add(error);
            error.ForeColor = Color.Firebrick;
            Controls.Add(flow);

            foreach (var t in new[] { Cpu, Gpu })
            {
                t.MouseDown += delegate { dragging = true; };
                t.MouseUp += delegate { dragging = false; Schedule(); };
                // keyboard and wheel moves arrive here with no mouse up; a drag is applied on release only
                t.ValueChanged += delegate { if (setting) return; Relabel(); if (!dragging) Schedule(); };
            }
            debounce.Tick += delegate { debounce.Stop(); if (ApplyRequested != null) ApplyRequested(this, EventArgs.Empty); };
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) Hide(); };
            FormClosing += (s, e) => { if (e.CloseReason == CloseReason.UserClosing) { e.Cancel = true; Hide(); } };
            ShowUnreachable("not asked yet");
        }

        void Schedule() { debounce.Stop(); debounce.Start(); }

        public double CpuValue { get { return Cpu.Value / 20.0; } }
        public double GpuValue { get { return Gpu.Value / 20.0; } }

        /// <summary>The node's truth. Sliders are moved to it unless the owner is mid-move.</summary>
        public void ShowView(HostingView v, bool snapSliders)
        {
            view = v;
            if (snapSliders || !Busy)
            {
                setting = true;
                Cpu.Value = Clamp((int)Math.Round(v.CpuCap * 20)); Gpu.Value = Clamp((int)Math.Round(v.GpuCap * 20));
                setting = false;
            }
            Cpu.Enabled = Gpu.Enabled = true;
            string waiting = v.WaitingForCap > 0 ? ", " + v.WaitingForCap + " waiting for room under the cap" : "";
            status.Text = "Node: reachable \u00B7 backend " + (v.Backend.Length > 0 ? v.Backend : "?") + " \u00B7 "
                        + v.Served + (v.Served == 1 ? " deployment" : " deployments") + " served" + waiting
                        + (v.AppsEnabled ? "" : " \u00B7 hosting is off on this node (APPS)");
            error.Text = v.CapsError.Length > 0 ? v.CapsError : "";
            Relabel();
        }

        public void ShowUnreachable(string why)
        {
            view = null;
            Cpu.Enabled = Gpu.Enabled = false;
            cpuLine.Text = gpuLine.Text = "offered \u2013 \u00B7 in use \u2013";
            cpuNote.Text = gpuNote.Text = "";
            status.Text = "Node: not reachable. " + why;
            error.Text = "";
        }

        public void ShowError(string message) { error.Text = message; }

        void Relabel()
        {
            if (view == null) return;
            var v = view;
            cpuLine.Text = "offered " + Pct(CpuValue) + " \u00B7 in use " + Pct(v.CpuInUse);
            gpuLine.Text = "offered " + Pct(GpuValue) + " \u00B7 in use " + Pct(v.GpuInUse);
            var cn = new List<string>();
            if (v.CpuInUse > CpuValue + 1e-9) cn.Add("More than this is in use. Nothing running is stopped; new work waits until use drops below it.");
            else if (v.Reserved > 0 && CpuValue > 1 - v.Reserved + 1e-9) cn.Add("New claims stop at " + Pct(1 - v.Reserved) + ": the node keeps " + Pct(v.Reserved) + " for itself.");
            cpuNote.Text = string.Join(" ", cn.ToArray());
            // Never imply GPU hosting that is not happening.
            if (!v.GpuConsumer)
                gpuNote.Text = v.Backend == "hv"
                    ? "The isolated backend doesn't use the GPU yet; this cap applies when it does."
                    : "Nothing on this node uses the GPU right now" + (v.GpuWhy.Length > 0 ? " (" + v.GpuWhy + ")" : "") + "; this cap applies when something does.";
            else gpuNote.Text = v.GpuInUse > GpuValue + 1e-9 ? "More than this is in use. Nothing running is stopped; new work waits until use drops below it." : "";
        }

        public static string Pct(double share) { return ((int)Math.Round(share * 100)).ToString(CultureInfo.InvariantCulture) + "%"; }
        static int Clamp(int x) { return Math.Max(0, Math.Min(20, x)); }
        // The process is DPI-aware (Program.Main), so fixed widths are scaled here rather than stretched by Windows.
        static readonly int Wide = Scaled(340);
        static int Scaled(int px)
        {
            try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) return (int)Math.Round(px * g.DpiX / 96f); } catch { return px; }
        }
        static TrackBar Slider()
        {
            return new TrackBar { Minimum = 0, Maximum = 20, TickFrequency = 1, SmallChange = 1, LargeChange = 2, Width = Wide,
                                  TickStyle = TickStyle.BottomRight };
        }
        static Label Title(string text) { return new Label { Text = text, AutoSize = true, Font = new Font(SystemFonts.MessageBoxFont, FontStyle.Bold), Margin = new Padding(3, 8, 3, 0) }; }
        static Label Line() { return new Label { AutoSize = true, MaximumSize = new Size(Wide, 0), Font = SystemFonts.MessageBoxFont }; }
        static Label Note() { return new Label { AutoSize = true, MaximumSize = new Size(Wide, 0), Font = SystemFonts.MessageBoxFont, ForeColor = SystemColors.GrayText }; }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly TrayConfig cfg;
        readonly NodeClient client;
        readonly NotifyIcon icon = new NotifyIcon();
        readonly ControlPanel panel = new ControlPanel();
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        readonly Icon iconOk = Glyph(Color.FromArgb(0x1F, 0x7A, 0x5C)), iconWarn = Glyph(Color.FromArgb(0xC2, 0x6A, 0x00)),
                      iconDown = Glyph(Color.FromArgb(0x80, 0x86, 0x8F));
        HostingView last;
        bool refreshing, applying, applyAgain;
        static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Enclave", "Tray");

        public TrayApp(TrayConfig cfg, string configError)
        {
            this.cfg = cfg;
            client = new NodeClient(cfg);
            var h = panel.Handle;                   // a window handle to marshal worker results onto
            var menu = new ContextMenuStrip();
            var controls = new ToolStripMenuItem("Hosting controls\u2026", null, delegate { ShowPanel(); });
            controls.Font = new Font(controls.Font, FontStyle.Bold);
            menu.Items.Add(controls);
            menu.Items.Add(new ToolStripMenuItem("Open logs folder", null, delegate { OpenLogs(); }));
            menu.Items.Add(new ToolStripMenuItem("Refresh", null, delegate { Refresh(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Quit(); }));
            icon.ContextMenuStrip = menu;
            icon.Icon = iconDown; icon.Text = "Enclave hosting";
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowPanel(); };
            icon.Visible = true;
            panel.ApplyRequested += delegate { Apply(); };
            poll.Interval = 10000; poll.Tick += delegate { Refresh(); }; poll.Start();
            Log("started; node 127.0.0.1:" + cfg.Port + ", token " + cfg.TokenFile + (configError != null ? "; " + configError : ""));
            if (configError != null) panel.ShowError(configError);
            Refresh();
        }

        void ShowPanel()
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            if (!panel.Visible) { panel.Show(); }
            panel.Location = new Point(area.Right - panel.Width - 12, area.Bottom - panel.Height - 12);
            panel.Activate();
            Refresh();
        }

        void Refresh()
        {
            if (refreshing || applying) return;
            refreshing = true;
            OnWorker(() => client.Get(), (v, err) => { refreshing = false; Show(v, err, false); });
        }

        void Apply()
        {
            if (last == null) return;
            if (applying) { applyAgain = true; return; }
            applying = true;
            double cpu = panel.CpuValue, gpu = panel.GpuValue;
            OnWorker(() => client.Put(cpu, gpu), (v, err) =>
            {
                applying = false;
                if (err != null)
                {
                    Log("set CPU " + ControlPanel.Pct(cpu) + ", GPU " + ControlPanel.Pct(gpu) + " FAILED: " + err.Message);
                    applyAgain = false;
                    if (last != null) panel.ShowView(last, true);          // back to what the node last said
                    panel.ShowError("Not applied: " + err.Message);
                    Refresh();
                    return;
                }
                Log("set CPU " + ControlPanel.Pct(v.CpuCap) + ", GPU " + ControlPanel.Pct(v.GpuCap));
                if (applyAgain) { applyAgain = false; Show(v, null, false); Apply(); return; }
                Show(v, null, true);
            });
        }

        void Show(HostingView v, Exception err, bool snap)
        {
            if (err != null)
            {
                last = null;
                panel.ShowUnreachable(err is NodeException ? err.Message : err.GetType().Name + ": " + err.Message);
                icon.Icon = iconDown; icon.Text = Tip("Enclave hosting: node not reachable");
                return;
            }
            last = v;
            panel.ShowView(v, snap);
            bool over = v.CpuInUse > v.CpuCap + 1e-9 || v.GpuInUse > v.GpuCap + 1e-9 || v.CapsError.Length > 0;
            icon.Icon = over ? iconWarn : iconOk;
            icon.Text = Tip("Enclave: CPU " + ControlPanel.Pct(v.CpuCap) + " offered, " + ControlPanel.Pct(v.CpuInUse) + " used; "
                            + v.Served + " served");
        }

        void OpenLogs()
        {
            // the configured folder, else the node's own (where its agent.log is), else this app's (tray.log)
            string dir = cfg.LogsFolder.Length > 0 ? cfg.LogsFolder
                       : last != null && last.LogsDir.Length > 0 && Directory.Exists(last.LogsDir) ? last.LogsDir : Home;
            try
            {
                if (dir == Home) Directory.CreateDirectory(Home);
                if (!Directory.Exists(dir)) throw new DirectoryNotFoundException("it does not exist");
                Process.Start("explorer.exe", "\"" + dir + "\"");
            }
            catch (Exception e) { panel.ShowError("Could not open " + dir + ": " + e.Message); ShowPanel(); }
        }

        void Quit()
        {
            poll.Stop();
            icon.Visible = false;
            icon.Dispose();
            Log("exit");
            ExitThread();
        }

        /// <summary>Run the network call off the UI thread and hand the answer back on it.</summary>
        void OnWorker(Func<HostingView> work, Action<HostingView, Exception> done)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                HostingView r = null; Exception err = null;
                try { r = work(); } catch (Exception e) { err = e; }
                try { panel.BeginInvoke((MethodInvoker)delegate { done(r, err); }); }
                catch (InvalidOperationException) { }     // exiting: the window is gone
            });
        }

        static string Tip(string s) { return s.Length <= 63 ? s : s.Substring(0, 63); }   // NotifyIcon.Text throws past 63

        static void Log(string line)
        {
            try
            {
                Directory.CreateDirectory(Home);
                var f = Path.Combine(Home, "tray.log");
                if (File.Exists(f) && new FileInfo(f).Length > 1024 * 1024) { File.Copy(f, f + ".old", true); File.Delete(f); }
                File.AppendAllText(f, DateTime.UtcNow.ToString("yyyy-MM-ddTHH:mm:ssZ", CultureInfo.InvariantCulture) + " " + line + Environment.NewLine);
            }
            catch { }
        }

        [DllImport("user32.dll")] static extern bool DestroyIcon(IntPtr handle);

        /// <summary>The tray glyph, drawn rather than shipped: a rounded tile with an E, in the state's colour.</summary>
        static Icon Glyph(Color fill)
        {
            using (var bmp = new Bitmap(32, 32))
            {
                using (var g = Graphics.FromImage(bmp))
                using (var path = new GraphicsPath())
                using (var brush = new SolidBrush(fill))
                using (var font = new Font("Segoe UI", 20, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var fmt = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center })
                {
                    g.SmoothingMode = SmoothingMode.AntiAlias;
                    g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
                    g.Clear(Color.Transparent);
                    const int r = 8;
                    path.AddArc(1, 1, r * 2, r * 2, 180, 90); path.AddArc(31 - r * 2, 1, r * 2, r * 2, 270, 90);
                    path.AddArc(31 - r * 2, 31 - r * 2, r * 2, r * 2, 0, 90); path.AddArc(1, 31 - r * 2, r * 2, r * 2, 90, 90);
                    path.CloseFigure();
                    g.FillPath(brush, path);
                    g.DrawString("E", font, Brushes.White, new RectangleF(0, 1, 32, 32), fmt);
                }
                IntPtr h = bmp.GetHicon();
                try { using (var tmp = Icon.FromHandle(h)) return (Icon)tmp.Clone(); }
                finally { DestroyIcon(h); }
            }
        }
    }

    static class Program
    {
        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static void Main()
        {
            bool first;
            using (var one = new Mutex(true, "Local\\EnclaveHostingTray", out first))
            {
                if (!first) return;                 // one tray per signed-in user
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string configError;
                var here = Path.GetDirectoryName(Application.ExecutablePath);
                var cfg = TrayConfig.Load(Path.Combine(here, "tray-config.json"), out configError);
                Application.Run(new TrayApp(cfg, configError));
                GC.KeepAlive(one);
            }
        }
    }
}
