/*
 * Setup -- the first time the Enclave app opens on a phone that hosts on its own (STANDALONE.md "Owner setup"): three steps,
 * each with a check that shows when it is done, then Start hosting.
 *   1. Allow apps to run here: the VM permission, granted by the app itself over the phone's Wireless debugging (SelfPair).
 *   2. Keep running: battery optimization off for Enclave (the agent runs with the screen off and starts VMs from the
 *      background).
 *   3. Start hosting: writes files/agent/setup.json and starts AgentService; the status screen takes over.
 * Plain words, one thing at a time (Steven, 2026-10-11: "too cluttered").
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.File;

final class Setup {
    private final Activity a;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final TextView vmCheck, vmState, batteryCheck, start;
    private final View vmSteps, batteryButton;

    static void show(Activity a) { new Setup(a).tick(); }

    private Setup(Activity a) {
        this.a = a;
        a.getWindow().setStatusBarColor(Status.BG); a.getWindow().setNavigationBarColor(Status.BG);
        if (a.checkSelfPermission("android.permission.POST_NOTIFICATIONS") != android.content.pm.PackageManager.PERMISSION_GRANTED)
            a.requestPermissions(new String[] { "android.permission.POST_NOTIFICATIONS" }, 1);   // the pairing code is typed into a notification
        LinearLayout p = new LinearLayout(a); p.setOrientation(LinearLayout.VERTICAL); p.setPadding(dp(22), dp(16), dp(22), dp(28));
        TextView title = text("Host apps on this phone", 24, Status.TEXT); title.setTypeface(Typeface.DEFAULT_BOLD); p.addView(title);
        TextView lede = text("Apps run in protected virtual machines that this phone proves to the network. You set how much of the phone they get, and earnings go to your payout address.", 15, Status.MUTED);
        lede.setPadding(0, dp(8), 0, 0); p.addView(lede);

        // 1. the VM permission
        vmCheck = step(p, "1", "Allow apps to run here");
        LinearLayout steps = new LinearLayout(a); steps.setOrientation(LinearLayout.VERTICAL);
        steps.addView(text("Enclave gives itself this permission over Wireless debugging, once. Nothing leaves the phone.", 14, Status.MUTED));
        steps.addView(item("Turn on Developer options: Settings › About phone, tap Build number 7 times."));
        steps.addView(item("In Developer options, turn on Wireless debugging (the phone must be on Wi-Fi)."));
        steps.addView(item("Tap Pair device with pairing code, then type the code into Enclave's notification."));
        TextView open = button("Open Developer options", true);
        open.setOnClickListener(v -> { SelfPair.watch(a); try { a.startActivity(new Intent(Settings.ACTION_APPLICATION_DEVELOPMENT_SETTINGS)); }
                                       catch (Exception e) { a.startActivity(new Intent(Settings.ACTION_DEVICE_INFO_SETTINGS)); } });
        LinearLayout.LayoutParams bp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); bp.topMargin = dp(12);
        steps.addView(open, bp);
        vmState = text("", 14, Status.AMBER); vmState.setPadding(0, dp(10), 0, 0); steps.addView(vmState);
        vmSteps = steps; p.addView(steps);

        // 2. battery
        batteryCheck = step(p, "2", "Keep hosting with the screen off");
        TextView allow = button("Allow", true);
        allow.setOnClickListener(v -> { try { a.startActivity(new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, Uri.parse("package:" + a.getPackageName()))); } catch (Exception ignored) {} });
        batteryButton = allow; p.addView(allow, bp);

        // 3. start
        start = button("Start hosting", true);
        LinearLayout.LayoutParams sp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); sp.topMargin = dp(36);
        p.addView(start, sp);
        start.setOnClickListener(v -> begin());
        TextView foot = text("Keep the phone on its charger and on Wi-Fi while it hosts.", 13, Status.MUTED); foot.setPadding(0, dp(10), 0, 0); p.addView(foot);

        ScrollView scroll = new ScrollView(a); scroll.setBackgroundColor(Status.BG); scroll.setFillViewport(true); scroll.addView(p);
        scroll.setOnApplyWindowInsetsListener((v, in) -> {
            android.graphics.Insets bars = in.getInsets(android.view.WindowInsets.Type.systemBars());
            v.setPadding(0, bars.top, 0, bars.bottom); return in; });
        a.setContentView(scroll);
        if (!SelfPair.granted(a)) SelfPair.watch(a);
    }

    private boolean battery() { return a.getSystemService(PowerManager.class).isIgnoringBatteryOptimizations(a.getPackageName()); }

    /** Every second while open: what is done shows as done. */
    private void tick() {
        if (a.isFinishing() || a.isDestroyed()) return;
        final boolean vm = SelfPair.granted(a), bat = battery();
        mark(vmCheck, vm); vmSteps.setVisibility(vm ? View.GONE : View.VISIBLE);
        vmState.setText(SelfPair.state); vmState.setVisibility(SelfPair.state.isEmpty() ? View.GONE : View.VISIBLE);
        mark(batteryCheck, bat); batteryButton.setVisibility(bat ? View.GONE : View.VISIBLE);
        start.setEnabled(vm && bat); start.setAlpha(vm && bat ? 1f : 0.4f);
        ui.postDelayed(this::tick, 1000);
    }

    private void begin() {
        if (!SelfPair.granted(a) || !battery()) return;
        try {
            final File dir = new File(a.getFilesDir(), "agent");
            if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no agent dir");
            final File t = new File(dir, "setup.json.tmp");
            java.nio.file.Files.write(t.toPath(), "{}\n".getBytes("UTF-8"));
            if (!t.renameTo(new File(dir, "setup.json"))) throw new Exception("rename");
        } catch (Exception e) { android.widget.Toast.makeText(a, "Not started: " + e.getMessage(), android.widget.Toast.LENGTH_SHORT).show(); return; }
        SelfPair.stop(a);
        ui.removeCallbacksAndMessages(null);
        Status.show(a);
    }

    // ---- views (Status's look) ----
    private TextView step(LinearLayout p, String n, String title) {
        LinearLayout row = new LinearLayout(a); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(0, dp(30), 0, dp(8));
        TextView check = text(n, 15, Status.MUTED); check.setTypeface(Typeface.DEFAULT_BOLD); check.setGravity(Gravity.CENTER);
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable(); g.setShape(android.graphics.drawable.GradientDrawable.OVAL); g.setStroke(dp(1), Status.MUTED);
        check.setBackground(g); row.addView(check, new LinearLayout.LayoutParams(dp(28), dp(28)));
        TextView t = text(title, 17, Status.TEXT); t.setTypeface(Typeface.DEFAULT_BOLD); t.setPadding(dp(12), 0, 0, 0); row.addView(t);
        p.addView(row);
        return check;
    }
    private void mark(TextView check, boolean done) {
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable(); g.setShape(android.graphics.drawable.GradientDrawable.OVAL);
        if (done) { g.setColor(Status.GREEN); check.setText("✓"); check.setTextColor(Status.BG); } else { g.setStroke(dp(1), Status.MUTED); check.setTextColor(Status.MUTED); }
        check.setBackground(g);
    }
    private TextView item(String s) { TextView t = text("•  " + s, 14, Status.TEXT); t.setPadding(0, dp(8), 0, 0); return t; }
    private TextView button(String s, boolean filled) {
        TextView b = text(s, 15, filled ? Status.BG : Status.TEXT); b.setTypeface(Typeface.DEFAULT_BOLD); b.setGravity(Gravity.CENTER); b.setPadding(dp(22), dp(11), dp(22), dp(11));
        android.graphics.drawable.GradientDrawable g = new android.graphics.drawable.GradientDrawable(); g.setCornerRadius(dp(10)); g.setColor(filled ? Status.GREEN : Status.BG); if (!filled) g.setStroke(dp(1), Status.MUTED);
        b.setBackground(g); return b;
    }
    private TextView text(String s, int sp, int color) { TextView t = new TextView(a); t.setText(s); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color); t.setLineSpacing(0, 1.15f); return t; }
    private int dp(int v) { return Math.round(v * a.getResources().getDisplayMetrics().density); }
}
