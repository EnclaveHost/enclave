// TrayTheme.cs -- the Windows apps' look, shared by the tray (EnclaveTray.cs: its icon, menu and window chrome) and the
// installer (windows/installer/EnclaveSetup.cs, compiled with this file alone, so it needs nothing of the tray's WebView2
// shell): the site's colours and mark, DPI scaling, the dark title bar, and the themed button the installer's pages use.
// The hosting panel itself is host-ui (HTML, shared with the Android app), not drawn here.
//
// C# 5 and ASCII, for the in-box csc.exe (.NET Framework 4.x).
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Runtime.InteropServices;
using System.Windows.Forms;

namespace Enclave.Tray
{
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
}
