/*
 * SelfPair -- the Enclave app grants itself the VM permission with no computer (STANDALONE.md "Owner setup"): it finds the
 * phone's own Wireless debugging services over mDNS (NsdManager: _adb-tls-pairing._tcp while Settings shows a pairing code,
 * _adb-tls-connect._tcp once paired), asks for the code in a notification (so the owner never leaves Settings), and runs
 * adb-self.mjs with the Node the APK carries: pair, then the setup commands (pm grant, the child-process limits).
 * Only services whose address is one of this phone's own are used.
 */
package host.enclave.anchor.avf;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.RemoteInput;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.nsd.NsdManager;
import android.net.nsd.NsdServiceInfo;
import android.os.Bundle;
import android.util.Log;

import java.io.File;
import java.net.InetAddress;
import java.net.NetworkInterface;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public class SelfPair extends BroadcastReceiver {
    static final String TAG = "EnclavePair", PAIRING = "_adb-tls-pairing._tcp", CONNECT = "_adb-tls-connect._tcp";
    static final String ACTION_CODE = "host.enclave.anchor.avf.PAIR_CODE", KEY_CODE = "code";
    static final int NOTE = 200;
    /** What the setup screen shows: the last thing that happened. */
    static volatile String state = "";
    static volatile int pairingPort = 0;
    private static NsdManager.DiscoveryListener discovering;

    static boolean granted(Context c) { return c.checkSelfPermission("android.permission.MANAGE_VIRTUAL_MACHINE") == android.content.pm.PackageManager.PERMISSION_GRANTED; }

    /** Look for this phone's pairing service; when it appears (the owner opened "Pair device with pairing code"), ask for the code. */
    static void watch(Context ctx) {
        final Context app = ctx.getApplicationContext();
        stop(app);
        discovering = discover(app, PAIRING, (port) -> { pairingPort = port; askCode(app); state = "Type the pairing code in Enclave's notification."; });
    }
    static void stop(Context ctx) {
        if (discovering != null) { try { ctx.getSystemService(NsdManager.class).stopServiceDiscovery(discovering); } catch (Exception ignored) {} discovering = null; }
    }

    interface Found { void port(int port); }
    /** NsdManager discovery of `type`, resolved, kept only when it is this phone's own service. */
    static NsdManager.DiscoveryListener discover(Context app, String type, Found found) {
        final NsdManager nsd = app.getSystemService(NsdManager.class);
        final NsdManager.DiscoveryListener l = new NsdManager.DiscoveryListener() {
            @Override public void onDiscoveryStarted(String t) { }
            @Override public void onDiscoveryStopped(String t) { }
            @Override public void onStartDiscoveryFailed(String t, int e) { Log.w(TAG, "discovery " + t + " failed " + e); }
            @Override public void onStopDiscoveryFailed(String t, int e) { }
            @Override public void onServiceLost(NsdServiceInfo s) { }
            @Override public void onServiceFound(NsdServiceInfo s) {
                nsd.resolveService(s, new NsdManager.ResolveListener() {
                    @Override public void onResolveFailed(NsdServiceInfo i, int e) { Log.w(TAG, "resolve failed " + e); }
                    @Override public void onServiceResolved(NsdServiceInfo i) {
                        if (i.getHost() != null && own(i.getHost())) found.port(i.getPort());
                        else Log.i(TAG, "another device's " + type + ": ignored");
                    }
                });
            }
        };
        nsd.discoverServices(type, NsdManager.PROTOCOL_DNS_SD, l);
        return l;
    }
    static boolean own(InetAddress a) {
        try { for (NetworkInterface n : Collections.list(NetworkInterface.getNetworkInterfaces())) for (InetAddress x : Collections.list(n.getInetAddresses())) if (x.equals(a)) return true; }
        catch (Exception ignored) { }
        return false;
    }

    /** A notification with a reply field for the six digits. */
    static void askCode(Context app) {
        final NotificationManager nm = app.getSystemService(NotificationManager.class);
        nm.createNotificationChannel(new NotificationChannel("pair", "Setup", NotificationManager.IMPORTANCE_HIGH));
        final RemoteInput in = new RemoteInput.Builder(KEY_CODE).setLabel("Pairing code").build();
        final PendingIntent pi = PendingIntent.getBroadcast(app, 0, new Intent(app, SelfPair.class).setAction(ACTION_CODE),
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_MUTABLE);
        final Notification.Action act = new Notification.Action.Builder(null, "Enter code", pi).addRemoteInput(in).build();
        nm.notify(NOTE, new Notification.Builder(app, "pair").setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Enclave: enter the pairing code").setContentText("The six digits Settings shows under Wi-Fi pairing code")
            .addAction(act).setOngoing(true).build());
    }
    static void note(Context app, String text, boolean done) {
        final NotificationManager nm = app.getSystemService(NotificationManager.class);
        nm.notify(NOTE, new Notification.Builder(app, "pair").setSmallIcon(android.R.drawable.ic_lock_lock)
            .setContentTitle("Enclave").setContentText(text).setOngoing(!done).setAutoCancel(done).build());
        state = text;
    }

    /** The code, from the notification's reply: pair, find the connect port, run the setup commands. */
    @Override public void onReceive(Context ctx, Intent intent) {
        final Bundle r = RemoteInput.getResultsFromIntent(intent);
        final String code = r == null ? "" : String.valueOf(r.getCharSequence(KEY_CODE)).trim();
        final Context app = ctx.getApplicationContext();
        final PendingResult pending = goAsync();
        new Thread(() -> { try { run(app, code); } finally { pending.finish(); } }, "self-pair").start();
    }

    static void run(Context app, String code) {
        if (!code.matches("[0-9]{6}")) { note(app, "The pairing code is six digits. Open the pairing dialog again.", true); return; }
        if (pairingPort == 0) { note(app, "The pairing dialog closed. Open it again in Settings.", true); return; }
        note(app, "Pairing…", false);
        try {
            AgentService.installBundle(app);
            final String[] out = node(app, "pair", "127.0.0.1", String.valueOf(pairingPort), code);
            if (!"0".equals(out[0])) { note(app, "Pairing failed: " + out[1].trim(), true); return; }
            stop(app);
            note(app, "Paired. Allowing Enclave to run apps…", false);
            final int[] port = { 0 };
            final Object lock = new Object();
            final NsdManager.DiscoveryListener l = discover(app, CONNECT, (p) -> { synchronized (lock) { port[0] = p; lock.notifyAll(); } });
            synchronized (lock) { if (port[0] == 0) lock.wait(20000); }
            try { app.getSystemService(NsdManager.class).stopServiceDiscovery(l); } catch (Exception ignored) {}
            if (port[0] == 0) { note(app, "Wireless debugging is not answering. Is it still on?", true); return; }
            final String pkg = app.getPackageName();
            final List<String> cmds = new ArrayList<>();
            cmds.add("pm grant " + pkg + " android.permission.MANAGE_VIRTUAL_MACHINE");
            cmds.add("device_config set_sync_disabled_for_tests persistent");
            cmds.add("device_config put activity_manager max_phantom_processes 2147483647");
            cmds.add("settings put global settings_enable_monitor_phantom_procs false");
            for (String c : cmds) {
                final String[] o = node(app, "shell", "127.0.0.1", String.valueOf(port[0]), c);
                if (!"0".equals(o[0])) { note(app, "Setup failed: " + o[1].trim(), true); return; }
            }
            note(app, granted(app) ? "Done. You can turn Wireless debugging off again." : "Paired, but the permission was not granted.", true);
        } catch (Exception e) { note(app, "Setup failed: " + e.getMessage(), true); }
    }

    /** node adb-self.mjs <args> --key files/agent/adb: { exit code, output }. */
    static String[] node(Context app, String... args) throws Exception {
        final List<String> cmd = new ArrayList<>();
        cmd.add(app.getApplicationInfo().nativeLibraryDir + "/libnode.so");
        cmd.add(new File(app.getFilesDir(), "agent/bundle/adb-self.mjs").getPath());
        Collections.addAll(cmd, args);
        cmd.add("--key"); cmd.add(new File(app.getFilesDir(), "agent/adb").getPath());
        final ProcessBuilder pb = new ProcessBuilder(cmd).redirectErrorStream(true);
        AgentService.nodeEnv(app, pb);
        final Process p = pb.start();
        final String out = new String(p.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        return new String[] { String.valueOf(p.waitFor()), out.length() > 300 ? out.substring(out.length() - 300) : out };
    }
}
