/*
 * Main -- the host side of the anchor on a Pixel: the app that OWNS the
 * protected VM.
 *
 * A --debug none pVM has no console and no log, and the shell domain may not
 * open AF_VSOCK at all (measured). What AVF gives the VM's owner instead is
 * VirtualMachine.connectVsock(port) through virtualizationservice, which is
 * how a production operator app would talk to the anchor. This activity
 * builds the VM config (protected, non-debuggable, match-host CPUs), runs it,
 * connects to the guest's listener when the payload reports ready and copies
 * everything it says to logcat under "anchor-host".
 *
 * android.system.virtualmachine is a @SystemApi: absent from the public SDK
 * android.jar but callable at runtime, so every call goes through reflection.
 *
 *   adb shell pm grant host.enclave.anchor.avf android.permission.MANAGE_VIRTUAL_MACHINE
 *   adb shell am start -n host.enclave.anchor.avf/.Main [--es payload libanchor.so] [--ei debug 0]
 *   adb logcat -s anchor-host
 */
package host.enclave.anchor.avf;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.os.ParcelFileDescriptor;
import android.util.Log;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

public class Main extends Activity {
    static final String TAG = "anchor-host";
    static final String PKG = "android.system.virtualmachine.";
    static final int VSOCK_PORT = 7777;

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        final String payload = getIntent().getStringExtra("payload") != null ? getIntent().getStringExtra("payload") : "libanchor.so";
        final int debug = getIntent().getIntExtra("debug", 0);          // 0 = DEBUG_LEVEL_NONE, 1 = FULL
        final long memMib = getIntent().getIntExtra("mem", 1024);
        new Thread(() -> runVm(this, payload, debug, memMib), "anchor-host").start();
    }

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

    static void runVm(Context ctx, String payload, int debug, long memMib) {
        try {
            Log.i(TAG, "HOST start payload=" + payload + " debug=" + debug + " mem=" + memMib + "MiB host=" + ctx.getClass().getSimpleName());
            Object vmm = ctx.getSystemService("virtualization");
            if (vmm == null) { Log.e(TAG, "HOST no VirtualMachineManager"); return; }
            Log.i(TAG, "HOST manager=" + vmm.getClass().getName());
            try { call(vmm, "delete", "anchor"); } catch (Exception ignored) { }

            Class<?> cBuilder = Class.forName(PKG + "VirtualMachineConfig$Builder");
            Object b = cBuilder.getConstructor(Context.class).newInstance(ctx);
            call(b, "setPayloadBinaryName", payload);
            call(b, "setProtectedVm", true);
            call(b, "setDebugLevel", debug);
            call(b, "setMemoryBytes", memMib << 20);
            call(b, "setCpuTopology", 1);            // CPU_TOPOLOGY_MATCH_HOST
            Object cfg = call(b, "build");
            Log.i(TAG, "HOST config protected=" + call(cfg, "isProtectedVm") + " debug=" + call(cfg, "getDebugLevel"));

            final Object vm = call(vmm, "getOrCreate", "anchor", cfg);
            Class<?> cCb = Class.forName(PKG + "VirtualMachineCallback");
            Executor ex = Executors.newSingleThreadExecutor();
            InvocationHandler h = (proxy, m, a) -> {
                String n = m.getName();
                if (n.equals("toString")) return "cb"; if (n.equals("hashCode")) return 0; if (n.equals("equals")) return proxy == a[0];
                switch (n) {
                    case "onPayloadStarted": Log.i(TAG, "VM payload started"); break;
                    case "onPayloadReady": Log.i(TAG, "VM payload ready -> connectVsock " + VSOCK_PORT); new Thread(() -> pump(vm), "vsock-pump").start(); break;
                    case "onPayloadFinished": Log.i(TAG, "VM payload finished exit=" + a[1]); break;
                    case "onError": Log.e(TAG, "VM error code=" + a[1] + " msg=" + a[2]); break;
                    case "onStopped": Log.i(TAG, "VM stopped reason=" + a[1]); break;
                    default: Log.i(TAG, "VM cb " + n);
                }
                return null;
            };
            Object cb = Proxy.newProxyInstance(cCb.getClassLoader(), new Class<?>[] { cCb }, h);
            call(vm, "setCallback", ex, cb);
            call(vm, "run");
            Log.i(TAG, "HOST vm.run() returned, status=" + call(vm, "getStatus"));
        } catch (Throwable t) {
            Log.e(TAG, "HOST FAIL", t);
        }
    }

    /* the guest binds its listener AFTER notifyPayloadReady, so the first connect may be refused: retry */
    static void pump(Object vm) {
        ParcelFileDescriptor pfd = null;
        for (int i = 0; i < 50 && pfd == null; i++) {
            try { pfd = (ParcelFileDescriptor) call(vm, "connectVsock", VSOCK_PORT); }
            catch (Throwable t) { try { Thread.sleep(200); } catch (InterruptedException ignored) { } }
        }
        if (pfd == null) { Log.e(TAG, "VSOCK connect failed after retries"); return; }
        Log.i(TAG, "VSOCK connected");
        try (BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(pfd.getFileDescriptor())))) {
            String line; int n = 0;
            while ((line = r.readLine()) != null) { Log.i(TAG, "VSOCK " + line); n++; }
            Log.i(TAG, "VSOCK closed after " + n + " lines");
        } catch (Exception e) {
            Log.e(TAG, "VSOCK read error", e);
        }
    }
}
