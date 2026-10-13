/*
 * Status -- what the Enclave app shows when it is opened from the launcher (a release pVM CPU build, no launch extras): the
 * hosting panel, host-ui (the repository's host-ui/, the Windows tray's panel too: one panel, the same on both). The page
 * ships in the APK (assets/host-ui/) and is served to this WebView from there at https://hosting.enclave.example/ (a name
 * that never leaves the phone). This class is its shell: the window, and the bridge that carries the page's requests to
 * the phone's host agent (the Windows node's local hosting API, 127.0.0.1:18191) with the agent's token from this app's
 * private files. The page never sees the token and opens no connection of its own (host-ui/README.md, "The shell's side").
 * The agent keeps the settings (files/offer.json) and enforces them; the screen never starts or stops anything itself.
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.WindowInsets;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.Collections;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import org.json.JSONObject;

final class Status {
    // the site's colours (DESIGN.md): the set-up screens (Setup.java) use them too
    static final int BG = 0xFF070A0F, CARD = 0xFF10161F, LINE = 0xFF1C2532, GREEN = 0xFF2FE6A8, TEXT = 0xFFE8EDF2, MUTED = 0xFF8A97A6, AMBER = 0xFFFFB454;
    static final String HOST = "hosting.enclave.example", ORIGIN = "https://" + HOST + "/";
    /** The host agent's panel endpoint (runner/standalone.mjs PANEL_PORT) and its token, beside the agent's files. */
    static final int PANEL_PORT = 18191;
    static final String TOKEN = "agent/hosting-admin.token";

    /** Opened from the launcher: a release pVM CPU build with no launch plan (the host agent always names a mode). */
    static boolean launcherOpen(Activity a, Intent i) {
        return Tier.PVM_CPU.equals(Tier.of(a)) && (i == null || !i.hasExtra("mode"));
    }
    /** This APK carries the on-phone agent (STANDALONE.md). */
    static boolean standaloneBuild(Activity a) {
        try { return Arrays.asList(a.getAssets().list("agent")).contains("standalone.mjs"); } catch (Exception e) { return false; }
    }
    private static Status current;
    static void show(Activity a) {
        if (standaloneBuild(a) && !new File(a.getFilesDir(), "agent/setup.json").isFile()) { Setup.show(a); return; }   /* STANDALONE.md: a phone that hosts on its own is set up first */
        AgentService.start(a); current = new Status(a);   /* a set-up phone hosts on its own; opening the app starts it if a boot did not */
    }
    /** The system back gesture: the panel's (it closes a question or the open section, else leaves). True: handled. */
    static boolean back() { Status s = current; if (s == null) return false; s.goBack(); return true; }

    private final Activity a;
    private final WebView web;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newCachedThreadPool();
    private boolean loaded;

    private Status(Activity a) {
        this.a = a;
        a.getWindow().setStatusBarColor(BG); a.getWindow().setNavigationBarColor(BG);
        // a lab (debuggable) build lets the panel be driven from a computer (chrome://inspect); a release build never does
        if ((a.getApplicationInfo().flags & android.content.pm.ApplicationInfo.FLAG_DEBUGGABLE) != 0) WebView.setWebContentsDebuggingEnabled(true);
        web = new WebView(a);
        web.setBackgroundColor(BG);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false); s.setDomStorageEnabled(false);
        s.setGeolocationEnabled(false); s.setSupportZoom(false); s.setBuiltInZoomControls(false); s.setDisplayZoomControls(false);
        s.setSupportMultipleWindows(false); s.setJavaScriptCanOpenWindowsAutomatically(false); s.setCacheMode(WebSettings.LOAD_NO_CACHE);
        s.setTextZoom(Math.round(a.getResources().getConfiguration().fontScale * 100));   // the owner's font size, as elsewhere on the phone
        web.addJavascriptInterface(new Bridge(), "EnclaveHostNative");
        web.setWebViewClient(new WebViewClient() {
            /** The page and its files, from the APK; nothing else is fetched (the page's CSP says the same). */
            @Override public WebResourceResponse shouldInterceptRequest(WebView v, WebResourceRequest r) {
                Uri u = r.getUrl();
                if (!"https".equals(u.getScheme()) || !HOST.equals(u.getHost()) || !"GET".equals(r.getMethod())) return empty(403);
                String name = u.getPath() == null ? "" : u.getPath().replaceFirst("^/", "");
                if (!name.matches("[a-z-]{1,40}\\.(html|css|js)")) return empty(404);
                try {
                    InputStream in = a.getAssets().open("host-ui/" + name);
                    String type = name.endsWith(".html") ? "text/html" : name.endsWith(".css") ? "text/css" : "text/javascript";
                    return new WebResourceResponse(type, "utf-8", 200, "OK", Collections.singletonMap("Cache-Control", "no-store"), in);
                } catch (java.io.IOException e) { return empty(404); }
            }
            /** The page stays the panel: an https link opens in the browser, never here. */
            @Override public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest r) {
                String url = r.getUrl().toString();
                if (url.startsWith(ORIGIN)) return false;
                openExternal(url);
                return true;
            }
            @Override public void onPageFinished(WebView v, String url) { loaded = true; }
            @Override public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail d) {
                Log.w("Enclave", "the panel's renderer went away; the screen is made again");
                a.recreate();
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient() {
            @Override public boolean onConsoleMessage(ConsoleMessage m) { Log.i("EnclavePanel", m.message() + " (" + m.sourceId() + ":" + m.lineNumber() + ")"); return true; }
        });
        FrameLayout root = new FrameLayout(a);
        root.setBackgroundColor(BG);
        root.addView(web, new FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        // edge to edge (Android 15+): the panel stays clear of the status and navigation bars, the cutout and the keyboard
        root.setOnApplyWindowInsetsListener((v, in) -> {
            android.graphics.Insets bars = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout() | WindowInsets.Type.ime());
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom); return in; });
        a.setContentView(root);
        // the page polls only while it is seen: WebView's own pause tells it (visibilitychange), and a return refreshes it
        a.registerActivityLifecycleCallbacks(new Application.ActivityLifecycleCallbacks() {
            @Override public void onActivityResumed(Activity x) { if (x == a) { web.onResume(); post("{\"event\":\"show\"}"); } }
            @Override public void onActivityPaused(Activity x) { if (x == a) web.onPause(); }
            @Override public void onActivityDestroyed(Activity x) { if (x == a) { io.shutdownNow(); web.destroy(); if (current == Status.this) current = null; } }
            @Override public void onActivityCreated(Activity x, Bundle b) { }
            @Override public void onActivityStarted(Activity x) { }
            @Override public void onActivityStopped(Activity x) { }
            @Override public void onActivitySaveInstanceState(Activity x, Bundle b) { }
        });
        web.loadUrl(ORIGIN + "index.html");
    }

    private static WebResourceResponse empty(int status) {
        return new WebResourceResponse("text/plain", "utf-8", status, status == 403 ? "Forbidden" : "Not Found", null, new ByteArrayInputStream(new byte[0]));
    }

    private void goBack() {
        if (!loaded) { a.moveTaskToBack(true); return; }
        web.evaluateJavascript("(function(){ if (window.EnclaveHostPanel) { window.EnclaveHostPanel.back(); return 1; } return 0; })()",
                               r -> { if (!"1".equals(r)) a.moveTaskToBack(true); });
    }

    /** A message for the page (bridge.js receives it through window.__enclaveHost; before the page has it, nothing happens). */
    private void post(String json) {
        ui.post(() -> web.evaluateJavascript("window.__enclaveHost && window.__enclaveHost(" + JSONObject.quote(json) + ")", null));
    }

    private void openExternal(String url) {
        Uri u = Uri.parse(url);
        if (!"https".equals(u.getScheme())) return;
        try { a.startActivity(new Intent(Intent.ACTION_VIEW, u).addCategory(Intent.CATEGORY_BROWSABLE)); } catch (Exception e) { Log.w("Enclave", "could not open " + u.getHost()); }
    }

    /** The page's only way out (host-ui/bridge.js): it posts JSON, this answers through post(). Binder threads call it. */
    final class Bridge {
        @JavascriptInterface public void postMessage(String json) {
            try {
                JSONObject m = new JSONObject(json);
                String op = m.optString("op");
                long id = m.optLong("id", -1);
                switch (op) {
                    case "hello": {
                        String version = "";
                        try { version = a.getPackageManager().getPackageInfo(a.getPackageName(), 0).versionName; } catch (Exception e) { }
                        post(new JSONObject().put("id", id).put("platform", "android").put("titleBar", false).put("version", version == null ? "" : version).toString());
                        break;
                    }
                    case "request": io.execute(() -> post(forward(id, m))); break;
                    case "hide": ui.post(() -> a.moveTaskToBack(true)); break;
                    case "open": { String url = m.optString("url"); ui.post(() -> openExternal(url)); break; }
                    default: break;   // "size": the window is the screen
                }
            } catch (Exception e) { Log.w("Enclave", "the panel sent a message this app does not read: " + e.getMessage()); }
        }
    }

    /** The page's request, to the host agent with its token; the answer as it came (status 0: the agent can't be asked). */
    private String forward(long id, JSONObject m) {
        try {
            String method = m.optString("method"), path = m.optString("path");
            if (!Arrays.asList("GET", "PUT", "POST", "DELETE").contains(method) || !path.matches("/v1/local/hosting(/[a-z-]{1,40})?"))
                return new JSONObject().put("id", id).put("status", 400).put("body", new JSONObject().put("error", "bad_request").put("message", "the panel may ask only for /v1/local/hosting")).toString();
            File tf = new File(a.getFilesDir(), TOKEN);
            if (!tf.isFile()) return unreachable(id, "the hosting service on this phone is starting");
            String token = new String(java.nio.file.Files.readAllBytes(tf.toPath()), StandardCharsets.UTF_8).trim();
            HttpURLConnection c = (HttpURLConnection) new URL("http://127.0.0.1:" + PANEL_PORT + path).openConnection();
            c.setConnectTimeout(5000); c.setReadTimeout(10000); c.setUseCaches(false);
            c.setRequestMethod(method);
            c.setRequestProperty("Authorization", "Bearer " + token);
            Object body = m.opt("body");
            if (body != null && body != JSONObject.NULL && !"GET".equals(method)) {
                byte[] b = body.toString().getBytes(StandardCharsets.UTF_8);
                c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json"); c.setFixedLengthStreamingMode(b.length);
                try (OutputStream out = c.getOutputStream()) { out.write(b); }
            }
            int status = c.getResponseCode();
            InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
            String text = "";
            if (in != null) try (InputStream i = in) { text = new String(readAll(i), StandardCharsets.UTF_8); }
            c.disconnect();
            JSONObject answer = new JSONObject().put("id", id).put("status", status);
            try { answer.put("body", new JSONObject(text)); } catch (Exception e) { answer.put("body", new JSONObject().put("message", text.length() > 200 ? text.substring(0, 200) : text)); }
            return answer.toString();
        } catch (java.net.ConnectException e) {
            return unreachable(id, "the hosting service on this phone is not answering yet (it starts with the app)");
        } catch (Exception e) {
            return unreachable(id, "the hosting service on this phone did not answer (" + e.getClass().getSimpleName() + ")");
        }
    }
    private static String unreachable(long id, String why) {
        try { return new JSONObject().put("id", id).put("status", 0).put("message", why).toString(); } catch (Exception e) { return "{}"; }
    }
    private static byte[] readAll(InputStream in) throws java.io.IOException {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[8192]; int n;
        while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); if (out.size() > 1 << 20) break; }
        return out.toByteArray();
    }
}
