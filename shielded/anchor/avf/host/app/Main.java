/*
 * Main -- the host side of the anchor on a Pixel: the app that OWNS the
 * protected VM, and the only thing that can talk to it.
 *
 * A production pVM is non-debuggable: no console, no log, no ramdump. The
 * shell domain may not even open AF_VSOCK (measured). What AVF gives the
 * VM's owner is VirtualMachine.connectVsock(), so this app is the guest's
 * whole outside world:
 *
 *   gate      is this phone one we support? (protected VMs + attestation)
 *   own       build the config (protected, DEBUG_LEVEL_NONE, match-host), run it
 *   control   vsock 7777: send a challenge and the run plan, relay every
 *             line the anchor says to logcat ("anchor-host") and the screen
 *   bridge    vsock 7778: pipe each worker connection to a TCP shielded
 *             worker. Only ciphertext frames cross it; the app never sees a
 *             pad, an activation or a product.
 *
 * android.system.virtualmachine is a @SystemApi: absent from the public SDK
 * android.jar but callable at runtime, so every call goes through reflection.
 *
 *   adb shell pm grant host.enclave.anchor.avf android.permission.MANAGE_VIRTUAL_MACHINE
 *   adb reverse tcp:9500 tcp:9500
 *   adb shell am start-foreground-service -n host.enclave.anchor.avf/.AnchorService \
 *       [--es worker 127.0.0.1:9500] [--es mode bridge|local] [--es shapes "K,N,nodes,iters,xmax;..."]
 *   adb logcat -s anchor-host
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.Socket;
import java.security.SecureRandom;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

public class Main extends Activity {
    static final String TAG = "anchor-host";
    static final String PKG = "android.system.virtualmachine.";
    static final int CTRL_PORT = 7777, WORKER_PORT = 7778;
    static final int VENDOR_LEVEL_ATTEST = 202404;      // /avf RKP component min-level

    /* run plan, from intent extras */
    public static final class Plan {
        String payload = "libanchor.so"; int debug = 0; long memMib = 1024;
        String worker = "127.0.0.1:9500"; String mode = "bridge";
        String shapes = "256,256,1,30,0;896,896,1,30,0;896,4864,2,12,0";
        static Plan from(Intent i) {
            Plan p = new Plan(); if (i == null) return p;
            if (i.getStringExtra("payload") != null) p.payload = i.getStringExtra("payload");
            p.debug = i.getIntExtra("debug", p.debug); p.memMib = i.getIntExtra("mem", (int) p.memMib);
            if (i.getStringExtra("worker") != null) p.worker = i.getStringExtra("worker");
            if (i.getStringExtra("mode") != null) p.mode = i.getStringExtra("mode");
            if (i.getStringExtra("shapes") != null) p.shapes = i.getStringExtra("shapes");
            return p;
        }
    }

    private static volatile TextView sScreen;
    static void say(String s) {
        Log.i(TAG, s);
        TextView t = sScreen;
        if (t != null) t.post(() -> t.append(s + "\n"));
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        TextView t = new TextView(this); t.setTextSize(11); t.setPadding(24, 48, 24, 24); t.setTypeface(android.graphics.Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this); sv.addView(t); setContentView(sv); sScreen = t;
        final Plan plan = Plan.from(getIntent());
        new Thread(() -> runVm(this, plan), "anchor-host").start();
    }
    @Override protected void onDestroy() { sScreen = null; super.onDestroy(); }

    /* call obj.name(args) resolving the method by name and arity; Method.invoke unboxes primitives */
    static Object call(Object obj, String name, Object... args) throws Exception {
        Class<?> c = obj instanceof Class ? (Class<?>) obj : obj.getClass();
        for (Class<?> k = c; k != null; k = k.getSuperclass())
            for (Method m : k.getMethods())
                if (m.getName().equals(name) && m.getParameterCount() == args.length) {
                    m.setAccessible(true);
                    return m.invoke(obj instanceof Class ? null : obj, args);
                }
        throw new NoSuchMethodException(c.getName() + "." + name + "/" + args.length);
    }
    static Object tryCall(Object obj, String name, Object... args) { try { return call(obj, name, args); } catch (Throwable t) { return null; } }
    static int sysprop(String key) {
        try { Class<?> sp = Class.forName("android.os.SystemProperties"); return (Integer) sp.getMethod("getInt", String.class, int.class).invoke(null, key, 0); }
        catch (Throwable t) { return 0; }
    }

    /* The support gate. The list customers see ("Pixel 9a, and Pixel 10 or newer") is the
     * translation of this: protected VMs must exist, and the vendor level must admit the
     * RKP /avf component. The attestation itself is the real test and runs right after. */
    static boolean gate(Object vmm) {
        int vendor = sysprop("ro.vendor.api_level"), board = sysprop("ro.board.api_level");
        Object caps = tryCall(vmm, "getCapabilities");
        int c = caps instanceof Integer ? (Integer) caps : -1;
        boolean protectedVm = c < 0 ? Boolean.TRUE.equals(tryCall(vmm, "isProtectedVmSupported")) : (c & 1) != 0;   // CAPABILITY_PROTECTED_VM
        Object ra = tryCall(vmm, "isRemoteAttestationSupported");
        say("GATE device=" + android.os.Build.MODEL + " sdk=" + android.os.Build.VERSION.SDK_INT + " vendor_api_level=" + vendor + " board_api_level=" + board);
        say("GATE capabilities=" + c + " protected_vm=" + protectedVm + " remote_attestation=" + (ra == null ? "n/a" : ra));
        boolean attestLevel = vendor >= VENDOR_LEVEL_ATTEST;
        boolean ok = protectedVm && attestLevel && !Boolean.FALSE.equals(ra);
        say("GATE " + (ok ? "SUPPORTED" : "UNSUPPORTED") + (protectedVm ? "" : " (no protected VMs)") + (attestLevel ? "" : " (launch generation " + vendor + " < " + VENDOR_LEVEL_ATTEST + ": /avf not provisioned)") + (Boolean.FALSE.equals(ra) ? " (service says no attestation)" : ""));
        return ok;
    }

    static void runVm(Context ctx, Plan plan) {
        try {
            say("HOST start payload=" + plan.payload + " debug=" + plan.debug + " mem=" + plan.memMib + "MiB worker=" + plan.worker + " mode=" + plan.mode + " host=" + ctx.getClass().getSimpleName());
            Object vmm = ctx.getSystemService("virtualization");
            if (vmm == null) { say("HOST no VirtualMachineManager: this build of Android has no AVF"); return; }
            gate(vmm);      // informative; the run proceeds so an unsupported phone still shows what it can do
            try { call(vmm, "delete", "anchor"); } catch (Exception ignored) { }

            Class<?> cBuilder = Class.forName(PKG + "VirtualMachineConfig$Builder");
            Object b = cBuilder.getConstructor(Context.class).newInstance(ctx);
            call(b, "setPayloadBinaryName", plan.payload);
            call(b, "setProtectedVm", true);
            call(b, "setDebugLevel", plan.debug);
            call(b, "setMemoryBytes", plan.memMib << 20);
            call(b, "setCpuTopology", 1);            // CPU_TOPOLOGY_MATCH_HOST
            Object cfg = call(b, "build");
            say("HOST config protected=" + call(cfg, "isProtectedVm") + " debug=" + call(cfg, "getDebugLevel"));

            final Object vm = call(vmm, "getOrCreate", "anchor", cfg);
            Class<?> cCb = Class.forName(PKG + "VirtualMachineCallback");
            Executor ex = Executors.newSingleThreadExecutor();
            InvocationHandler h = (proxy, m, a) -> {
                String n = m.getName();
                if (n.equals("toString")) return "cb"; if (n.equals("hashCode")) return 0; if (n.equals("equals")) return proxy == a[0];
                switch (n) {
                    case "onPayloadStarted": say("VM payload started"); break;
                    case "onPayloadReady": say("VM payload ready"); new Thread(() -> control(vm, plan), "vsock-control").start(); break;
                    case "onPayloadFinished": say("VM payload finished exit=" + a[1]); break;
                    case "onError": say("VM error code=" + a[1] + " msg=" + a[2]); break;
                    case "onStopped": say("VM stopped reason=" + a[1]); break;
                    default: say("VM cb " + n);
                }
                return null;
            };
            Object cb = Proxy.newProxyInstance(cCb.getClassLoader(), new Class<?>[] { cCb }, h);
            call(vm, "setCallback", ex, cb);
            call(vm, "run");
            say("HOST vm.run() returned, status=" + call(vm, "getStatus"));
        } catch (Throwable t) {
            Log.e(TAG, "HOST FAIL", t); say("HOST FAIL " + t);
        }
    }

    /* the guest binds its listeners before notifyPayloadReady, but be tolerant anyway */
    static ParcelFileDescriptor connect(Object vm, int port, int tries) {
        for (int i = 0; i < tries; i++) {
            try { return (ParcelFileDescriptor) call(vm, "connectVsock", port); }
            catch (Throwable t) { try { Thread.sleep(200); } catch (InterruptedException ignored) { } }
        }
        return null;
    }

    private static volatile boolean sEnded;
    static void control(Object vm, Plan plan) {
        sEnded = false;
        ParcelFileDescriptor pfd = connect(vm, CTRL_PORT, 50);
        if (pfd == null) { say("CONTROL connect failed"); return; }
        say("CONTROL connected");
        if (plan.mode.equals("bridge")) new Thread(() -> bridge(vm, plan), "vsock-bridge").start();
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor());
             BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(pfd.getFileDescriptor())))) {
            byte[] ch = new byte[32]; new SecureRandom().nextBytes(ch);
            StringBuilder hex = new StringBuilder(); for (byte x : ch) hex.append(String.format("%02x", x));
            StringBuilder cmd = new StringBuilder();
            cmd.append("CHAL ").append(hex).append('\n');
            cmd.append("WORKER ").append(plan.mode).append('\n');
            for (String s : plan.shapes.split(";")) { String[] f = s.trim().split(","); if (f.length == 5) cmd.append("SHAPE ").append(String.join(" ", f)).append('\n'); }
            cmd.append("RUN\n");
            out.write(cmd.toString().getBytes()); out.flush();
            say("CONTROL challenge=" + hex + " plan sent");
            String line; int n = 0;
            while ((line = r.readLine()) != null) { say("VSOCK " + line); n++; if (line.equals("END")) break; }
            say("CONTROL closed after " + n + " lines");
        } catch (Exception e) {
            say("CONTROL error " + e);
        } finally {
            sEnded = true;
            try { pfd.close(); } catch (Exception ignored) { }
        }
    }

    /* one worker connection per shape: connect into the guest, dial the TCP worker, pipe both ways, repeat */
    static void bridge(Object vm, Plan plan) {
        String host = plan.worker.substring(0, plan.worker.lastIndexOf(':')); int port = Integer.parseInt(plan.worker.substring(plan.worker.lastIndexOf(':') + 1));
        int conn = 0;
        while (!sEnded) {
            ParcelFileDescriptor pfd = connect(vm, WORKER_PORT, 25);
            if (pfd == null) break;
            conn++;
            try (Socket s = new Socket(host, port)) {
                s.setTcpNoDelay(true);
                final int id = conn;
                say("BRIDGE #" + id + " guest<->" + plan.worker);
                InputStream gi = new FileInputStream(pfd.getFileDescriptor()); OutputStream go = new FileOutputStream(pfd.getFileDescriptor());
                InputStream wi = s.getInputStream(); OutputStream wo = s.getOutputStream();
                Thread up = new Thread(() -> pipe(gi, wo, "up"), "bridge-up"); up.start();
                long[] down = { pipe(wi, go, "down") };
                try { s.shutdownInput(); } catch (Exception ignored) { }
                try { pfd.close(); } catch (Exception ignored) { }
                up.join();
                say("BRIDGE #" + id + " closed, down=" + down[0] + " bytes");
            } catch (Exception e) {
                say("BRIDGE error " + e);
                try { pfd.close(); } catch (Exception ignored) { }
                if (!sEnded) { try { Thread.sleep(300); } catch (InterruptedException ignored) { } }
            }
        }
    }
    static long pipe(InputStream in, OutputStream out, String dir) {
        long total = 0; byte[] buf = new byte[65536];
        try { int n; while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); out.flush(); total += n; } } catch (Exception ignored) { }
        try { out.close(); } catch (Exception ignored) { }
        return total;
    }
}
