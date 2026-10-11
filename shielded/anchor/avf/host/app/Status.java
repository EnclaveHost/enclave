/*
 * Status -- what the Enclave app shows when it is opened from the launcher (a release pVM CPU build, no launch extras), read
 * from the owner's host agent over the phone's loopback (127.0.0.1:18187, the agent's `adb reverse` door, on USB or over
 * Wi-Fi: PVM-CPU.md "Off the cable"). Two pages, kept plain (Steven, 2026-10-11: "too cluttered"):
 *   main      the Hosting switch, one status line, Earnings (what is ready to pay out), Sharing -- the CPU share bar (Apply
 *             and Cancel appear once it moves; no GPU share in the mobile app) --, the apps here by name, Settings;
 *   settings  memory for apps (Apply and Cancel likewise) and the payout address (Save and Cancel likewise, confirmed:
 *             payouts cannot be undone).
 * The screen speaks of apps only. Its settings go to files/offer.json, which only this app (and the owner's adb) can write
 * and the host agent reads every half minute; the screen never starts or stops anything itself.
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.content.Intent;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.Switch;
import android.widget.TextView;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONObject;

final class Status {
    static final String AGENT = "http://127.0.0.1:18187/availability", EARNINGS = "http://127.0.0.1:18187/v1/earnings";
    static final int BG = 0xFF070A0F, CARD = 0xFF10161F, LINE = 0xFF1C2532, GREEN = 0xFF2FE6A8, TEXT = 0xFFE8EDF2, MUTED = 0xFF8A97A6, AMBER = 0xFFFFB454;
    // the owner's offer (files/offer.json): CPU per mille, memory in MiB
    static final int CPU_STEP = 50, MEM_STEP = 256, MEM_MIN = 256;

    /** Opened from the launcher: a release pVM CPU build with no launch plan (the host agent always names a mode). */
    static boolean launcherOpen(Activity a, Intent i) {
        return Tier.PVM_CPU.equals(Tier.of(a)) && (i == null || !i.hasExtra("mode"));
    }
    private static Status current;
    static void show(Activity a) { current = new Status(a); current.poll(); }
    /** The system back gesture: from Settings to the main page (true), else the activity's own (false). */
    static boolean back() { Status s = current; if (s == null || !s.inSettings) return false; s.showMain(); return true; }

    private final Activity a;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ScrollView scroll;
    private final LinearLayout mainPage, settingsPage, apps, cpuButtons, memButtons, payoutButtons;
    private final TextView state, stateNote, earnings, cpuLabel, memLabel, payoutNote, payoutSave, payoutCancel;
    private final SeekBar cpuBar, memBar;
    private final Switch hostSwitch;
    private final EditText payoutField;
    private boolean inSettings = false;
    // what is in effect (saved for the host agent); the controls may differ until Apply / Save
    private int appliedCpu = 1000, appliedMem = 4096, memMax = 4096, lastAppCount = 0;
    private boolean hosting = true, settingsKnown = false, offerShown = false, quiet = false;
    private String appliedPayout = null, payoutSaid = "";

    private Status(Activity a) {
        this.a = a;
        a.getWindow().setStatusBarColor(BG); a.getWindow().setNavigationBarColor(BG);

        // ---- main page ----
        mainPage = page();
        LinearLayout head = new LinearLayout(a); head.setOrientation(LinearLayout.HORIZONTAL); head.setGravity(Gravity.CENTER_VERTICAL);
        ImageView icon = new ImageView(a); icon.setImageDrawable(a.getApplicationInfo().loadIcon(a.getPackageManager()));
        head.addView(icon, new LinearLayout.LayoutParams(dp(36), dp(36)));
        TextView name = text("Enclave", 24, TEXT); name.setTypeface(Typeface.DEFAULT_BOLD); name.setPadding(dp(10), 0, 0, 0);
        head.addView(name, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        hostSwitch = new Switch(a);   // hosting on or off entirely
        int[][] st = { { android.R.attr.state_checked }, {} };
        hostSwitch.setThumbTintList(new ColorStateList(st, new int[] { GREEN, MUTED }));
        hostSwitch.setTrackTintList(new ColorStateList(st, new int[] { 0x802FE6A8, LINE }));
        head.addView(hostSwitch);
        mainPage.addView(head);
        state = text("Connecting…", 16, MUTED); state.setTypeface(Typeface.DEFAULT_BOLD); state.setPadding(0, dp(18), 0, 0);
        mainPage.addView(state);
        stateNote = text("", 13, MUTED); stateNote.setVisibility(View.GONE); stateNote.setPadding(0, dp(4), 0, 0);
        mainPage.addView(stateNote);
        mainPage.addView(section("Earnings"));
        earnings = text("–", 32, TEXT); earnings.setTypeface(Typeface.DEFAULT_BOLD);
        mainPage.addView(earnings);
        // Sharing: the CPU share offered to apps (Apply and Cancel appear once it moves). No GPU share: the mobile app has
        // none (Steven, 2026-10-11)
        mainPage.addView(section("Sharing"));
        cpuLabel = text("CPU", 15, TEXT); mainPage.addView(cpuLabel);
        cpuBar = new SeekBar(a); cpuBar.setMax(1000 / CPU_STEP - 1); mainPage.addView(cpuBar);
        TextView cpuApply = button("Apply", true); cpuApply.setOnClickListener(v -> { if (barCpu() != appliedCpu && save(barCpu(), appliedMem, hosting)) toast("Applied"); });
        TextView cpuCancel = button("Cancel", false); cpuCancel.setOnClickListener(v -> { cpuBar.setProgress(cpuToBar(appliedCpu)); labels(); applyState(); });
        cpuButtons = pair(cpuApply, cpuCancel); mainPage.addView(cpuButtons);
        mainPage.addView(section("Apps"));
        apps = new LinearLayout(a); apps.setOrientation(LinearLayout.VERTICAL);
        mainPage.addView(apps);
        TextView open = button("Settings", false); open.setOnClickListener(v -> showSettings());
        LinearLayout.LayoutParams op = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT); op.topMargin = dp(36);
        mainPage.addView(open, op);

        // ---- settings page ----
        settingsPage = page();
        TextView title = text("‹  Settings", 22, TEXT); title.setTypeface(Typeface.DEFAULT_BOLD); title.setPadding(0, dp(4), 0, dp(4));
        title.setOnClickListener(v -> showMain());
        settingsPage.addView(title);
        settingsPage.addView(section("Memory for apps"));
        memLabel = text("Memory", 15, TEXT); settingsPage.addView(memLabel);
        memBar = new SeekBar(a); settingsPage.addView(memBar);
        TextView memApply = button("Apply", true); memApply.setOnClickListener(v -> { if (barMem() != appliedMem && save(appliedCpu, barMem(), hosting)) toast("Applied"); });
        TextView memCancel = button("Cancel", false); memCancel.setOnClickListener(v -> { memBar.setProgress(memToBar(appliedMem)); labels(); applyState(); });
        memButtons = pair(memApply, memCancel); settingsPage.addView(memButtons);

        settingsPage.addView(section("Payout address"));
        payoutField = new EditText(a); payoutField.setSingleLine(true); payoutField.setTypeface(Typeface.MONOSPACE); payoutField.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13);
        payoutField.setTextColor(TEXT); payoutField.setHintTextColor(LINE); payoutField.setHint("0x…");
        payoutField.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS | InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD);
        GradientDrawable fb = new GradientDrawable(); fb.setCornerRadius(dp(10)); fb.setColor(CARD); fb.setStroke(dp(1), LINE);
        payoutField.setBackground(fb); payoutField.setPadding(dp(12), dp(10), dp(12), dp(10));
        settingsPage.addView(payoutField);
        payoutNote = text("", 13, MUTED); payoutNote.setPadding(0, dp(8), 0, 0); settingsPage.addView(payoutNote);
        payoutSave = button("Save", true); payoutSave.setOnClickListener(v -> confirmPayout());
        payoutCancel = button("Cancel", false); payoutCancel.setOnClickListener(v -> { payoutField.setText(appliedPayout == null ? "" : appliedPayout); payoutState(); });
        payoutButtons = pair(payoutSave, payoutCancel); settingsPage.addView(payoutButtons);
        settingsPage.setVisibility(View.GONE);

        // ---- what is in effect: this phone's saved settings, else (until the agent answers) all of it, hosting on ----
        SeekBar.OnSeekBarChangeListener l = new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar b, int p, boolean user) { labels(); applyState(); }
            @Override public void onStartTrackingTouch(SeekBar b) { }
            @Override public void onStopTrackingTouch(SeekBar b) { }
        };
        cpuBar.setOnSeekBarChangeListener(l); memBar.setOnSeekBarChangeListener(l);
        setMemMax(memMax);
        Object[] saved = readOffer();
        if (saved != null) { appliedCpu = (Integer) saved[0]; appliedMem = (Integer) saved[1]; hosting = (Boolean) saved[2]; appliedPayout = (String) saved[3]; settingsKnown = true; }
        else appliedMem = memMax;
        cpuBar.setProgress(cpuToBar(appliedCpu)); memBar.setProgress(memToBar(appliedMem));
        quiet = true; hostSwitch.setChecked(hosting); quiet = false;
        hostSwitch.setOnCheckedChangeListener((b, on) -> { if (!quiet) toggle(on); });
        if (appliedPayout != null) payoutField.setText(appliedPayout);
        payoutField.addTextChangedListener(new android.text.TextWatcher() {
            @Override public void beforeTextChanged(CharSequence c, int s0, int n, int af) { }
            @Override public void onTextChanged(CharSequence c, int s0, int b, int n) { }
            @Override public void afterTextChanged(android.text.Editable e) { payoutState(); }
        });
        labels(); applyState(); payoutState();

        LinearLayout both = new LinearLayout(a); both.setOrientation(LinearLayout.VERTICAL); both.addView(mainPage); both.addView(settingsPage);
        scroll = new ScrollView(a); scroll.setBackgroundColor(BG); scroll.setFillViewport(true); scroll.addView(both);
        // edge to edge (Android 15+): the content stays clear of the status and navigation bars, scrolled or not
        scroll.setClipToPadding(true);
        scroll.setOnApplyWindowInsetsListener((v, in) -> {
            android.graphics.Insets bars = in.getInsets(android.view.WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.ime());
            v.setPadding(0, bars.top, 0, bars.bottom); return in; });
        a.setContentView(scroll);
    }

    private void showSettings() { inSettings = true; mainPage.setVisibility(View.GONE); settingsPage.setVisibility(View.VISIBLE); scroll.scrollTo(0, 0); }
    private void showMain() {
        inSettings = false; settingsPage.setVisibility(View.GONE); mainPage.setVisibility(View.VISIBLE); scroll.scrollTo(0, 0);
        android.view.inputmethod.InputMethodManager im = a.getSystemService(android.view.inputmethod.InputMethodManager.class);
        if (im != null) im.hideSoftInputFromWindow(payoutField.getWindowToken(), 0);
    }

    /** Every 5 s while the screen is open: the agent's availability and earnings, off the UI thread. */
    private void poll() {
        if (a.isFinishing() || a.isDestroyed()) return;
        new Thread(() -> {
            JSONObject av = null, earn = null;
            try { av = getJson(AGENT); } catch (Exception ignored) { }
            if (av != null) { try { earn = getJson(EARNINGS); } catch (Exception ignored) { } }
            final JSONObject gotAv = av, gotEarn = earn;
            ui.post(() -> { render(gotAv); renderEarnings(gotEarn); });
        }, "enclave-status").start();
        ui.postDelayed(this::poll, 5000);
    }
    private static JSONObject getJson(String url) throws Exception {
        java.net.HttpURLConnection c = (java.net.HttpURLConnection) new java.net.URL(url).openConnection();
        c.setConnectTimeout(3000); c.setReadTimeout(5000);
        try (java.io.InputStream in = c.getInputStream()) { return new JSONObject(new String(in.readAllBytes(), "UTF-8")); }
        finally { c.disconnect(); }
    }

    // ---- main page ----
    private void render(JSONObject av) {
        if (av == null) {
            setState("● Not connected", MUTED, "Apps here keep running, but can't be reached until this phone reconnects to its host computer.");
            return;
        }
        boolean serving = av.optBoolean("registered") && av.optBoolean("claimEnabled"), agentHosting = av.optBoolean("hosting", true);
        JSONArray list = av.optJSONArray("apps"); int n = list == null ? 0 : list.length(); lastAppCount = n;
        String apps1 = n + (n == 1 ? " app" : " apps");
        if (hosting != agentHosting) setState(hosting ? "● Turning hosting on…" : "● Turning hosting off…", AMBER, null);   // saved, not yet taken
        else if (!agentHosting) setState(n > 0 ? "● Hosting off: releasing " + apps1 + "…" : "● Hosting off", MUTED, null);
        else if (serving) setState("● Hosting " + apps1, GREEN, null);
        else setState("● Starting…", AMBER, null);
        apps.removeAllViews();
        if (n == 0) apps.addView(text("None right now.", 15, MUTED));
        for (int k = 0; k < n; k++) {
            JSONObject app = list.optJSONObject(k); if (app == null) continue;
            String id = app.optString("id", ""), host = (id.length() >= 10 ? id.substring(2, 10) : id) + ".app.enclave.host";
            apps.addView(card(host, "serving".equals(app.optString("phase")) ? null : "Starting…", "https://" + host + "/"));
        }
        if (av.has("poolMemMbMax")) setMemMax(av.optInt("poolMemMbMax", memMax));
        JSONObject off = av.optJSONObject("offer");
        if (off != null && !offerShown && !settingsKnown && !cpuBar.isPressed() && !memBar.isPressed()) {   // nothing saved here: the agent's
            offerShown = true;
            appliedCpu = off.optInt("cpuMilli", 1000); appliedMem = off.optInt("memMb", memMax);
            cpuBar.setProgress(cpuToBar(appliedCpu)); memBar.setProgress(memToBar(appliedMem)); labels(); applyState();
        }
    }
    private void setState(String s, int color, String note) {
        state.setText(s); state.setTextColor(color);
        stateNote.setText(note == null ? "" : note); stateNote.setVisibility(note == null ? View.GONE : View.VISIBLE);
    }
    private void renderEarnings(JSONObject e) {
        if (e == null) { earnings.setText("–"); return; }
        earnings.setText(usd(micro(e, "readyToPay6")));
        JSONObject p = e.optJSONObject("payout");
        if (appliedPayout == null && p != null && !payoutField.hasFocus()) {   // nothing saved here: the agent's (its config's)
            String to = p.optString("to", "");
            if (to.matches("0x[0-9a-f]{40}")) { appliedPayout = to; payoutField.setText(to); }
        }
        payoutSaid = p == null ? "No payout address yet: earnings wait until you set one."
                               : "Paid automatically once " + usd(p == null ? 1_000_000 : micro(p, "minWithdraw6")) + " has built up.";
        payoutState();
    }
    static String usd(long micro) {   // USDC has 6 decimals; under a cent, four places
        return micro == 0 ? "$0.00" : micro < 10_000 ? String.format(java.util.Locale.ROOT, "$%.4f", micro / 1e6) : String.format(java.util.Locale.ROOT, "$%.2f", micro / 1e6);
    }
    private static long micro(JSONObject o, String k) { try { return Long.parseLong(o.optString(k, "0")); } catch (Exception e) { return 0; } }

    /** The switch: on saves at once; off with apps here asks first (they are released). */
    private void toggle(boolean on) {
        if (on || lastAppCount == 0) { if (!save(appliedCpu, appliedMem, on)) revertSwitch(); return; }
        new android.app.AlertDialog.Builder(a, android.R.style.Theme_Material_Dialog_Alert)
            .setTitle("Turn hosting off?")
            .setMessage((lastAppCount == 1 ? "The app running here will move to another host or wait for one."
                                           : "The " + lastAppCount + " apps running here will move to other hosts or wait for one.")
                        + " Nothing runs on this phone until you turn hosting on again.")
            .setPositiveButton("Turn off", (d, w) -> { if (!save(appliedCpu, appliedMem, false)) revertSwitch(); })
            .setNegativeButton("Cancel", (d, w) -> revertSwitch())
            .setOnCancelListener(d -> revertSwitch())
            .show();
    }
    private void revertSwitch() { quiet = true; hostSwitch.setChecked(hosting); quiet = false; }

    // ---- settings: sharing ----
    private int cpuToBar(int milli) { return Math.max(0, Math.min(cpuBar.getMax(), Math.round(milli / (float) CPU_STEP) - 1)); }
    private int barCpu() { return (cpuBar.getProgress() + 1) * CPU_STEP; }
    private int memToBar(int mb) { return Math.max(0, Math.min(memBar.getMax(), Math.round((mb - MEM_MIN) / (float) MEM_STEP))); }
    private int barMem() { return Math.min(memMax, MEM_MIN + memBar.getProgress() * MEM_STEP); }
    private void setMemMax(int max) { memMax = Math.max(MEM_MIN, max); memBar.setMax(Math.max(1, (memMax - MEM_MIN + MEM_STEP - 1) / MEM_STEP)); }
    private void labels() {
        cpuLabel.setText("CPU  ·  " + barCpu() / 10 + "%");
        memLabel.setText(String.format(java.util.Locale.ROOT, "%.2f GB", barMem() / 1024.0));
    }
    /** Each slider's Apply and Cancel appear only while it differs from what is in effect. */
    private void applyState() {
        cpuButtons.setVisibility(barCpu() != appliedCpu ? View.VISIBLE : View.GONE);
        memButtons.setVisibility(barMem() != appliedMem ? View.VISIBLE : View.GONE);
    }

    // ---- settings: the payout address ----
    private String typedPayout() { return payoutField.getText().toString().trim().toLowerCase(java.util.Locale.ROOT); }
    private boolean dirtyPayout() { return !typedPayout().equals(appliedPayout == null ? "" : appliedPayout); }
    private boolean validPayout() { return typedPayout().matches("0x[0-9a-f]{40}") && !typedPayout().matches("0x0{40}"); }
    /** Save and Cancel appear only while the field differs from the address in effect; Save is live only for an address. */
    private void payoutState() {
        boolean dirty = dirtyPayout(), ok = dirty && validPayout();
        payoutButtons.setVisibility(dirty ? View.VISIBLE : View.GONE);
        payoutSave.setEnabled(ok); payoutSave.setAlpha(ok ? 1f : 0.4f);
        payoutNote.setText(!dirty ? payoutSaid : ok ? "" : "Not an address yet: 0x followed by 40 characters (0-9, a-f).");
        payoutNote.setVisibility(payoutNote.getText().length() == 0 ? View.GONE : View.VISIBLE);
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
                if (save(appliedCpu, appliedMem, hosting)) toast("Saved"); else appliedPayout = was;
                payoutState(); })
            .setNegativeButton("Cancel", null)
            .show();
    }

    // ---- the settings file the host agent reads ----
    private java.io.File offerFile() { return new java.io.File(a.getFilesDir(), "offer.json"); }
    /** What this phone last saved: { cpuMilli, memMb, hosting, payoutTo|null }, or null. */
    private Object[] readOffer() {
        try {
            JSONObject o = new JSONObject(new String(java.nio.file.Files.readAllBytes(offerFile().toPath()), "UTF-8"));
            String to = o.optString("payoutTo", "");
            return new Object[] { o.getInt("cpuMilli"), o.getInt("memMb"), o.optBoolean("hosting", true), to.matches("0x[0-9a-fA-F]{40}") ? to.toLowerCase(java.util.Locale.ROOT) : null };
        } catch (Exception e) { return null; }
    }
    /** Saved where only this app (and the owner's adb) can write; the host agent reads it on its next round. */
    private boolean save(int cpu, int mem, boolean host) {
        try {
            JSONObject o = new JSONObject().put("v", 1).put("hosting", host).put("cpuMilli", cpu).put("memMb", mem)
                .put("at", new java.text.SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ssXXX", java.util.Locale.ROOT).format(new java.util.Date()));
            if (appliedPayout != null) o.put("payoutTo", appliedPayout);
            java.io.File t = new java.io.File(a.getFilesDir(), "offer.json.tmp");
            java.nio.file.Files.write(t.toPath(), (o.toString() + "\n").getBytes("UTF-8"));
            if (!t.renameTo(offerFile())) throw new java.io.IOException("rename");
            appliedCpu = cpu; appliedMem = mem; hosting = host; settingsKnown = true;
            applyState();
            return true;
        } catch (Exception e) { toast("Not saved: " + e.getMessage()); return false; }
    }

    // ---- views ----
    private LinearLayout page() { LinearLayout p = new LinearLayout(a); p.setOrientation(LinearLayout.VERTICAL); p.setPadding(dp(22), dp(16), dp(22), dp(28)); return p; }
    private View card(String title, String detail, String url) {
        LinearLayout c = new LinearLayout(a); c.setOrientation(LinearLayout.VERTICAL); c.setPadding(dp(14), dp(14), dp(14), dp(14));
        GradientDrawable bg = new GradientDrawable(); bg.setColor(CARD); bg.setCornerRadius(dp(12)); bg.setStroke(dp(1), LINE);
        c.setBackground(bg);
        TextView t = text(title, 15, TEXT); t.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        c.addView(t);
        if (detail != null) c.addView(text(detail, 13, MUTED));
        c.setOnClickListener(v -> { try { a.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(url))); } catch (Exception ignored) {} });
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.topMargin = dp(8); c.setLayoutParams(lp);
        return c;
    }
    /** A button: filled (the action) or outlined (the quieter choice). */
    private TextView button(String s, boolean filled) {
        TextView b = text(s, 15, filled ? BG : TEXT); b.setTypeface(Typeface.DEFAULT_BOLD); b.setGravity(Gravity.CENTER); b.setPadding(dp(22), dp(11), dp(22), dp(11));
        GradientDrawable g = new GradientDrawable(); g.setCornerRadius(dp(10)); g.setColor(filled ? GREEN : BG); if (!filled) g.setStroke(dp(1), MUTED);
        b.setBackground(g);
        return b;
    }
    private LinearLayout pair(TextView first, TextView second) {
        LinearLayout r = new LinearLayout(a); r.setOrientation(LinearLayout.HORIZONTAL); r.setPadding(0, dp(14), 0, 0);
        r.addView(first);
        LinearLayout.LayoutParams p = new LinearLayout.LayoutParams(LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT); p.leftMargin = dp(12);
        r.addView(second, p);
        return r;
    }
    private void toast(String s) { Toast.makeText(a, s, Toast.LENGTH_SHORT).show(); }
    private TextView section(String s) { TextView t = text(s.toUpperCase(java.util.Locale.ROOT), 12, GREEN); t.setTypeface(Typeface.DEFAULT_BOLD); t.setLetterSpacing(0.08f); t.setPadding(0, dp(28), 0, dp(6)); return t; }
    private TextView text(String s, int sp, int color) { TextView t = new TextView(a); t.setText(s); t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp); t.setTextColor(color); t.setLineSpacing(0, 1.15f); return t; }
    private int dp(int v) { return Math.round(v * a.getResources().getDisplayMetrics().density); }
}
