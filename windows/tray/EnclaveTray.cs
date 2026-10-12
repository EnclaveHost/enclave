// EnclaveTray.cs -- the box owner's hosting controls, in the notification area of the Windows node (nucbox-k11).
//
// Two sliders: the most of this machine's CPU, and of its GPU, that the node offers to hosting. They set the node's
// hosting caps through its LOCAL API (windows/node/hosting.mjs: GET/PUT http://127.0.0.1:9610/v1/local/hosting with the
// bearer token the node writes to %ProgramData%\Enclave\hosting\hosting-admin.token). The node enforces them; this app only
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
                                               "Enclave", "hosting", "hosting-admin.token");
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
    /// <summary>One axis of the node's pricing (Host.pricingView): the posted price, the default and where it came from, the
    /// owner's override. Prices are USDC per hour for the whole CPU or card.</summary>
    sealed class PriceAxis
    {
        public double PerHour, Gb, Flops, DefaultPerHour = -1;
        public double? Override;
        public string Tier = "", DefaultFrom = "";
        public static PriceAxis From(Dictionary<string, object> o)
        {
            if (o == null) return null;
            var a = new PriceAxis { PerHour = HostingView.Num(o, "perHour", 0), Gb = HostingView.Num(o, "gb", 0), Flops = HostingView.Num(o, "flops", 0),
                                    Tier = HostingView.Str(o, "tier") };
            double ov = HostingView.Num(o, "override", -1); if (ov > 0) a.Override = ov;
            object d; var def = o.TryGetValue("default", out d) ? d as Dictionary<string, object> : null;
            if (def != null) { a.DefaultPerHour = HostingView.Num(def, "perHour", -1); a.DefaultFrom = HostingView.Str(def, "from"); }
            return a;
        }
        public static string Usd(double perHour)
        {
            return "$" + perHour.ToString(perHour >= 1 ? "0.00" : perHour >= 0.01 ? "0.000" : "0.0000", CultureInfo.InvariantCulture);
        }
    }

    sealed class HostingView
    {
        public double CpuCap, GpuCap, CpuInUse, GpuInUse, CpuFree, GpuFree, Reserved;
        public int Served, WaitingForCap;
        public string Backend = "", GpuWhy = "", CapsError = "", LogsDir = "";
        public bool GpuConsumer, AppsEnabled, Paused, CanPause;
        public bool? Taking;                                // the network's view: taking new work now (null: an older node)
        public string TakingWhy = "";
        public int Dropped;                                 // in the answer to an Apply: deployments it dropped
        public PriceAxis CpuPrice, GpuPrice;                // the node's pricing (null: an older node, or no card to price)

        public static HostingView From(Dictionary<string, object> o)
        {
            var v = new HostingView();
            var caps = Obj(o, "caps"); var inUse = Obj(o, "inUse"); var free = Obj(o, "free"); var gpu = Obj(o, "gpu");
            v.CpuCap = Num(caps, "cpuShare", 0); v.GpuCap = Num(caps, "gpuShare", 0);
            object dropped; v.Dropped = o.TryGetValue("dropped", out dropped) && dropped is object[] ? ((object[])dropped).Length : 0;
            v.Paused = Bool(caps, "paused"); v.CanPause = caps != null && caps.ContainsKey("paused");   // an older node has no switch
            v.CpuInUse = Num(inUse, "cpuShare", 0); v.GpuInUse = Num(inUse, "gpuShare", 0);
            v.CpuFree = Num(free, "cpuShare", 0); v.GpuFree = Num(free, "gpuShare", 0);
            v.Reserved = Num(o, "reservedShare", 0);
            v.Served = (int)Num(o, "deploymentsServed", 0); v.WaitingForCap = (int)Num(o, "waitingForCap", 0);
            v.Backend = Str(o, "backend"); v.CapsError = Str(o, "capsError"); v.LogsDir = Str(o, "logsDir");
            v.GpuConsumer = Bool(gpu, "consumer"); v.GpuWhy = Str(gpu, "why"); v.AppsEnabled = Bool(o, "appsEnabled");
            var market = Obj(o, "market");
            if (market != null) { v.Taking = Bool(market, "taking"); v.TakingWhy = Str(market, "why"); }
            var pricing = Obj(o, "pricing");
            v.CpuPrice = PriceAxis.From(Obj(pricing, "cpu")); v.GpuPrice = PriceAxis.From(Obj(pricing, "gpu"));
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
    }

    /// <summary>GET /v1/local/hosting/earnings (windows/node/payout.mjs): USDC the ledger holds for this box, and where it goes.</summary>
    sealed class EarningsView
    {
        public bool Readable, Paying;
        public double Earned, PaidOut, MinPayout;            // USDC
        public string EnclaveId = "", Operator = "", Wallet = "", PayTo = "", Why = "", LastError = "", LastTx = "";

        public static EarningsView From(Dictionary<string, object> o)
        {
            var e = new EarningsView();
            object v;
            e.Readable = o.TryGetValue("readable", out v) && v is bool && (bool)v;
            e.Paying = o.TryGetValue("paying", out v) && v is bool && (bool)v;
            e.Earned = Usdc(HostingView.Str(o, "earned6")); e.PaidOut = Usdc(HostingView.Str(o, "paidOut6")); e.MinPayout = Usdc(HostingView.Str(o, "minPayout6"));
            e.EnclaveId = HostingView.Str(o, "enclaveId"); e.Operator = HostingView.Str(o, "operator"); e.Wallet = HostingView.Str(o, "wallet");
            e.PayTo = HostingView.Str(o, "payTo"); e.Why = HostingView.Str(o, "why"); e.LastError = HostingView.Str(o, "lastError");
            if (o.TryGetValue("history", out v) && v is object[] && ((object[])v).Length > 0)
                e.LastTx = HostingView.Str(((object[])v)[0] as Dictionary<string, object>, "tx");
            return e;
        }
        /// <summary>The only check a payout wallet gets: its format. 0x and 40 hexadecimal digits, and not the zero address.</summary>
        public static bool IsAddress(string a)
        {
            return a != null && System.Text.RegularExpressions.Regex.IsMatch(a, "^0x[0-9a-fA-F]{40}$") && a.Substring(2).Trim('0').Length > 0;
        }
        // the node sends 6-decimal integers as strings, so nothing is lost on the way
        static double Usdc(string six)
        {
            decimal d; return decimal.TryParse(six, NumberStyles.Integer, CultureInfo.InvariantCulture, out d) ? (double)(d / 1000000m) : 0;
        }
        public static string Usd(double v) { return "$" + v.ToString("0.00", CultureInfo.InvariantCulture); }
        public static string Short(string a) { return a.Length > 14 ? a.Substring(0, 8) + "\u2026" + a.Substring(a.Length - 4) : a; }
    }

    sealed class NodeException : Exception { public NodeException(string m) : base(m) { } }

    /// <summary>A deployment the node says the new caps leave no room for (its 409 would_drop).</summary>
    sealed class DropUnit
    {
        public string Id = "", AppRef = "";
        public double CpuShare, GpuShare;
    }

    /// <summary>The node refused the caps until the owner confirms dropping exactly these.</summary>
    sealed class WouldDropException : Exception
    {
        public readonly List<DropUnit> Units;
        public WouldDropException(string m, List<DropUnit> units) : base(m) { Units = units; }
    }

    /// <summary>The node's local API. Loopback, no proxy, the token read fresh each call.</summary>
    sealed class NodeClient
    {
        readonly TrayConfig cfg;
        public NodeClient(TrayConfig c) { cfg = c; }

        const string Hosting = "/v1/local/hosting";
        public HostingView Get() { return HostingView.From(Send("GET", Hosting, null)); }
        public EarningsView GetEarnings() { return EarningsView.From(Send("GET", Hosting + "/earnings", null)); }
        /// <summary>The payout wallet the owner pasted (format-checked here and by the node): the earnings view after it.</summary>
        public EarningsView SetPayoutWallet(string address)
        {
            if (!EarningsView.IsAddress(address)) throw new NodeException("that is not a wallet address (0x followed by 40 hexadecimal characters)");
            return EarningsView.From(Send("PUT", Hosting + "/payout-wallet", "{\"address\":\"" + address + "\"}"));
        }
        public void PayoutNow() { Send("POST", Hosting + "/payout", null); }
        /// <summary>The owner's price for "cpu" or "gpu" in USDC an hour, or null for the network's default.</summary>
        public HostingView SetPrice(string axis, double? perHour)
        {
            string v = perHour.HasValue ? perHour.Value.ToString("R", CultureInfo.InvariantCulture) : "null";
            return HostingView.From(Send("PUT", Hosting + "/price", "{\"" + axis + "PerHour\":" + v + "}"));
        }

        /// <summary>Set both caps. `drop` confirms the node's own list of what they drop (null: confirm nothing, so caps
        /// that would drop anything come back as a WouldDropException and change nothing).</summary>
        public HostingView Put(double cpuShare, double gpuShare, IList<string> drop)
        {
            var ack = new StringBuilder();
            if (drop != null && drop.Count > 0)
            {
                ack.Append(",\"drop\":[");
                for (int i = 0; i < drop.Count; i++) ack.Append(i > 0 ? "," : "").Append('"').Append(drop[i]).Append('"');
                ack.Append(']');
            }
            return HostingView.From(Send("PUT", Hosting, string.Format(CultureInfo.InvariantCulture,
                "{{\"cpuShare\":{0:0.00},\"gpuShare\":{1:0.00}{2}}}", cpuShare, gpuShare, ack)));
        }

        /// <summary>The switch. Off with apps running comes back as a WouldDropException (the node's list) and changes nothing,
        /// until `drop` confirms exactly that list: turning hosting off stops everything on this PC.</summary>
        public HostingView SetPaused(bool paused, IList<string> drop)
        {
            var ack = new StringBuilder();
            if (drop != null && drop.Count > 0)
            {
                ack.Append(",\"drop\":[");
                for (int i = 0; i < drop.Count; i++) ack.Append(i > 0 ? "," : "").Append('"').Append(drop[i]).Append('"');
                ack.Append(']');
            }
            return HostingView.From(Send("PUT", Hosting, "{\"paused\":" + (paused ? "true" : "false") + ack + "}"));
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

        Dictionary<string, object> Send(string method, string route, string body)
        {
            string token = ReadToken();
            var req = (HttpWebRequest)WebRequest.Create("http://127.0.0.1:" + cfg.Port.ToString(CultureInfo.InvariantCulture) + route);
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
                if (body == null && method != "GET") req.ContentLength = 0;
                using (var resp = (HttpWebResponse)req.GetResponse()) return Parse(ReadAll(resp));
            }
            catch (WebException e)
            {
                var r = e.Response as HttpWebResponse;
                if (r == null) throw new NodeException("the node is not answering on 127.0.0.1:" + cfg.Port + " (" + e.Status + ")");
                int status = (int)r.StatusCode;             // read before the response is disposed: it throws after
                string text; using (r) text = ReadAll(r);
                string why = null;
                Dictionary<string, object> answer = null;
                try { answer = Parse(text); object m; if (answer.TryGetValue("message", out m) && m is string) why = (string)m; } catch { }
                object code, list;
                if (status == 409 && answer != null && answer.TryGetValue("error", out code) && "would_drop".Equals(code)
                    && answer.TryGetValue("drop", out list) && list is object[])
                {
                    var units = new List<DropUnit>();
                    foreach (var x in (object[])list)
                    {
                        var u = x as Dictionary<string, object>;
                        if (u == null) continue;
                        units.Add(new DropUnit { Id = HostingView.Str(u, "id"), AppRef = HostingView.Str(u, "appRef"),
                                                 CpuShare = HostingView.Num(u, "cpuShare", 0), GpuShare = HostingView.Num(u, "gpuShare", 0) });
                    }
                    throw new WouldDropException(why ?? "these caps would drop running work", units);
                }
                throw new NodeException("the node answered HTTP " + status + ": " + (why ?? (text.Length > 200 ? text.Substring(0, 200) : text)));
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

    /// <summary>
    /// The share slider, drawn in the theme (a native TrackBar ignores colours). It keeps TrackBar's contract that the panel
    /// relies on: MouseDown, then ValueChanged while dragging, then MouseUp; arrows, PageUp/PageDown, Home/End and the wheel.
    /// </summary>
    sealed class ShareSlider : Control
    {
        public const int Steps = 20;                    // 5% each
        int value;
        bool grabbed;
        public event EventHandler ValueChanged;

        public ShareSlider(string name)
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                   | ControlStyles.ResizeRedraw | ControlStyles.Selectable | ControlStyles.StandardClick, true);
            TabStop = true; AccessibleName = name; AccessibleRole = AccessibleRole.Slider;
            Size = new Size(Theme.Px(340), Theme.Px(30)); Margin = new Padding(3, Theme.Px(2), 3, 0);
        }

        public int Value
        {
            get { return value; }
            set
            {
                int v = Math.Max(0, Math.Min(Steps, value));
                if (v == this.value) return;
                this.value = v;
                Invalidate();
                if (ValueChanged != null) ValueChanged(this, EventArgs.Empty);
                AccessibilityNotifyClients(AccessibleEvents.ValueChange, -1);
            }
        }

        int Inset { get { return Theme.Px(9); } }
        int XOf(int v) { return Inset + (int)Math.Round((Width - 2 * Inset) * v / (double)Steps); }
        int ValueAt(int x) { return (int)Math.Round((x - Inset) * Steps / (double)Math.Max(1, Width - 2 * Inset)); }

        protected override void OnMouseDown(MouseEventArgs e)
        {
            if (e.Button != MouseButtons.Left || !Enabled) { base.OnMouseDown(e); return; }
            Focus(); grabbed = true;
            base.OnMouseDown(e);                        // the panel marks the drag before the value moves
            Value = ValueAt(e.X);
        }
        protected override void OnMouseMove(MouseEventArgs e) { if (grabbed) Value = ValueAt(e.X); base.OnMouseMove(e); }
        protected override void OnMouseUp(MouseEventArgs e)
        {
            if (grabbed) { grabbed = false; Value = ValueAt(e.X); }
            base.OnMouseUp(e);
        }
        protected override void OnMouseWheel(MouseEventArgs e)
        {
            var h = e as HandledMouseEventArgs; if (h != null) h.Handled = true;
            if (Enabled) Value += Math.Sign(e.Delta);
            base.OnMouseWheel(e);
        }
        protected override bool IsInputKey(Keys k)
        {
            switch (k & Keys.KeyCode) { case Keys.Left: case Keys.Right: case Keys.Up: case Keys.Down: return true; }
            return base.IsInputKey(k);
        }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            switch (e.KeyCode)
            {
                case Keys.Left: case Keys.Down: Value -= 1; e.Handled = true; break;
                case Keys.Right: case Keys.Up: Value += 1; e.Handled = true; break;
                case Keys.PageDown: Value -= 2; e.Handled = true; break;
                case Keys.PageUp: Value += 2; e.Handled = true; break;
                case Keys.Home: Value = 0; e.Handled = true; break;
                case Keys.End: Value = Steps; e.Handled = true; break;
            }
            base.OnKeyDown(e);
        }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }

        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            int mid = Height / 2 - Theme.Px(2), track = Math.Max(2, Theme.Px(4)), x0 = XOf(0), x1 = XOf(Steps), xv = XOf(value);
            Color on = Enabled ? Theme.Jade : Theme.Dim;
            using (var rail = Theme.Rounded(new RectangleF(x0, mid - track / 2f, x1 - x0, track), track / 2f))
            using (var b = new SolidBrush(Theme.Line)) g.FillPath(b, rail);
            if (Enabled && xv > x0)
                using (var fill = Theme.Rounded(new RectangleF(x0, mid - track / 2f, xv - x0, track), track / 2f))
                using (var b = new SolidBrush(Theme.Jade)) g.FillPath(b, fill);
            using (var tick = new SolidBrush(Theme.LineStrong))            // 0, 25, 50, 75, 100%
                for (int v = 0; v <= Steps; v += 5)
                    g.FillRectangle(tick, XOf(v) - Theme.Px(1) / 2f, mid + track + Theme.Px(4), Math.Max(1, Theme.Px(1)), Theme.Px(4));
            float r = Theme.Px(7);
            if (Focused && Enabled)
                using (var halo = new SolidBrush(Theme.JadeDeep)) g.FillEllipse(halo, xv - r - Theme.Px(4), mid - r - Theme.Px(4), 2 * r + Theme.Px(8), 2 * r + Theme.Px(8));
            using (var face = new SolidBrush(Theme.Bg)) g.FillEllipse(face, xv - r, mid - r, 2 * r, 2 * r);
            using (var ring = new Pen(on, Math.Max(2, Theme.Px(2)))) g.DrawEllipse(ring, xv - r, mid - r, 2 * r, 2 * r);
        }

        protected override AccessibleObject CreateAccessibilityInstance() { return new Accessible(this); }
        sealed class Accessible : ControlAccessibleObject
        {
            readonly ShareSlider owner;
            public Accessible(ShareSlider owner) : base(owner) { this.owner = owner; }
            public override string Value { get { return ControlPanel.Pct(owner.value / (double)Steps); } }
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

    /// <summary>Hosting on or off: a switch in the theme. A click ASKS (Toggled); only the node's answer moves it.</summary>
    sealed class HostingSwitch : Control
    {
        bool on;
        public event EventHandler Toggled;
        public HostingSwitch()
        {
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                   | ControlStyles.Selectable | ControlStyles.StandardClick, true);
            TabStop = true; AccessibleName = "Hosting"; AccessibleRole = AccessibleRole.CheckButton;
            Size = new Size(Theme.Px(40), Theme.Px(22)); Margin = new Padding(3, Theme.Px(2), Theme.Px(8), 0); Cursor = Cursors.Hand;
        }
        public bool On
        {
            get { return on; }
            set { if (on == value) return; on = value; Invalidate(); AccessibilityNotifyClients(AccessibleEvents.StateChange, -1); }
        }
        void Ask() { if (Enabled && Toggled != null) Toggled(this, EventArgs.Empty); }
        protected override void OnClick(EventArgs e) { Focus(); Ask(); base.OnClick(e); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { Ask(); e.Handled = true; }
            base.OnKeyDown(e);
        }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            float pad = Theme.Px(2), h = Height - 2 * pad, w = Width - 2 * pad;
            var track = new RectangleF(pad, pad, w, h);
            using (var path = Theme.Rounded(track, h / 2))
            {
                if (Focused) using (var ring = new Pen(Theme.JadeDeep, Theme.Px(3))) g.DrawPath(ring, path);
                using (var fill = new SolidBrush(on && Enabled ? Theme.Jade : Theme.Surface2)) g.FillPath(fill, path);
                if (!on || !Enabled) using (var edge = new Pen(Theme.LineStrong)) g.DrawPath(edge, path);
            }
            float d = h - Theme.Px(6), x = on ? track.Right - d - Theme.Px(3) : track.X + Theme.Px(3);
            using (var knob = new SolidBrush(on && Enabled ? Theme.Bg : Theme.Dim)) g.FillEllipse(knob, x, track.Y + Theme.Px(3), d, d);
        }
        protected override AccessibleObject CreateAccessibilityInstance() { return new Accessible(this); }
        sealed class Accessible : ControlAccessibleObject
        {
            readonly HostingSwitch owner;
            public Accessible(HostingSwitch owner) : base(owner) { this.owner = owner; }
            public override AccessibleStates State { get { return base.State | (owner.on ? AccessibleStates.Checked : AccessibleStates.None); } }
            public override string DefaultAction { get { return owner.on ? "Turn hosting off" : "Turn hosting on"; } }
            public override void DoDefaultAction() { owner.Ask(); }
        }
    }

    /// <summary>A button in the theme: Primary is jade on black (Apply); the other is a hairline outline (Reset).</summary>
    sealed class ThemeButton : Control
    {
        readonly bool primary;
        readonly Color accent;
        bool hot;
        public ThemeButton(string text, bool primary) : this(text, primary, Theme.Jade) { }
        /// <summary>A primary button in another colour: Theme.Danger for one that destroys something.</summary>
        public ThemeButton(string text, bool primary, Color accent)
        {
            this.primary = primary; this.accent = accent;
            SetStyle(ControlStyles.UserPaint | ControlStyles.AllPaintingInWmPaint | ControlStyles.OptimizedDoubleBuffer
                   | ControlStyles.Selectable | ControlStyles.StandardClick, true);
            Text = text; TabStop = true; AccessibleName = text; AccessibleRole = AccessibleRole.PushButton;
            Font = Theme.Mono(9f, primary ? FontStyle.Bold : FontStyle.Regular);
            Size = new Size(Theme.Px(primary ? 92 : 72), Theme.Px(28)); Margin = new Padding(Theme.Px(8), 0, 0, 0);
        }
        protected override void OnTextChanged(EventArgs e) { AccessibleName = Text; Invalidate(); base.OnTextChanged(e); }
        /// <summary>Wide enough for its text, never narrower than it was made.</summary>
        public void FitText()
        {
            Width = Math.Max(Width, TextRenderer.MeasureText(Text, Font).Width + Theme.Px(28));
        }
        protected override void OnMouseEnter(EventArgs e) { hot = true; Invalidate(); base.OnMouseEnter(e); }
        protected override void OnMouseLeave(EventArgs e) { hot = false; Invalidate(); base.OnMouseLeave(e); }
        protected override void OnGotFocus(EventArgs e) { Invalidate(); base.OnGotFocus(e); }
        protected override void OnLostFocus(EventArgs e) { Invalidate(); base.OnLostFocus(e); }
        protected override void OnEnabledChanged(EventArgs e) { Cursor = Enabled ? Cursors.Hand : Cursors.Default; Invalidate(); base.OnEnabledChanged(e); }
        protected override void OnKeyDown(KeyEventArgs e)
        {
            if (e.KeyCode == Keys.Space || e.KeyCode == Keys.Enter) { OnClick(EventArgs.Empty); e.Handled = true; }
            base.OnKeyDown(e);
        }
        protected override void OnPaint(PaintEventArgs e)
        {
            var g = e.Graphics;
            g.Clear(Theme.Bg);
            g.SmoothingMode = SmoothingMode.AntiAlias;
            var r = new RectangleF(1, 1, Width - 2, Height - 2);
            Color fill, ink, edge;
            if (!Enabled) { fill = Theme.Bg; ink = Theme.Dim; edge = Theme.Line; }
            else if (primary) { fill = hot ? ControlPaint.Light(accent, .35f) : accent; ink = Theme.Bg; edge = fill; }
            else { fill = hot ? Theme.Surface2 : Theme.Bg; ink = Theme.Text; edge = Theme.LineStrong; }
            using (var path = Theme.Rounded(r, Theme.Px(4)))
            {
                using (var b = new SolidBrush(fill)) g.FillPath(b, path);
                using (var pen = new Pen(Focused && Enabled ? (primary ? Theme.Text : Theme.Jade) : edge)) g.DrawPath(pen, path);
            }
            TextRenderer.DrawText(g, Text, Font, Rectangle.Round(r), ink,
                                  TextFormatFlags.HorizontalCenter | TextFormatFlags.VerticalCenter | TextFormatFlags.SingleLine);
        }
    }

    /// <summary>
    /// A question in the theme that matters: what is about to happen, the exact things it happens to, and a red (or jade)
    /// button that does it. Cancel is the default; nothing happens unless the owner presses the other one.
    /// </summary>
    sealed class AskDialog : Form
    {
        public AskDialog(string heading, Color headingInk, string body, string detail, string okText, Color okFill)
        {
            Text = "Enclave hosting";
            FormBorderStyle = FormBorderStyle.FixedToolWindow; ShowInTaskbar = false; TopMost = true;
            StartPosition = FormStartPosition.CenterParent; KeyPreview = true;
            AutoScaleMode = AutoScaleMode.None; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            int wide = Theme.Px(380);
            var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true,
                                             AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(Theme.Px(16)), BackColor = Theme.Bg };
            flow.Controls.Add(new Label { Text = heading, AutoSize = true, Font = Theme.Mono(11f, FontStyle.Bold), ForeColor = headingInk,
                                          Margin = new Padding(3, 0, 3, Theme.Px(8)) });
            flow.Controls.Add(new Label { AutoSize = true, MaximumSize = new Size(wide, 0), ForeColor = Theme.Text, Text = body });
            if (!string.IsNullOrEmpty(detail))
                flow.Controls.Add(new Label { Text = detail, AutoSize = true, MaximumSize = new Size(wide, 0),
                                              Font = Theme.Mono(8.5f, FontStyle.Regular), ForeColor = Theme.Muted, Margin = new Padding(3, Theme.Px(10), 3, 0) });
            var cancel = new ThemeButton("Cancel", false);
            var ok = new ThemeButton(okText, true, okFill); ok.FitText();
            cancel.Click += delegate { DialogResult = DialogResult.Cancel; };
            ok.Click += delegate { DialogResult = DialogResult.OK; };
            var buttons = new FlowLayoutPanel { FlowDirection = FlowDirection.RightToLeft, WrapContents = false, AutoSize = true,
                                                AutoSizeMode = AutoSizeMode.GrowAndShrink, BackColor = Theme.Bg,
                                                MinimumSize = new Size(wide, 0), Margin = new Padding(3, Theme.Px(16), 3, 0) };
            buttons.Controls.Add(ok); buttons.Controls.Add(cancel);
            flow.Controls.Add(buttons);
            Controls.Add(flow);
            KeyDown += (s, e) => { if (e.KeyCode == Keys.Escape) DialogResult = DialogResult.Cancel; };
            Shown += delegate { cancel.Focus(); };
        }
        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Theme.DarkFrame(Handle); }

        /// <summary>The warning before an Apply drops running work: what the node said it would drop, newest first.</summary>
        public static AskDialog ForDrop(List<DropUnit> units, double cpu, double gpu)
        {
            string n = units.Count == 1 ? "1 deployment" : units.Count + " deployments";
            var list = new StringBuilder();
            foreach (var u in units)
            {
                list.Append(Short(u.Id, 10, 0)).Append("  ").Append(Short(u.AppRef, 22, 4)).Append("  ")
                    .Append(ControlPanel.Pct(u.CpuShare)).Append(" CPU");
                if (u.GpuShare > 0) list.Append(", ").Append(ControlPanel.Pct(u.GpuShare)).Append(" GPU");
                list.AppendLine();
            }
            return new AskDialog("Drop running work?", Theme.Amber,
                "Applying CPU " + ControlPanel.Pct(cpu) + " \u00B7 GPU " + ControlPanel.Pct(gpu) + " leaves no room for " + n
                + " running on this box. " + (units.Count == 1 ? "It is" : "They are") + " stopped now and "
                + (units.Count == 1 ? "its lease is" : "their leases are") + " handed back to the network, so another host can take "
                + (units.Count == 1 ? "it" : "them") + " (newest first):",
                list.ToString().TrimEnd(), "Drop " + units.Count + " and apply", Theme.Danger);
        }

        /// <summary>The warning before the switch turns hosting off with apps running: all of them stop.</summary>
        public static AskDialog ForOff(List<DropUnit> units)
        {
            string n = units.Count == 1 ? "1 app" : units.Count + " apps";
            var list = new StringBuilder();
            foreach (var u in units) list.Append(Short(u.Id, 10, 0)).Append("  ").Append(Short(u.AppRef, 22, 4)).AppendLine();
            return new AskDialog("Turn hosting off?", Theme.Amber,
                n + " running on this PC " + (units.Count == 1 ? "is" : "are") + " stopped now and "
                + (units.Count == 1 ? "its lease is" : "their leases are") + " handed back to the network, so another host takes "
                + (units.Count == 1 ? "it" : "them") + " over. Nothing of the apps keeps running: this PC's CPU, GPU and memory are "
                + "all yours until you turn hosting on again.",
                list.ToString().TrimEnd(), "Stop " + n + " and turn off", Theme.Danger);
        }

        static string Short(string s, int head, int tail)
        {
            if (s == null) return "";
            return s.Length <= head + tail + 1 ? s : s.Substring(0, head) + "\u2026" + (tail > 0 ? s.Substring(s.Length - tail) : "");
        }
    }

    sealed class PriceEventArgs : EventArgs
    {
        public readonly string Axis; public readonly double? PerHour;
        public PriceEventArgs(string axis, double? perHour) { Axis = axis; PerHour = perHour; }
    }
    /// <summary>
    /// One price, CPU or GPU: what this PC asks an hour for the whole of it, and why (the network's default for its size, or
    /// the owner's own). Edit opens a field (USDC an hour) with Save, Cancel and Use default.
    /// </summary>
    sealed class PriceRow : FlowLayoutPanel
    {
        readonly string axis, label;
        readonly Label line = new Label(), note = new Label(), hint = new Label();
        readonly TextBox box = new TextBox();
        readonly ThemeButton edit = new ThemeButton("Edit", false), save = new ThemeButton("Save", true), cancel = new ThemeButton("Cancel", false),
                             useDefault = new ThemeButton("Use default", false);
        PriceAxis shown; bool editing;
        public event EventHandler<PriceEventArgs> SaveRequested;
        public PriceRow(string axis, string label, int wide)
        {
            this.axis = axis; this.label = label;
            FlowDirection = FlowDirection.TopDown; WrapContents = false; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
            BackColor = Theme.Bg; Margin = new Padding(0, Theme.Px(4), 0, 0);
            line.AutoSize = true; line.Font = Theme.Mono(9f, FontStyle.Regular); line.ForeColor = Theme.Text; line.Margin = new Padding(3, Theme.Px(2), 3, 0);
            note.AutoSize = true; note.MaximumSize = new Size(wide, 0); note.Font = Theme.Body; note.ForeColor = Theme.Dim; note.Margin = new Padding(3, Theme.Px(2), 3, 0);
            box.Font = Theme.Mono(9f, FontStyle.Regular); box.BackColor = Theme.Surface2; box.ForeColor = Theme.Text; box.BorderStyle = BorderStyle.FixedSingle;
            box.Width = Theme.Px(120); box.MaxLength = 12; box.Margin = new Padding(3, Theme.Px(4), 3, 0);
            hint.AutoSize = true; hint.MaximumSize = new Size(wide, 0); hint.Font = Theme.Mono(8.25f, FontStyle.Regular); hint.Margin = new Padding(3, Theme.Px(2), 3, 0);
            var row = new FlowLayoutPanel { FlowDirection = FlowDirection.LeftToRight, WrapContents = false, AutoSize = true, BackColor = Theme.Bg,
                                            Margin = new Padding(0, Theme.Px(6), 0, 0) };
            foreach (var b in new[] { edit, save, cancel, useDefault }) { b.FitText(); b.Margin = new Padding(3, 0, Theme.Px(6), 0); row.Controls.Add(b); }
            Controls.Add(line); Controls.Add(note); Controls.Add(box); Controls.Add(hint); Controls.Add(row);
            edit.Click += delegate { if (shown == null) return; editing = true; box.Text = (shown.Override ?? shown.PerHour).ToString("0.####", CultureInfo.InvariantCulture); Mode(); box.Focus(); box.SelectAll(); };
            cancel.Click += delegate { editing = false; Mode(); };
            save.Click += delegate { double v; if (save.Enabled && Parse(out v)) Ask(v); };
            useDefault.Click += delegate { Ask(null); };
            box.TextChanged += delegate { Hint(); };
            box.KeyDown += (o, k) =>
            {
                double v;
                if (k.KeyCode == Keys.Enter && save.Enabled && Parse(out v)) { k.SuppressKeyPress = true; Ask(v); }
                else if (k.KeyCode == Keys.Escape) { k.SuppressKeyPress = true; editing = false; Mode(); }
            };
            Mode();
        }
        void Ask(double? v) { save.Enabled = useDefault.Enabled = false; if (SaveRequested != null) SaveRequested(this, new PriceEventArgs(axis, v)); }
        public void Saved() { editing = false; useDefault.Enabled = true; Mode(); }
        bool Parse(out double v)
        {
            string t = box.Text.Trim().TrimStart('$').Trim();
            return double.TryParse(t, NumberStyles.Float, CultureInfo.InvariantCulture, out v) && v > 0 && v <= 1000;
        }
        public void Show(PriceAxis a) { shown = a; if (!editing) Mode(); }
        void Mode()
        {
            var a = shown;
            bool open = editing && a != null;
            line.Text = a == null ? label + "  \u2013" : label + "  " + PriceAxis.Usd(a.Override ?? a.PerHour) + " an hour" + (a.Override.HasValue ? "  \u00B7 your price" : "  \u00B7 default");
            // the registry counts whole micro-USDC a second ($0.0036 an hour): say what is posted when it rounds away from it
            string posted = a != null && a.Override.HasValue && Math.Abs(a.PerHour - a.Override.Value) > a.Override.Value * 0.002
                ? " Posted as " + PriceAxis.Usd(a.PerHour) + " an hour: the registry counts whole micro-USDC a second." : "";
            string size = a == null ? "" : " for this PC's " + a.Gb.ToString("0.#", CultureInfo.InvariantCulture) + " GB \u00D7 "
                          + a.Flops.ToString("0.#", CultureInfo.InvariantCulture) + (axis == "gpu" ? " TFLOPS" : " GFLOPS");
            string tierName = a == null ? "" : a.Tier.ToUpperInvariant().Replace("TEE-", "TEE ").Replace("PVM-", "pVM ");
            string def = a == null || a.DefaultPerHour < 0 ? "reading the network's prices\u2026"
                       : (a.DefaultFrom.Length > 0 ? "the cheapest " + tierName + " host's rate (" + a.DefaultFrom + ")" : "the network's starting rate (no other " + tierName + " host yet)") + size;
            note.Text = a == null ? "" : a.Override.HasValue
                ? "Set by you. The default would be " + (a.DefaultPerHour >= 0 ? PriceAxis.Usd(a.DefaultPerHour) + " an hour: " : "") + def + "." + posted
                : "Default: " + def + ". A deployment pays the share of it it leases.";
            box.Visible = hint.Visible = open; save.Visible = cancel.Visible = open;
            useDefault.Visible = open && a.Override.HasValue;
            edit.Visible = a != null && !open;
            Hint();
        }
        void Hint()
        {
            if (!editing) return;
            double v; bool ok = Parse(out v);
            save.Enabled = ok && (shown == null || !shown.Override.HasValue || Math.Abs(v - shown.Override.Value) > 1e-12);
            hint.ForeColor = ok ? Theme.Text : Theme.Amber;
            hint.Text = ok ? "USDC an hour for the whole " + label + (shown != null && shown.DefaultPerHour > 0 ? " (default " + PriceAxis.Usd(shown.DefaultPerHour) + ")" : "")
                           : "a price in USDC an hour, above 0 and at most 1000";
        }
    }

    sealed class WalletEventArgs : EventArgs { public readonly string Address; public WalletEventArgs(string a) { Address = a; } }
    sealed class PauseEventArgs : EventArgs
    {
        public readonly bool Paused;
        public PauseEventArgs(bool paused) { Paused = paused; }
    }

    /// <summary>The panel: the hosting switch, two sliders and their Apply, what they mean right now, and whether the node is there at all.</summary>
    sealed class ControlPanel : Form
    {
        public readonly ShareSlider Cpu = new ShareSlider("CPU share offered to hosting"), Gpu = new ShareSlider("GPU share offered to hosting");
        readonly Label cpuLine = Line(), gpuLine = Line(), cpuNote = Note(), gpuNote = Note(), status = Line(), error = Note();
        readonly HostingSwitch hosting = new HostingSwitch();
        readonly Label hostingLine = Line(), unsaved = Line();
        readonly ThemeButton apply = new ThemeButton("Apply", true), reset = new ThemeButton("Reset", false);
        readonly Label earnLine = Line(), earnNote = Note();
        readonly ThemeButton saveWallet = new ThemeButton("Save", true), editWallet = new ThemeButton("Edit", false),
                             cancelWallet = new ThemeButton("Cancel", false), payNow = new ThemeButton("Pay out now", false);
        readonly TextBox walletBox = new TextBox();
        readonly Label walletHint = Note();
        bool editingWallet;                                  // the field is open: Save/Cancel; closed (a wallet saved): Edit
        public event EventHandler PayoutNowRequested;
        public event EventHandler<WalletEventArgs> PayoutWalletSaveRequested;
        readonly PriceRow cpuPrice = new PriceRow("cpu", "CPU", Wide), gpuPrice = new PriceRow("gpu", "GPU", Wide);
        public event EventHandler<PriceEventArgs> PriceSaveRequested;
        public void PriceSaved(string axis) { (axis == "gpu" ? gpuPrice : cpuPrice).Saved(); }
        EarningsView earnings;
        public event EventHandler ApplyRequested;
        public event EventHandler<PauseEventArgs> PauseRequested;
        bool dragging, setting, applying, switching;
        HostingView view;

        /// <summary>The sliders say something the node does not: moved and not applied (or being applied).</summary>
        public bool Pending
        {
            get { return view != null && (Cpu.Value != Step(view.CpuCap) || Gpu.Value != Step(view.GpuCap)); }
        }
        static int Step(double share) { return (int)Math.Round(share * ShareSlider.Steps); }

        public ControlPanel()
        {
            Text = "Enclave hosting";
            FormBorderStyle = FormBorderStyle.FixedToolWindow;
            ShowInTaskbar = false; TopMost = true; StartPosition = FormStartPosition.Manual;
            AutoScaleMode = AutoScaleMode.None; AutoSize = true; AutoSizeMode = AutoSizeMode.GrowAndShrink;
            KeyPreview = true;
            BackColor = Theme.Bg; ForeColor = Theme.Text; Font = Theme.Body;
            var flow = new FlowLayoutPanel { FlowDirection = FlowDirection.TopDown, WrapContents = false, AutoSize = true,
                                             AutoSizeMode = AutoSizeMode.GrowAndShrink, Padding = new Padding(Theme.Px(14)),
                                             BackColor = Theme.Bg };
            // no in-window masthead: the title bar already says Enclave hosting, with its mark
            var first = Title("Hosting"); first.Margin = new Padding(3, Theme.Px(2), 3, 0); flow.Controls.Add(first);
            var switchRow = Row(FlowDirection.LeftToRight);
            switchRow.Controls.Add(hosting); switchRow.Controls.Add(hostingLine);
            hostingLine.Margin = new Padding(0, Theme.Px(4), 0, 0); hostingLine.MaximumSize = new Size(Wide - Theme.Px(56), 0);
            flow.Controls.Add(switchRow);
            flow.Controls.Add(Title("CPU share offered"));
            flow.Controls.Add(Cpu); flow.Controls.Add(cpuLine); flow.Controls.Add(cpuNote);
            flow.Controls.Add(Title("GPU share offered"));
            flow.Controls.Add(Gpu); flow.Controls.Add(gpuLine); flow.Controls.Add(gpuNote);
            // Apply and Reset, right-aligned, with what is waiting on the left
            var buttons = new TableLayoutPanel { ColumnCount = 3, RowCount = 1, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                                                 BackColor = Theme.Bg, Margin = new Padding(3, Theme.Px(14), 3, 0), Width = Wide };
            buttons.ColumnStyles.Add(new ColumnStyle(SizeType.Percent, 100)); buttons.ColumnStyles.Add(new ColumnStyle()); buttons.ColumnStyles.Add(new ColumnStyle());
            unsaved.ForeColor = Theme.Amber; unsaved.Font = Theme.Mono(8.25f, FontStyle.Regular); unsaved.Anchor = AnchorStyles.Left;
            unsaved.Margin = new Padding(0); unsaved.MaximumSize = new Size(0, 0);
            buttons.Controls.Add(unsaved, 0, 0); buttons.Controls.Add(reset, 1, 0); buttons.Controls.Add(apply, 2, 0);
            buttons.MinimumSize = new Size(Wide, 0);
            flow.Controls.Add(buttons);
            flow.Controls.Add(Rule());
            // the price this PC asks: its default from the network, or the owner's own
            flow.Controls.Add(Title("Price"));
            flow.Controls.Add(cpuPrice); flow.Controls.Add(gpuPrice); gpuPrice.Visible = false;
            cpuPrice.SaveRequested += (o, e) => { if (PriceSaveRequested != null) PriceSaveRequested(this, e); };
            gpuPrice.SaveRequested += (o, e) => { if (PriceSaveRequested != null) PriceSaveRequested(this, e); };
            flow.Controls.Add(Rule());
            flow.Controls.Add(Title("Earnings (USDC)"));
            flow.Controls.Add(earnLine); flow.Controls.Add(earnNote);
            // the payout wallet: pasted here, format-checked only (no wallet connects; nothing is signed)
            flow.Controls.Add(Title("Payout wallet"));
            saveWallet.FitText(); editWallet.FitText(); cancelWallet.FitText(); payNow.FitText();
            // the whole width: an address is 42 characters and should be read in full before it is saved
            walletBox.Font = Theme.Mono(8.5f, FontStyle.Regular); walletBox.BackColor = Theme.Surface2; walletBox.ForeColor = Theme.Text;
            walletBox.BorderStyle = BorderStyle.FixedSingle; walletBox.MaxLength = 64;
            walletBox.Width = Wide - Theme.Px(6); walletBox.Margin = new Padding(3, Theme.Px(4), 3, 0);
            flow.Controls.Add(walletBox);
            walletHint.Font = Theme.Mono(8.25f, FontStyle.Regular);
            flow.Controls.Add(walletHint);
            var earnRow = Row(FlowDirection.LeftToRight);
            earnRow.Margin = new Padding(0, Theme.Px(8), 0, 0);
            saveWallet.Margin = editWallet.Margin = cancelWallet.Margin = payNow.Margin = new Padding(3, 0, Theme.Px(6), 0);
            saveWallet.Enabled = false; cancelWallet.Visible = editWallet.Visible = false;
            earnRow.Controls.Add(saveWallet); earnRow.Controls.Add(editWallet); earnRow.Controls.Add(cancelWallet); earnRow.Controls.Add(payNow);
            flow.Controls.Add(earnRow);
            walletBox.TextChanged += delegate { if (editingWallet) WalletHint(); };
            walletBox.KeyDown += (o, k) =>
            {
                if (k.KeyCode == Keys.Enter && editingWallet && saveWallet.Enabled) { k.SuppressKeyPress = true; SaveWallet(); }
                else if (k.KeyCode == Keys.Escape && editingWallet && cancelWallet.Visible) { k.SuppressKeyPress = true; CancelWallet(); }
            };
            saveWallet.Click += delegate { if (saveWallet.Enabled) SaveWallet(); };
            editWallet.Click += delegate { EditWallet(); };
            cancelWallet.Click += delegate { CancelWallet(); };
            payNow.Click += delegate { if (PayoutNowRequested != null) PayoutNowRequested(this, EventArgs.Empty); };
            ShowEarnings(null, "not asked yet");
            flow.Controls.Add(Rule());
            flow.Controls.Add(status); flow.Controls.Add(error);
            status.ForeColor = Theme.Muted; status.Font = Theme.Mono(8.25f, FontStyle.Regular);
            error.ForeColor = Theme.Danger;
            Controls.Add(flow);

            foreach (var t in new[] { Cpu, Gpu })
            {
                t.MouseDown += delegate { dragging = true; };
                t.MouseUp += delegate { dragging = false; Relabel(); };
                // nothing is sent until Apply: a move only relabels and arms the buttons
                t.ValueChanged += delegate { if (setting) return; Relabel(); };
            }
            apply.Click += delegate { RequestApply(); };
            reset.Click += delegate { if (view != null && !applying) { ShowView(view, true); ShowError(""); } };
            hosting.Toggled += delegate
            {
                if (view == null || switching || PauseRequested == null) return;
                PauseRequested(this, new PauseEventArgs(!view.Paused));
            };
            KeyDown += (s, e) =>
            {
                if (e.KeyCode == Keys.Escape) Hide();
                else if (e.KeyCode == Keys.Enter && (Cpu.Focused || Gpu.Focused)) { RequestApply(); e.Handled = true; }
            };
            // Hiding with changes not applied discards them: the panel opens again on what the node says.
            VisibleChanged += delegate { if (!Visible && view != null && !applying) ShowView(view, true); };
            // Closing only hides: a WM_CLOSE from outside arrives as TaskManagerClosing, not UserClosing, and a closed
            // panel is a disposed one. Only the end of the session closes it, so logoff and shutdown are never held up.
            FormClosing += (s, e) => { if (e.CloseReason != CloseReason.WindowsShutDown) { e.Cancel = true; Hide(); } };
            ShowUnreachable("not asked yet");
        }

        protected override void OnHandleCreated(EventArgs e) { base.OnHandleCreated(e); Theme.DarkFrame(Handle); }

        void RequestApply() { if (Pending && !applying && ApplyRequested != null) ApplyRequested(this, EventArgs.Empty); }

        /// <summary>An Apply is in flight: the buttons wait, and the sliders keep what is being applied.</summary>
        public bool Applying { get { return applying; } set { applying = value; Relabel(); } }
        /// <summary>A pause or resume is in flight: the switch waits for the node's answer.</summary>
        public bool Switching { get { return switching; } set { switching = value; Relabel(); } }

        public double CpuValue { get { return Cpu.Value / (double)ShareSlider.Steps; } }
        public double GpuValue { get { return Gpu.Value / (double)ShareSlider.Steps; } }

        /// <summary>
        /// The node's truth. Sliders are moved to it unless the owner is moving them or has moved them and not applied
        /// (judged against the answer they were last set from, not this one).
        /// </summary>
        public void ShowView(HostingView v, bool snapSliders)
        {
            cpuPrice.Show(v != null ? v.CpuPrice : null);
            gpuPrice.Show(v != null ? v.GpuPrice : null); gpuPrice.Visible = v != null && v.GpuPrice != null;
            bool keep = !snapSliders && (dragging || Pending);
            view = v;
            if (!keep)
            {
                setting = true;
                Cpu.Value = (int)Math.Round(v.CpuCap * ShareSlider.Steps); Gpu.Value = (int)Math.Round(v.GpuCap * ShareSlider.Steps);
                setting = false;
            }
            Cpu.Enabled = Gpu.Enabled = true;
            hosting.On = !v.Paused;
            string waiting = v.WaitingForCap > 0 ? ", " + v.WaitingForCap + " waiting for room under the cap" : "";
            status.Text = "Node: reachable \u00B7 backend " + (v.Backend.Length > 0 ? v.Backend : "?") + " \u00B7 "
                        + v.Served + (v.Served == 1 ? " deployment" : " deployments") + " served" + waiting
                        + (v.AppsEnabled ? "" : " \u00B7 hosting is off on this node (APPS)");
            // a refresh never wipes what the owner was just told; the next Apply, switch or Reset does
            if (v.CapsError.Length > 0) ShowError(v.CapsError);
            Relabel();
        }

        public void ShowUnreachable(string why)
        {
            view = null;
            Cpu.Enabled = Gpu.Enabled = false;
            Relabel();
            cpuLine.Text = gpuLine.Text = "offered \u2013 \u00B7 in use \u2013";
            cpuNote.Text = gpuNote.Text = "";
            status.Text = "Node: not reachable. " + why;
            error.Text = "";
        }

        /// <summary>The node is stopped by an automatic update: the same idle controls, and what is happening instead of an error.</summary>
        public void ShowUpdating(UpdateState u)
        {
            ShowUnreachable("");
            status.Text = u.Say();
        }

        /// <summary>A download in progress while the node still runs: said after the node's own line.</summary>
        public void NoteUpdate(UpdateState u) { status.Text += "\n" + u.Say(); }

        public void ShowError(string message) { error.ForeColor = Theme.Danger; error.Text = message; }

        /// <summary>What the box has earned and where it goes; null with the reason when the node cannot say.</summary>
        public void ShowEarnings(EarningsView e, string unavailable)
        {
            earnings = e;
            if (e == null || !e.Readable)
            {
                earnLine.Text = "earned \u2013 \u00B7 paid out " + (e != null ? EarningsView.Usd(e.PaidOut) : "\u2013");
                earnNote.ForeColor = Theme.Dim;
                earnNote.Text = e != null ? e.Why : unavailable;
                payNow.Enabled = false;
                ShowWallet(e);
                return;
            }
            earnLine.Text = "earned " + EarningsView.Usd(e.Earned) + " not yet paid \u00B7 paid out " + EarningsView.Usd(e.PaidOut);
            earnNote.ForeColor = Theme.Dim;
            if (e.PayTo.Length > 0)
                earnNote.Text = "Credited every second to this box's operator key " + EarningsView.Short(e.Operator) + ", then paid to your wallet "
                              + EarningsView.Short(e.PayTo) + " automatically from " + EarningsView.Usd(e.MinPayout) + "."
                              + (e.LastError.Length > 0 ? " Last try failed: " + e.LastError : "");
            else if (e.Wallet.Length > 0)
            { earnNote.ForeColor = Theme.Amber; earnNote.Text = Cap(e.Why) + "."; }
            else
                earnNote.Text = "Credited every second to this box's operator key " + EarningsView.Short(e.Operator)
                              + ". Paste your wallet's address below to have them paid to it; until then they wait in the ledger.";
            payNow.Enabled = e.PayTo.Length > 0 && e.Earned > 0 && !e.Paying;
            ShowWallet(e);
        }
        /// <summary>
        /// The payout wallet field. Saved: read-only (it can still be selected and copied), with Edit. Editing: open, with Save
        /// (armed only by a valid, changed address) and Cancel (back to the saved address, out of edit mode). No wallet yet:
        /// open for the first one, with nothing to cancel back to.
        /// </summary>
        void ShowWallet(EarningsView e)
        {
            string saved = SavedWallet();
            if (saved.Length == 0 && WalletReady()) editingWallet = true;
            if (!editingWallet) walletBox.Text = saved;
            WalletMode();
        }
        string SavedWallet() { return earnings != null ? earnings.Wallet : ""; }
        bool WalletReady() { return earnings != null && earnings.EnclaveId.Length > 0; }
        void WalletMode()
        {
            bool ready = WalletReady(), open = editingWallet && ready;
            walletBox.ReadOnly = !open; walletBox.TabStop = open; walletBox.Enabled = ready;
            walletBox.BackColor = open ? Theme.Surface2 : Theme.Bg; walletBox.ForeColor = open ? Theme.Text : Theme.Muted;
            saveWallet.Visible = open;
            cancelWallet.Visible = open && SavedWallet().Length > 0;
            editWallet.Visible = ready && !open;
            WalletHint();
        }
        void WalletHint()
        {
            string a = walletBox.Text.Trim(), saved = SavedWallet();
            bool changed = !string.Equals(a, saved, StringComparison.OrdinalIgnoreCase), ok = EarningsView.IsAddress(a);
            saveWallet.Enabled = editingWallet && WalletReady() && changed && ok;
            if (!editingWallet && saved.Length > 0) { walletHint.ForeColor = Theme.Jade; walletHint.Text = "\u2713 earnings are paid to this wallet"; }
            else if (a.Length == 0) { walletHint.ForeColor = Theme.Dim; walletHint.Text = "your wallet's public address: 0x and 40 characters"; }
            else if (!changed) { walletHint.ForeColor = Theme.Dim; walletHint.Text = "this is the saved wallet: paste another to change it, or Cancel"; }
            else if (!ok) { walletHint.ForeColor = Theme.Amber; walletHint.Text = "not a wallet address yet: 0x followed by 40 characters 0-9, a-f (" + Math.Max(0, a.Length - 2) + " of 40)"; }
            else { walletHint.ForeColor = Theme.Text; walletHint.Text = "a valid address: Save to have earnings paid to it"; }
        }
        void EditWallet()
        {
            if (!WalletReady()) return;
            editingWallet = true; WalletMode();
            walletBox.Focus(); walletBox.SelectAll();
        }
        void CancelWallet()
        {
            editingWallet = false; walletBox.Text = SavedWallet(); WalletMode();
            if (editWallet.Visible) editWallet.Focus();
        }
        void SaveWallet()
        {
            string a = walletBox.Text.Trim();
            if (!EarningsView.IsAddress(a) || PayoutWalletSaveRequested == null) return;
            saveWallet.Enabled = false;
            PayoutWalletSaveRequested(this, new WalletEventArgs(a));
        }
        /// <summary>The node saved it: out of edit mode (ShowEarnings, next, shows the saved address).</summary>
        public void WalletSaved() { editingWallet = false; }
        static string Cap(string s) { return s.Length > 0 ? char.ToUpperInvariant(s[0]) + s.Substring(1) : s; }
        public void ShowNotice(string message) { error.ForeColor = Theme.Amber; error.Text = message; }

        void Relabel()
        {
            var v = view;
            // the switch, and the buttons: armed only by a change the node has not got
            hosting.Enabled = v != null && v.CanPause && !switching;
            // "taking new work" is the NETWORK's word (the node's market status), not the switch: after every start or update
            // the box is off the market until the relay has verified it again
            bool waiting = v != null && !v.Paused && v.Taking == false;
            hostingLine.ForeColor = v != null && (v.Paused || waiting) ? Theme.Amber : Theme.Text;
            hostingLine.Text = v == null ? "\u2013"
                : !v.CanPause ? "on (this node has no off switch yet: update the node)"
                : switching ? (v.Paused ? "turning on\u2026" : "turning off\u2026")
                : v.Paused ? (v.Served > 0 ? "off \u00B7 stopping " + v.Served + " app(s)\u2026" : "off \u00B7 nothing runs; this PC is all yours")
                : waiting ? "on \u00B7 NOT taking new work yet: " + v.TakingWhy
                : v.Taking == true ? "on \u00B7 listed on enclave.host, taking new work under the caps below"
                : "on \u00B7 taking new work under the caps below";
            apply.Enabled = reset.Enabled = Pending && !applying;
            apply.Text = applying ? "Applying\u2026" : "Apply";
            unsaved.Text = Pending && !applying ? "not applied" : "";
            if (v == null) return;
            cpuLine.Text = "offered " + Pct(CpuValue) + " \u00B7 in use " + Pct(v.CpuInUse);
            gpuLine.Text = "offered " + Pct(GpuValue) + " \u00B7 in use " + Pct(v.GpuInUse);
            var cn = new List<string>();
            if (v.CpuInUse > CpuValue + 1e-9) cn.Add(Pending ? BelowUse : "More than this is in use. Nothing running is stopped; new work waits until use drops below it.");
            else if (v.Reserved > 0 && CpuValue > 1 - v.Reserved + 1e-9) cn.Add("New claims stop at " + Pct(1 - v.Reserved) + ": the node keeps " + Pct(v.Reserved) + " for itself.");
            cpuNote.Text = string.Join(" ", cn.ToArray());
            cpuNote.ForeColor = v.CpuInUse > CpuValue + 1e-9 ? Theme.Amber : Theme.Dim;
            // Never imply GPU hosting that is not happening.
            // The node says why (on the isolated backend: no partition holds a masked GPU allocation); repeat it, don't guess.
            if (!v.GpuConsumer)
                gpuNote.Text = "Nothing on this node uses the GPU right now" + (v.GpuWhy.Length > 0 ? " (" + v.GpuWhy + ")" : "") + "; this cap applies when something does.";
            else gpuNote.Text = v.GpuInUse > GpuValue + 1e-9 ? (Pending ? BelowUse : "More than this is in use. Nothing running is stopped; new work waits until use drops below it.") : "";
            gpuNote.ForeColor = v.GpuConsumer && v.GpuInUse > GpuValue + 1e-9 ? Theme.Amber : Theme.Dim;
        }

        const string BelowUse = "Below what is in use: Apply asks before it drops running deployments (newest first) until use fits.";
        public static string Pct(double share) { return ((int)Math.Round(share * 100)).ToString(CultureInfo.InvariantCulture) + "%"; }
        static readonly int Wide = Theme.Px(340);
        // DESIGN.md's label voice: small mono capitals in the muted ink; the numbers in mono, the prose in the system face.
        static Label Title(string text)
        {
            return new Label { Text = text.ToUpperInvariant(), AutoSize = true, Font = Theme.Mono(7.5f, FontStyle.Regular),
                               ForeColor = Theme.Muted, Margin = new Padding(3, Theme.Px(12), 3, 0) };
        }
        static Label Line() { return new Label { AutoSize = true, MaximumSize = new Size(Wide, 0), Font = Theme.Mono(9f, FontStyle.Regular), ForeColor = Theme.Text }; }
        static FlowLayoutPanel Row(FlowDirection direction)
        {
            return new FlowLayoutPanel { FlowDirection = direction, WrapContents = false, AutoSize = true, AutoSizeMode = AutoSizeMode.GrowAndShrink,
                                         BackColor = Theme.Bg, Margin = new Padding(0, Theme.Px(4), 0, 0) };
        }
        static Label Note() { return new Label { AutoSize = true, MaximumSize = new Size(Wide, 0), Font = Theme.Body, ForeColor = Theme.Dim, Margin = new Padding(3, Theme.Px(2), 3, 0) }; }
        static Control Rule() { return new Panel { Size = new Size(Wide, 1), BackColor = Theme.Line, Margin = new Padding(3, Theme.Px(8), 3, Theme.Px(2)) }; }
    }

    sealed class TrayApp : ApplicationContext
    {
        readonly TrayConfig cfg;
        readonly NodeClient client;
        readonly NotifyIcon icon = new NotifyIcon();
        readonly SynchronizationContext ui;
        readonly string configError;
        ControlPanel panel;
        readonly System.Windows.Forms.Timer poll = new System.Windows.Forms.Timer();
        static readonly bool lightBar = Theme.LightTaskbar();
        readonly Icon iconOk = Glyph(lightBar ? Theme.JadeDim : Theme.Jade), iconWarn = Glyph(lightBar ? Theme.AmberDim : Theme.Amber),
                      iconDown = Glyph(lightBar ? Theme.LineStrong : Theme.Dim);
        readonly ToolStripMenuItem pauseItem;
        HostingView last;
        EarningsView lastEarnings;
        bool refreshing, applying, switching, earningsBusy;
        readonly System.Windows.Forms.Timer earningsPoll = new System.Windows.Forms.Timer();
        static readonly string Home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Enclave", "Tray");

        public TrayApp(TrayConfig cfg, string configError)
        {
            this.cfg = cfg;
            this.configError = configError;
            client = new NodeClient(cfg);
            panel = NewPanel();
            // the first control installs it on this thread: worker results come back on it, whatever happens to the panel
            ui = SynchronizationContext.Current ?? new WindowsFormsSynchronizationContext();
            var menu = new ContextMenuStrip { Renderer = new DarkMenuRenderer(), ShowImageMargin = false, ForeColor = Theme.Text,
                                              BackColor = Theme.Surface, Padding = new Padding(0, Theme.Px(4), 0, Theme.Px(4)) };
            var controls = new ToolStripMenuItem("Hosting controls\u2026", null, delegate { ShowPanel(); });
            controls.Font = new Font(controls.Font, FontStyle.Bold);
            menu.Items.Add(controls);
            pauseItem = new ToolStripMenuItem("Turn hosting off", null, delegate { if (last != null) SetPaused(!last.Paused, null); }) { Enabled = false };
            menu.Items.Add(pauseItem);
            menu.Items.Add(new ToolStripMenuItem("Open logs folder", null, delegate { OpenLogs(); }));
            menu.Items.Add(new ToolStripMenuItem("Refresh", null, delegate { Refresh(); }));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Exit", null, delegate { Quit(); }));
            icon.ContextMenuStrip = menu;
            icon.Icon = iconDown; icon.Text = "Enclave hosting";
            icon.MouseClick += (s, e) => { if (e.Button == MouseButtons.Left) ShowPanel(); };
            icon.Visible = true;
            poll.Interval = 10000; poll.Tick += delegate { Refresh(); }; poll.Start();
            earningsPoll.Interval = 60000; earningsPoll.Tick += delegate { RefreshEarnings(); }; earningsPoll.Start();
            Log("started; node 127.0.0.1:" + cfg.Port + ", token " + cfg.TokenFile + (configError != null ? "; " + configError : ""));
            Refresh();
            RefreshEarnings();
        }

        /// <summary>The panel, rebuilt if anything ever closed it (an aborted shutdown does), showing what the node last said.</summary>
        ControlPanel Panel
        {
            get
            {
                if (panel.IsDisposed) { Log("the panel had been closed; rebuilt"); panel = NewPanel(); }
                return panel;
            }
        }

        ControlPanel NewPanel()
        {
            var p = new ControlPanel();
            p.ApplyRequested += delegate { Apply(); };
            p.PauseRequested += (s, e) => SetPaused(e.Paused, null);
            p.PayoutWalletSaveRequested += (o, w) => SavePayoutWallet(w.Address);
            p.PriceSaveRequested += (o, e) => SavePrice(e.Axis, e.PerHour);
            p.PayoutNowRequested += delegate { PayoutNow(); };
            if (lastEarnings != null) p.ShowEarnings(lastEarnings, null);
            p.FormClosed += (s, e) => Log("panel closed (" + e.CloseReason + ")");
            if (last != null) p.ShowView(last, true);
            if (configError != null) p.ShowError(configError);
            return p;
        }

        /// <summary>Another launch (a Desktop or Start Menu shortcut) asked this running tray to show itself.</summary>
        public void ShowFromOutside() { ui.Post(delegate { ShowPanel(); }, null); }

        void ShowPanel()
        {
            var area = Screen.FromPoint(Cursor.Position).WorkingArea;
            var p = Panel;
            if (!p.Visible) { p.Show(); }
            p.Location = new Point(area.Right - p.Width - 12, area.Bottom - p.Height - 12);
            p.Activate();
            Refresh();
            RefreshEarnings();
        }

        void Refresh()
        {
            if (refreshing || applying || switching) return;
            refreshing = true;
            OnWorker(() => client.Get(), (v, err) => { refreshing = false; Show(v, err, false); });
        }

        void Apply()
        {
            if (last == null || applying) return;
            applying = true; Panel.Applying = true;
            double cpu = Panel.CpuValue, gpu = Panel.GpuValue;
            Send(cpu, gpu, null);
        }

        /// <summary>
        /// PUT the caps. The first try confirms nothing, so caps that would drop running work come back as the node's
        /// list (409 would_drop) having changed nothing; the owner sees that list and only "Drop N and apply" sends it
        /// back as the confirmation.
        /// </summary>
        void Send(double cpu, double gpu, List<string> confirmed)
        {
            OnWorker(() => client.Put(cpu, gpu, confirmed), (v, err) =>
            {
                var would = err as WouldDropException;
                // asked again if what it would drop changed between the warning and the confirmation
                if (would != null && would.Units.Count > 0)
                {
                    bool yes;
                    using (var ask = AskDialog.ForDrop(would.Units, cpu, gpu)) yes = ask.ShowDialog(Panel) == DialogResult.OK;
                    if (yes)
                    {
                        var ids = new List<string>();
                        foreach (var u in would.Units) ids.Add(u.Id);
                        Log("owner confirmed dropping " + ids.Count + " deployment(s) for CPU " + ControlPanel.Pct(cpu) + ", GPU " + ControlPanel.Pct(gpu));
                        Send(cpu, gpu, ids);
                        return;
                    }
                    applying = false; Panel.Applying = false;
                    Panel.ShowNotice("Not applied: nothing was dropped. Raise the caps, or Reset.");
                    return;
                }
                applying = false;
                if (err != null)
                {
                    Log("set CPU " + ControlPanel.Pct(cpu) + ", GPU " + ControlPanel.Pct(gpu) + " FAILED: " + err.Message);
                    Panel.Applying = false;                                 // the sliders keep the owner's values: Apply again, or Reset
                    Panel.ShowError("Not applied: " + err.Message);
                    Refresh();
                    return;
                }
                Log("set CPU " + ControlPanel.Pct(v.CpuCap) + ", GPU " + ControlPanel.Pct(v.GpuCap) + (v.Dropped > 0 ? "; dropped " + v.Dropped : ""));
                Show(v, null, true);
                Panel.Applying = false;
                if (v.Dropped > 0)
                    Panel.ShowNotice("Dropped " + (v.Dropped == 1 ? "1 deployment" : v.Dropped + " deployments")
                                     + ": " + (v.Dropped == 1 ? "its lease goes" : "their leases go") + " back to the network.");
                else Panel.ShowError("");
            });
        }

        // ---- earnings (windows/node/payout.mjs) ------------------------------------------------------------------------
        void RefreshEarnings()
        {
            if (earningsBusy) return;
            earningsBusy = true;
            OnWorkerE(() => client.GetEarnings(), (e, err) =>
            {
                earningsBusy = false;
                lastEarnings = err == null ? e : null;
                var up = err == null ? null : UpdateState.Read(cfg.TokenFile);
                Panel.ShowEarnings(lastEarnings, err == null ? null : up != null ? "back when the update finishes"
                                                 : (err is NodeException ? err.Message : err.GetType().Name + ": " + err.Message));
            });
        }

        /// <summary>The owner's price (or null: back to the default). The node posts it to the registry on its next tick.</summary>
        void SavePrice(string axis, double? perHour)
        {
            OnWorker(() => client.SetPrice(axis, perHour), (v, err) =>
            {
                Panel.PriceSaved(axis);
                if (err != null) { Panel.ShowError("Price not saved: " + err.Message); Refresh(); return; }
                Log(axis + " price " + (perHour.HasValue ? "set to " + perHour.Value.ToString(CultureInfo.InvariantCulture) + " USDC/hr" : "back to the default"));
                Show(v, null, false);
                Panel.ShowNotice(perHour.HasValue ? "Price saved: new deployments are charged it once the registry has it (a minute or so)."
                                                  : "Back to the default price.");
            });
        }

        /// <summary>Save the payout wallet the owner pasted: the node checks its format again and pays it from then on.</summary>
        void SavePayoutWallet(string address)
        {
            OnWorkerE(() => client.SetPayoutWallet(address), (e, err) =>
            {
                if (err != null) { Panel.ShowError("Payout wallet not saved: " + err.Message); RefreshEarnings(); return; }
                Log("payout wallet set: " + address);
                Panel.WalletSaved(); lastEarnings = e; Panel.ShowEarnings(e, null);
                Panel.ShowNotice("Payout wallet saved: earnings go to " + EarningsView.Short(address) + ".");
            });
        }

        void PayoutNow()
        {
            OnWorkerE(() => { client.PayoutNow(); return client.GetEarnings(); }, (e, err) =>
            {
                if (err != null) { Panel.ShowError("Not paid out: " + err.Message); RefreshEarnings(); return; }
                Log("paid out on request");
                lastEarnings = e; Panel.ShowEarnings(e, null);
                Panel.ShowNotice("Paid out" + (e.LastTx.Length > 0 ? " (tx " + EarningsView.Short(e.LastTx) + ")" : "") + ".");
            });
        }

        /// <summary>OnWorker for the earnings calls.</summary>
        void OnWorkerE(Func<EarningsView> work, Action<EarningsView, Exception> done)
        {
            ThreadPool.QueueUserWorkItem(delegate
            {
                EarningsView r = null; Exception err = null;
                try { r = work(); } catch (Exception e) { err = e; }
                try { ui.Post(delegate { done(r, err); }, null); }
                catch (InvalidOperationException) { }
            });
        }

        /// <summary>
        /// The switch. ON takes work under the caps. OFF stops EVERYTHING: the node drops every app running here and hands its
        /// lease back, so a game gets the whole PC. With apps running the node first answers with their list (409
        /// would_drop) having changed nothing; the owner sees it, and only "Stop N and turn off" sends it back confirmed.
        /// The caps are kept either way.
        /// </summary>
        void SetPaused(bool paused, List<string> confirmed)
        {
            if (last == null || switching) return;
            switching = true; Panel.Switching = true; pauseItem.Enabled = false;
            OnWorker(() => client.SetPaused(paused, confirmed), (v, err) =>
            {
                switching = false;
                var would = err as WouldDropException;
                if (would != null && would.Units.Count > 0)
                {
                    bool yes;
                    using (var ask = AskDialog.ForOff(would.Units)) yes = ask.ShowDialog(Panel) == DialogResult.OK;
                    Panel.Switching = false;
                    if (yes)
                    {
                        var ids = new List<string>();
                        foreach (var u in would.Units) ids.Add(u.Id);
                        Log("owner confirmed turning hosting off: stopping " + ids.Count + " deployment(s)");
                        SetPaused(true, ids);
                        return;
                    }
                    Panel.ShowNotice("Hosting is still on: nothing was stopped.");
                    Refresh();
                    return;
                }
                if (err != null)
                {
                    Log((paused ? "turn off" : "turn on") + " FAILED: " + err.Message);
                    Panel.Switching = false;
                    Panel.ShowError("Hosting was not turned " + (paused ? "off" : "on") + ": " + err.Message);
                    Refresh();
                    return;
                }
                Log(v.Paused ? "hosting turned off" : "hosting turned on");
                Show(v, null, false);                                       // a move not yet applied stays as it is
                Panel.Switching = false;
                Panel.ShowError("");
            });
        }

        void Show(HostingView v, Exception err, bool snap)
        {
            if (err != null)
            {
                last = null;
                pauseItem.Enabled = false;
                var up = UpdateState.Read(cfg.TokenFile);
                if (up != null) { Panel.ShowUpdating(up); icon.Icon = iconDown; icon.Text = Tip(up.Tip()); return; }
                Panel.ShowUnreachable(err is NodeException ? err.Message : err.GetType().Name + ": " + err.Message);
                icon.Icon = iconDown; icon.Text = Tip("Enclave hosting: node not reachable");
                return;
            }
            last = v;
            Panel.ShowView(v, snap);
            var downloading = UpdateState.Read(cfg.TokenFile);
            if (downloading != null) Panel.NoteUpdate(downloading);
            pauseItem.Text = v.Paused ? "Turn hosting on" : "Turn hosting off";
            pauseItem.Enabled = v.CanPause && !switching;
            if (v.Paused)
            {
                icon.Icon = iconDown;
                icon.Text = Tip(v.Served > 0 ? "Enclave hosting: off; stopping " + v.Served + " app(s)" : "Enclave hosting: off");
                return;
            }
            bool over = v.CpuInUse > v.CpuCap + 1e-9 || v.GpuInUse > v.GpuCap + 1e-9 || v.CapsError.Length > 0;
            if (v.Taking == false) { icon.Icon = iconWarn; icon.Text = Tip("Enclave hosting: on, not taking new work yet"); return; }
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
            catch (Exception e) { Panel.ShowError("Could not open " + dir + ": " + e.Message); ShowPanel(); }
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
                try { ui.Post(delegate { done(r, err); }, null); }
                catch (InvalidOperationException) { }     // exiting: the UI thread is gone
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
        /// <summary>
        /// An automatic update (update-host.ps1) replaces Program Files\Enclave\tray\EnclaveTray.exe, but this user's copy is the
        /// one that starts at sign-in. When the two differ, this copy steps aside (a running exe can be renamed, not
        /// overwritten), takes the new one's place and starts it. -> true when the new copy was started and this one should exit.
        /// </summary>
        static bool RefreshFromProgramFiles(string[] args)
        {
            try
            {
                string self = Application.ExecutablePath, old = self + ".old";
                string pf = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), @"Enclave\tray\EnclaveTray.exe");
                try { if (File.Exists(old)) File.Delete(old); } catch { }
                if (!File.Exists(pf) || string.Equals(Path.GetFullPath(self), Path.GetFullPath(pf), StringComparison.OrdinalIgnoreCase)) return false;
                if (Sha256(self) == Sha256(pf)) return false;
                File.Move(self, old);
                try { File.Copy(pf, self); } catch { File.Move(old, self); return false; }
                var quoted = new StringBuilder();
                foreach (var a in args) quoted.Append(quoted.Length > 0 ? " " : "").Append('"').Append(a.Replace("\"", "")).Append('"');
                Process.Start(new ProcessStartInfo(self, quoted.ToString()) { UseShellExecute = true, WorkingDirectory = Path.GetDirectoryName(self) });
                return true;
            }
            catch { return false; }
        }
        static string Sha256(string path)
        {
            using (var f = File.OpenRead(path)) using (var h = System.Security.Cryptography.SHA256.Create())
                return BitConverter.ToString(h.ComputeHash(f)).Replace("-", "");
        }

        [DllImport("user32.dll")] static extern bool SetProcessDPIAware();

        const string ShowSignal = "Local\\EnclaveHostingTray.Show";

        [STAThread]
        static int Main(string[] args)
        {
            // build.cmd: the exe's own icon file, drawn by the same code as the tray glyph
            if (args.Length == 2 && args[0] == "--write-icon") return IconFile.Write(args[1]) ? 0 : 1;
            if (RefreshFromProgramFiles(args)) return 0;
            bool first;
            using (var one = new Mutex(true, "Local\\EnclaveHostingTray", out first))
            using (var show = new EventWaitHandle(false, EventResetMode.AutoReset, ShowSignal))
            {
                if (!first) { show.Set(); return 0; }  // one tray per signed-in user: a second launch opens its panel
                try { SetProcessDPIAware(); } catch { }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                string configError;
                var here = Path.GetDirectoryName(Application.ExecutablePath);
                var cfg = TrayConfig.Load(Path.Combine(here, "tray-config.json"), out configError);
                var app = new TrayApp(cfg, configError);
                var wait = ThreadPool.RegisterWaitForSingleObject(show, delegate { app.ShowFromOutside(); }, null, -1, false);
                Application.Run(app);
                wait.Unregister(null);
                GC.KeepAlive(one);
            }
            return 0;
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
