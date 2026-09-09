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
import android.system.Os;
import android.system.OsConstants;
import android.util.Log;
import android.widget.ScrollView;
import android.widget.TextView;
import org.json.JSONObject;
import java.nio.charset.StandardCharsets;

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
import java.util.TreeMap;
import java.util.concurrent.Executor;
import java.util.concurrent.Executors;

public class Main extends Activity {
    static final String TAG = "anchor-host";
    static final String PKG = "android.system.virtualmachine.";
    static final int CTRL_PORT = 7777, WORKER_PORT = 7778, MODEL_PORT = 7779;
    static final int VENDOR_LEVEL_ATTEST = 202404;      // /avf RKP component min-level

    /* run plan, from intent extras */
    public static final class Plan {
        String payload = "libanchor.so"; int debug = 0; long memMib = 1024;
        String worker = "127.0.0.1:9500"; String mode = "bridge";
        String relay = null; String name = "phone-anchor";
        String model = "/data/local/tmp/anchor/gg/model.gguf"; String prompt = "The capital of France is"; int n = 8; int threads = 4; long storageMib = 0;
        int mtp = 0;                         // engine: draft k tokens per round with the model's own MTP head (0 = plain decode)
        int boost = 0;                       // engine: spinning threads in the VM that keep the phone's clocks up between exchanges
        int burners = 0;                     // app-side: lowest-priority spinning threads that keep the clusters' clocks up while the VM decodes
        String shenv = "";                   // engine: extra environment for the VM engine, "K=V,K=V" (e.g. SHIELDED_LOCAL_SITES=token_embd.weight)
        int hugepages = 0;                   // VM: setShouldUseHugepages(true) when the phone's AVF offers it
        int pumpprio = 0;                    // bridge pump threads: android.os.Process priority (e.g. -19 = URGENT_AUDIO)
        int tamper = 0;                      // --ei tamper 1: after the grant, re-stage the model with one extra byte (must be refused), then honestly (must pass)
        int fresh = 0;                       // --ei fresh 1: delete the VM instance first (empty encrypted storage = a clean first boot)
        String vmName = "anchor";            // --es vmname: which VM instance (its own encrypted store) this run uses; [a-z0-9_-], 1-32 chars
        boolean nativeEcho = false;          // --ez nativeecho true: native loop for worker=echo transport diagnostic only
        boolean nativeBridge = false;        // --ez nativebridge true: the worker bridge runs as one native pump (NativeBridge) instead of the two Java pipe() threads
        boolean bridgeProfile = false;       // --ez bridgeprofile true: bridge timing only, independent of the guest source profiler
        int bridgeWriteMax = 0;               // --ei bridgewrite 4096: experimental VM-bound native send cap; 0 keeps existing sends
        boolean bridgeIo = false;            // --ez bridgeio true: bounded metadata-only per-call timeline
        String benchSizes = "65536,262144,1048576,3145728";   // --es benchsizes: frame sizes for mode=bridgebench
        String shapes = "256,256,1,30,0;896,896,1,30,0;896,4864,2,12,0";
        String pads = "";                    // dealt pads: bank dir of .pads files on this phone; "" = the VM mints its own
        String prefix = "", prefixPk = "";   // shared-prefix KV dir (prefix.kv + .sig + prefix.txt) and the platform's prefix key
        String prefixName = "", prefixDigest = "";   // or fetch them from the platform store by (model digest, name)
        String modelAuth = "whole-file";     // --es model_auth catalog: the VM admits the model through its measured catalog (assets/model.agcat) instead of the whole-file scan
        String artifacts = "";               // --es artifacts <dir>: public encoded-weight artifacts (<64hex>.i8) streamed into the VM over the pads port after the ENGINE line
        boolean artifactsConsume = false;    // --ez artifacts_consume true: delete a local artifact ONLY after the VM answered 'K' (fresh, block-verified); never after 'H'
        String artifactsUrl = "";            // --es artifacts_url http://127.0.0.1:<port>/v1/artifacts: stream public artifacts from the host feed (adb reverse) straight into the VM, no phone copy (ArtifactFeed)
        int artifactsDeadlineS = 300;        // --ei artifacts_deadline: the whole feed's budget in seconds (default 300, max 600), measured from the feed's start
        int artifactsCoalesce = 0;           // --ei artifacts_coalesce 1: fill 1 MiB before each vsock write (A/B option; see ArtifactFeed's timeout note); 0 = forward as received
        int padsDirect = 0;                  // --ei pads_direct 1: stream a NEW sealed shipment from its HTTP body straight into the PADS receiver (no Android file); 0 = cached-file path
        String modelCache = "";              // --es model_cache only: the VM reuses a retained model or refuses ('N', nothing streamed, store untouched); "" = today's re-receive on a miss
        String configError = "";             // a plan that must not run (mutually exclusive extras): the launcher says HOST FAIL and stops instead of guessing
        static Plan from(Intent i) {
            Plan p = new Plan(); if (i == null) return p;
            p.nativeEcho = i.getBooleanExtra("nativeecho", false);
            p.nativeBridge = i.getBooleanExtra("nativebridge", false);
            p.bridgeProfile = i.getBooleanExtra("bridgeprofile", false);
            p.bridgeWriteMax = i.getIntExtra("bridgewrite", 0);
            p.bridgeIo = i.getBooleanExtra("bridgeio", false);
            if (i.getStringExtra("benchsizes") != null) p.benchSizes = i.getStringExtra("benchsizes");
            if (i.getStringExtra("payload") != null) p.payload = i.getStringExtra("payload");
            p.debug = i.getIntExtra("debug", p.debug); p.memMib = i.getIntExtra("mem", (int) p.memMib);
            if (i.getStringExtra("worker") != null) p.worker = i.getStringExtra("worker");
            if (i.getStringExtra("mode") != null) p.mode = i.getStringExtra("mode");
            if (i.getStringExtra("shapes") != null) p.shapes = i.getStringExtra("shapes");
            if (i.getStringExtra("relay") != null) p.relay = i.getStringExtra("relay");
            if (i.getStringExtra("name") != null) p.name = i.getStringExtra("name");
            if (i.getStringExtra("model") != null) p.model = i.getStringExtra("model");
            if (i.getStringExtra("prompt") != null) p.prompt = i.getStringExtra("prompt");
            if (i.getStringExtra("pads") != null) p.pads = i.getStringExtra("pads");     // dealt pads: a bank dir of .pads files on this phone ("" = off)
            if (i.getStringExtra("prefix") != null) p.prefix = i.getStringExtra("prefix");   // shared-prefix KV: a dir holding prefix.kv, prefix.kv.sig, prefix.txt
            if (i.getStringExtra("prefixpk") != null) p.prefixPk = i.getStringExtra("prefixpk");   // the platform's prefix key (64 hex) the VM pins
            if (i.getStringExtra("prefixname") != null) p.prefixName = i.getStringExtra("prefixname");       // fetch <name>.kv/.sig/.txt from the platform's store...
            if (i.getStringExtra("prefixdigest") != null) p.prefixDigest = i.getStringExtra("prefixdigest"); // ...for this model digest, into files/prefix
            if (i.getStringExtra("model_auth") != null) p.modelAuth = i.getStringExtra("model_auth");
            if (i.getStringExtra("artifacts") != null) p.artifacts = i.getStringExtra("artifacts");
            p.artifactsConsume = i.getBooleanExtra("artifacts_consume", false);
            if (i.getStringExtra("artifacts_url") != null) p.artifactsUrl = i.getStringExtra("artifacts_url");
            p.artifactsDeadlineS = i.getIntExtra("artifacts_deadline", p.artifactsDeadlineS);
            p.artifactsCoalesce = i.getIntExtra("artifacts_coalesce", 0);
            p.padsDirect = i.getIntExtra("pads_direct", 0);
            if (i.getStringExtra("model_cache") != null) p.modelCache = i.getStringExtra("model_cache");
            if (i.getStringExtra("shenv") != null) p.shenv = i.getStringExtra("shenv");   // read BEFORE the validation chain: prepare mode judges its ANCHOR_ARTIFACT_PROFILE request here
            if (!p.artifacts.isEmpty() && !p.artifactsUrl.isEmpty()) p.configError = "artifacts (directory) and artifacts_url (feed) are both set: choose one";
            else if (!p.artifactsUrl.isEmpty() && !ArtifactFeed.validBase(p.artifactsUrl)) p.configError = "artifacts_url must be http://127.0.0.1:<port>/v1/artifacts (the host feed through adb reverse)";
            else if (p.artifactsDeadlineS < 1 || p.artifactsDeadlineS > 600) p.configError = "artifacts_deadline must be 1..600 seconds";
            else if (p.artifactsCoalesce != 0 && p.artifactsCoalesce != 1) p.configError = "artifacts_coalesce must be 0 or 1";
            else if (p.padsDirect != 0 && p.padsDirect != 1) p.configError = "pads_direct must be 0 or 1";
            else if (p.bridgeWriteMax != 0 && p.bridgeWriteMax != 4096) p.configError = "bridgewrite must be 0 or 4096";
            else if (p.bridgeWriteMax != 0 && !p.nativeBridge) p.configError = "bridgewrite needs nativebridge";
            else if (p.bridgeIo && !p.nativeBridge) p.configError = "bridgeio needs nativebridge";
            else if (!p.modelCache.isEmpty() && !p.modelCache.equals("only")) p.configError = "model_cache must be \"only\" or absent";
            else if (p.mode.equals("prepare") && (!"catalog".equals(p.modelAuth) || p.artifactsUrl.isEmpty())) p.configError = "mode prepare needs model_auth catalog and artifacts_url (no engine, no seed, no worker)";
            else if (p.mode.equals("prepare") && ArtifactProfile.requested(p.shenv) < 0) p.configError = "shenv " + ArtifactProfile.KEY + " must be 0 or 1, once (the only shenv key a preparation honours, as the explicit ARTIFACT_PROFILE control line)";
            p.n = i.getIntExtra("n", p.n); p.threads = i.getIntExtra("threads", p.threads); p.mtp = i.getIntExtra("mtp", p.mtp); p.boost = i.getIntExtra("boost", p.boost); p.burners = i.getIntExtra("burners", p.burners); p.hugepages = i.getIntExtra("hugepages", p.hugepages); p.pumpprio = i.getIntExtra("pumpprio", p.pumpprio); p.tamper = i.getIntExtra("tamper", p.tamper); p.fresh = i.getIntExtra("fresh", p.fresh); if (i.getStringExtra("vmname") != null && i.getStringExtra("vmname").matches("[a-z0-9_-]{1,32}")) p.vmName = i.getStringExtra("vmname"); pumpPriority = p.pumpprio; paceBytesPerSec = (long) i.getIntExtra("pace_mbps", 0) << 20; p.storageMib = i.getIntExtra("storage", (int) p.storageMib);
            if (p.mode.equals("delete")) {   // diagnostic deletion of exactly the owned test instance; judged on the RAW extra, after vmname is parsed above
                final String raw = i.getStringExtra("vmname");
                if (!"anchorfeed1".equals(raw)) p.configError = "mode delete removes only the owned test VM instance anchorfeed1 (explicit --es vmname anchorfeed1); refused for " + (raw == null ? "<missing>" : "'" + raw + "'");
            }
            if (p.mode.equals("engine")) {                                         // the model lives in the VM
                if (i.getIntExtra("mem", 0) == 0) p.memMib = 4096;
                if (i.getIntExtra("storage", 0) == 0) p.storageMib = 2048;             // encrypted storage: the model's home, kept across runs
            }
            return p;
        }
    }

    private static volatile TextView sScreen;
    /* Opt-in bounded capture of every say() line (CaptureSink.java): `--es capture <label>` [`--ei capture_cap_mib` 1..64,
     * default 16]. A REQUESTED capture that cannot be opened refuses the launch (both entry paths check the result). */
    private static volatile CaptureSink sCapture;
    private static final CaptureSink.Warn sCaptureWarn = m -> Log.w(TAG, m);
    static boolean captureOpen(Context ctx, Intent i) {
        if (i == null || !i.hasExtra("capture")) return true;                       /* not requested: nothing changes */
        if (sCapture != null) { Log.w(TAG, "CAPTURE FAIL already open"); return false; }
        final int capMib = i.hasExtra("capture_cap_mib") ? i.getIntExtra("capture_cap_mib", -1) : CaptureSink.CAP_MIB_DEFAULT;   /* malformed -> -1 -> refused */
        CaptureSink c = CaptureSink.open(new java.io.File(ctx.getFilesDir(), "capture"), i.getStringExtra("capture"), capMib, sCaptureWarn);
        if (c == null) return false;
        sCapture = c; return true;
    }
    static void captureClose(boolean sawEnd) {
        CaptureSink c = sCapture; sCapture = null;   /* unpublish first: the footer line below must not be captured */
        if (c == null) return;
        String footer = c.close(sawEnd);
        if (footer != null) say(footer);
    }
    static void say(String s) {
        CaptureSink c = sCapture; if (c != null) c.line(s, sCaptureWarn);   /* the file first: logd may drop or delay */
        Log.i(TAG, s);
        TextView t = sScreen;
        if (t != null) t.post(() -> t.append(s + "\n"));
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        TextView t = new TextView(this); t.setTextSize(11); t.setPadding(24, 48, 24, 24); t.setTypeface(android.graphics.Typeface.MONOSPACE);
        ScrollView sv = new ScrollView(this); sv.addView(t); setContentView(sv); sScreen = t;
        final Plan plan = Plan.from(getIntent());
        if (!plan.configError.isEmpty()) { say("HOST FAIL: " + plan.configError); return; }   /* an inconsistent plan never runs a VM */
        if (!captureOpen(this, getIntent())) { say("CAPTURE FAIL: launch refused"); return; }
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
        /* Updatable VMs (AOSP updatable_vm.md): with Secretkeeper the instance secret survives an APK/OS
         * update and the encrypted store stays readable; without it the legacy instance.img rejects changed
         * code. The query is read-only; "n/a" = the framework hides or lacks it (then the device's
         * ISecretkeeper service is the next-best evidence, not proof). Never assumed per model. */
        Object upd = tryCall(vmm, "isUpdatableVmSupported");
        say("GATE device=" + android.os.Build.MODEL + " sdk=" + android.os.Build.VERSION.SDK_INT + " vendor_api_level=" + vendor + " board_api_level=" + board);
        say("GATE capabilities=" + c + " protected_vm=" + protectedVm + " remote_attestation=" + (ra == null ? "n/a" : ra) + " updatable_vm=" + (upd == null ? "n/a" : upd));
        boolean attestLevel = vendor >= VENDOR_LEVEL_ATTEST;
        boolean ok = protectedVm && attestLevel && !Boolean.FALSE.equals(ra);
        say("GATE " + (ok ? "SUPPORTED" : "UNSUPPORTED") + (protectedVm ? "" : " (no protected VMs)") + (attestLevel ? "" : " (launch generation " + vendor + " < " + VENDOR_LEVEL_ATTEST + ": /avf not provisioned)") + (Boolean.FALSE.equals(ra) ? " (service says no attestation)" : ""));
        return ok;
    }

    static java.io.File filesDir = new java.io.File("/data/user/0/host.enclave.anchor.avf/files");
    static void runVm(Context ctx, Plan plan) {
        filesDir = ctx.getFilesDir();
        try {
            say("HOST start payload=" + plan.payload + " debug=" + plan.debug + " mem=" + plan.memMib + "MiB worker=" + plan.worker + " mode=" + plan.mode + " host=" + ctx.getClass().getSimpleName());
            Object vmm = ctx.getSystemService("virtualization");
            if (vmm == null) { say("HOST no VirtualMachineManager: this build of Android has no AVF"); return; }
            if (plan.mode.equals("delete")) {   // --es mode delete --es vmname <test instance>: reclaim a test store (Astra 03:58); nothing is created or started
                try { call(vmm, "delete", plan.vmName); say("HOST VM instance '" + plan.vmName + "' deleted (mode delete): its encrypted store is gone"); }
                catch (Throwable t) { say("HOST VM instance '" + plan.vmName + "' NOT deleted: " + (t.getCause() != null ? t.getCause().getMessage() : t.getMessage())); }
                captureClose(true); return;
            }
            gate(vmm);      // informative; the run proceeds so an unsupported phone still shows what it can do

            Class<?> cBuilder = Class.forName(PKG + "VirtualMachineConfig$Builder");
            {   // what this phone's AVF can configure (network for the pVM would remove the vsock bridge from every exchange)
                StringBuilder caps = new StringBuilder();
                for (java.lang.reflect.Method m : cBuilder.getMethods()) { String n = m.getName(); if (n.startsWith("set") && n.matches(".*(Network|Vsock|Cpu|Vendor|Os|Console|Gpu|Balloon|Hugepages|Extra).*")) caps.append(n).append(' '); }
                say("HOST VirtualMachineConfig.Builder: " + caps);
                // Does this build's virtualization service offer VM networking at all? (Only custom-image VMs
                // can ask for it on Android 16; the Microdroid app-VM config has no setter. Hidden API: needs
                // `settings put global hidden_api_policy 1` to be reachable from a third-party app.)
                try { Object r = vmm.getClass().getMethod("isFeatureEnabled", String.class).invoke(vmm, "com.android.kvm.NETWORK"); say("HOST AVF feature com.android.kvm.NETWORK: " + r); }
                catch (Throwable t) { say("HOST AVF feature com.android.kvm.NETWORK: not queryable (" + t.getClass().getSimpleName() + ")"); }
            }
            Object b = cBuilder.getConstructor(Context.class).newInstance(ctx);
            call(b, "setPayloadBinaryName", plan.payload);
            call(b, "setProtectedVm", true);
            call(b, "setDebugLevel", plan.debug);
            call(b, "setMemoryBytes", plan.memMib << 20);
            call(b, "setCpuTopology", 1);            // CPU_TOPOLOGY_MATCH_HOST
            if (plan.hugepages > 0) say("HOST hugepages: " + (tryCall(b, "setShouldUseHugepages", true) != null ? "requested" : "not available"));
            if (plan.storageMib > 0) say("HOST encrypted storage " + plan.storageMib + " MiB: " + (tryCall(b, "setEncryptedStorageBytes", plan.storageMib << 20) != null ? "set" : "not available"));
            Object cfg = call(b, "build");
            say("HOST config protected=" + call(cfg, "isProtectedVm") + " debug=" + call(cfg, "getDebugLevel"));

            /* Keep the VM instance across runs: its encrypted storage is where the model
             * lives, and deleting the VM deletes it. getOrCreate returns an EXISTING instance
             * unchanged and ignores the config passed with it (Android 35), so the requested
             * numbers below are not the applied ones: the effective line after retrieval is. */
            Object vm0;
            /* One named instance per store: "anchor" is the default identity; a larger test store gets its own name
             * (--es vmname anchor64 --ei storage 65536) and never replaces it. An existing instance whose stored
             * config no longer matches is NOT deleted on its own: only --ei fresh 1 deletes, and says so. */
            say("HOST VM instance '" + plan.vmName + "' mem=" + plan.memMib + " MiB storage=" + plan.storageMib + " MiB");
            if (plan.fresh == 1) { try { call(vmm, "delete", plan.vmName); say("HOST VM instance '" + plan.vmName + "' deleted first (--ei fresh 1): empty encrypted storage, the model streams again"); } catch (Exception e) { say("HOST no instance to delete: " + e.getMessage()); } }
            try { vm0 = call(vmm, "getOrCreate", plan.vmName, cfg); }
            catch (Exception e) {
                say("HOST existing VM '" + plan.vmName + "' is incompatible with this config (" + (e.getCause() != null ? e.getCause().getMessage() : e.getMessage()) + "): NOT deleting it; run with --ei fresh 1 to replace it, or --es vmname <other> for a separate instance");
                return;
            }
            final Object vm = vm0;
            {   /* what the instance actually runs with, from its stored config, never from the request */
                Object ecfg = tryCall(vm, "getConfig");
                Object emem = ecfg == null ? null : tryCall(ecfg, "getMemoryBytes"), esto = ecfg == null ? null : tryCall(ecfg, "getEncryptedStorageBytes");
                say("HOST VM instance '" + plan.vmName + "' EFFECTIVE mem=" + (emem instanceof Long ? ((Long) emem >> 20) + " MiB" : "n/a") + " storage=" + (esto instanceof Long ? ((Long) esto >> 20) + " MiB" : "n/a")
                    + " (requested mem=" + plan.memMib + " storage=" + plan.storageMib + ")");
            }
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
    static boolean ended() { return sEnded; }
    static void control(Object vm, Plan plan) {
        sEnded = false;
        final PadDelivery.Session padSession = PadDelivery.begin();
        ParcelFileDescriptor pfd = connect(vm, CTRL_PORT, 50);
        if (pfd == null) { padSession.close(); say("CONTROL connect failed"); captureClose(false); return; }
        say("CONTROL connected");
        boolean sawEnd = false; Thread feedThread = null;   /* prepare mode: joined (bounded) at END so its terminal line lands in the capture */
        if (plan.mode.equals("bridge") || plan.mode.equals("engine") || plan.mode.equals("bridgebench")) new Thread(() -> bridge(vm, plan), "vsock-bridge").start();
        RelayAttach relay = null;
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor());
             BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(pfd.getFileDescriptor())))) {
            // 1. the VM's transport key is the first thing it says
            String first = r.readLine();
            byte[] spki = first != null && first.startsWith("SPKI ") ? RelayAttach.unhex(first.substring(5).trim()) : null;
            say("VSOCK " + first);
            // 1b. its pad key (dealt pads): the platform boxes the VM's seed to it
            String second = r.readLine();
            String padKey = second != null && second.startsWith("PADKEY ") ? second.substring(7).trim() : "";
            if (second != null) say("VSOCK " + second);
            // 2. the challenge: the relay's, bound to the transport key, or a local one
            String chal, boundHex = "";
            if (plan.relay != null && spki != null) {
                relay = new RelayAttach(plan.relay, plan.name, spki);
                relay.padKey = padKey;
                try { chal = relay.challenge(); boundHex = RelayAttach.hex(relay.bound); }
                catch (Exception e) { say("RELAY dial failed: " + e + " (continuing with a local challenge)"); relay = null; byte[] c = new byte[32]; new SecureRandom().nextBytes(c); chal = RelayAttach.hex(c); }
            } else { byte[] c = new byte[32]; new SecureRandom().nextBytes(c); chal = RelayAttach.hex(c); }
            if (!boundHex.isEmpty()) out.write(("BOUND " + boundHex + "\n").getBytes());
            out.write(("CHAL " + chal + "\n").getBytes()); out.flush();
            say("CONTROL challenge=" + chal);
            // 3. what the VM produced: status, the chain in chunks, the signature
            TreeMap<Integer, TreeMap<Integer, String>> certs = new TreeMap<>(); TreeMap<Integer, String> sig = new TreeMap<>();
            String line;
            while ((line = r.readLine()) != null) {
                say("VSOCK " + (line.length() > 160 ? line.substring(0, 160) + "…(" + line.length() + ")" : line));
                if (line.equals("ATTEST end")) break;
                java.util.regex.Matcher m;
                if ((m = java.util.regex.Pattern.compile("^CERT(\\d+)\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches())
                    certs.computeIfAbsent(Integer.parseInt(m.group(1)), (k) -> new TreeMap<>()).put(Integer.parseInt(m.group(2)), m.group(3));
                else if ((m = java.util.regex.Pattern.compile("^SIG\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches())
                    sig.put(Integer.parseInt(m.group(1)), m.group(2));
            }
            // 4. present it; a bound tunnel keeps serving the hub in its own thread
            if (relay != null) {
                JSONObject res = relay.present(certs, sig);
                if (res != null && res.optBoolean("ok")) { final RelayAttach rr = relay; new Thread(() -> rr.serve(android.os.Build.MODEL), "relay-serve").start(); }
                else { relay.close(); relay = null; }
            }
            // 4a. the model stage: the VM receives (or finds cached) the model and judges the bytes it will parse
            //     BEFORE any seed is requested for it (PAD-BOOTSTRAP.md); a protected first boot needs this order
            boolean modelOk = false;
            if (plan.mode.equals("engine") || plan.mode.equals("prepare")) {
                String ml = modelStage(vm, plan, out, r, 0);
                modelOk = ml != null && ml.startsWith("MODEL ok");
                if (!modelOk) say("MODEL stage did not pass: " + ml + (plan.mode.equals("prepare") ? " (the artifact feed will NOT start; the VM refuses PREPARE and ends)" : " (pads bootstrap will be refused)"));
            }
            // 4b. dealt pads: once the tunnel is bound, fetch the VM's seed through the platform's ledger
            boolean pads = false;
            // Only ENGINE decode consumes pads. Diagnostic modes (echo/bridgebench) need no masks, so they
            // must NOT grant a seed or the dealer mints two 759 MiB shipments per diagnostic leg and
            // contends with the very measurement (confound seen 2026-09-08).
            if (relay != null && !padKey.isEmpty() && !plan.pads.isEmpty() && plan.mode.equals("engine"))
                pads = PadsClient.bootstrap(padSession, PadsClient.httpBase(plan.relay), plan.name, out, r);
            // 4c. shared-prefix KV: the VM pins the platform's prefix key; the files follow over the pads port
            boolean prefix = false;
            if (plan.prefix.isEmpty() && !plan.prefixName.isEmpty() && plan.prefixDigest.matches("[0-9a-f]{64}") && relay != null) {
                java.io.File pdir = new java.io.File(filesDir, "prefix");
                if (PadsClient.fetchPrefix(PadsClient.httpBase(plan.relay), plan.prefixDigest, plan.prefixName, pdir)) plan.prefix = pdir.getPath();
                else say("PREFIX " + plan.prefixName + " not fetched; running without the shared prefix");
            }
            if (!plan.prefix.isEmpty() && plan.prefixPk.matches("[0-9a-f]{64}")) {
                out.write(("PREFIXPK " + plan.prefixPk + "\n").getBytes()); out.flush();
                String pl = PadsClient.until(r, "PREFIXPK ");
                prefix = pl != null && pl.startsWith("PREFIXPK ok");   // the VM says "ok (pinned)" / "ok (unpinned)"
                say("PREFIX key " + (prefix ? "pinned in the VM" : "NOT accepted: " + pl));
            }
            // 4d. --ei tamper 1: the swap-after-grant regression on the real chain. The VM holds its own copy,
            //     so the only re-receive is a different size: stream the model plus one byte under the real tag
            //     (must be refused against the frozen grant digest and purged), then the honest bytes (must pass).
            if (plan.tamper == 1 && plan.mode.equals("engine")) {
                String bad = modelStage(vm, plan, out, r, 1);
                boolean refused = bad != null && bad.startsWith("MODEL fail") && bad.contains("granted for");
                say("TAMPER swapped model " + (refused ? "REFUSED: PASS" : "NOT refused: FAIL") + " (" + bad + ")");
                String good = modelStage(vm, plan, out, r, 0);
                boolean ok = good != null && good.startsWith("MODEL ok") && good.contains(pads ? "matches the grant" : "hashed only");
                say("TAMPER honest re-stage " + (ok ? "ACCEPTED: PASS" : "NOT accepted: FAIL") + " (" + good + ")");
            }
            // 5. the run plan
            StringBuilder cmd = new StringBuilder();
            if (plan.mode.equals("engine")) {
                long bytes = new java.io.File(plan.model).length();
                String sha = RelayAttach.hex(fileSha256Cached(plan.model));
                cmd.append("ENGINE model_bytes=").append(bytes).append(" model_sha256=").append(sha).append(" n=").append(plan.n).append(" threads=").append(plan.threads).append(" mtp=").append(plan.mtp).append(" boost=").append(plan.boost).append(plan.shenv.isEmpty() ? "" : " env=" + RelayAttach.hex(plan.shenv.getBytes("UTF-8")))
                   .append(" prompt=").append(RelayAttach.hex(plan.prompt.getBytes("UTF-8"))).append(pads ? " pads=1" : "").append(prefix ? " prefix=1" : "").append(authFlag(plan)).append('\n');
                startBurners(plan.burners);
                say("ENGINE plan: " + plan.model + " (" + (bytes >> 20) + " MiB), " + plan.n + " tokens, " + plan.threads + " threads" + (plan.mtp > 0 ? ", MTP draft k=" + plan.mtp : "") + (pads ? ", dealt pads from " + plan.pads : ""));
                if (pads) { final java.io.File bank = new java.io.File(plan.pads); final boolean direct = plan.padsDirect == 1; new Thread(() -> PadsClient.streamBank(padSession, vm, bank, direct), "vsock-pads").start(); if (direct) say("PADS direct: new shipments stream from HTTP into the VM without a phone file (one attempt per shipment, then the cached-file path)"); }
                if (prefix) { final java.io.File pdir = new java.io.File(plan.prefix); new Thread(() -> PadsClient.streamFiles(vm, pdir, new String[] { "prefix.kv", "prefix.kv.sig", "prefix.txt" }), "vsock-prefix").start(); }
                if (!plan.artifacts.isEmpty()) { final java.io.File adir = new java.io.File(plan.artifacts); final boolean consume = plan.artifactsConsume; new Thread(() -> PadsClient.streamArtifacts(vm, adir, consume), "vsock-artifacts").start(); }
                if (!plan.artifactsUrl.isEmpty()) { final String url = plan.artifactsUrl; final int dl = plan.artifactsDeadlineS; final boolean co = plan.artifactsCoalesce == 1; new Thread(() -> PadsClient.feedArtifacts(vm, url, dl, co), "vsock-artifact-feed").start(); }
            }
            if (plan.mode.equals("prepare")) {   // artifacts preparation: [ARTIFACT_PROFILE 1] PREPARE <s> (ArtifactProfile: the VM's receiver takes the feed, then reports PREPARATION present n/count)
                String pre = ArtifactProfile.preparePreamble(plan.shenv, plan.artifactsDeadlineS);
                if (pre == null) throw new IllegalStateException("PREPARE preamble refused (shenv " + ArtifactProfile.KEY + " 0|1 once, artifacts_deadline 1..600): nothing sent");   // already refused at plan parse; CONTROL error + the finally's cleanup if ever reached
                cmd.append(pre);
            }
            if (plan.mode.equals("maskbench")) cmd.append("MASKBENCH\n");   // sampler + cell-import speed probe: no model stage, no seed, no worker, no shapes
            if (plan.mode.equals("echo")) { cmd.append("ECHO\n"); new Thread(() -> echoBench(vm), "vsock-echo").start(); }
            if (plan.mode.equals("bridgebench")) cmd.append("BRIDGEBENCH ").append(plan.benchSizes).append('\n');
            if (!plan.mode.equals("prepare") && !plan.mode.equals("maskbench")) cmd.append("WORKER ").append(plan.mode.equals("engine") || plan.mode.equals("bridgebench") ? "bridge" : plan.mode).append('\n');   // preparation has no worker
            if (!plan.mode.equals("prepare") && !plan.mode.equals("maskbench")) for (String s : plan.shapes.split(";")) { String[] f = s.trim().split(","); if (f.length == 5) cmd.append("SHAPE ").append(String.join(" ", f)).append('\n'); }   // preparation has no shapes (the VM refuses PREPARE with any)
            cmd.append("RUN\n");
            out.write(cmd.toString().getBytes()); out.flush();
            if (plan.mode.equals("prepare") && modelOk) {   // the feed runs now; when it ends (complete, deadline, ended) the VM is told to STOP and reports what is present
                final OutputStream o = out; final String url = plan.artifactsUrl; final int dl = plan.artifactsDeadlineS; final boolean co = plan.artifactsCoalesce == 1;
                feedThread = new Thread(() -> { try { PadsClient.feedArtifacts(vm, url, dl, co); } finally { try { synchronized (o) { o.write("STOP\n".getBytes()); o.flush(); } } catch (Exception e) { say("PREPARE stop not sent: " + e); } } }, "vsock-artifact-feed");
                feedThread.start();
            }
            int n = 0;
            while ((line = r.readLine()) != null) {
                say("VSOCK " + line); n++;
                if (line.startsWith("PADWIN ")) PadsClient.onWindow(padSession, line, plan.name, out);   // the engine asks for a ledger window
                if (line.startsWith("RECEIPT ")) PadsClient.onReceipt(padSession, line);                 // the engine's signed usage
                if (line.startsWith("PADACK ")) PadsClient.onAck(padSession, line, plan.name);       // the VM's signed delivery acknowledgment
                if (line.equals("END")) { sawEnd = true; break; }
            }
            say("CONTROL closed after " + n + " lines");
        } catch (Exception e) {
            say("CONTROL error " + e);
        } finally {
            padSession.close();
            sEnded = true; cancelNativeBridge();
            if (feedThread != null) {   /* the guest may end first (its own deadline): the feed's terminal line must be in the capture, or its absence said explicitly */
                try { feedThread.join(5000); } catch (InterruptedException ignored) { }
                if (feedThread.isAlive()) say("PREPARE feed thread still running after a 5 s join: its terminal ARTIFACTS feed line is NOT in this capture");
            }
            burnersOn = false;   /* a finished leg leaves the app idle: the burners exist only while the VM decodes */
            try { pfd.close(); } catch (Exception ignored) { }
            if (relay != null) relay.close();
            captureClose(sawEnd);   /* the footer, then nothing more is written to the capture file */
        }
    }

    /* vsock round trip, app <-> guest: the floor under every exchange the bridge carries */
    static void echoBench(Object vm) {
        ParcelFileDescriptor pfd = connect(vm, 7780, 100);
        if (pfd == null) { say("ECHO connect failed"); return; }
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
            for (int size : new int[] { 64, 4096, 65536 }) {
                byte[] b = new byte[size]; long[] us = new long[200];
                for (int i = 0; i < 200; i++) {
                    long t0 = System.nanoTime(); out.write(b); out.flush();
                    int got = 0; while (got < size) { int r = in.read(b, got, size - got); if (r < 0) throw new java.io.EOFException(); got += r; }
                    us[i] = (System.nanoTime() - t0) / 1000;
                }
                java.util.Arrays.sort(us);
                say("ECHO " + size + " B: p50=" + us[100] + " us p90=" + us[180] + " us min=" + us[0] + " us");
            }
        } catch (Exception e) { say("ECHO error " + e); }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }

    /* The model's digest is only a cache TAG on the app side (the VM hashes what it holds); a 27 GB file takes
     * minutes to hash in Java, so the tag is remembered in a sidecar keyed by size and mtime and recomputed
     * only when the file changes. Never used for a security decision here. */
    /* The sidecar lives in the app's own files dir (filesDir, resolved from the Context at start-up): a model under
     * /data/local/tmp is readable but not writable by the app, so the sidecar next to it was never created and every
     * launch re-hashed the whole model (~45 s for the 27B). The key binds path + size + mtime; the digest remains only
     * the cache TAG sent with MODEL - the VM hashes what it holds. */
    static byte[] fileSha256Cached(String path) {
        java.io.File f = new java.io.File(path);
        java.io.File side = new java.io.File(filesDir, "model-tag-" + Integer.toHexString(path.hashCode()) + ".sha256");
        String key = f.length() + " " + f.lastModified() + " " + path + " ";
        try { if (side.exists() && side.length() <= 4096) { String line = new String(java.nio.file.Files.readAllBytes(side.toPath()), StandardCharsets.UTF_8).trim();   /* bounded: a tag line is ~120 bytes; anything larger is not ours */
              if (line.startsWith(key) && line.length() == key.length() + 64) { byte[] d = new byte[32]; for (int i = 0; i < 32; i++) d[i] = (byte) Integer.parseInt(line.substring(key.length() + 2 * i, key.length() + 2 * i + 2), 16); return d; } } } catch (Exception ignored) { }
        byte[] d = fileSha256(path);
        try { java.nio.file.Files.write(side.toPath(), (key + RelayAttach.hex(d) + "\n").getBytes(StandardCharsets.UTF_8)); } catch (Exception ignored) { }
        return d;
    }
    static byte[] fileSha256(String path) {
        try (InputStream in = new java.io.FileInputStream(path)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            byte[] buf = new byte[1 << 20]; int r; while ((r = in.read(buf)) > 0) md.update(buf, 0, r);
            return md.digest();
        } catch (Exception e) { say("MODEL sha256 failed: " + e); return new byte[32]; }
    }

    /* One model stage: a streamer for this line, "MODEL <bytes> <cache tag>" on the control channel, then the
     * VM's verdict line ("MODEL ok ..." / "MODEL fail ..."; null when the channel ended). `extra` bytes are
     * appended to the stream (the tamper regression); the tag is always the real file's. */
    /** " auth=catalog" on the MODEL and ENGINE lines when the run asks for catalog-v1 admission (the VM's measured pins decide whether it is admissible). */
    static String authFlag(Plan plan) { return "catalog".equals(plan.modelAuth) ? " auth=catalog" : ""; }
    /** " cache=only" on the MODEL line only (never on ENGINE): a miss then answers 'N' and the VM's store stays untouched. */
    static String cacheFlag(Plan plan) { return "only".equals(plan.modelCache) ? " cache=only" : ""; }
    static String modelStage(Object vm, Plan plan, OutputStream out, BufferedReader r, long extra) throws java.io.IOException {
        long modelBytes = new java.io.File(plan.model).length() + extra;
        new Thread(() -> streamModel(vm, plan, extra), "vsock-model").start();
        out.write(("MODEL " + modelBytes + " " + RelayAttach.hex(fileSha256Cached(plan.model)) + authFlag(plan) + cacheFlag(plan) + "\n").getBytes()); out.flush();   // the sha is only the cache tag; the VM hashes what it holds (or admits it through its measured catalog)
        String ml; while ((ml = r.readLine()) != null) { final boolean verdict = ml.startsWith("MODEL ok") || ml.startsWith("MODEL fail"); say("VSOCK " + (!verdict && ml.length() > 160 ? ml.substring(0, 160) + "…" : ml)); /* the verdict carries the full catalog identities: never truncated */ if (verdict) break; }
        return ml;
    }

    /* engine mode: the public model, streamed into the guest (8-byte length, then the bytes, then `extra` zero bytes) */
    static void streamModel(Object vm, Plan plan, long extra) {
        ParcelFileDescriptor pfd = connect(vm, MODEL_PORT, 150);
        if (pfd == null) { say("MODEL connect failed"); return; }
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new java.io.FileInputStream(plan.model)) {
            long bytes = new java.io.File(plan.model).length() + extra;
            byte[] hdr = new byte[8]; for (int i = 0; i < 8; i++) hdr[i] = (byte) (bytes >>> (8 * i));
            out.write(hdr); out.flush();
            int ans = new java.io.FileInputStream(pfd.getFileDescriptor()).read();     // 'K' = the VM already holds it, 'S' = send
            if (ans == 'K') { say("MODEL already in the VM's encrypted storage (" + (bytes >> 20) + " MiB), not streamed"); return; }
            if (ans == 'N') { say("MODEL not retained in the VM (cache-only): nothing streamed, the VM's store is unchanged"); return; }
            if (ans != 'S') { say("MODEL guest answered " + ans + ", not streaming"); return; }
            byte[] buf = new byte[1 << 20]; long sent = 0; int r; long t0 = System.nanoTime();
            while ((r = in.read(buf)) > 0) { out.write(buf, 0, r); sent += r; }
            for (long e = 0; e < extra; e++) out.write(0);
            out.flush();
            say("MODEL streamed " + (sent >> 20) + " MiB in " + ((System.nanoTime() - t0) / 1_000_000) + " ms");
        } catch (Exception e) { say("MODEL stream error " + e); }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }

    /* one worker connection per shape: connect into the guest, dial the TCP worker, pipe both ways, repeat */
    static void bridge(Object vm, Plan plan) {
        if (plan.worker.equals("echo")) {   // measure the vsock + this pump alone: bytes from the guest go straight back
            ParcelFileDescriptor pfd = connect(vm, WORKER_PORT, 25);
            if (pfd == null) return;
            if (plan.nativeEcho) {
                try {
                    if (pumpPriority != 0) android.os.Process.setThreadPriority(pumpPriority);
                    say("BRIDGE native echo: " + NativeEcho.describe(pfd.getFd()));
                    say("BRIDGE native echo closed, bytes_or_negative_errno=" + NativeEcho.run(pfd.getFd()));
                } catch (LinkageError | RuntimeException e) { say("BRIDGE native echo failed: " + e); }
                finally { try { pfd.close(); } catch (Exception ignored) {} }
                return;
            }
            say("BRIDGE echo: guest bytes returned to the guest (no TCP)");
            InputStream gi = new FileInputStream(pfd.getFileDescriptor()); OutputStream go = new FileOutputStream(pfd.getFileDescriptor());
            long n = pipe(gi, go, "echo");
            try { pfd.close(); } catch (Exception ignored) { }
            say("BRIDGE echo closed, " + n + " bytes");
            return;
        }
        String host = plan.worker.substring(0, plan.worker.lastIndexOf(':')); int port = Integer.parseInt(plan.worker.substring(plan.worker.lastIndexOf(':') + 1));
        int conn = 0;
        while (!sEnded) {
            ParcelFileDescriptor pfd = connect(vm, WORKER_PORT, 25);
            if (pfd == null) break;
            conn++;
            // A plain AF_INET socket (not Java's dual-stack v6-mapped one): over the USB NCM link the
            // engine's stream from the app stalled the link within seconds while the same bytes from a
            // shell (AF_INET) did not; bisecting that starts here.
            try (Socket s = new Socket(java.net.Inet4Address.getByName(host), port)) {
                s.setTcpNoDelay(true);
                final int id = conn;
                say("BRIDGE #" + id + " guest<->" + plan.worker);
                if (plan.nativeBridge) {
                    /* one native thread, bounded buffers, no per-chunk JNI or Java-heap copies; Java owns every
                     * descriptor and closes them after the run. The native pump has no rate limiter, so a
                     * configured pace is a hard mismatch, not a silent no-op. */
                    if (paceBytesPerSec > 0) throw new IllegalStateException("nativebridge cannot honor pace=" + paceBytesPerSec + " B/s; unset pace or use the Java pump");
                    ParcelFileDescriptor[] cancel = null; ParcelFileDescriptor spfd = null, traceFd = null; java.io.File traceFile = null; long[] st = new long[10]; int rc = 0;
                    try {
                        /* acquire every descriptor inside the cleanup scope: an exception here leaks nothing */
                        cancel = ParcelFileDescriptor.createSocketPair();
                        spfd = ParcelFileDescriptor.fromSocket(s);
                        /* publish the cancel end and read the ended flag UNDER the lock, so a set-ended + cancel
                         * that runs before this point is honored instead of lost (the run would idle forever) */
                        boolean alreadyEnded;
                        synchronized (sBridgeLock) { sBridgeCancel = sEnded ? null : cancel[1]; alreadyEnded = sEnded; }
                        if (alreadyEnded) { rc = -125 /* -ECANCELED */; }
                        else {
                            if (pumpPriority != 0) android.os.Process.setThreadPriority(pumpPriority);
                            boolean profile = plan.bridgeProfile || ("," + plan.shenv + ",").contains(",SHIELDED_SOURCE_PROFILE=1,");
                            if (profile) say("BRIDGE profile: call CPU and wall timing enabled");
                            say("BRIDGE send cap: guest=" + plan.bridgeWriteMax + " tcp=0");
                            if (plan.bridgeIo) {
                                traceFile = java.io.File.createTempFile("bridge-io-", ".bin", filesDir);
                                traceFd = ParcelFileDescriptor.open(traceFile, ParcelFileDescriptor.MODE_WRITE_ONLY);
                                say("BRIDGE_IO file=" + traceFile.getName());
                            }
                            rc = NativeBridge.run(pfd.getFd(), spfd.getFd(), cancel[0].getFd(), 0, profile, plan.bridgeWriteMax, traceFd == null ? -1 : traceFd.getFd(), st);
                        }
                    } finally {
                        if (traceFd != null) try { traceFd.close(); } catch (Exception ignored) { }
                        synchronized (sBridgeLock) { sBridgeCancel = null; }   /* clear before closing: no signal can touch a closing fd */
                        if (spfd != null) try { spfd.close(); } catch (Exception ignored) { }
                        if (cancel != null) { try { cancel[0].close(); } catch (Exception ignored) { } try { cancel[1].close(); } catch (Exception ignored) { } }
                        try { pfd.close(); } catch (Exception ignored) { }
                    }
                    say("BRIDGE #" + id + " native closed rc=" + rc + " up=" + st[0] + " down=" + st[1] + " bytes, reads=" + st[2] + " writes=" + st[3] + " polls=" + st[4] + " max_read=" + st[5]);
                    if (traceFile != null) say("BRIDGE_IO complete file=" + traceFile.getName() + " records=" + st[6] + " dropped=" + st[7] + " bytes=" + st[8] + " status=" + st[9]);
                } else {
                InputStream gi = new FileInputStream(pfd.getFileDescriptor()); OutputStream go = new FileOutputStream(pfd.getFileDescriptor());
                InputStream wi = s.getInputStream(); OutputStream wo = s.getOutputStream();
                Thread up = new Thread(() -> pipe(gi, wo, "up"), "bridge-up"); up.start();
                long[] down = { pipe(wi, go, "down") };
                try { s.shutdownInput(); } catch (Exception ignored) { }
                try { pfd.close(); } catch (Exception ignored) { }
                up.join();
                say("BRIDGE #" + id + " closed, down=" + down[0] + " bytes");
                }
            } catch (Exception e) {
                say("BRIDGE error " + e);
                try { pfd.close(); } catch (Exception ignored) { }
                if (!sEnded) { try { Thread.sleep(300); } catch (InterruptedException ignored) { } }
            }
        }
    }
    // The VM's decode is ~100 short compute bursts per token between link waits; the phone's governor
    // answers that duty cycle with 0.4 GHz on the mid cores. Spinning threads INSIDE the VM (engine
    // ANCHOR_BOOST_THREADS) made it worse: to the phone they are normal-priority crosvm threads and
    // they preempt the compute vCPUs. Burners in the app at the lowest priority (nice 19) keep the
    // clusters' clocks up and yield to the vCPU threads: measured +57% tokens/s as shell burners.
    static volatile boolean burnersOn = false;
    static void startBurners(int n) {
        burnersOn = n > 0;
        for (int i = 0; i < n; i++) {
            Thread t = new Thread(() -> {
                try { android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_LOWEST); } catch (Exception ignored) { }
                long x = 0; while (burnersOn) { x += x * 31 + 7; if ((x & 0xffff) == 1) Thread.onSpinWait(); }
            }, "burner-" + i);
            t.setDaemon(true); t.start();
        }
    }
    /* Cancel by half-closing the dedicated cancel-writer socket: the native pump polls the reader end for
     * POLLIN and treats EOF/POLLHUP as cancel, so no byte is written (no O_NONBLOCK, no EINTR retry, no
     * swallowed setup failure) and a second call is idempotent. Under the lock so it never races the
     * publish/clear/close of the fd. */
    static final Object sBridgeLock = new Object();
    static volatile ParcelFileDescriptor sBridgeCancel = null;
    static void cancelNativeBridge() {
        synchronized (sBridgeLock) {
            ParcelFileDescriptor c = sBridgeCancel; if (c == null) return;
            try { Os.shutdown(c.getFileDescriptor(), OsConstants.SHUT_RDWR); }
            catch (android.system.ErrnoException e) { if (e.errno != OsConstants.ENOTCONN) Log.w(TAG, "cancel shutdown", e); }
            catch (Exception ignored) { }
        }
    }
    static volatile long paceBytesPerSec = 0;   // > 0: cap the guest->worker pump (the weight upload) to this rate; bursts up to 2 MB pass
    static volatile int pumpPriority = 0;   // ANCHOR_PUMP_PRIO via --ei pumpprio: android.os.Process priority for the pump threads (0 = leave)
    static long pipe(InputStream in, OutputStream out, String dir) {
        long total = 0; byte[] buf = new byte[65536];
        if (pumpPriority != 0) { try { android.os.Process.setThreadPriority(pumpPriority); say("BRIDGE " + dir + " pump priority " + pumpPriority + " -> " + android.os.Process.getThreadPriority(android.os.Process.myTid())); } catch (Exception e) { say("BRIDGE pump priority: " + e); } }
        // Token bucket for the "up" pump: the USB NCM link to the host wedged under sustained line-rate
        // uploads (netbench: nondeterministic at ~40 MB/s, never seen at <= 24 MB/s); an exchange's
        // burst (<= 2 MB) is never delayed, only a long stream is.
        long tokens = 2L << 20, tLast = System.nanoTime(); final boolean pace = dir.equals("up") && paceBytesPerSec > 0;
        // (No spin on available(): the vsock stream lacks FIONREAD, and spinning the TCP side made the
        //  exchange slower, 5.4 -> 18 ms, by starving the phone's other threads; run24.)
        try {
            int n;
            for (;;) {
                if ((n = in.read(buf)) <= 0) break;
                if (pace) {
                    long now = System.nanoTime(); tokens = Math.min(2L << 20, tokens + (now - tLast) * paceBytesPerSec / 1_000_000_000L); tLast = now;
                    if (tokens < n) { long wait = (n - tokens) * 1_000_000_000L / paceBytesPerSec; try { Thread.sleep(wait / 1_000_000L, (int) (wait % 1_000_000L)); } catch (InterruptedException ignored) { } tokens = 0; }
                    else tokens -= n;
                }
                out.write(buf, 0, n); out.flush(); total += n;
            }
        } catch (Exception ignored) { }
        try { out.close(); } catch (Exception ignored) { }
        return total;
    }
}
