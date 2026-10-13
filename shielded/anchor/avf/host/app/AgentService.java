/*
 * AgentService -- the phone hosts on its own (STANDALONE.md): this foreground service, in its own process (":agent"), runs the
 * host agent and the Enclave network with the Node runtime the APK carries (lib/arm64-v8a/libnode.so, executed from the
 * extracted native libraries: the one place Android lets an app run a program it ships), and answers the agent's launches.
 *
 * Its own process, because the host VM is the app's main process: hosting off ends that process, and must not end the agent.
 *
 *   control   127.0.0.1:18190 with "Authorization: Bearer <files/agent/control-token>": GET /procs (this app's processes, which
 *             a program it runs cannot see in /proc), POST /kill { process } (one VM process), and
 *             POST /launch { service, extras: [[name, "s"|"i"|"z", value]] } with "Authorization: Bearer
 *             <files/agent/control-token>": starts one of this app's VM services (AnchorService, AnchorServiceSlot1..32) with
 *             those extras -- what `adb shell am start-foreground-service` did for an owner's computer. Loopback is shared by
 *             every app on a phone, so the token (fresh each start, 0600 in the app's private files) is what makes it ours.
 *   agent     node files/agent/bundle/standalone.mjs --files <files> --apk <apk> --lib <native libs> --control-port 18190,
 *             restarted when it ends (5 s doubling to 5 min); its output goes to files/agent/agent.log (rotated at 4 MiB).
 *   bundle    the agent's JavaScript (assets/agent/*), copied to files/agent/bundle when the installed APK changes.
 */
package host.enclave.anchor.avf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.IBinder;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

public class AgentService extends Service {
    static final String TAG = "EnclaveAgent";
    static final int CONTROL_PORT = 18190, MAX_BODY = 64 << 10;
    private static volatile boolean started;
    private volatile boolean stopping;
    private volatile Process node;
    private ServerSocket control;
    private String token;

    /** Start hosting on this phone (the app's setup is done: files/agent/setup.json exists). */
    static void start(Context ctx) {
        if (!new File(ctx.getFilesDir(), "agent/setup.json").isFile()) { Log.i(TAG, "not set up yet: the agent does not start"); return; }
        ctx.startForegroundService(new Intent(ctx, AgentService.class));
    }

    @Override public IBinder onBind(Intent i) { return null; }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        NotificationManager nm = getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("anchor", "Hosting", NotificationManager.IMPORTANCE_LOW));
        int mark = 0;
        try { mark = getResources().getIdentifier("ic_stat_enclave", "drawable", getResources().getResourcePackageName(getApplicationInfo().icon)); } catch (Exception ignored) {}
        Notification n = new Notification.Builder(this, "anchor").setContentTitle("Enclave").setContentText("Hosting on this phone")
            .setSmallIcon(mark != 0 ? mark : android.R.drawable.stat_notify_sync).setOngoing(true)
            .setContentIntent(android.app.PendingIntent.getActivity(this, 0, new Intent(this, Main.class).setAction(Intent.ACTION_MAIN)
                .addCategory(Intent.CATEGORY_LAUNCHER).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK), android.app.PendingIntent.FLAG_IMMUTABLE))
            .build();
        startForeground(100, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
        synchronized (AgentService.class) { if (started) return START_STICKY; started = true; }
        new Thread(this::run, "agent").start();
        return START_STICKY;
    }

    @Override public void onDestroy() {
        stopping = true;
        try { if (control != null) control.close(); } catch (Exception ignored) {}
        final Process p = node; if (p != null) p.destroy();
        synchronized (AgentService.class) { started = false; }
        super.onDestroy();
    }

    private void run() {
        final File dir = new File(getFilesDir(), "agent");
        if (!dir.isDirectory() && !dir.mkdirs()) { Log.e(TAG, "no agent dir"); return; }
        try { token = newToken(new File(dir, "control-token")); }
        catch (Exception e) { Log.e(TAG, "no control token: " + e); return; }
        try {
            control = new ServerSocket(CONTROL_PORT, 8, InetAddress.getByName("127.0.0.1"));
            new Thread(this::accept, "agent-control").start();
        } catch (Exception e) { Log.e(TAG, "control endpoint not started: " + e); return; }
        long backoff = 5000;
        while (!stopping) {
            final long t0 = System.currentTimeMillis();
            try { installBundle(this); runNode(dir); }
            catch (Exception e) { Log.e(TAG, "agent: " + e); }
            if (stopping) break;
            if (System.currentTimeMillis() - t0 > 10 * 60_000L) backoff = 5000;   /* it ran a while: a fresh failure, not a loop */
            Log.w(TAG, "agent ended; again in " + backoff / 1000 + " s");
            try { Thread.sleep(backoff); } catch (InterruptedException e) { break; }
            backoff = Math.min(backoff * 2, 5 * 60_000L);
        }
    }

    /** A fresh 32-byte hex token, 0600 (the app's private files are this uid's alone), renamed into place. */
    static String newToken(File f) throws Exception {
        final byte[] b = new byte[32]; new java.security.SecureRandom().nextBytes(b);
        final String t = RelayAttach.hex(b);
        final File tmp = new File(f.getPath() + ".tmp");
        try (FileOutputStream o = new FileOutputStream(tmp)) { o.write((t + "\n").getBytes(StandardCharsets.US_ASCII)); o.getFD().sync(); }
        tmp.setReadable(false, false); tmp.setReadable(true, true); tmp.setWritable(false, false); tmp.setWritable(true, true);
        if (!tmp.renameTo(f)) throw new Exception("rename failed");
        return t;
    }

    /** The agent's JavaScript from the APK's assets, copied when the installed APK is not the one it was copied from. */
    static synchronized void installBundle(Context ctx) throws Exception {
        final File dir = new File(ctx.getFilesDir(), "agent");
        if (!dir.isDirectory() && !dir.mkdirs()) throw new Exception("no agent dir");
        final String stamp = ctx.getPackageManager().getPackageInfo(ctx.getPackageName(), 0).lastUpdateTime + " " + new File(ctx.getApplicationInfo().sourceDir).length();
        final File bundle = new File(dir, "bundle"), mark = new File(bundle, ".installed");
        if (mark.isFile() && stamp.equals(new String(java.nio.file.Files.readAllBytes(mark.toPath()), StandardCharsets.UTF_8).trim())) return;
        final File fresh = new File(dir, "bundle.new");
        deleteTree(fresh);
        if (!fresh.mkdirs()) throw new Exception("cannot make " + fresh);
        for (String name : ctx.getAssets().list("agent")) {
            try (InputStream in = ctx.getAssets().open("agent/" + name); OutputStream out = new FileOutputStream(new File(fresh, name))) {
                final byte[] buf = new byte[1 << 16]; int r; while ((r = in.read(buf)) > 0) out.write(buf, 0, r);
            }
        }
        try (FileOutputStream o = new FileOutputStream(new File(fresh, ".installed"))) { o.write(stamp.getBytes(StandardCharsets.UTF_8)); }
        deleteTree(bundle);
        if (!fresh.renameTo(bundle)) throw new Exception("cannot install the bundle");
        Log.i(TAG, "agent bundle installed (" + stamp + ")");
    }

    /** Node's environment: its C++ runtime is libc++_shared.so beside it in the APK's native libraries. */
    static void nodeEnv(Context ctx, ProcessBuilder pb) {
        pb.environment().put("LD_LIBRARY_PATH", ctx.getApplicationInfo().nativeLibraryDir);
        pb.environment().put("HOME", new File(ctx.getFilesDir(), "agent").getPath());
        pb.environment().put("TMPDIR", ctx.getCacheDir().getPath());
    }

    private void runNode(File dir) throws Exception {
        final String lib = getApplicationInfo().nativeLibraryDir;
        final ProcessBuilder pb = new ProcessBuilder(lib + "/libnode.so", "--max-old-space-size=384",
            new File(dir, "bundle/standalone.mjs").getPath(), "--files", getFilesDir().getPath(), "--apk", getApplicationInfo().sourceDir,
            "--lib", lib, "--control-port", String.valueOf(CONTROL_PORT));
        pb.directory(dir).redirectErrorStream(true);
        nodeEnv(this, pb);
        node = pb.start();
        final File log = new File(dir, "agent.log");
        try (InputStream in = node.getInputStream()) {
            OutputStream out = new FileOutputStream(log, true);
            final byte[] buf = new byte[8192]; int r;
            while ((r = in.read(buf)) > 0) {
                out.write(buf, 0, r);
                if (log.length() > (4 << 20)) { out.close(); log.renameTo(new File(dir, "agent.log.1")); out = new FileOutputStream(log, true); }
            }
            out.close();
        }
        Log.w(TAG, "agent exited " + node.waitFor());
        node = null;
    }

    // ---- the launch control ----
    private void accept() {
        while (!stopping) {
            final Socket s;
            try { s = control.accept(); } catch (Exception e) { if (!stopping) Log.w(TAG, "control accept ended: " + e); return; }
            new Thread(() -> serve(s), "agent-launch").start();
        }
    }

    private void serve(Socket s) {
        try (Socket sock = s) {
            sock.setSoTimeout(15000);
            final InputStream in = sock.getInputStream();
            final String head = readHead(in);
            final String[] lines = head.split("\r\n");
            int len = -1; String auth = "";
            for (int i = 1; i < lines.length; i++) {
                final int c = lines[i].indexOf(':'); if (c < 0) continue;
                final String k = lines[i].substring(0, c).trim().toLowerCase(java.util.Locale.ROOT), v = lines[i].substring(c + 1).trim();
                if (k.equals("content-length")) len = Integer.parseInt(v);
                if (k.equals("authorization")) auth = v;
            }
            if (!java.security.MessageDigest.isEqual(auth.getBytes(StandardCharsets.US_ASCII), ("Bearer " + token).getBytes(StandardCharsets.US_ASCII))) { answer(sock, 401, "{\"error\":\"token\"}"); return; }
            if (lines[0].startsWith("GET /procs ")) { answer(sock, 200, procs().toString()); return; }
            final boolean isLaunch = lines[0].startsWith("POST /launch "), isKill = lines[0].startsWith("POST /kill ");
            if (!isLaunch && !isKill) { answer(sock, 404, "{\"error\":\"not found\"}"); return; }
            if (len < 0 || len > MAX_BODY) { answer(sock, 400, "{\"error\":\"body\"}"); return; }
            final byte[] body = new byte[len]; int off = 0;
            while (off < len) { final int r = in.read(body, off, len - off); if (r < 0) break; off += r; }
            final JSONObject req = new JSONObject(new String(body, 0, off, StandardCharsets.UTF_8));
            final String err = isLaunch ? launch(req) : kill(req.optString("process"));
            answer(sock, err == null ? 200 : 400, err == null ? "{\"ok\":true}" : new JSONObject().put("error", err).toString());
        } catch (Exception e) { Log.w(TAG, "control: " + e); }
    }

    /** One of this app's VM services, with the agent's extras; null when it started, else why not. */
    String launch(JSONObject req) throws Exception {
        final String service = req.optString("service");
        if (!service.matches("host\\.enclave\\.anchor\\.avf\\.AnchorService(Slot([1-9]|[12][0-9]|3[0-2]))?")) return "not one of this app's VM services";
        final Intent i = new Intent(this, Class.forName(service));
        final JSONArray ex = req.getJSONArray("extras");
        for (int k = 0; k < ex.length(); k++) {
            final JSONArray e = ex.getJSONArray(k);
            final String name = e.getString(0), type = e.getString(1);
            if (!name.matches("[a-z_]{1,24}")) return "extra name " + name;
            switch (type) {
                case "s": i.putExtra(name, e.getString(2)); break;
                case "i": i.putExtra(name, e.getInt(2)); break;
                case "z": i.putExtra(name, e.getBoolean(2)); break;
                default: return "extra type " + type;
            }
        }
        startForegroundService(i);
        return null;
    }

    /* An app sees none of its own other processes in /proc from a program it runs (measured on the Pixel 10, Android 17:
     * Node's /proc held only itself), so the agent asks here: this app's processes, as the system lists them. */
    JSONObject procs() throws Exception {
        final JSONArray a = new JSONArray();
        final java.util.List<android.app.ActivityManager.RunningAppProcessInfo> l = getSystemService(android.app.ActivityManager.class).getRunningAppProcesses();
        if (l != null) for (android.app.ActivityManager.RunningAppProcessInfo p : l) a.put(new JSONObject().put("pid", p.pid).put("name", p.processName));
        return new JSONObject().put("procs", a);
    }

    /** End one of this app's VM processes (the host VM's, a slot's): never the agent's own or the screen's. null when ended. */
    String kill(String name) throws Exception {
        final String pkg = getPackageName();
        if (!name.equals(pkg) && !name.matches(java.util.regex.Pattern.quote(pkg) + ":slot([1-9]|[12][0-9]|3[0-2])")) return "not one of this app's VM processes";
        for (int i = 0; i < 40; i++) {
            int pid = 0;
            final java.util.List<android.app.ActivityManager.RunningAppProcessInfo> l = getSystemService(android.app.ActivityManager.class).getRunningAppProcesses();
            if (l != null) for (android.app.ActivityManager.RunningAppProcessInfo p : l) if (name.equals(p.processName)) pid = p.pid;
            if (pid == 0) return null;
            if (i == 0) android.os.Process.killProcess(pid);
            Thread.sleep(250);
        }
        return name + " did not end";
    }

    private static String readHead(InputStream in) throws Exception {
        final StringBuilder b = new StringBuilder(); int c, n = 0;
        while ((c = in.read()) >= 0) {
            b.append((char) c);
            if (++n > 8192) throw new Exception("head too long");
            if (b.length() >= 4 && b.substring(b.length() - 4).equals("\r\n\r\n")) break;
        }
        return b.toString();
    }

    private static void answer(Socket s, int code, String json) throws Exception {
        final byte[] b = json.getBytes(StandardCharsets.UTF_8);
        final OutputStream o = s.getOutputStream();
        o.write(("HTTP/1.1 " + code + " X\r\ncontent-type: application/json\r\ncontent-length: " + b.length + "\r\nconnection: close\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
        o.write(b); o.flush();
    }

    static void deleteTree(File f) {
        if (!f.exists()) return;
        final File[] kids = f.listFiles();
        if (kids != null) for (File k : kids) deleteTree(k);
        f.delete();
    }
}
