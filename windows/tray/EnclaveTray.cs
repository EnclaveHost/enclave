// EnclaveTray.cs -- the box owner's hosting controls, in the notification area of a Windows host.
//
// The panel itself is host-ui/ (HTML, CSS and JavaScript shared with the Android Enclave app: one panel, the same on both),
// shown in a WebView2 window that sits in the corner above the tray. This program is its shell: the tray icon and menu, the
// window, and the bridge that carries the panel's requests to the node's LOCAL API (windows/node/hosting.mjs: GET/PUT
// http://127.0.0.1:9610/v1/local/hosting and below, with the bearer token the node writes to
// %ProgramData%\Enclave\hosting\hosting-admin.token). The page never sees the token and opens no connection of its own;
// it only posts messages (host-ui/README.md, "The shell's side"). The node enforces every setting; the panel only shows
// and sets them.
//
// Built by build.cmd with the csc.exe that ships with Windows (.NET Framework 4.x, the C# 5 compiler), so the syntax
// here is C# 5 and the source is ASCII; the WebView2 SDK's two assemblies and its loader sit beside the exe (fetched and
// checked against their pinned hash by fetch-webview2.ps1). The tray talks to nothing but 127.0.0.1 and holds no secret
// of its own: it re-reads the token file on every call, because the node mints a new one each time it starts. (The
// WebView2 runtime is Microsoft Edge's, and updates itself as Edge does.)
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
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace Enclave.Tray
{
    /// <summary>tray-config.json beside the exe; every key optional. The defaults are the node's own.</summary>
    sealed class TrayConfig
    {
        public int Port = 9610;
        public string TokenFile = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.CommonApplicationData),
                                               "Enclave", "hosting", "hosting-admin.token");
        public string LogsFolder = "";          // empty: the folder the node reports (its agent.log), else the tray's own
        public string UiFolder = Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "ui");   // host-ui's files
        public bool DevTools;                   // the page's developer tools and context menu (for working on host-ui)
        public string Instance = "";            // a second, separate tray beside the owner's (a test copy): its own name, no self-refresh

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
                if (o.TryGetValue("uiFolder", out v) && v is string && ((string)v).Length > 0) c.UiFolder = Environment.ExpandEnvironmentVariables((string)v);
                if (o.TryGetValue("devTools", out v) && v is bool) c.DevTools = (bool)v;
                if (o.TryGetValue("instance", out v) && v is string)
                {
                    if (!Regex.IsMatch((string)v, "^[a-z0-9-]{0,24}$")) throw new FormatException("instance is a short name: a-z, 0-9 and -");
                    c.Instance = (string)v;
                }
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

    /// <summary>What GET /v1/local/hosting answers, as far as the tray ICON needs it (the panel reads the rest itself).
    /// Read defensively: a missing field is a default, never a crash.</summary>
    sealed class HostingView
    {
        public double CpuCap, GpuCap, CpuInUse, GpuInUse;
        public int Served;
        public string CapsError = "", LogsDir = "";
        public bool Paused, CanPause, GasLow;
        public bool? Taking;                                // the network's view: taking new work now (null: an older node)

        public static HostingView From(Dictionary<string, object> o)
        {
            var v = new HostingView();
            var caps = Obj(o, "caps"); var inUse = Obj(o, "inUse");
            v.CpuCap = Num(caps, "cpuShare", 0); v.GpuCap = Num(caps, "gpuShare", 0);
            v.Paused = Bool(caps, "paused"); v.CanPause = caps != null && caps.ContainsKey("paused");   // an older node has no switch
            v.CpuInUse = Num(inUse, "cpuShare", 0); v.GpuInUse = Num(inUse, "gpuShare", 0);
            v.Served = (int)Num(o, "deploymentsServed", 0);
            v.CapsError = Str(o, "capsError"); v.LogsDir = Str(o, "logsDir");
            var market = Obj(o, "market");
            if (market != null) v.Taking = Bool(market, "taking");
            v.GasLow = Bool(Obj(o, "gas"), "low");
            return v;
        }
        static Dictionary<string, object> Obj(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) ? v as Dictionary<string, object> : null;
        }
        internal static double Num(Dictionary<string, object> d, string k, double dflt)
        {
            object v;
            if (d == null || !d.TryGetValue(k, out v) || v == null || v is string || v is bool) return dflt;
            try { return Convert.ToDouble(v, CultureInfo.InvariantCulture); } catch { return dflt; }
        }
        internal static string Str(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is string ? (string)v : "";
        }
        static bool Bool(Dictionary<string, object> d, string k)
        {
            object v; return d != null && d.TryGetValue(k, out v) && v is bool && (bool)v;
        }
        public static string Pct(double share) { return ((int)Math.Round(share * 100)).ToString(CultureInfo.InvariantCulture) + "%"; }
    }

    /// <summary>The node could not be asked at all (not running, no token, the token unreadable): said in words.</summary>
    sealed class NodeException : Exception { public NodeException(string m) : base(m) { } }

    /// <summary>A node's answer as it came: the HTTP status and the body's text.</summary>
    sealed class RawAnswer { public int Status; public string Text = ""; }

    /// <summary>The node's local API. Loopback, no proxy, the token read fresh each call.</summary>
    sealed class NodeClient
    {
        readonly TrayConfig cfg;
        public NodeClient(TrayConfig c) { cfg = c; }

        public const string Hosting = "/v1/local/hosting";
        public HostingView Get()
        {
            var r = Send("GET", Hosting, null);
            if (r.Status != 200) throw new NodeException("the node answered HTTP " + r.Status);
            var o = new JavaScriptSerializer().DeserializeObject(r.Text) as Dictionary<string, object>;
            if (o == null) throw new NodeException("the node's answer is not a JSON object");
            return HostingView.From(o);
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

        /// <summary>One call, answered as it came (any HTTP status). Throws NodeException only when the node can't be
        /// asked: no token, or nothing answering on its port.</summary>
        public RawAnswer Send(string method, string route, string body)
        {
            string token = ReadToken();
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + cfg.Port.ToString(CultureInfo.InvariantCulture) + route);
            req.Method = method;
            req.Proxy = null;
            req.Timeout = 8000; req.ReadWriteTimeout = 8000;
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
                if (body == null && method != "GET") req.ContentLength = 0;
                using (var resp = (HttpWebResponse)req.GetResponse()) return new RawAnswer { Status = (int)resp.StatusCode, Text = ReadAll(resp) };
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r == null) throw new NodeException("the node is not answering on 127.0.0.1:" + cfg.Port + " (" + e.Status + ")");
                int status = (int)r.StatusCode;             // read before the response is disposed: it throws after
                string text; using (r) text = ReadAll(r);
                return new RawAnswer { Status = status, Text = text };
            }
        }
        static string ReadAll(HttpWebResponse r)
        {
            using (var s = r.GetResponseStream()) using (var rd = new StreamReader(s, Encoding.UTF8)) return rd.ReadToEnd();
        }
    }

    /// <summary>
    /// An automatic update in progress, as update-host.ps1 writes it beside the token (%ProgramData%\Enclave\hosting\
    /// update.json): { state: downloading | installing | done | failed, from, to, at }. An install stops the node for a few
    /// minutes, so while one runs the tray says so rather than "not reachable". Null when no update is running (or the file
    /// is older than two hours: an update that died mid-way is not shown forever).
    /// </summary>
    sealed class UpdateState
    {
        public string State = "", To = "";
        public static UpdateState Read(string tokenFile)
        {
            try
            {
                var path = Path.Combine(Path.GetDirectoryName(tokenFile), "update.json");
                if (!File.Exists(path)) return null;
                var o = new JavaScriptSerializer().DeserializeObject(File.ReadAllText(path).TrimStart('\uFEFF')) as Dictionary<string, object>;
                if (o == null) return null;
                object v;
                var u = new UpdateState();
                if (o.TryGetValue("state", out v) && v != null) u.State = v.ToString();
                if (o.TryGetValue("to", out v) && v != null) u.To = v.ToString();
                if (u.State != "downloading" && u.State != "installing") return null;
                DateTime at;
                if (!o.TryGetValue("at", out v) || v == null
                    || !DateTime.TryParse(v.ToString(), CultureInfo.InvariantCulture, DateTimeStyles.AdjustToUniversal | DateTimeStyles.AssumeUniversal, out at)
                    || DateTime.UtcNow - at > TimeSpan.FromHours(2)) return null;
                return u;
            }
            catch { return null; }
        }
        public bool Installing { get { return State == "installing"; } }
        /// <summary>The panel's line.</summary>
        public string Say()
        {
            return Installing ? "Updating to " + To + ": installing. Hosting stops for a few minutes and resumes on its own."
                              : "Downloading update " + To + "; hosting carries on until it installs.";
        }
        /// <summary>The tray icon's tooltip (63 characters at most).</summary>
        public string Tip() { return Installing ? "Enclave hosting: updating to " + To : "Enclave hosting: downloading " + To; }
    }

    /// <summary>The site's look (DESIGN.md, "The Verifier's Console"): near-black tonal surfaces, mono labels, jade marks.</summary>
    static class Theme
    {
        public static readonly Color Bg = Rgb(0x070A0F), Surface = Rgb(0x0F1620), Surface2 = Rgb(0x131C28), Line = Rgb(0x1E2937),
                                     LineStrong = Rgb(0x566880), Text = Rgb(0xE7EEF6), Muted = Rgb(0x93A1B5), Dim = Rgb(0x7A8AA0),
                                     Jade = Rgb(0x2FE6A8), JadeDim = Rgb(0x1C9C74), JadeDeep = Rgb(0x0E3A2C), Amber = Rgb(0xFF914D),
                                     AmberDim = Rgb(0xB4622F), Danger = Rgb(0xFF6B6B);

        /// <summary>Is the taskbar light (Windows' "system" theme)? The tray glyph has no tile of its own, so it takes the deeper
        /// shades there; anything unreadable counts as dark, the Windows 11 default.</summary>
        public static bool LightTaskbar()
        {
            try
            {
                using (var k = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"Software\Microsoft\Windows\CurrentVersion\Themes\Personalize"))
                    return k != null && k.GetValue("SystemUsesLightTheme") is int && (int)k.GetValue("SystemUsesLightTheme") == 1;
            }
            catch { return false; }
        }
        static Color Rgb(int x) { return Color.FromArgb(0xFF, (x >> 16) & 0xFF, (x >> 8) & 0xFF, x & 0xFF); }

        // The site's mono stack, as Windows has it: Cascadia Mono ships with Windows 11, Consolas with everything since Vista.
        static readonly string MonoFamily = FirstInstalled("Cascadia Mono", "Consolas", "Lucida Console");
        public static Font Mono(float pt, FontStyle style) { return new Font(MonoFamily, pt, style); }
        public static readonly Font Body = SystemFonts.MessageBoxFont;
        static string FirstInstalled(params string[] names)
        {
            using (var fonts = new System.Drawing.Text.InstalledFontCollection())
                foreach (var n in names)
                    foreach (var f in fonts.Families)
                        if (string.Equals(f.Name, n, StringComparison.OrdinalIgnoreCase)) return f.Name;
            return FontFamily.GenericMonospace.Name;
        }

        // The process is DPI-aware (Program.Main), so fixed sizes are scaled here rather than stretched by Windows.
        public static readonly float Dpi = ReadDpi();
        public static int Px(float px) { return (int)Math.Round(px * Dpi); }
        static float ReadDpi()
        {
            try { using (var g = Graphics.FromHwnd(IntPtr.Zero)) return g.DpiX / 96f; } catch { return 1f; }
        }

        [DllImport("dwmapi.dll")] static extern int DwmSetWindowAttribute(IntPtr hwnd, int attribute, ref int value, int size);
        /// <summary>A dark title bar in the panel's own colours (Windows 11; older builds keep theirs, which is harmless).</summary>
        public static void DarkFrame(IntPtr hwnd)
        {
            Attr(hwnd, 20, 1);                          // DWMWA_USE_IMMERSIVE_DARK_MODE
            Attr(hwnd, 35, ColorRef(Bg));               // DWMWA_CAPTION_COLOR
            Attr(hwnd, 36, ColorRef(Muted));            // DWMWA_TEXT_COLOR
            Attr(hwnd, 34, ColorRef(Line));             // DWMWA_BORDER_COLOR
        }
        static void Attr(IntPtr hwnd, int attribute, int value) { try { DwmSetWindowAttribute(hwnd, attribute, ref value, 4); } catch { } }
        static int ColorRef(Color c) { return c.R | (c.G << 8) | (c.B << 16); }

        /// <summary>
        /// The site's mark (site/assets/icon.svg): a key in a hexagonal box on a dark tile, drawn in its own 32-unit space.
        /// Below 32 px the inner hexagon would blur into the outer one, so it is left out and the strokes are thickened to
        /// stay a whole pixel wide.
        /// </summary>
        public static void Mark(Graphics g, RectangleF r, Color stroke, bool tile) { Mark(g, r, stroke, tile, false); }
        /// <summary>The site's mark. outline: a thin black edge around every stroke (~1 device px), so the mark reads on
        /// any background (light or dark taskbars, the desktop); the mark shrinks a little so the edge is never clipped.</summary>
        public static void Mark(Graphics g, RectangleF r, Color stroke, bool tile, bool outline)
        {
            var state = g.Save();
            g.SmoothingMode = SmoothingMode.AntiAlias;
            g.PixelOffsetMode = PixelOffsetMode.HighQuality;
            float k = r.Width / 32f;
            g.TranslateTransform(r.X, r.Y); g.ScaleTransform(k, k);
            if (tile)
                using (var path = Rounded(new RectangleF(0, 0, 32, 32), 6))
                using (var b = new SolidBrush(Bg)) g.FillPath(b, path);
            // on its tile the mark is inset as on the site; on its own it fills the icon (the hexagon spans 2..30 of 32)
            float inset = tile ? .82f : 1f;
            // outlined, the hexagon's outer edge (14 from the centre, plus half a stroke and the outline) stays inside the 16
            // (the edge: 1 device px each side at tray sizes, 1/4 of a mark unit at large ones - 2 px at 256)
            float edge = Math.Max(1f / k, .25f);
            if (outline) inset = Math.Min(inset, 15.5f / (14f + Math.Max(2f, 1.3f / k) / 2f + edge));
            g.TranslateTransform(16, 16); g.ScaleTransform(inset, inset); g.TranslateTransform(-16, -16);
            float w = Math.Max(2f, 1.3f / (k * inset));          // at least ~1.3 device px whatever the size
            // the inner hexagon only on the site's tile: on the icons (outlined: tray, taskbar, shortcuts) it is a smudge at 32 px
            bool detail = r.Width >= 32 && !outline;
            if (outline) Strokes(g, Color.Black, w, 2f * edge / inset, detail);
            Strokes(g, stroke, w, 0, detail);
            g.Restore(state);
        }
        static void Strokes(Graphics g, Color c, float w, float extra, bool detail)
        {
            using (var pen = new Pen(c, w + extra) { LineJoin = LineJoin.Round, StartCap = LineCap.Round, EndCap = LineCap.Round })
            {
                g.DrawPolygon(pen, Hex(16, 2, 28, 9, 23, 30, 4));
                if (detail)
                    using (var inner = new Pen(extra > 0 ? c : Color.FromArgb(140, c), w * .7f + extra) { LineJoin = LineJoin.Round })
                        g.DrawPolygon(inner, Hex(16, 7.333f, 24, 12, 20, 24.667f, 8));
                g.DrawEllipse(pen, 16 - 2.45f, 12.55f - 2.45f, 4.9f, 4.9f);
                g.DrawLine(pen, 16, 15, 16, 21.6f);
                g.DrawLine(pen, 16, 21.6f, 18, 21.6f);
                g.DrawLine(pen, 16, 19.4f, 17.5f, 19.4f);
            }
        }
        static PointF[] Hex(float cx, float top, float right, float upper, float lower, float bottom, float left)
        {
            return new[] { new PointF(cx, top), new PointF(right, upper), new PointF(right, lower), new PointF(cx, bottom),
                           new PointF(left, lower), new PointF(left, upper) };
        }
        public static GraphicsPath Rounded(RectangleF b, float radius)
        {
            var path = new GraphicsPath(); float d = radius * 2;
            path.AddArc(b.X, b.Y, d, d, 180, 90); path.AddArc(b.Right - d, b.Y, d, d, 270, 90);
            path.AddArc(b.Right - d, b.Bottom - d, d, d, 0, 90); path.AddArc(b.X, b.Bottom - d, d, d, 90, 90);
            path.CloseFigure();
            return path;
        }
    }

    /// <summary>The tray menu in the panel's colours, every part painted here so no system highlight shows through.</summary>
    sealed class DarkMenuRenderer : ToolStripRenderer
    {
        protected override void OnRenderToolStripBackground(ToolStripRenderEventArgs e)
        {
            using (var b = new SolidBrush(Theme.Surface)) e.Graphics.FillRectangle(b, e.AffectedBounds);
        }
        protected override void OnRenderToolStripBorder(ToolStripRenderEventArgs e)
        {
            var r = new Rectangle(Point.Empty, e.ToolStrip.Size); r.Width -= 1; r.Height -= 1;
            using (var pen = new Pen(Theme.Line)) e.Graphics.DrawRectangle(pen, r);
        }
        protected override void OnRenderImageMargin(ToolStripRenderEventArgs e)
        {
            using (var b = new SolidBrush(Theme.Surface)) e.Graphics.FillRectangle(b, e.AffectedBounds);
        }
        protected override void OnRenderMenuItemBackground(ToolStripItemRenderEventArgs e)
        {
            var r = new Rectangle(Theme.Px(3), 1, e.Item.Width - Theme.Px(6), e.Item.Height - 2);
            using (var b = new SolidBrush(e.Item.Selected && e.Item.Enabled ? Theme.Surface2 : Theme.Surface)) e.Graphics.FillRectangle(b, r);
            if (e.Item.Selected && e.Item.Enabled)
                using (var jade = new SolidBrush(Theme.Jade)) e.Graphics.FillRectangle(jade, r.X, r.Y + Theme.Px(3), Math.Max(2, Theme.Px(2)), r.Height - Theme.Px(6));
        }
        protected override void OnRenderItemText(ToolStripItemTextRenderEventArgs e)
        {
            e.TextColor = e.Item.Enabled ? Theme.Text : Theme.Dim;
            base.OnRenderItemText(e);
        }
        protected override void OnRenderSeparator(ToolStripSeparatorRenderEventArgs e)
        {
            int y = e.Item.Height / 2;
            using (var pen = new Pen(Theme.Line)) e.Graphics.DrawLine(pen, Theme.Px(8), y, e.Item.Width - Theme.Px(8), y);
        }
    }

    /// <summary>
    /// The panel's window: host-ui in WebView2, served from its folder at https://hosting.enclave.example/ (a name that
    /// never leaves this machine), in the corner above the tray, as tall as the panel. It is made at start-up and kept, so
    /// opening it is instant. The page posts messages (host-ui/README.md); requests go to the node with the token, answered
    /// on the UI thread; nothing else the page asks for is done (navigation away, other paths, other origins).
    /// </summary>
    sealed class PanelWindow : Form
    {
        public const string Host = "hosting.enclave.example", Origin = "https://" + Host + "/";
        const int CssWidth = 372;                           // the panel's width in CSS pixels: the tray panel's 340 + its padding
        static readonly Regex Route = new Regex(@"^/v1/local/hosting(/[a-z-]{1,40})?$");
        readonly WebView2 web = new WebView2();
        readonly TrayConfig cfg;
        readonly NodeClient client;
        readonly SynchronizationContext ui;
        readonly Label fallback = new Label();
        readonly LinkLabel getRuntime = new LinkLabel();
        bool ready;
        /// <summary>Said in the panel when it opens (a tray-config.json that could not be used).</summary>
        public string Notice;
        Rectangle dockArea;
        int cssHeight = 320;

        public PanelWindow(TrayConfig cfg, NodeClient client, SynchronizationContext ui)
        {
            this.cfg = cfg; this.client = client; this.ui = ui;
            Text = "Enclave hosting";
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None; KeyPreview = true;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            ClientSize = new Size(Theme.Px(CssWidth), Theme.Px(cssHeight));
            web.Dock = DockStyle.Fill;
            web.DefaultBackgroundColor = Theme.Bg;          // no white flash before the page draws
            Controls.Add(web);
            // without the WebView2 runtime (Windows 10 without Edge's): say so, with the way to get it
            fallback.Dock = DockStyle.Top; fallback.AutoSize = false; fallback.Height = Theme.Px(120); fallback.Padding = new Padding(Theme.Px(14));
            fallback.ForeColor = Theme.Text; fallback.Visible = false;
            getRuntime.Dock = DockStyle.Top; getRuntime.Padding = new Padding(Theme.Px(14), 0, Theme.Px(14), 0); getRuntime.Height = Theme.Px(28);
            getRuntime.Text = "Get the Microsoft Edge WebView2 Runtime"; getRuntime.LinkColor = Theme.Jade; getRuntime.ActiveLinkColor = Theme.Jade; getRuntime.Visible = false;
            getRuntime.LinkClicked += delegate { OpenExternal("https://go.microsoft.com/fwlink/p/?LinkId=2124703"); };
            Controls.Add(getRuntime); Controls.Add(fallback);
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape && !ready) { Hide(); e.Handled = true; } };
            VisibleChanged += delegate { PostEvent(Visible ? "show" : "hidden"); };
            // Closing only hides: a closed panel is a disposed one. Only the end of the session closes it.
            FormClosing += (s, e) => { if (e.CloseReason != CloseReason.WindowsShutDown) { e.Cancel = true; Hide(); } };
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Theme.DarkFrame(Handle); }

        /// <summary>Make the page now, while the window is still hidden.</summary>
        public async void Start()
        {
            try
            {
                var here = Path.GetDirectoryName(Application.ExecutablePath);
                if (File.Exists(Path.Combine(here, "WebView2Loader.dll"))) CoreWebView2Environment.SetLoaderDllFolderPath(here);
                if (!File.Exists(Path.Combine(cfg.UiFolder, "index.html"))) throw new FileNotFoundException("the panel's files are missing: no index.html in " + cfg.UiFolder);
                string data = Path.Combine(TrayApp.Home, "WebView2");
                var made = web.Handle;                      // the control's window, while the panel is still hidden: the page starts now
                var env = await CoreWebView2Environment.CreateAsync(null, data);
                await web.EnsureCoreWebView2Async(env);
                var core = web.CoreWebView2;
                var s = core.Settings;
                s.AreDevToolsEnabled = cfg.DevTools; s.AreDefaultContextMenusEnabled = cfg.DevTools; s.AreBrowserAcceleratorKeysEnabled = cfg.DevTools;
                s.IsStatusBarEnabled = false; s.IsZoomControlEnabled = false; s.IsPasswordAutosaveEnabled = false; s.IsGeneralAutofillEnabled = false;
                core.SetVirtualHostNameToFolderMapping(Host, cfg.UiFolder, CoreWebView2HostResourceAccessKind.Deny);
                // the page stays the panel: a link opens in the browser, never in this window
                core.NavigationStarting += (o, e) => { if (!e.Uri.StartsWith(Origin, StringComparison.Ordinal)) { e.Cancel = true; OpenExternal(e.Uri); } };
                core.NewWindowRequested += (o, e) => { e.Handled = true; OpenExternal(e.Uri); };
                core.WebMessageReceived += OnMessage;
                core.ProcessFailed += (o, e) => { TrayApp.Log("the panel's page failed (" + e.ProcessFailedKind + "); reloading"); try { core.Reload(); } catch { } };
                core.Navigate(Origin + "index.html");
                ready = true;
            }
            catch (WebView2RuntimeNotFoundException)
            {
                Fallback("This panel needs the Microsoft Edge WebView2 Runtime, which this PC does not have. Hosting carries on; the"
                       + " tray menu still turns it on and off.", true);
            }
            catch (Exception e) { Fallback("The panel could not start: " + e.Message, false); }
        }
        void Fallback(string why, bool offerRuntime)
        {
            TrayApp.Log(why);
            web.Visible = false; fallback.Text = why; fallback.Visible = true; getRuntime.Visible = offerRuntime;
        }

        /// <summary>Sit in the bottom-right corner of this work area, and stay there as the panel's height changes.</summary>
        public void Corner(Rectangle area) { dockArea = area; Fit(); }
        void Fit()
        {
            int max = dockArea.IsEmpty ? Screen.PrimaryScreen.WorkingArea.Height - 24 : dockArea.Height - 24;
            int chrome = Height - ClientSize.Height;
            ClientSize = new Size(Theme.Px(CssWidth), Math.Max(Theme.Px(120), Math.Min(Theme.Px(cssHeight), max - chrome)));
            if (!dockArea.IsEmpty) Location = new Point(dockArea.Right - Width - 12, dockArea.Bottom - Height - 12);
        }

        /// <summary>An event for the page: show, hidden, toggle (the menu's switch), refresh.</summary>
        public void PostEvent(string name)
        {
            if (!ready || web.CoreWebView2 == null) return;
            try { web.CoreWebView2.PostWebMessageAsJson("{\"event\":\"" + name + "\"}"); } catch (InvalidOperationException) { }
        }

        void OnMessage(object sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            if (!e.Source.StartsWith(Origin, StringComparison.Ordinal)) return;      // the panel's own page only
            Dictionary<string, object> m;
            try { m = new JavaScriptSerializer().DeserializeObject(e.WebMessageAsJson) as Dictionary<string, object>; } catch { return; }
            if (m == null) return;
            string op = HostingView.Str(m, "op");
            long id = (long)HostingView.Num(m, "id", -1);
            switch (op)
            {
                case "hello":
                    Reply("{\"id\":" + id + ",\"platform\":\"windows\",\"titleBar\":true,\"version\":" + Json(Application.ProductVersion)
                          + (Notice != null ? ",\"notice\":" + Json(Notice) : "") + "}");
                    break;
                case "request": Forward(id, m); break;
                case "size":
                    double h = HostingView.Num(m, "height", -1);
                    if (h > 0 && h < 10000) { cssHeight = (int)Math.Ceiling(h); Fit(); }
                    break;
                case "hide": Hide(); break;
                case "open": OpenExternal(HostingView.Str(m, "url")); break;
            }
        }

        /// <summary>The page's request, to the node with the token, off the UI thread; the answer as it came.</summary>
        void Forward(long id, Dictionary<string, object> m)
        {
            string method = HostingView.Str(m, "method"), path = HostingView.Str(m, "path");
            if (Array.IndexOf(new[] { "GET", "PUT", "POST", "DELETE" }, method) < 0 || !Route.IsMatch(path))
            {
                Reply("{\"id\":" + id + ",\"status\":400,\"body\":{\"error\":\"bad_request\",\"message\":\"the panel may ask only for /v1/local/hosting\"}}");
                return;
            }
            object b; string body = m.TryGetValue("body", out b) && b != null ? new JavaScriptSerializer().Serialize(b) : null;
            ThreadPool.QueueUserWorkItem(delegate
            {
                string reply;
                try
                {
                    var r = client.Send(method, path, body);
                    reply = "{\"id\":" + id + ",\"status\":" + r.Status + ",\"body\":" + (IsJson(r.Text) ? r.Text : "{\"message\":" + Json(r.Text.Length > 200 ? r.Text.Substring(0, 200) : r.Text) + "}") + UpdatePart() + "}";
                }
                catch (NodeException x) { reply = "{\"id\":" + id + ",\"status\":0,\"message\":" + Json(x.Message) + UpdatePart() + "}"; }
                catch (Exception x) { reply = "{\"id\":" + id + ",\"status\":0,\"message\":" + Json(x.GetType().Name + ": " + x.Message) + UpdatePart() + "}"; }
                try { ui.Post(delegate { Reply(reply); }, null); } catch (InvalidOperationException) { }
            });
        }
        /// <summary>An automatic update while it runs (update-host.ps1's update.json), for the page to say.</summary>
        string UpdatePart()
        {
            var u = UpdateState.Read(cfg.TokenFile);
            return ",\"update\":" + (u == null ? "null" : "{\"state\":" + Json(u.State) + ",\"to\":" + Json(u.To) + "}");
        }
        void Reply(string json)
        {
            if (IsDisposed || !ready || web.CoreWebView2 == null) return;
            try { web.CoreWebView2.PostWebMessageAsJson(json); } catch (InvalidOperationException) { }
        }
        static bool IsJson(string text)
        {
            try { new JavaScriptSerializer().DeserializeObject(text); return text.TrimStart().StartsWith("{"); } catch { return false; }
        }
        static string Json(string s) { return new JavaScriptSerializer().Serialize(s ?? ""); }

        /// <summary>Only https links leave, and only to the system browser.</summary>
        public static void OpenExternal(string url)
        {
            Uri u;
            if (!Uri.TryCreate(url, UriKind.Absolute, out u) || u.Scheme != Uri.UriSchemeHttps) return;
            try { Process.Start(new ProcessStartInfo(u.AbsoluteUri) { UseShellExecute = true }); } catch (Exception e) { TrayApp.Log("could not open " + u.Host + ": " + e.Message); }
        }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly TrayConfig cfg;
        readonly NodeClient client;
        readonly NotifyIcon icon = new NotifyIcon();
        readonly SynchronizationContext ui;
        readonly string configError;
        PanelWindow panel;
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        static readonly bool lightBar = Theme.LightTaskbar();
        readonly Icon iconOk = Glyph(lightBar ? Theme.JadeDim : Theme.Jade), iconWarn = Glyph(lightBar ? Theme.AmberDim : Theme.Amber),
                      iconDown = Glyph(lightBar ? Theme.LineStrong : Theme.Dim);
        readonly ToolStripMenuItem pauseItem;
        HostingView last;
        bool refreshing;
        /// <summary>The tray's own folder: its log and the panel's WebView2 data (a named instance keeps its own, beside it).</summary>
        public static string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Enclave", "Tray");

        public TrayApp(TrayConfig cfg, string configError)
        {
            this.cfg = cfg;
            this.configError = configError;
            client = new NodeClient(cfg);
            // the first control installs it on this thread: worker results come back on it, whatever happens to the panel
            var menu = new ContextMenuStrip { Renderer = new DarkMenuRenderer(), ShowImageMargin = false, ForeColor = Theme.Text,
                                              BackColor = Theme.Surface, Padding = new Padding(0, Theme.Px(4), 0, Theme.Px(4)) };
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            panel = NewPanel();
            var controls = new ToolStripMenuItem("Hosting controls\u2026", null, delegate { ShowPanel(); });
            controls.Font = new Font(controls.Font, FontStyle.Bold);
            menu.Items.Add(controls);
            // the switch is the panel's: it asks first when apps would stop, so the menu opens the panel and flips it there
            pauseItem = new ToolStripMenuItem("Turn hosting off", null, delegate { ShowPanel(); Panel.PostEvent("toggle"); }) { Enabled = false };
            menu.Items.Add(pauseItem);
            menu.Items.Add(new ToolStripMenuItem("Open logs folder", null, delegate { OpenLogs(); }));
            menu.Items.Add(new ToolStripMenuItem("Refresh", null, delegate { Refresh(); Panel.PostEvent("refresh"); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Quit(); }));
            icon.ContextMenuStrip = menu;
            icon.Icon = iconDown; icon.Text = "Enclave hosting";
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowPanel(); };
            icon.Visible = true;
            poll.Interval = 10000; poll.Tick += delegate { Refresh(); }; poll.Start();
            Log("started; node 127.0.0.1:" + cfg.Port + ", token " + cfg.TokenFile + ", panel " + cfg.UiFolder + (configError != null ? "; " + configError : ""));
            Refresh();
        }

        /// <summary>The panel, rebuilt if anything ever closed it (an aborted shutdown does).</summary>
        PanelWindow Panel
        {
            get
            {
                if (panel.IsDisposed) { Log("the panel had been closed; rebuilt"); panel = NewPanel(); }
                return panel;
            }
        }

        PanelWindow NewPanel()
        {
            var p = new PanelWindow(cfg, client, ui) { Notice = configError };
            var unused = p.Handle;                          // the window exists (hidden), so the page loads now, not on first open
            p.Corner(Screen.PrimaryScreen.WorkingArea);
            p.Start();
            p.FormClosed += (s, e) => Log("panel closed (" + e.CloseReason + ")");
            return p;
        }

        /// <summary>Another launch (a Desktop or Start Menu shortcut) asked this running tray to show itself.</summary>
        public void ShowFromOutside() { ui.Post(delegate { ShowPanel(); }, null); }

        void ShowPanel()
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            var p = Panel;
            p.Corner(area);
            if (!p.Visible) p.Show();
            p.Activate();
            Refresh();
        }

        /// <summary>The icon's own look at the node, every 10 s: its colour, its tooltip and the menu's switch.</summary>
        void Refresh()
        {
            if (refreshing) return;
            refreshing = true;
            ThreadPool.QueueUserWorkItem(delegate
            {
                HostingView v = null; Exception err = null;
                try { v = client.Get(); } catch (Exception e) { err = e; }
                try { ui.Post(delegate { refreshing = false; Show(v, err); }, null); } catch (InvalidOperationException) { }
            });
        }

        void Show(HostingView v, Exception err)
        {
            if (err != null)
            {
                last = null;
                pauseItem.Enabled = false;
                var up = UpdateState.Read(cfg.TokenFile);
                icon.Icon = iconDown;
                icon.Text = Tip(up != null ? up.Tip() : "Enclave hosting: node not reachable");
                return;
            }
            last = v;
            pauseItem.Text = v.Paused ? "Turn hosting on" : "Turn hosting off";
            pauseItem.Enabled = v.CanPause;
            if (v.Paused)
            {
                icon.Icon = iconDown;
                icon.Text = Tip(v.Served > 0 ? "Enclave hosting: off; stopping " + v.Served + " app(s)" : "Enclave hosting: off");
                return;
            }
            bool over = v.CpuInUse > v.CpuCap + 1e-9 || v.GpuInUse > v.GpuCap + 1e-9 || v.CapsError.Length > 0;
            if (v.GasLow) { icon.Icon = iconWarn; icon.Text = Tip("Enclave hosting: operator gas is low, top it up"); return; }
            if (v.Taking == false) { icon.Icon = iconWarn; icon.Text = Tip("Enclave hosting: on, not taking new work yet"); return; }
            icon.Icon = over ? iconWarn : iconOk;
            icon.Text = Tip("Enclave: CPU " + HostingView.Pct(v.CpuCap) + " offered, " + HostingView.Pct(v.CpuInUse) + " used; "
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
            catch (Exception e) { Log("could not open " + dir + ": " + e.Message); MessageBox.Show("Could not open " + dir + ": " + e.Message, "Enclave hosting"); }
        }

        void Quit()
        {
            poll.Stop();
            icon.Visible = false;
            icon.Dispose();
            Log("exit");
            ExitThread();
        }

        static string Tip(string s) { return s.Length <= 63 ? s : s.Substring(0, 63); }   // NotifyIcon.Text throws past 63

        public static void Log(string line)
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

        /// <summary>The tray glyph: the site's mark (a key in a box) in the state's colour on a transparent ground, drawn at the
        /// size the tray shows.</summary>
        static Icon Glyph(Color stroke)
        {
            int n = Math.Max(16, SystemInformation.SmallIconSize.Width);
            using (var bmp = new Bitmap(n, n))
            {
                using (var g = Graphics.FromImage(bmp))
                {
                    g.Clear(Color.Transparent);
                    Theme.Mark(g, new RectangleF(0, 0, n, n), stroke, false, true);
                }
                IntPtr h = bmp.GetHicon();
                try { using (var tmp = Icon.FromHandle(h)) return (Icon)tmp.Clone(); }
                finally { DestroyIcon(h); }
            }
        }
    }

    static class Program
    {
        /// <summary>What a tray folder holds besides its exe: the WebView2 SDK's assemblies and loader.</summary>
        static readonly string[] Beside = { "Microsoft.Web.WebView2.Core.dll", "Microsoft.Web.WebView2.WinForms.dll", "WebView2Loader.dll" };

        /// <summary>
        /// An automatic update (update-host.ps1) replaces Program Files\Enclave\tray, but this user's copy is the one that starts
        /// at sign-in. When they differ, this copy takes the new one's files: the panel's (ui\), the WebView2 assemblies, and
        /// last the exe, which steps aside (a running exe can be renamed, not overwritten), takes the new one's place and
        /// starts it. -> true when the new copy was started and this one should exit. Nothing of WebView2 is loaded yet here.
        /// </summary>
        static bool RefreshFromProgramFiles(string[] args)
        {
            try
            {
                string self = Application.ExecutablePath, here = Path.GetDirectoryName(self), old = self + ".old";
                string pfDir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Enclave\tray"), pf = Path.Combine(pfDir, "EnclaveTray.exe");
                try { if (File.Exists(old)) File.Delete(old); } catch { }
                if (!File.Exists(pf) || string.Equals(Path.GetFullPath(here), Path.GetFullPath(pfDir), StringComparison.OrdinalIgnoreCase)) return false;
                Mirror(Path.Combine(pfDir, "ui"), Path.Combine(here, "ui"));
                foreach (var f in Beside) Take(Path.Combine(pfDir, f), Path.Combine(here, f));
                if (Sha256(self) == Sha256(pf)) return false;
                File.Move(self, old);
                try { File.Copy(pf, self); } catch { File.Move(old, self); return false; }
                var quoted = new StringBuilder();
                foreach (var a in args) quoted.Append(quoted.Length > 0 ? " " : "").Append('"').Append(a.Replace("\"", "")).Append('"');
                Process.Start(new ProcessStartInfo(self, quoted.ToString()) { UseShellExecute = true, WorkingDirectory = here });
                return true;
            }
            catch { return false; }
        }
        /// <summary>dest becomes a copy of src (a file that differs is replaced; one src lacks is removed).</summary>
        static void Mirror(string src, string dest)
        {
            if (!Directory.Exists(src)) return;
            Directory.CreateDirectory(dest);
            var keep = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var f in Directory.GetFiles(src)) { var name = Path.GetFileName(f); keep.Add(name); Take(f, Path.Combine(dest, name)); }
            foreach (var f in Directory.GetFiles(dest)) if (!keep.Contains(Path.GetFileName(f))) try { File.Delete(f); } catch { }
        }
        /// <summary>Copy src over dest when they differ; a dest in use (another copy of the tray has it loaded) is renamed first.</summary>
        static void Take(string src, string dest)
        {
            if (!File.Exists(src) || (File.Exists(dest) && Sha256(src) == Sha256(dest))) return;
            try { File.Copy(src, dest, true); }
            catch (IOException) { var aside = dest + ".old"; try { File.Delete(aside); } catch { } File.Move(dest, aside); File.Copy(src, dest); }
        }
        static string Sha256(string path)
        {
            using (var f = File.OpenRead(path)) using (var h = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(f)).Replace("-", "");
        }

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        [STAThread]
        static int Main(string[] args)
        {
            // build.cmd: the exe's own icon file, drawn by the same code as the tray glyph
            if (args.Length == 2 && args[0] == "--write-icon") return IconFile.Write(args[1]) ? 0 : 1;
            string configError;
            var cfg = TrayConfig.Load(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "tray-config.json"), out configError);
            // a named instance is a test copy beside the owner's tray: it keeps its own files and its own single-instance name
            if (cfg.Instance.Length == 0 && RefreshFromProgramFiles(args)) return 0;
            string name = "Local\\EnclaveHostingTray" + (cfg.Instance.Length > 0 ? "." + cfg.Instance : "");
            bool first;
            using (var one = new Mutex(true, name, out first))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, name + ".Show"))
            {
                if (!first) { show.Set(); return 0; }  // one tray per signed-in user: a second launch opens its panel
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Run(cfg, configError, show);
                GC.KeepAlive(one);
            }
            return 0;
        }
        // apart from Main, so nothing of WebView2 is touched before RefreshFromProgramFiles has put this version's files in place
        static void Run(TrayConfig cfg, string configError, EventWaitHandle show)
        {
            if (cfg.Instance.Length > 0) TrayApp.Home = TrayApp.Home + "." + cfg.Instance;
            var app = new TrayApp(cfg, configError);
            var wait = ThreadPool.RegisterWaitForSingleObject(show, delegate { app.ShowFromOutside(); }, null, -1, false);
            Application.Run(app);
            wait.Unregister(null);
        }
    }

    /// <summary>A multi-size .ico of the mark on a transparent ground (PNG entries, which Windows reads from Vista on).</summary>
    static class IconFile
    {
        public static bool Write(string path)
        {
            int[] sizes = { 16, 20, 24, 32, 40, 48, 64, 256 };
            var pngs = new List<byte[]>();
            foreach (int n in sizes)
                using (var bmp = new Bitmap(n, n, System.Drawing.Imaging.PixelFormat.Format32bppArgb))
                {
                    using (var g = Graphics.FromImage(bmp)) { g.Clear(Color.Transparent); Theme.Mark(g, new RectangleF(0, 0, n, n), Theme.Jade, false, true); }
                    using (var ms = new MemoryStream()) { bmp.Save(ms, System.Drawing.Imaging.ImageFormat.Png); pngs.Add(ms.ToArray()); }
                }
            try
            {
                using (var w = new BinaryWriter(File.Create(path)))
                {
                    w.Write((short)0); w.Write((short)1); w.Write((short)sizes.Length);           // ICONDIR: reserved, type 1 (icon), count
                    int offset = 6 + 16 * sizes.Length;
                    for (int i = 0; i < sizes.Length; i++)
                    {
                        w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i])); w.Write((byte)(sizes[i] >= 256 ? 0 : sizes[i]));   // 0 means 256
                        w.Write((byte)0); w.Write((byte)0); w.Write((short)1); w.Write((short)32);
                        w.Write(pngs[i].Length); w.Write(offset);
                        offset += pngs[i].Length;
                    }
                    foreach (var png in pngs) w.Write(png);
                }
                return true;
            }
            catch (Exception e) { Console.Error.WriteLine("write-icon: " + e.Message); return false; }
        }
    }
}
