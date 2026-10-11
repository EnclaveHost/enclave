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
import android.widget.EditText;
import android.text.InputType;
import android.content.res.ColorStateList;
import android.widget.TextView;
import org.json.JSONArray;
import org.json.JSONObject;

final class Status {
    static final String AGENT = "http://127.0.0.1:18187/availability", EARNINGS = "http://127.0.0.1:18187/v1/earnings";
    // the screen speaks of apps only (Steven, 2026-10-11): how an app is kept apart is not this screen's to explain
    static final String ABOUT = "This phone runs apps for buyers. Each app is sealed off on its own: not even the phone's owner can read its memory or its keys.";
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
    private final TextView apply, cancel;
    // what is in effect (saved for the host agent) -- the sliders may differ until Apply
    private int appliedCpu = 1000, appliedMem = 4096; private boolean hosting = true, settingsKnown = false, quiet = false;
    private int lastAppCount = 0;
    // earnings and the payout address (Earnings / Payout address sections)
    private final TextView ready, paid, total, rate, payoutNote, payoutSave, payoutCancel;
    private final EditText payoutField;
    private String appliedPayout = null;   // the address in effect (saved here, else the agent's), lowercase
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
        summary = text(ABOUT, 14, MUTED);
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
        TextView gpu = text("GPU  ·  not shared: apps on this phone can't use its GPU, so they run on the CPU.", 14, MUTED);
        gpu.setPadding(0, dp(10), 0, 0); col.addView(gpu);
        apply = text("Apply", 15, BG); apply.setTypeface(Typeface.DEFAULT_BOLD); apply.setGravity(Gravity.CENTER); apply.setPadding(dp(20), dp(10), dp(20), dp(10));
        apply.setOnClickListener(v -> { if (dirty()) save(barCpu(), barMem(), hosting, "Applied: the host agent takes it within half a minute. Apps already running keep their share."); });
        // Cancel: the sliders back to what is in effect, nothing saved
        cancel = text("Cancel", 15, MUTED); cancel.setTypeface(Typeface.DEFAULT_BOLD); cancel.setGravity(Gravity.CENTER); cancel.setPadding(dp(20), dp(10), dp(20), dp(10));
        cancel.setOnClickListener(v -> cancelEdits());
        LinearLayout buttons = new LinearLayout(a); buttons.setOrientation(LinearLayout.HORIZONTAL);
        buttons.addView(apply);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); cp.leftMargin = dp(12);
        buttons.addView(cancel, cp);
        LinearLayout.LayoutParams ap = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); ap.topMargin = dp(14);
        col.addView(buttons, ap);
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
        // Earnings: from the ledger, through the host agent
        col.addView(section("Earnings"));
        ready = row(col, "Ready to pay out"); paid = row(col, "Paid out so far"); total = row(col, "Earned in total"); rate = row(col, "Earning now");
        // Payout address: where earnings are paid, automatically
        col.addView(section("Payout address"));
        payoutField = new EditText(a); payoutField.setSingleLine(true); payoutField.setTypeface(Typeface.MONOSPACE); payoutField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        payoutField.setTextColor(TEXT); payoutField.setHintTextColor(LINE); payoutField.setHint("0x…");
        payoutField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        GradientDrawable fb = new GradientDrawable(); fb.setCornerRadius(dp(10)); fb.setColor(CARD); fb.setStroke(dp(1), LINE);
        payoutField.setBackground(fb); payoutField.setPadding(dp(12), dp(10), dp(12), dp(10));
        col.addView(payoutField);
        payoutSave = text("Save", 15, BG); payoutSave.setTypeface(Typeface.DEFAULT_BOLD); payoutSave.setGravity(Gravity.CENTER); payoutSave.setPadding(dp(20), dp(10), dp(20), dp(10));
        payoutCancel = text("Cancel", 15, MUTED); payoutCancel.setTypeface(Typeface.DEFAULT_BOLD); payoutCancel.setGravity(Gravity.CENTER); payoutCancel.setPadding(dp(20), dp(10), dp(20), dp(10));
        payoutSave.setOnClickListener(v -> confirmPayout());
        payoutCancel.setOnClickListener(v -> { payoutField.setText(appliedPayout == null ? "" : appliedPayout); payoutState(); });
        LinearLayout pb = new LinearLayout(a); pb.setOrientation(LinearLayout.HORIZONTAL); pb.addView(payoutSave);
        LinearLayout.LayoutParams pcp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); pcp.leftMargin = dp(12);
        pb.addView(payoutCancel, pcp);
        LinearLayout.LayoutParams pbp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); pbp.topMargin = dp(12);
        col.addView(pb, pbp);
        payoutNote = text("", 12, MUTED); payoutNote.setPadding(0, dp(8), 0, 0); col.addView(payoutNote);
        payoutField.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int st2, int n, int af) { }
            @Override public void onTextChanged(CharSequence c, int st2, int b, int n) { }
            @Override public void afterTextChanged(android.text.Editable e) { payoutState(); }
        });
        if (saved != null && saved[3] != null) { appliedPayout = (String) saved[3]; payoutField.setText(appliedPayout); }
        payoutState();

        footer = text("", 12, MUTED); footer.setPadding(0, dp(28), 0, 0);
        col.addView(footer);

        ScrollView sv = new ScrollView(a); sv.setBackgroundColor(BG); sv.setFillViewport(true); sv.addView(col);
        a.setContentView(sv);
    }

    /** Every 5 s while the screen is open: one GET to the agent, off the UI thread. */
    private void poll() {
        if (a.isFinishing() || a.isDestroyed()) return;
        new Thread(() -> {
            JSONObject av = null, earn = null; String why = null;
            try { av = getJson(AGENT); } catch (Exception e) { why = e.getClass().getSimpleName(); }
            if (av != null) { try { earn = getJson(EARNINGS); } catch (Exception ignored) { } }
            final JSONObject got = av, gotEarn = earn; final String err = why;
            ui.post(() -> { render(got, err); renderEarnings(gotEarn); });
        }, "enclave-status").start();
        ui.postDelayed(this::poll, 5000);
    }

    private static JSONObject getJson(String url) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(3000); c.setReadTimeout(5000);
        try (java.io.InputStream in = c.getInputStream()) { return new JSONObject(new String(in.readAllBytes(), "UTF-8")); }
        finally { c.disconnect(); }
    }

    // ---- earnings and the payout address ----
    static String usd(long micro) {   // USDC has 6 decimals; under a cent, four places
        return micro == 0 ? "$0.00" : micro < 10_000 ? String.format(java.util.Locale.ROOT, "$%.4f", micro / 1e6) : String.format(java.util.Locale.ROOT, "$%.2f", micro / 1e6);
    }
    private static long micro(JSONObject o, String k) { try { return Long.parseLong(o.optString(k, "0")); } catch (Exception e) { return 0; } }
    private static String shortAddr(String a) { return a.length() == 42 ? a.substring(0, 6) + "…" + a.substring(38) : a; }
    private void renderEarnings(JSONObject e) {
        if (e == null) { for (TextView t : new TextView[] { ready, paid, total, rate }) t.setText("–"); return; }
        ready.setText(usd(micro(e, "readyToPay6"))); paid.setText(usd(micro(e, "paidOut6"))); total.setText(usd(micro(e, "earnedAllTime6")));
        rate.setText(usd(micro(e, "ratePerHour6")) + " an hour");
        JSONObject p = e.optJSONObject("payout");
        if (appliedPayout == null && p != null && !payoutField.hasFocus()) {   // nothing saved here: the agent's (its config's)
            String to = p.optString("to", "");
            if (to.matches("0x[0-9a-f]{40}")) { appliedPayout = to; payoutField.setText(to); }
        }
        long min = p == null ? 1_000_000 : micro(p, "minWithdraw6");
        if (!dirtyPayout()) payoutNote.setText(p == null ? "No payout address yet: earnings wait on the ledger until you set one."
                                                         : "Paid automatically to " + shortAddr(p.optString("to")) + " once " + usd(min) + " has built up.");
    }
    private String typedPayout() { return payoutField.getText().toString().trim().toLowerCase(java.util.Locale.ROOT); }
    private boolean dirtyPayout() { return !typedPayout().equals(appliedPayout == null ? "" : appliedPayout); }
    private boolean validPayout() { return typedPayout().matches("0x[0-9a-f]{40}") && !typedPayout().matches("0x0{40}"); }
    /** Save and Cancel are live only while the field differs from the address in effect; Save only for an address. */
    private void payoutState() {
        boolean dirty = dirtyPayout(), ok = dirty && validPayout();
        payoutSave.setEnabled(ok); payoutSave.setClickable(ok);
        GradientDrawable sb = new GradientDrawable(); sb.setCornerRadius(dp(10)); sb.setColor(ok ? GREEN : LINE);
        payoutSave.setBackground(sb); payoutSave.setTextColor(ok ? BG : MUTED);
        payoutCancel.setEnabled(dirty); payoutCancel.setClickable(dirty);
        GradientDrawable cb = new GradientDrawable(); cb.setCornerRadius(dp(10)); cb.setColor(BG); cb.setStroke(dp(1), dirty ? MUTED : LINE);
        payoutCancel.setBackground(cb); payoutCancel.setTextColor(dirty ? TEXT : LINE);
        if (dirty) payoutNote.setText(validPayout() ? "Save to pay future earnings to this address." : "Not an address yet: 0x followed by 40 characters (0-9, a-f).");
    }
    /** Payouts cannot be undone: the owner confirms the address first. */
    private void confirmPayout() {
        if (!dirtyPayout() || !validPayout()) return;
        final String to = typedPayout();
        new android.app.AlertDialog.Builder(a, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Pay earnings to this address?")
            .setMessage(to + "\n\nPayouts can't be undone, so make sure this address is yours.")
            .setPositiveButton("Save", (d, w) -> {
                String was = appliedPayout; appliedPayout = to;
                boolean ok = save(appliedCpu, appliedMem, hosting, null);
                if (!ok) appliedPayout = was;
                payoutState();
                payoutNote.setText(ok ? "Saved: earnings are paid to " + shortAddr(to) + " from now on (the host agent takes it within half a minute)."
                                      : "Not saved: the address is unchanged."); })
            .setNegativeButton("Cancel", null)
            .show();
    }
    private TextView row(LinearLayout col, String label) {
        LinearLayout r = new LinearLayout(a); r.setOrientation(LinearLayout.HORIZONTAL); r.setPadding(0, dp(3), 0, dp(3));
        r.addView(text(label, 14, MUTED), new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        TextView v = text("–", 14, TEXT); v.setTypeface(Typeface.DEFAULT_BOLD); r.addView(v);
        col.addView(r);
        return v;
    }

    private void render(JSONObject av, String err) {
        String now = new java.text.SimpleDateFormat("HH:mm:ss", java.util.Locale.ROOT).format(new java.util.Date());
        if (av == null) {
            state.setText("● Not connected to the host agent"); state.setTextColor(MUTED);
            summary.setText("The apps keep running, but nothing reaches them until the owner's host agent is connected (USB or Wi-Fi).");
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
                        : ABOUT);
        apps.removeAllViews();
        if (n == 0) apps.addView(text("None right now.", 14, MUTED));
        for (int k = 0; k < n; k++) {
            JSONObject app = list.optJSONObject(k); if (app == null) continue;
            String id = app.optString("id", ""), host = (id.length() >= 10 ? id.substring(2, 10) : id) + ".app.enclave.host";
            int cpu = app.optInt("cpuMilli", 0);
            String line2 = ("serving".equals(app.optString("phase")) ? "Serving" : "Starting") + "  ·  " + app.optInt("vmMib", 0) + " MB  ·  "
                         + (cpu < 10 ? "under 1" : String.valueOf(cpu / 10)) + "% of the CPU";
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
        memLabel.setText("Memory  ·  " + String.format(java.util.Locale.ROOT, "%.2f GB", barMem() / 1024.0) + " for apps");
    }
    private boolean dirty() { return barCpu() != appliedCpu || barMem() != appliedMem; }
    /** Cancel: the sliders back to what is in effect; nothing saved. */
    private void cancelEdits() {
        if (!dirty()) return;
        cpuBar.setProgress(cpuToBar(appliedCpu)); memBar.setProgress(memToBar(appliedMem)); labels(); applyState();
        sharingNote.setText("Not changed: still " + appliedCpu / 10 + "% of the CPU and " + String.format(java.util.Locale.ROOT, "%.2f GB", appliedMem / 1024.0) + ".");
    }
    /** Apply is live only when the sliders differ from what is in effect. */
    private void applyState() {
        boolean on = dirty();
        apply.setEnabled(on); apply.setClickable(on);
        GradientDrawable bg = new GradientDrawable(); bg.setCornerRadius(dp(10)); bg.setColor(on ? GREEN : LINE);
        apply.setBackground(bg); apply.setTextColor(on ? BG : MUTED);
        // Cancel: live with Apply, outlined (the quieter choice)
        cancel.setEnabled(on); cancel.setClickable(on);
        GradientDrawable cb = new GradientDrawable(); cb.setCornerRadius(dp(10)); cb.setColor(BG); cb.setStroke(dp(1), on ? MUTED : LINE);
        cancel.setBackground(cb); cancel.setTextColor(on ? TEXT : LINE);
    }
    /** The switch: on saves at once; off with apps here asks first (they are released). */
    private void toggle(boolean on) {
        if (on) { save(appliedCpu, appliedMem, true, "Hosting on: the host agent starts taking apps within half a minute."); return; }
        if (lastAppCount == 0) { save(appliedCpu, appliedMem, false, "Hosting off: nothing runs here and no app is taken."); return; }
        new android.app.AlertDialog.Builder(a, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Turn hosting off?")
            .setMessage((lastAppCount == 1 ? "The app running here will be released: it moves to another host or waits for one."
                                           : "The " + lastAppCount + " apps running here will be released: they move to other hosts or wait for one.")
                        + " Nothing runs on this phone until you turn hosting on again.")
            .setPositiveButton("Turn off", (d, w) -> save(appliedCpu, appliedMem, false, "Hosting off: releasing the apps here."))
            .setNegativeButton("Cancel", (d, w) -> { quiet = true; hostSwitch.setChecked(true); quiet = false; })
            .setOnCancelListener(d -> { quiet = true; hostSwitch.setChecked(true); quiet = false; })
            .show();
    }
    private java.io.File offerFile() { return new java.io.File(a.getFilesDir(), "offer.json"); }
    /** What this phone last saved: { cpuMilli, memMb, hosting }, or null. */
    private Object[] readOffer() {
        try {
            JSONObject o = new JSONObject(new String(java.nio.file.Files.readAllBytes(offerFile().toPath()), "UTF-8"));
            String to = o.optString("payoutTo", "");
            return new Object[] { o.getInt("cpuMilli"), o.getInt("memMb"), o.optBoolean("hosting", true), to.matches("0x[0-9a-fA-F]{40}") ? to.toLowerCase(java.util.Locale.ROOT) : null };
        } catch (Exception e) { return null; }
    }
    /** Saved where only this app (and the owner's adb) can write; the host agent reads it on its next round. */
    private boolean save(int cpu, int mem, boolean host, String said) {
        boolean ok = false;
        try {
            JSONObject o = new JSONObject().put("v", 1).put("hosting", host).put("cpuMilli", cpu).put("memMb", mem)
                .put("at", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", java.util.Locale.ROOT).format(new java.util.Date()));
            if (appliedPayout != null) o.put("payoutTo", appliedPayout);
            java.io.File t = new java.io.File(a.getFilesDir(), "offer.json.tmp");
            java.nio.file.Files.write(t.toPath(), (o.toString() + "\n").getBytes("UTF-8"));
            if (!t.renameTo(offerFile())) throw new java.io.IOException("rename");
            appliedCpu = cpu; appliedMem = mem; hosting = host; settingsKnown = true; ok = true;
            if (said != null) sharingNote.setText(said);
        } catch (Exception e) { sharingNote.setText("Not saved: " + e.getMessage()); quiet = true; hostSwitch.setChecked(hosting); quiet = false; }
        applyState();
        return ok;
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
