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
import android.widget.SeekBar;
import android.widget.Switch;
import android.content.res.ColorStateList;
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
    private final TextView state, summary, room, footer, cpuLabel, memLabel, sharingNote;
    private final LinearLayout apps;
    private final SeekBar cpuBar, memBar;
    private final Switch hostSwitch;
    private final TextView apply;
    // what is in effect (saved for the host agent) -- the sliders may differ until Apply
    private int appliedCpu = 1000, appliedMem = 4096; private boolean hosting = true, settingsKnown = false, quiet = false;
    private int lastAppCount = 0;
    // the owner's offer (files/offer.json, which the host agent reads each round): CPU per mille, VM memory in MiB
    static final int CPU_STEP = 50, MEM_STEP = 256, MEM_MIN = 256;
    private int memMax = 4096;              // the agent's ceiling (its config's pool), learned from /availability
    private boolean offerShown = false;     // the sliders take the agent's offer once (no saved file), then only the owner moves them

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

        // the on/off switch: hosting entirely (off releases every app here and ends every VM)
        LinearLayout row = new LinearLayout(a); row.setOrientation(LinearLayout.HORIZONTAL); row.setGravity(Gravity.CENTER_VERTICAL); row.setPadding(0, dp(22), 0, 0);
        TextView hl = text("Hosting", 17, TEXT); hl.setTypeface(Typeface.DEFAULT_BOLD);
        row.addView(hl, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        hostSwitch = new Switch(a);
        int[][] st = { { android.R.attr.state_checked }, {} };
        hostSwitch.setThumbTintList(new ColorStateList(st, new int[] { GREEN, MUTED }));
        hostSwitch.setTrackTintList(new ColorStateList(st, new int[] { 0x802FE6A8, LINE }));
        row.addView(hostSwitch);
        col.addView(row);
        state = text("Looking for the host agent…", 15, MUTED); state.setTypeface(Typeface.DEFAULT_BOLD); state.setPadding(0, dp(10), 0, dp(4));
        col.addView(state);
        summary = text("This phone runs apps for buyers, each in its own protected VM: the phone's owner cannot read an app's memory or its TLS keys.", 14, MUTED);
        col.addView(summary);

        col.addView(section("Apps on this phone"));
        apps = new LinearLayout(a); apps.setOrientation(LinearLayout.VERTICAL);
        col.addView(apps);
        col.addView(section("Room left"));
        room = text("–", 14, TEXT);
        col.addView(room);

        // Sharing: how much of this phone the owner offers to host apps
        col.addView(section("Sharing"));
        cpuLabel = text("CPU", 14, TEXT); col.addView(cpuLabel);
        cpuBar = new SeekBar(a); cpuBar.setMax(1000 / CPU_STEP - 1); col.addView(cpuBar);
        memLabel = text("Memory", 14, TEXT); memLabel.setPadding(0, dp(10), 0, 0); col.addView(memLabel);
        memBar = new SeekBar(a); col.addView(memBar);
        TextView gpu = text("GPU  ·  not shared: a protected VM on this phone cannot use its GPU, so apps here run on the CPU.", 14, MUTED);
        gpu.setPadding(0, dp(10), 0, 0); col.addView(gpu);
        apply = text("Apply", 15, BG); apply.setTypeface(Typeface.DEFAULT_BOLD); apply.setGravity(Gravity.CENTER); apply.setPadding(dp(20), dp(10), dp(20), dp(10));
        apply.setOnClickListener(v -> { if (dirty()) save(barCpu(), barMem(), hosting, "Applied: the host agent takes it within half a minute. Apps already running keep their share."); });
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); ap.topMargin = dp(14);
        col.addView(apply, ap);
        sharingNote = text("New apps are taken only within what you share; apps already running keep theirs.", 12, MUTED);
        sharingNote.setPadding(0, dp(8), 0, 0); col.addView(sharingNote);
        SeekBar.OnSeekBarChangeListener l = new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar b, int p, boolean user) { labels(); applyState(); }
            @Override public void onStartTrackingTouch(SeekBar b) { }
            @Override public void onStopTrackingTouch(SeekBar b) { }
        };
        cpuBar.setOnSeekBarChangeListener(l); memBar.setOnSeekBarChangeListener(l);
        setMemMax(memMax);
        Object[] saved = readOffer();   // until the agent answers: what this phone last saved, else all of it, hosting on
        if (saved != null) { appliedCpu = (Integer) saved[0]; appliedMem = (Integer) saved[1]; hosting = (Boolean) saved[2]; settingsKnown = true; }
        else { appliedCpu = 1000; appliedMem = memMax; }
        cpuBar.setProgress(cpuToBar(appliedCpu)); memBar.setProgress(memToBar(appliedMem));
        quiet = true; hostSwitch.setChecked(hosting); quiet = false;
        hostSwitch.setOnCheckedChangeListener((b, on) -> { if (!quiet) toggle(on); });
        labels(); applyState();
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
        boolean serving = av.optBoolean("registered") && av.optBoolean("claimEnabled"), agentHosting = av.optBoolean("hosting", true);
        JSONArray list = av.optJSONArray("apps"); int n = list == null ? 0 : list.length(); lastAppCount = n;
        if (hosting != agentHosting) {   // saved here, not yet taken by the agent (it reads the setting every half minute)
            state.setText(hosting ? "● Turning hosting on…" : "● Turning hosting off…" + (n > 0 ? " releasing " + n + (n == 1 ? " app" : " apps") : ""));
            state.setTextColor(AMBER);
        } else if (!agentHosting) {
            state.setText(n > 0 ? "● Hosting off: releasing " + n + (n == 1 ? " app" : " apps") + "…" : "● Hosting off"); state.setTextColor(MUTED);
        } else {
            state.setText(serving ? "● Hosting " + n + (n == 1 ? " app" : " apps") : "● Connected, not taking apps yet");
            state.setTextColor(serving ? GREEN : AMBER);
        }
        summary.setText(!agentHosting && !hosting ? "This phone hosts nothing: no app runs here and none is taken. Turn hosting on to take apps again."
                        : "This phone runs apps for buyers, each in its own protected VM: the phone's owner cannot read an app's memory or its TLS keys.");
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
        if (av.has("poolMemMbMax")) setMemMax(av.optInt("poolMemMbMax", memMax));
        JSONObject off = av.optJSONObject("offer");
        if (off != null && !offerShown && !settingsKnown && !cpuBar.isPressed() && !memBar.isPressed()) {   // nothing saved here: the agent's
            offerShown = true;
            appliedCpu = off.optInt("cpuMilli", 1000); appliedMem = off.optInt("memMb", memMax);
            cpuBar.setProgress(cpuToBar(appliedCpu)); memBar.setProgress(memToBar(appliedMem)); labels(); applyState();
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

    // ---- the offer: the sliders, and the file the host agent reads ----
    private int cpuToBar(int milli) { return Math.max(0, Math.min(cpuBar.getMax(), Math.round(milli / (float) CPU_STEP) - 1)); }
    private int barCpu() { return (cpuBar.getProgress() + 1) * CPU_STEP; }
    private int memToBar(int mb) { return Math.max(0, Math.min(memBar.getMax(), Math.round((mb - MEM_MIN) / (float) MEM_STEP))); }
    private int barMem() { return Math.min(memMax, MEM_MIN + memBar.getProgress() * MEM_STEP); }
    private void setMemMax(int max) { memMax = Math.max(MEM_MIN, max); memBar.setMax(Math.max(1, (memMax - MEM_MIN + MEM_STEP - 1) / MEM_STEP)); }
    private void labels() {
        cpuLabel.setText("CPU  ·  " + barCpu() / 10 + "% of this phone");
        memLabel.setText("Memory  ·  " + String.format(java.util.Locale.ROOT, "%.2f GB", barMem() / 1024.0) + " for apps' VMs");
    }
    private boolean dirty() { return barCpu() != appliedCpu || barMem() != appliedMem; }
    /** Apply is live only when the sliders differ from what is in effect. */
    private void applyState() {
        boolean on = dirty();
        apply.setEnabled(on); apply.setClickable(on);
        GradientDrawable bg = new GradientDrawable(); bg.setCornerRadius(dp(10)); bg.setColor(on ? GREEN : LINE);
        apply.setBackground(bg); apply.setTextColor(on ? BG : MUTED);
    }
    /** The switch: on saves at once; off with apps here asks first (they are released). */
    private void toggle(boolean on) {
        if (on) { save(appliedCpu, appliedMem, true, "Hosting on: the host agent starts taking apps within half a minute."); return; }
        if (lastAppCount == 0) { save(appliedCpu, appliedMem, false, "Hosting off: nothing runs here and no app is taken."); return; }
        new android.app.AlertDialog.Builder(a, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Turn hosting off?")
            .setMessage((lastAppCount == 1 ? "The app running here will be released: a final proof, then its owner's deployment moves"
                                           : "The " + lastAppCount + " apps running here will be released: a final proof, then their owners' deployments move")
                        + " to another host or waits. Nothing runs on this phone until you turn hosting on again.")
            .setPositiveButton("Turn off", (d, w) -> save(appliedCpu, appliedMem, false, "Hosting off: releasing the apps here, then ending every VM."))
            .setNegativeButton("Cancel", (d, w) -> { quiet = true; hostSwitch.setChecked(true); quiet = false; })
            .setOnCancelListener(d -> { quiet = true; hostSwitch.setChecked(true); quiet = false; })
            .show();
    }
    private java.io.File offerFile() { return new java.io.File(a.getFilesDir(), "offer.json"); }
    /** What this phone last saved: { cpuMilli, memMb, hosting }, or null. */
    private Object[] readOffer() {
        try {
            JSONObject o = new JSONObject(new String(java.nio.file.Files.readAllBytes(offerFile().toPath()), "UTF-8"));
            return new Object[] { o.getInt("cpuMilli"), o.getInt("memMb"), o.optBoolean("hosting", true) };
        } catch (Exception e) { return null; }
    }
    /** Saved where only this app (and the owner's adb) can write; the host agent reads it on its next round. */
    private void save(int cpu, int mem, boolean host, String said) {
        try {
            JSONObject o = new JSONObject().put("v", 1).put("hosting", host).put("cpuMilli", cpu).put("memMb", mem)
                .put("at", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", java.util.Locale.ROOT).format(new java.util.Date()));
            java.io.File t = new java.io.File(a.getFilesDir(), "offer.json.tmp");
            java.nio.file.Files.write(t.toPath(), (o.toString() + "\n").getBytes("UTF-8"));
            if (!t.renameTo(offerFile())) throw new java.io.IOException("rename");
            appliedCpu = cpu; appliedMem = mem; hosting = host; settingsKnown = true;
            sharingNote.setText(said);
        } catch (Exception e) { sharingNote.setText("Not saved: " + e.getMessage()); quiet = true; hostSwitch.setChecked(hosting); quiet = false; }
        applyState();
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
