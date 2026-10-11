/*
 * Status -- what the Enclave app shows when it is opened from the launcher (a release pVM CPU build, no launch extras): what
 * this phone hosts right now, read from the owner's host agent over the phone's loopback (127.0.0.1:18187, the agent's
 * `adb reverse` door, on USB or over Wi-Fi: PVM-CPU.md "Off the cable"). It only shows: hosting runs in the foreground
 * services, which the host agent starts and stops; nothing here launches, stops or changes a VM.
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class Status {
    static final String AGENT = "http://127.0.0.1:18187/availability";
    static final int BG = 0xFF070A0F, CARD = 0xFF10161F, LINE = 0xFF1C2532, GREEN = 0xFF2FE6A8, TEXT = 0xFFE8EDF2, MUTED = 0xFF8A97A6, AMBER = 0xFFFFB454;

    /** Opened from the launcher: a release pVM CPU build with no launch plan (the host agent always names a mode). */
    static boolean launcherOpen(Activity a, Intent i) {
        return Tier.PVM_CPU.equals(Tier.of(a)) && (i == null || !i.hasExtra("mode"));
    }

    private final Activity a;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final TextView state, summary, room, footer;
    private final LinearLayout apps;

    static void show(Activity a) { new Status(a).poll(); }

    private Status(Activity a) {
        this.a = a;
        a.getWindow().setStatusBarColor(BG); a.getWindow().setNavigationBarColor(BG);
        LinearLayout col = new LinearLayout(a); col.setOrientation(LinearLayout.VERTICAL);
        col.setPadding(dp(22), dp(40), dp(22), dp(28)); col.setBackgroundColor(BG);

        LinearLayout head = new LinearLayout(a); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(a); icon.setImageDrawable(a.getApplicationInfo().loadIcon(a.getPackageManager()));
        head.addView(icon, new LinearLayout.LayoutParams(dp(44), dp(44)));
        TextView name = text("Enclave", 26, TEXT); name.setTypeface(Typeface.DEFAULT_BOLD); name.setPadding(dp(12), 0, 0, 0);
        head.addView(name);
        col.addView(head);

        state = text("Looking for the host agent…", 15, MUTED); state.setTypeface(Typeface.DEFAULT_BOLD); state.setPadding(0, dp(22), 0, dp(4));
        col.addView(state);
        summary = text("This phone runs apps for buyers, each in its own protected VM: the phone's owner cannot read an app's memory or its TLS keys.", 14, MUTED);
        col.addView(summary);

        col.addView(section("Apps on this phone"));
        apps = new LinearLayout(a); apps.setOrientation(LinearLayout.VERTICAL);
        col.addView(apps);
        col.addView(section("Room left"));
        room = text("–", 14, TEXT);
        col.addView(room);
        footer = text("", 12, MUTED); footer.setPadding(0, dp(28), 0, 0);
        col.addView(footer);

        ScrollView sv = new ScrollView(a); sv.setBackgroundColor(BG); sv.setFillViewport(true); sv.addView(col);
        a.setContentView(sv);
    }

    /** Every 5 s while the screen is open: one GET to the agent, off the UI thread. */
    private void poll() {
        if (a.isFinishing() || a.isDestroyed()) return;
        new Thread(() -> {
            JSONObject av = null; String why = null;
            try {
                java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(AGENT).openConnection();
                c.setConnectTimeout(3000); c.setReadTimeout(5000);
                try (java.io.InputStream in = c.getInputStream()) { av = new JSONObject(new String(in.readAllBytes(), "UTF-8")); }
                finally { c.disconnect(); }
            } catch (Exception e) { why = e.getClass().getSimpleName(); }
            final JSONObject got = av; final String err = why;
            ui.post(() -> render(got, err));
        }, "enclave-status").start();
        ui.postDelayed(this::poll, 5000);
    }

    private void render(JSONObject av, String err) {
        String now = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.ROOT).format(new java.util.Date());
        if (av == null) {
            state.setText("● Not connected to the host agent"); state.setTextColor(MUTED);
            summary.setText("The apps keep running in their VMs, but nothing reaches them until the owner's host agent is connected (USB or Wi-Fi).");
            apps.removeAllViews(); room.setText("–");
            footer.setText("Checked " + now + (err != null ? " (" + err + ")" : ""));
            return;
        }
        boolean serving = av.optBoolean("registered") && av.optBoolean("claimEnabled");
        JSONArray list = av.optJSONArray("apps"); int n = list == null ? 0 : list.length();
        state.setText(serving ? "● Hosting " + n + (n == 1 ? " app" : " apps") : "● Connected, not taking apps");
        state.setTextColor(serving ? GREEN : AMBER);
        summary.setText("This phone runs apps for buyers, each in its own protected VM: the phone's owner cannot read an app's memory or its TLS keys.");
        apps.removeAllViews();
        if (n == 0) apps.addView(text("None right now.", 14, MUTED));
        for (int k = 0; k < n; k++) {
            JSONObject app = list.optJSONObject(k); if (app == null) continue;
            String id = app.optString("id", ""), host = (id.length() >= 10 ? id.substring(2, 10) : id) + ".app.enclave.host";
            int cpu = app.optInt("cpuMilli", 0);
            String line2 = ("serving".equals(app.optString("phase")) ? "Serving" : "Starting") + "  ·  " + app.optInt("vmMib", 0) + " MB VM  ·  "
                         + (cpu / 10) + "% of the CPU  ·  slot " + app.optInt("slot", 0);
            apps.addView(card(host, line2, "https://" + host + "/"));
        }
        int slotsFree = av.optInt("nodeSlotsFree", 0);
        double cpuFree = av.optDouble("cpuShareFree", 0), gbFree = av.optDouble("ramGbFree", 0);
        // how many more apps fit is the shares' (the agent counts the smallest VM against the memory and CPU left)
        room.setText(Math.round(cpuFree * 100) + "% of the CPU  ·  " + String.format(java.util.Locale.ROOT, "%.1f GB", gbFree)
                     + (slotsFree > 0 ? "  ·  up to " + slotsFree + " more small " + (slotsFree == 1 ? "app" : "apps") : "  ·  full"));
        long price6 = av.optLong("askCpuPricePerSec6", 0);
        footer.setText(av.optString("name", "") + (price6 > 0 ? "  ·  $" + String.format(java.util.Locale.ROOT, "%.4f", price6 * 3600 / 1e6) + " an hour for the whole phone" : "")
                       + "\nUpdated " + now);
    }

    private View card(String title, String detail, String url) {
        LinearLayout c = new LinearLayout(a); c.setOrientation(LinearLayout.VERTICAL); c.setPadding(dp(14), dp(12), dp(14), dp(12));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(CARD); bg.setCornerRadius(dp(12)); bg.setStroke(dp(1), LINE);
        c.setBackground(bg);
        TextView t = text(title, 15, TEXT); t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        c.addView(t); c.addView(text(detail, 13, MUTED));
        c.setOnClickListener(v -> { try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {} });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8); c.setLayoutParams(lp);
        return c;
    }
    private TextView section(String s) { TextView t = text(s.toUpperCase(java.util.Locale.ROOT), 12, GREEN); t.setTypeface(Typeface.DEFAULT_BOLD); t.setLetterSpacing(0.08f); t.setPadding(0, dp(26), 0, dp(4)); return t; }
    private TextView text(String s, int sp, int color) { TextView t = new TextView(a); t.setText(s); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color); t.setLineSpacing(0, 1.15f); return t; }
    private int dp(int v) { return Math.round(v * a.getResources().getDisplayMetrics().density); }
}
