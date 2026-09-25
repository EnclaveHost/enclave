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
import java.io.Closeable;
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
    public static final class Plan implements Cloneable {
        /** A field-for-field copy for a supervised restart; only the scripted turns change (Main.restartVm). */
        static Plan copyForRestart(Plan p) { try { return (Plan) p.clone(); } catch (CloneNotSupportedException e) { throw new IllegalStateException(e); } }
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
        int bridgeWriteMax = 0;               // --ei bridgewrite 4096|8192: experimental VM-bound native send cap; 0 keeps existing sends
        int bridgeBatch = 0;                  // --ei bridgebatch 65536: batch Shielded response bytes, flushing each final tail
        int padWriteMax = 0;                  // --ei padwrite 4096|8192|65536: experimental pad body write cap; cached HTTP downloads unchanged
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
        int padsDirectFill = 0;              // --ei pads_direct_fill 1: gather HTTP fragments into bounded VM body writes; requires pads_direct
        int quietPadsMs = 0;                 // --ei quiet_pads_ms 20000: EXPERIMENT, engine mode only. Total budget per quiet
                                             // transaction; must equal shenv ANCHOR_QUIET_PADS. 0/unset = off, ordinary path untouched.
        int padCredit = 0;                   // --ei padcredit 8192: EXPERIMENT, engine mode only. The VM's PAD LISTENER receive credit window, set and
                                             // acknowledged (PADWINDOW) before any pads-port sender starts. 0 = default, no command sent, nothing changed.
                                             // Everything that uses the pads port is affected: shipments, prefix assets and artifacts.
        String modelCache = "";              // --es model_cache only: the VM reuses a retained model or refuses ('N', nothing streamed, store untouched); "" = today's re-receive on a miss
        int ctx = 4096;                      // --ei ctx: mode local, the conversation's context window in tokens (512..32768)
        int maxNew = 512;                    // --ei max_new: mode local, the most tokens one reply may run to (1..8192)
        int temperatureMilli = 0;            // --ei temp_milli: mode local, sampling temperature x1000 (0 = greedy, reproducible; chat screen default 700)
        String tpuGraphs = "";               // --es tpu_graphs <dir>: mode local with Shielded-TPU decode: the compiled per-block graphs (L<n>.tflite) the app-side worker loads
        String tpuBundle = "";               // --es tpu_bundle <file>: the public lane bundle streamed into the VM (tpu/make_graphs.py)
        int tpuBank = 64;                    // --ei tpu_bank: pad positions minted in the VM before READY (0 = mint inside decode steps, which the stats then show)
        int tpuRefill = 0;                   // --ei tpu_refill 0..8: background minter threads in the VM during decode (0 = only the bank minted before READY)
        int tpuPrio = 99;                    // --ei tpu_prio: worker thread priority (99 = URGENT_AUDIO, the default; 0 = normal; 10 = background)
        int tpuLinks = 0;                    // --ei tpu_links 2..4: extra worker connections for the link-scaling benchmark ONLY (mode local)
        int tpuSpin = 0;                     // --ei tpu_spin 1..20000: us the VM polls the worker link for a reply before sleeping (0 = block)
        int tpuWorkerSpin = 0;               // --ei tpu_worker_spin 1..20000: us the worker polls for the next request before sleeping (0 = block)
        int poolPoll = -1;                   // --ei pool_poll 0..100: the VM thread pool's polling level (-1 = ggml's default)
        int decodeThreads = 0;               // --ei decode_threads 1..16: a separate decode pool (0 = one pool of `threads`)
        int corrThreads = 0;                 // --ei corr_threads 1..5: helpers for the TPU lane's out-of-lane correction (0 = the engine's default, 1)
        int verifyThreads = 0;               // --ei verify_threads 1..16: the pool speculative verification uses after the prompt (0 = the prompt's)
        int tpuLayers = 35;                  // --ei tpu_layers: how many L<n>.tflite files the worker loads
        String draft = "";                   // --es draft <gguf>: mode local, a drafter model streamed into the VM for speculative rows (the target verifies every proposal); "none" = no drafter
        String laneDefaults = "";            // which Shielded-TPU profile values this launch took by default (logged in "LOCAL plan"), "" off the TPU lane
        int draftMax = 4;                    // --ei draft_max 1..4: proposals per step (the TPU graphs verify 5 rows at once)
        String app = "";                     // mode app: the portable component file (PVM-CPU.md, "The app runtime")
        String appArgs = "";                 // --es app_args "a|b": its arguments
        String appSha = "";                  // --es app_sha256: TEST HOOK -- announce this digest instead of the file's (the VM must refuse)
        String appGraph = "";                // --es app_graph <name>: the component runs over the staged model (LOCAL line + APP graph=), wasi:nn
        String appHttp = "";                 // --es app_http "/ping|/?q=1": a wasi:http app (APP serve=http); these GETs are sent to it, then STOP
        int appTls = 0;                      // --ei app_tls 1: LAB serving prototype: APP serve=https (TLS in the VM), reached only through the relay
        int appServeS = 240;                 // --ei app_serve_s N: LAB: STOP the served app after N seconds
        String appAnnounced = "";            // the APP line's digest (the app's identity), for the ABI/2 evidence frame
        String attachSigner = null;          // --es attach_signer <http(s) URL>: the owner's attach co-signer (RUNNER-AGENT.md "Attach")
        String proofPins = "";               // --es proof_pins "<chainId> <proofOfTime> <registry> <deployment> <enclaveId> <operator>": the lease
                                             // proof key's pins (PROOF-KEY.md), handed to the VM once; the VM parses them strictly
        /* the whole model runs in the VM's CPU engine: mode local, or an app over the model (PVM-CPU.md, milestone 3) */
        boolean localEngine() { return mode.equals("local") || (mode.equals("app") && !appGraph.isEmpty()); }
        String deviceProfile = "";           // mode local: what DeviceProfile read (capacities, RAM) and chose from it
        int restarts = -1;                   // --ei restarts N (0..5): mode local restarts a VM that died mid-conversation; -1 = the tier's default (pvm-cpu 2, research 0)
        String ask = "";                     // --es ask "first|second": mode local, scripted turns logged with their counters (the host tunnel will drive the same session)
        String configError = "";             // a plan that must not run (mutually exclusive extras): the launcher says HOST FAIL and stops instead of guessing
        static Plan from(Intent i) {
            Plan p = new Plan(); if (i == null) return p;
            p.nativeEcho = i.getBooleanExtra("nativeecho", false);
            p.nativeBridge = i.getBooleanExtra("nativebridge", false);
            p.bridgeProfile = i.getBooleanExtra("bridgeprofile", false);
            p.bridgeWriteMax = i.getIntExtra("bridgewrite", 0);
            p.bridgeBatch = i.getIntExtra("bridgebatch", 0);
            p.padWriteMax = i.getIntExtra("padwrite", 0);
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
            p.padsDirectFill = i.getIntExtra("pads_direct_fill", 0);
            p.padCredit = i.getIntExtra("padcredit", 0);
            p.quietPadsMs = i.getIntExtra("quiet_pads_ms", 0);
            if (i.getStringExtra("model_cache") != null) p.modelCache = i.getStringExtra("model_cache");
            if (i.getStringExtra("shenv") != null) p.shenv = i.getStringExtra("shenv");   // read BEFORE the validation chain: prepare mode judges its ANCHOR_ARTIFACT_PROFILE request here
            final long quietShenv = quietIntentMs(p.shenv);
            if (quietShenv < 0) p.configError = "shenv ANCHOR_QUIET_PADS must appear at most once as canonical decimal 0 or 3000..45000";
            else if (p.quietPadsMs != 0 && (p.quietPadsMs < 3000 || p.quietPadsMs > 45000)) p.configError = "quiet_pads_ms must be 0 or 3000..45000";
            else if (p.quietPadsMs != quietShenv) p.configError = "quiet_pads_ms " + p.quietPadsMs + " and shenv ANCHOR_QUIET_PADS " + quietShenv + " must agree: the app arms the gate and the engine drives it, so one intent";
            else if (p.quietPadsMs != 0 && !p.mode.equals("engine")) p.configError = "quiet_pads_ms is engine mode only: nothing else has a measured trial to quieten";
            // The gate covers the two PADS_PORT senders that hold a Session. streamFiles,
            // streamArtifacts and feedArtifacts open the same port WITHOUT one, so with any of
            // them a drained interval would be quiet for pad shipments only. Refuse rather than
            // word the claim that way; the current bench provisions neither.
            else if (p.quietPadsMs != 0 && !p.artifacts.isEmpty()) p.configError = "quiet_pads_ms with artifacts: the artifact feeder is not gated, so the interval would not be quiet";
            else if (p.quietPadsMs != 0 && !p.artifactsUrl.isEmpty()) p.configError = "quiet_pads_ms with artifacts_url: the artifact feeder is not gated, so the interval would not be quiet";
            else if (p.quietPadsMs != 0 && (!p.prefix.isEmpty() || !p.prefixName.isEmpty() || !p.prefixDigest.isEmpty())) p.configError = "quiet_pads_ms with a shared prefix: the prefix streamer is not gated, and a remote fetch can populate it later";
            else if (p.quietPadsMs != 0 && p.padsDirect != 0) p.configError = "quiet_pads_ms needs pads_direct 0: the direct path would park its HTTP fetch thread on the gate, and HTTP fetching must stay normal";
            else if (!p.artifacts.isEmpty() && !p.artifactsUrl.isEmpty()) p.configError = "artifacts (directory) and artifacts_url (feed) are both set: choose one";
            else if (!p.artifactsUrl.isEmpty() && !ArtifactFeed.validBase(p.artifactsUrl)) p.configError = "artifacts_url must be http://127.0.0.1:<port>/v1/artifacts (the host feed through adb reverse)";
            else if (p.artifactsDeadlineS < 1 || p.artifactsDeadlineS > 600) p.configError = "artifacts_deadline must be 1..600 seconds";
            else if (p.artifactsCoalesce != 0 && p.artifactsCoalesce != 1) p.configError = "artifacts_coalesce must be 0 or 1";
            else if (p.padsDirect != 0 && p.padsDirect != 1) p.configError = "pads_direct must be 0 or 1";
            else if (p.padsDirectFill != 0 && p.padsDirectFill != 1) p.configError = "pads_direct_fill must be 0 or 1";
            else if (p.padsDirectFill != 0 && p.padsDirect == 0) p.configError = "pads_direct_fill needs pads_direct";
            else if (p.padCredit != 0 && p.padCredit != 8192) p.configError = "padcredit must be 0 or 8192";
            else if (p.padCredit != 0 && !p.mode.equals("engine")) p.configError = "padcredit is an engine-mode experiment only (mode " + p.mode + " refused rather than silently ignored)";
            else if (p.bridgeWriteMax != 0 && p.bridgeWriteMax != 4096 && p.bridgeWriteMax != 8192) p.configError = "bridgewrite must be 0, 4096 or 8192";
            else if (p.bridgeWriteMax != 0 && !p.nativeBridge) p.configError = "bridgewrite needs nativebridge";
            else if (p.bridgeBatch != 0 && p.bridgeBatch != 65536) p.configError = "bridgebatch must be 0 or 65536";
            else if (p.bridgeBatch != 0 && !p.nativeBridge) p.configError = "bridgebatch needs nativebridge";
            else if (p.padWriteMax != 0 && p.padWriteMax != 4096 && p.padWriteMax != 8192 && p.padWriteMax != 65536) p.configError = "padwrite must be 0, 4096, 8192 or 65536";
            else if (p.bridgeIo && !p.nativeBridge) p.configError = "bridgeio needs nativebridge";
            else if (!p.modelCache.isEmpty() && !p.modelCache.equals("only")) p.configError = "model_cache must be \"only\" or absent";
            else if (p.mode.equals("prepare") && (!"catalog".equals(p.modelAuth) || p.artifactsUrl.isEmpty())) p.configError = "mode prepare needs model_auth catalog and artifacts_url (no engine, no seed, no worker)";
            else if (p.mode.equals("prepare") && ArtifactProfile.requested(p.shenv) < 0) p.configError = "shenv " + ArtifactProfile.KEY + " must be 0 or 1, once (the only shenv key a preparation honours, as the explicit ARTIFACT_PROFILE control line)";
            p.n = i.getIntExtra("n", p.n); p.threads = i.getIntExtra("threads", p.threads); p.mtp = i.getIntExtra("mtp", p.mtp); p.boost = i.getIntExtra("boost", p.boost); p.burners = i.getIntExtra("burners", p.burners); p.hugepages = i.getIntExtra("hugepages", p.hugepages); p.pumpprio = i.getIntExtra("pumpprio", p.pumpprio); p.tamper = i.getIntExtra("tamper", p.tamper); p.fresh = i.getIntExtra("fresh", p.fresh); if (i.getStringExtra("vmname") != null && i.getStringExtra("vmname").matches("[a-z0-9_-]{1,32}")) p.vmName = i.getStringExtra("vmname"); pumpPriority = p.pumpprio; paceBytesPerSec = (long) i.getIntExtra("pace_mbps", 0) << 20; p.storageMib = i.getIntExtra("storage", (int) p.storageMib);
            if (p.mode.equals("delete")) {   // diagnostic deletion of exactly the owned test instance; judged on the RAW extra, after vmname is parsed above
                final String raw = i.getStringExtra("vmname");
                if (!"anchorfeed1".equals(raw)) p.configError = "mode delete removes only the owned test VM instance anchorfeed1 (explicit --es vmname anchorfeed1); refused for " + (raw == null ? "<missing>" : "'" + raw + "'");
            }
            p.ctx = i.getIntExtra("ctx", p.ctx); p.maxNew = i.getIntExtra("max_new", p.maxNew); p.temperatureMilli = i.getIntExtra("temp_milli", p.temperatureMilli);
            if (i.getStringExtra("ask") != null) p.ask = i.getStringExtra("ask");
            p.restarts = i.getIntExtra("restarts", -1);
            if (i.getStringExtra("app") != null) p.app = i.getStringExtra("app");
            if (i.getStringExtra("app_args") != null) p.appArgs = i.getStringExtra("app_args");
            if (i.getStringExtra("app_sha256") != null) p.appSha = i.getStringExtra("app_sha256");
            if (i.getStringExtra("app_graph") != null) p.appGraph = i.getStringExtra("app_graph");
            if (i.getStringExtra("app_http") != null) p.appHttp = i.getStringExtra("app_http");
            p.appTls = i.getIntExtra("app_tls", 0); p.appServeS = i.getIntExtra("app_serve_s", p.appServeS);
            if (i.getStringExtra("proof_pins") != null) p.proofPins = i.getStringExtra("proof_pins").trim();
            if (i.getStringExtra("attach_signer") != null) p.attachSigner = i.getStringExtra("attach_signer").trim();
            if (p.attachSigner != null && !p.attachSigner.matches("https?://[^\\s]+/attach-sign")) p.configError = "attach_signer must be the owner's http(s) co-signer URL ending /attach-sign";
            if (!p.proofPins.matches("[0-9a-fx ]*")) p.configError = "proof_pins must be the six pins, lowercase, space-separated";
            if (p.mode.equals("app") && p.configError.isEmpty()) {
                if (p.app.isEmpty() || !new java.io.File(p.app).isFile()) p.configError = "mode app needs --es app <component file>";
                else if (!p.appSha.isEmpty() && !p.appSha.matches("[0-9a-f]{64}")) p.configError = "app_sha256 must be 64 lowercase hex";
                else if (p.appArgs.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 8192) p.configError = "app_args must be at most 8192 bytes";
                else if (!p.appGraph.isEmpty() && !p.appGraph.matches("[a-z0-9][a-z0-9._-]{0,63}")) p.configError = "app_graph must be 1..64 of [a-z0-9._-], starting with a letter or digit";
                else if (!p.appGraph.isEmpty() && !new java.io.File(p.model).isFile()) p.configError = "app_graph runs the app over the model, and model " + p.model + " is not a file";
                else if (!p.appHttp.isEmpty() && !p.appArgs.isEmpty()) p.configError = "app_http serves the component over HTTP: it takes no app_args";
                else if (p.appTls != 0 && (p.appTls != 1 || !p.appHttp.isEmpty() || !p.appArgs.isEmpty() || p.relay == null)) p.configError = "app_tls 1 (lab) serves the component over TLS through the relay: it needs --es relay and takes no app_http or app_args";
                else if (p.appServeS < 10 || p.appServeS > 3600) p.configError = "app_serve_s must be 10..3600";
                else if (!p.appHttp.isEmpty() && !p.appHttp.matches("(/[\\x21-\\x7e]{0,1023})(\\|/[\\x21-\\x7e]{0,1023}){0,7}")) p.configError = "app_http is 1..8 paths separated by |, each starting with / and holding no spaces or control bytes";
            }
            if (p.restarts < -1 || p.restarts > 5) p.configError = "restarts must be 0..5";
            if (i.getStringExtra("draft") != null) p.draft = "none".equals(i.getStringExtra("draft")) ? "" : i.getStringExtra("draft");
            p.draftMax = i.getIntExtra("draft_max", p.draftMax);
            p.tpuLinks = i.getIntExtra("tpu_links", p.tpuLinks);
            p.poolPoll = i.getIntExtra("pool_poll", p.poolPoll); p.decodeThreads = i.getIntExtra("decode_threads", p.decodeThreads); p.corrThreads = i.getIntExtra("corr_threads", p.corrThreads); p.verifyThreads = i.getIntExtra("verify_threads", p.verifyThreads);
            p.tpuSpin = i.getIntExtra("tpu_spin", p.tpuSpin); p.tpuWorkerSpin = i.getIntExtra("tpu_worker_spin", p.tpuWorkerSpin);
            p.tpuPrio = i.getIntExtra("tpu_prio", p.tpuPrio);
            if (i.getStringExtra("tpu_graphs") != null) p.tpuGraphs = i.getStringExtra("tpu_graphs");
            if (i.getStringExtra("tpu_bundle") != null) p.tpuBundle = i.getStringExtra("tpu_bundle");
            p.tpuBank = i.getIntExtra("tpu_bank", p.tpuBank); p.tpuRefill = i.getIntExtra("tpu_refill", p.tpuRefill); p.tpuLayers = i.getIntExtra("tpu_layers", p.tpuLayers);
            if (p.localEngine()) {                                                 // the WHOLE model runs in the VM (LOCAL.md): no worker, pads, prefix, artifacts or catalog
                /* sized from what the kernel reports, never from the device name (DeviceProfile; PVM-CPU.md, Devices): on a Pixel 10
                 * this is the measured 6 threads and 7,168 MiB */
                final int[] caps = DeviceProfile.capacities(); final int big = DeviceProfile.bigCores(caps); final long ram = DeviceProfile.totalMib();
                if (i.getIntExtra("mem", 0) == 0) p.memMib = ram > 0 ? DeviceProfile.vmMemMib(ram) : 7168;
                if (i.getIntExtra("storage", 0) == 0) p.storageMib = 6144;
                if (i.getIntExtra("threads", 0) == 0) p.threads = big > 0 ? big : 6;   // the big and mid cores; the little ones drag every parallel section
                p.deviceProfile = "cpu_capacity " + java.util.Arrays.toString(caps) + " -> " + big + " cores at >= half the largest; RAM " + ram + " MiB";
                if (p.configError.isEmpty() && i.getIntExtra("mem", 0) == 0) { final String mr = DeviceProfile.memRefusal(p.memMib, new java.io.File(p.model).length()); if (mr != null) p.configError = mr; }
                // The MEASURED Shielded-TPU profile (TPU.md; TRANSFER-27B.md): before this, a launch that named only the graphs and
                // bundle ran the lane with none of it -- no drafter, one correction helper (so no parallel unmask), a 64-position
                // bank -- about 1 tok/s instead of 2.4-2.6. Applied ONLY on the TPU lane and ONLY to settings the launch did not
                // name, so a condition file still pins every value it gives; the CPU-only lane keeps its own, separately measured
                // defaults. The verification pool was only measured with a drafter, so it follows the drafter.
                if (!p.tpuGraphs.isEmpty()) {
                    final StringBuilder d = new StringBuilder();
                    if (!i.hasExtra("corr_threads")) { p.corrThreads = 3; d.append(" corr_threads=3"); }
                    if (!i.hasExtra("decode_threads")) { p.decodeThreads = 2; d.append(" decode_threads=2"); }
                    if (!i.hasExtra("tpu_bank")) { p.tpuBank = 128; d.append(" tpu_bank=128"); }
                    if (!i.hasExtra("draft")) { final java.io.File df = new java.io.File(filesDir, "draft.gguf"); if (df.isFile()) { p.draft = df.getPath(); d.append(" draft=").append(df.getPath()); } }
                    if (!i.hasExtra("verify_threads") && !p.draft.isEmpty()) { p.verifyThreads = 4; d.append(" verify_threads=4"); }
                    p.laneDefaults = d.length() == 0 ? "none (every profile setting named by the launch)" : d.toString().trim();
                }
                // The CPU lane's MEASURED default (results/pvm-cpu-threads1, 8 runs): decode on its own pool of 4 when there are
                // more threads. Sustained decode is the same with 4, 5 or 6 decode threads (the phone is thermally limited) and 4
                // spends ~32 % less CPU per token; prefill keeps every thread, so time to first token is unchanged (4 threads for
                // everything slowed prefill). Measured on a Pixel 10 only; a launch that names decode_threads keeps its value.
                else if (!i.hasExtra("decode_threads") && p.threads > 4) { p.decodeThreads = 4; p.deviceProfile += "; decode on its own pool of 4 (measured default)"; }
                if (p.configError.isEmpty()) {
                    if (!p.pads.isEmpty() || !p.prefix.isEmpty() || !p.prefixName.isEmpty() || !p.artifacts.isEmpty() || !p.artifactsUrl.isEmpty()) p.configError = "mode local takes no pads, prefix or artifacts: nothing leaves the VM, so nothing is blinded";
                    else if ("catalog".equals(p.modelAuth)) p.configError = "mode local stages with the whole-file digest; model_auth catalog is not wired into the local engine yet";
                    else if (p.tpuGraphs.isEmpty() != p.tpuBundle.isEmpty()) p.configError = "Shielded-TPU decode needs both tpu_graphs (the worker's compiled graphs) and tpu_bundle (the VM's lane bundle)";
                    else if (!p.tpuBundle.isEmpty() && !new java.io.File(p.tpuBundle).isFile()) p.configError = "tpu_bundle " + p.tpuBundle + " is not a file";
                    else if (p.tpuBank < 0 || p.tpuBank > 4096 || p.tpuLayers < 1 || p.tpuLayers > 128) p.configError = "tpu_bank must be 0..4096 and tpu_layers 1..128";
                    else if (!p.draft.isEmpty() && !new java.io.File(p.draft).isFile()) p.configError = "draft " + p.draft + " is not a file";
                    else if (p.draftMax < 1 || p.draftMax > 4) p.configError = "draft_max must be 1..4";
                    else if (p.tpuLinks != 0 && (p.tpuLinks < 2 || p.tpuLinks > 4)) p.configError = "tpu_links must be 0 (off) or 2..4";
                    else if (p.tpuLinks != 0 && p.tpuGraphs.isEmpty()) p.configError = "tpu_links needs the Shielded-TPU path (tpu_graphs/tpu_bundle)";
                    else if (p.poolPoll < -1 || p.poolPoll > 100) p.configError = "pool_poll must be -1 (default) or 0..100";
                    else if (p.decodeThreads < 0 || p.decodeThreads > 16) p.configError = "decode_threads must be 0 (one pool) or 1..16";
                    else if (p.verifyThreads < 0 || p.verifyThreads > 16) p.configError = "verify_threads must be 0 or 1..16";
                    else if (p.corrThreads < 0 || p.corrThreads > 5 || (p.corrThreads > 0 && p.tpuGraphs.isEmpty())) p.configError = "corr_threads must be 0 or 1..5, and needs the Shielded-TPU path";
                    else if (p.tpuSpin < 0 || p.tpuSpin > 20000 || p.tpuWorkerSpin < 0 || p.tpuWorkerSpin > 20000) p.configError = "tpu_spin and tpu_worker_spin must be 0..20000 us";
                    else if ((p.tpuSpin != 0 || p.tpuWorkerSpin != 0) && p.tpuGraphs.isEmpty()) p.configError = "tpu_spin/tpu_worker_spin need the Shielded-TPU path (tpu_graphs/tpu_bundle)";
                    else if (p.ctx < 512 || p.ctx > 32768) p.configError = "ctx must be 512..32768";
                    else if (p.threads < 1 || p.threads > 16) p.configError = "threads must be 1..16";
                    else if (p.maxNew < 1 || p.maxNew > 8192) p.configError = "max_new must be 1..8192";
                    else if (p.temperatureMilli < 0 || p.temperatureMilli > 2000) p.configError = "temp_milli must be 0..2000";
                }
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
    /* Evidence lines (the attestation chain, the signature) go to the capture WHOLE: the chain is what a verifier checks
     * (relay/avf-verify.mjs --log), and a capture that kept only the screen's 160-character form held no verifiable chain
     * (every capture before this did). The screen and logcat keep the short form. */
    static void sayEvidence(String s) {
        CaptureSink c = sCapture; if (c != null) c.line(s, sCaptureWarn);
        final String shortForm = s.length() > 160 ? s.substring(0, 160) + "…(" + s.length() + ")" : s;
        Log.i(TAG, shortForm);
        TextView t = sScreen;
        if (t != null) t.post(() -> t.append(shortForm + "\n"));
    }

    @Override protected void onCreate(Bundle saved) {
        super.onCreate(saved);
        TextView t = new TextView(this); t.setTextSize(11); t.setPadding(24, 24, 24, 24); t.setTypeface(android.graphics.Typeface.MONOSPACE);
        final String tier = Tier.of(this);   /* assets/tier, measured with the APK (PVM-CPU.md) */
        android.widget.LinearLayout col = new android.widget.LinearLayout(this); col.setOrientation(android.widget.LinearLayout.VERTICAL); col.setPadding(24, 48, 24, 0);
        col.addView(Tier.badge(this, tier));
        ScrollView sv = new ScrollView(this); sv.addView(t); col.addView(sv); setContentView(col); sScreen = t;
        final Plan plan = Plan.from(getIntent());
        final String tierWhy = Tier.refusal(tier, plan.mode, getIntent());
        if (tierWhy != null) plan.configError = "tier " + tier + ": " + tierWhy;   /* the tier's refusal is named first, whatever else is wrong */
        /* mode local computes in the VM on THIS activity's scheduling class: a dark phone turns top-app into the background cpuset mid-run (LOCAL.md) */
        if (plan.localEngine()) getWindow().addFlags(android.view.WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        if (!plan.configError.isEmpty()) { say("HOST FAIL: " + plan.configError); return; }   /* an inconsistent plan never runs a VM */
        if (!captureOpen(this, getIntent())) { say("CAPTURE FAIL: launch refused"); return; }
        say("TIER " + tier + " (assets/tier)");
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
    static Context appCtx = null;
    static void runVm(Context ctx, Plan plan) {
        appCtx = ctx; sLivePlan = plan;
        filesDir = ctx.getFilesDir();
        apkPath = ctx.getApplicationInfo().sourceDir;
        try {
            say("HOST start payload=" + plan.payload + " debug=" + plan.debug + " mem=" + plan.memMib + "MiB worker=" + plan.worker + " mode=" + plan.mode + " host=" + ctx.getClass().getSimpleName());
            if (!plan.deviceProfile.isEmpty()) say("HOST device profile: " + plan.deviceProfile + " -> threads " + plan.threads + ", VM mem " + plan.memMib + " MiB");
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
                /* EVERY setter, not a pattern list: the question is whether this AVF offers any channel between the
                 * pVM and this process faster than vsock. The masked rows are public by construction, so a shared
                 * ring would need no confidentiality at all - only speed - and the engine's own shm ring is why the
                 * same masking design costs 1.72x on a server and 17.7x here. */
                for (java.lang.reflect.Method m : cBuilder.getMethods()) { String n = m.getName(); if (n.startsWith("set")) caps.append(n).append(' '); }
                say("HOST VirtualMachineConfig.Builder ALL: " + caps);
                try { StringBuilder vmm2 = new StringBuilder();
                      for (java.lang.reflect.Method m : Class.forName(PKG + "VirtualMachine").getMethods()) vmm2.append(m.getName()).append(' ');
                      say("HOST VirtualMachine ALL: " + vmm2); } catch (Throwable t) { say("HOST VirtualMachine reflect: " + t); }
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
            /* mode local: every vCPU is a full-utilization compute thread. Without the boost the host scheduler was measured stacking
             * two busy vCPU threads on one big core while another idled, and ggml's even split then runs at the slower pair's pace
             * (7 tok/s instead of 14, LOCAL.md). Fixed at instance creation: an existing instance keeps what it was created with. */
            if (plan.localEngine()) say("HOST vCPU uclamp boost: " + (tryCall(b, "setShouldBoostUclamp", true) != null ? "requested" : "not available (hidden API: settings put global hidden_api_policy 1)"));
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
                    case "onPayloadReady": say("VM payload ready"); { final Plan live = sLivePlan != null ? sLivePlan : plan; new Thread(() -> control(vm, live), "vsock-control").start(); } break;
                    case "onPayloadFinished": say("VM payload finished exit=" + a[1]); break;
                    case "onError": say("VM error code=" + a[1] + " msg=" + a[2]); break;
                    case "onStopped": say("VM stopped reason=" + a[1]); if (sRestartPending) restartVm(vm); break;
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
    /* Supervised restart (mode local; PVM-CPU.md target 5): a VM that dies mid-conversation is run again with the turns that
     * remain. The interrupted turn is reported INTERRUPTED and never as an answer; the capture stays open across the restart
     * and is closed once, at the real end. */
    static volatile Plan sLivePlan;
    static volatile boolean sRestartPending, sInterrupted;
    static volatile int sTurnOffset = 0, sTurnsDone = 0, sInterruptedTurn = 0, sRestartsUsed = 0;
    static int restartsAllowed(Plan p) { return p.restarts >= 0 ? p.restarts : Tier.PVM_CPU.equals(Tier.of(appCtx)) ? 2 : 0; }
    static void restartVm(Object vm) {
        sRestartPending = false; sRestartsUsed++;
        final Plan base = sLivePlan; final Plan next = Plan.copyForRestart(base);
        final java.util.List<String> turns = new java.util.ArrayList<>();
        for (String q : base.ask.split("\\|")) if (!q.trim().isEmpty()) turns.add(q.trim());
        final int consumed = sInterruptedTurn - sTurnOffset;   /* turns of the live plan finished or interrupted */
        next.ask = String.join("|", turns.subList(Math.min(consumed, turns.size()), turns.size()));
        sTurnOffset = sInterruptedTurn; sInterrupted = false; sLivePlan = next;
        say("LOCAL restart " + sRestartsUsed + " boottime_ms=" + android.os.SystemClock.elapsedRealtime() + ": the VM stopped during turn " + sInterruptedTurn
            + "; running it again (" + (turns.size() - Math.min(consumed, turns.size())) + " turn(s) remain)");
        new Thread(() -> { try { call(vm, "run"); say("HOST vm.run() returned after restart, status=" + call(vm, "getStatus")); }
                           catch (Exception e) { say("LOCAL restart failed: " + e); captureClose(false); } }, "vm-restart").start();
    }
    static boolean ended() { return sEnded; }
    static void control(Object vm, Plan plan) {
        sEnded = false;
        // gateSends arms the send gate; it is the ONLY way to arm one, and it stays false for
        // every ordinary run, so the default path is untouched.
        final PadDelivery.Session padSession = PadDelivery.begin(plan.padWriteMax, plan.padsDirectFill != 0, plan.quietPadsMs > 0);
        say("PADS send cap: guest=" + plan.padWriteMax + " cache=0");
        say("PADS direct fill: enabled=" + plan.padsDirectFill);
        ParcelFileDescriptor pfd = connect(vm, CTRL_PORT, 50);
        if (pfd == null) { padSession.close(); say("CONTROL connect failed"); captureClose(false); return; }
        say("CONTROL connected");
        boolean sawEnd = false; Thread feedThread = null;   /* prepare mode: joined (bounded) at END so its terminal line lands in the capture */
        Thread localThread = null;                          /* mode local: joined (bounded) before the end is judged, so an interruption is known */
        if (plan.mode.equals("bridge") || plan.mode.equals("engine") || plan.mode.equals("bridgebench")) new Thread(() -> bridge(vm, plan), "vsock-bridge").start();
        RelayAttach relay = null;
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor());
             BufferedReader r = new BufferedReader(new InputStreamReader(new FileInputStream(pfd.getFileDescriptor())))) {
            // Created ONLY for a quiet plan: an ordinary run allocates no queue and takes on none
            // of this object's output-close semantics. Tracked on the session, so a session stop
            // closes it exactly as it closes every other resource - marked closed, worker
            // interrupted, gate and output closed. If the session will not own it there is no one
            // to stop the worker, so the run is refused here rather than measured ungated.
            final QuietPadsControl quietControl;
            if (plan.quietPadsMs > 0) {
                final QuietPadsControl qc = new QuietPadsControl(padSession, out);
                boolean owned = false;
                try { owned = padSession.track(qc); } catch (Exception e) { say("QUIETPADS not tracked: " + e); }
                if (!owned) {
                    qc.close();
                    throw new IllegalStateException("quiet pads requested but the pad session would not own the control helper; "
                                                    + "refusing the run rather than leaving an unowned worker");
                }
                quietControl = qc;
            } else quietControl = null;
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
                relay.attachSigner = plan.attachSigner;
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
                sayEvidence("VSOCK " + line);
                if (line.equals("ATTEST end")) break;
                java.util.regex.Matcher m;
                if ((m = java.util.regex.Pattern.compile("^CERT(\\d+)\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches())
                    certs.computeIfAbsent(Integer.parseInt(m.group(1)), (k) -> new TreeMap<>()).put(Integer.parseInt(m.group(2)), m.group(3));
                else if ((m = java.util.regex.Pattern.compile("^SIG\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches())
                    sig.put(Integer.parseInt(m.group(1)), m.group(2));
                else if (relay != null && (m = java.util.regex.Pattern.compile("^INSTANCEATTACH key=(302a300506032b6570032100[0-9a-f]{64}) sig=([0-9a-f]{128})$").matcher(line)).matches()) {
                    relay.instanceKey = m.group(1); relay.instanceSig = m.group(2); }
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
            if (plan.mode.equals("engine") || plan.mode.equals("prepare") || plan.localEngine()) {
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
                if (plan.padCredit != 0) {
                    // The pad receive window must be in force before ANY connection to the pads port exists: the guest kernel
                    // creates and initialises the accepted child on the incoming REQUEST, not at the VM's accept(). This is sent
                    // and acknowledged here, ahead of the pads/prefix/artifact sender threads below and ahead of the buffered
                    // ENGINE..RUN block, which is still written unchanged at its own point. Nothing before this line opens the
                    // pads port: bootstrap and fetchPrefix use this control channel and HTTP only, and the model stage is 7779.
                    // until() skips the ordinary diagnostics that may still be queued on the channel; the verdict is then exact.
                    out.write(("PADWINDOW " + plan.padCredit + "\n").getBytes()); out.flush();
                    String padAck = PadsClient.until(r, "PADWINDOW ");
                    if (padAck == null || !padAck.equals("PADWINDOW ok listener=" + plan.padCredit))
                        throw new IllegalStateException("PADWINDOW not acknowledged (" + padAck + "): the run is refused rather than measured at the default window");
                }
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
            if (plan.mode.equals("local")) {   // the whole model in the VM: one strict line (LocalChat.plan <-> anchor_local.h), then the conversation on its own port
                final boolean tpu = !plan.tpuBundle.isEmpty();
                String localLine = tpu ? LocalChat.plan(new java.io.File(plan.model).length(), plan.threads, plan.ctx, new java.io.File(plan.tpuBundle).length(), plan.tpuBank, plan.tpuRefill)
                                       : LocalChat.plan(new java.io.File(plan.model).length(), plan.threads, plan.ctx);
                if (!plan.draft.isEmpty()) localLine = LocalChat.withDraft(localLine, new java.io.File(plan.draft).length(), plan.draftMax);
                if (plan.tpuLinks >= 2) localLine = LocalChat.withLinks(localLine, plan.tpuLinks);
                if (tpu && plan.tpuSpin > 0) localLine = LocalChat.withSpin(localLine, plan.tpuSpin);
                if (plan.poolPoll >= 0) localLine = LocalChat.withPoll(localLine, plan.poolPoll);
                if (plan.decodeThreads > 0) localLine = LocalChat.withDecodeThreads(localLine, plan.decodeThreads);
                if (tpu && plan.corrThreads > 0) localLine = LocalChat.withCorrThreads(localLine, plan.corrThreads);
                if (plan.verifyThreads > 0) localLine = LocalChat.withVerifyThreads(localLine, plan.verifyThreads);
                cmd.append(localLine).append('\n');
                if (!plan.draft.isEmpty() && modelOk) new Thread(() -> streamPublicFile(vm, DRAFT_PORT, plan.draft, "drafter"), "vsock-draft").start();
                if (tpu && modelOk) { new Thread(() -> streamPublicFile(vm, BUNDLE_PORT, plan.tpuBundle, "TPU bundle"), "vsock-bundle").start(); new Thread(() -> tpuWorker(vm, plan), "tpu-worker").start(); }
                if (tpu && modelOk && plan.tpuLinks >= 2) for (int li = 0; li < plan.tpuLinks; li++) { final int w = li; new Thread(() -> benchLink(vm, w), "linkbench-" + li).start(); }
                say("LOCAL plan: " + plan.model + " (" + (new java.io.File(plan.model).length() >> 20) + " MiB), " + plan.threads + " threads, ctx " + plan.ctx + (plan.ask.isEmpty() ? ", no turns scripted (--es ask)" : ", scripted turns"));
                if (tpu) say("LOCAL tpu lane: corr_threads " + plan.corrThreads + ", decode_threads " + plan.decodeThreads + ", verify_threads " + plan.verifyThreads + ", tpu_bank " + plan.tpuBank + ", drafter " + (plan.draft.isEmpty() ? "none" : plan.draft + " draft_max " + plan.draftMax) + " | defaulted: " + plan.laneDefaults);
                if (modelOk) { localThread = new Thread(() -> localSession(vm, plan), "vsock-local"); localThread.start(); } else say("LOCAL not started: the model stage did not pass");
            }
            if (plan.mode.equals("app")) {   // the portable component: its identity on the control line, its bytes on APP_PORT
                final long abytes = new java.io.File(plan.app).length();
                final String asha = plan.appSha.isEmpty() ? RelayAttach.hex(fileSha256Cached(plan.app)) : plan.appSha;
                final String aargs = plan.appArgs.isEmpty() ? "" : " args=" + LocalChat.hex(plan.appArgs.replace('|', '\0').getBytes(java.nio.charset.StandardCharsets.UTF_8));
                if (!plan.appGraph.isEmpty()) {   // over the model: the engine's LOCAL line (no chat port is opened), the APP line names the graph
                    String localLine = LocalChat.plan(new java.io.File(plan.model).length(), plan.threads, plan.ctx);
                    if (plan.poolPoll >= 0) localLine = LocalChat.withPoll(localLine, plan.poolPoll);
                    if (plan.decodeThreads > 0) localLine = LocalChat.withDecodeThreads(localLine, plan.decodeThreads);
                    cmd.append(localLine).append('\n');
                    say("APP over the model: " + plan.model + " (" + (new java.io.File(plan.model).length() >> 20) + " MiB), " + plan.threads + " threads, ctx " + plan.ctx + ", graph " + plan.appGraph + (modelOk ? "" : " -- the model stage did not pass; the VM will refuse"));
                }
                plan.appAnnounced = asha;
                if (relay != null) {   // LAB: the relay's fresh nonce goes into the app's ABI/2 evidence (the VM binds it into Bind2)
                    try { final String an = relay.abi2Nonce.get(20, java.util.concurrent.TimeUnit.SECONDS); cmd.append("APPNONCE ").append(an).append('\n'); say("APP evidence will bind the relay's nonce " + an.substring(0, 16) + "…"); }
                    catch (Exception e) { say("RELAY issued no ABI/2 nonce within 20 s: the app's evidence will not verify there (" + e + ")"); }
                }
                if (!plan.proofPins.isEmpty()) { cmd.append("PROOFPINS ").append(plan.proofPins).append('\n'); say("APP proof pins handed to the VM (it signs checkpoints for these only)"); }
                cmd.append("APP bytes=").append(abytes).append(" sha256=").append(asha).append(aargs).append(plan.appGraph.isEmpty() ? "" : " graph=" + plan.appGraph)
                   .append(plan.appTls == 1 ? " serve=https" : plan.appHttp.isEmpty() ? "" : " serve=http").append('\n');
                new Thread(() -> streamPublicFile(vm, APP_PORT, plan.app, "app bundle"), "vsock-app").start();
                say("APP plan: " + plan.app + " (" + abytes + " bytes, sha256 " + asha + (plan.appSha.isEmpty() ? "" : ", ANNOUNCED BY THE TEST HOOK, not the file's") + "), args " + (plan.appArgs.isEmpty() ? "none" : plan.appArgs));
            }
            if (plan.mode.equals("maskbench")) cmd.append("MASKBENCH\n");   // sampler + cell-import speed probe: no model stage, no seed, no worker, no shapes
            if (plan.mode.equals("echo")) { cmd.append("ECHO\n"); new Thread(() -> echoBench(vm), "vsock-echo").start(); }
            if (plan.mode.equals("bridgebench")) cmd.append("BRIDGEBENCH ").append(plan.benchSizes).append('\n');
            if (!plan.mode.equals("prepare") && !plan.mode.equals("maskbench") && !plan.mode.equals("local") && !plan.mode.equals("app")) cmd.append("WORKER ").append(plan.mode.equals("engine") || plan.mode.equals("bridgebench") ? "bridge" : plan.mode).append('\n');   // preparation has no worker
            if (!plan.mode.equals("prepare") && !plan.mode.equals("maskbench") && !plan.mode.equals("local") && !plan.mode.equals("app")) for (String s : plan.shapes.split(";")) { String[] f = s.trim().split(","); if (f.length == 5) cmd.append("SHAPE ").append(String.join(" ", f)).append('\n'); }   // preparation has no shapes (the VM refuses PREPARE with any)
            cmd.append("RUN\n");
            out.write(cmd.toString().getBytes()); out.flush();
            if (plan.mode.equals("prepare") && modelOk) {   // the feed runs now; when it ends (complete, deadline, ended) the VM is told to STOP and reports what is present
                final OutputStream o = out; final String url = plan.artifactsUrl; final int dl = plan.artifactsDeadlineS; final boolean co = plan.artifactsCoalesce == 1;
                feedThread = new Thread(() -> { try { PadsClient.feedArtifacts(vm, url, dl, co); } finally { try { synchronized (o) { o.write("STOP\n".getBytes()); o.flush(); } } catch (Exception e) { say("PREPARE stop not sent: " + e); } } }, "vsock-artifact-feed");
                feedThread.start();
            }
            int n = 0;
            // LAB: the app's ABI/2 evidence as the VM prints it, relayed whole on "ABI2 end" for the relay to verify
            String abi2Id = null, abi2Tuple = null, abi2Inst = null; final TreeMap<Integer, TreeMap<Integer, String>> abi2Certs = new TreeMap<>();
            while ((line = r.readLine()) != null) {
                // the pVM CPU capability report (PVM-CPU.md): the capture keeps it WHOLE (it is verifiable offline with the chain),
                // and a bound relay tunnel receives it as the caps frame the relay admits the tier from
                final boolean caps = line.startsWith("CAPS ") && line.split(" ").length == 3 && !line.startsWith("CAPS summary");
                if (caps) sayEvidence("VSOCK " + line); else say("VSOCK " + line); n++;
                if (caps && relay != null) { final String[] cf = line.split(" "); relay.sendCaps(cf[1], cf[2]); }
                // The experiment measures ONE window. A child that did not inherit it has already stopped the VM's pads
                // receiver, so the run can only stall: end it here instead, through the finally below.
                if (plan.padCredit != 0 && line.startsWith("PADWINDOW child REFUSED"))
                    throw new IllegalStateException("the VM refused an accepted pads connection: " + line);
                if (line.startsWith("PADWIN ")) PadsClient.onWindow(padSession, line, plan.name, out);   // the engine asks for a ledger window
                if (line.startsWith("RECEIPT ")) PadsClient.onReceipt(padSession, line);                 // the engine's signed usage
                if (line.startsWith("PADACK ")) PadsClient.onAck(padSession, line, plan.name);       // the VM's signed delivery acknowledgment
                if (line.startsWith("QUIETPADS v1 ") && quietControl != null) quietControl.offer(line);   // hand it to the worker and keep reading
                if (line.startsWith("APP serving http") && !plan.appHttp.isEmpty()) { final OutputStream o = out; new Thread(() -> appHttpProbe(vm, plan.appHttp, o), "app-http").start(); }
                if (line.startsWith("ABI2 runtime ")) abi2Id = line.substring(13);
                else if (line.startsWith("ABI2 selftest ")) abi2Tuple = line.substring(14);
                else if (line.startsWith("ABI2 instance ")) abi2Inst = line;   // v3: the VM instance's key + its signature (INSTANCE-BINDING.md)
                else if (line.startsWith("ABI2_LINK")) { java.util.regex.Matcher m = java.util.regex.Pattern.compile("^ABI2_LINK(\\d+)\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line);
                    if (m.matches()) abi2Certs.computeIfAbsent(Integer.parseInt(m.group(1)), (k) -> new TreeMap<>()).put(Integer.parseInt(m.group(2)), m.group(3)); }
                else if (line.startsWith("ABI2 end") && relay != null && abi2Id != null && abi2Tuple != null && !abi2Certs.isEmpty()) {
                    final java.util.List<String> chain = new java.util.ArrayList<>();
                    for (TreeMap<Integer, String> chunks : abi2Certs.values()) chain.add(RelayAttach.b64(RelayAttach.unhex(String.join("", chunks.values()))));
                    relay.sendAbi2(chain, abi2Id, abi2Tuple, plan.appAnnounced, abi2Inst);
                }
                if (line.startsWith("APP serving https") && plan.appTls == 1 && relay != null) {
                    // LAB: from now the relay may open raw streams; this app splices each to the VM's TLS port and never
                    // sees plaintext (TLS terminates in the VM with the attested transport key); STOP after app_serve_s
                    relay.vmConnect = (port) -> connect(vm, port, 50);   // RelayAttach.portOf: the TLS app port or the evidence endpoint
                    final OutputStream o = out; final int secs = plan.appServeS;
                    say("APP https: relay streams are forwarded to the VM as ciphertext; the lab run STOPs in " + secs + " s");
                    new Thread(() -> { try { Thread.sleep(secs * 1000L); } catch (InterruptedException ignored) { }
                        try { synchronized (o) { o.write("STOP\n".getBytes()); o.flush(); } say("APP https: STOP sent (lab time limit)"); } catch (Exception e) { say("APP https: STOP not sent: " + e); } }, "app-tls-stop").start();
                }
                if (line.equals("END")) { sawEnd = true; break; }
            }
            say("CONTROL closed after " + n + " lines");
        } catch (Exception e) {
            say("CONTROL error " + e);
        } finally {
            padSession.close();        // closes the tracked QuietPadsControl with everything else
            sEnded = true; cancelNativeBridge();
            if (feedThread != null) {   /* the guest may end first (its own deadline): the feed's terminal line must be in the capture, or its absence said explicitly */
                try { feedThread.join(5000); } catch (InterruptedException ignored) { }
                if (feedThread.isAlive()) say("PREPARE feed thread still running after a 5 s join: its terminal ARTIFACTS feed line is NOT in this capture");
            }
            burnersOn = false;   /* a finished leg leaves the app idle: the burners exist only while the VM decodes */
            try { pfd.close(); } catch (Exception ignored) { }
            if (relay != null) relay.close();
            if (localThread != null) { try { localThread.join(10000); } catch (InterruptedException ignored) { } }
            if (sInterrupted && sRestartsUsed < restartsAllowed(plan)) {
                sRestartPending = true; say("LOCAL restart pending: the conversation was interrupted; the VM will be run again when it has stopped");
            } else captureClose(sawEnd);   /* the footer, then nothing more is written to the capture file */
        }
    }

    /* ---- Shielded-TPU decode (TPU.md): the public lane bundle into the VM, and the app-side worker on the VM's worker port ---- */
    static final int BUNDLE_PORT = 7782;
    // The benchmark links have their OWN port. They first shared WORKER_PORT with the real worker, and
    // because both sets of threads start at once while the real worker loads its graphs before dialling,
    // accept order could not tell the roles apart -- a benchmark link could have been handed to the lane.
    static final int BENCH_PORT = 7784;
    static final int DRAFT_PORT = 7783;
    static final int APP_PORT = 7785;       // the portable component (payload/anchor_app.h)
    static final int APP_HTTP_PORT = 7786;  // HTTP/1.1 to a served wasi:http app (APP ... serve=http)
    /* The test hook behind --es app_http: each path as its own GET on its own connection (Connection: close), the whole raw
     * response into the capture as APPHTTP <i> ms=<wall> <hex>, then STOP on the control channel. The product path puts the
     * relay tunnel where this loop is. */
    static void appHttpProbe(Object vm, String paths, OutputStream ctl) {
        int i = 0;
        for (String path : paths.split("\\|")) {
            i++;
            final long t0 = System.nanoTime();
            ParcelFileDescriptor pfd = connect(vm, APP_HTTP_PORT, 50);
            if (pfd == null) { say("APPHTTP " + i + " connect failed"); continue; }
            try (OutputStream o = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new FileInputStream(pfd.getFileDescriptor())) {
                o.write(("GET " + path + " HTTP/1.1\r\nHost: app\r\nConnection: close\r\n\r\n").getBytes(java.nio.charset.StandardCharsets.US_ASCII)); o.flush();
                java.io.ByteArrayOutputStream got = new java.io.ByteArrayOutputStream(); byte[] b = new byte[1 << 16]; int n;
                while ((n = in.read(b)) > 0 && got.size() < (4 << 20)) got.write(b, 0, n);
                sayEvidence("APPHTTP " + i + " ms=" + (System.nanoTime() - t0) / 1_000_000 + " " + LocalChat.hex(got.toByteArray()));
            } catch (Exception e) { say("APPHTTP " + i + " failed: " + e); }
            finally { try { pfd.close(); } catch (Exception ignored) { } }
        }
        try { synchronized (ctl) { ctl.write("STOP\n".getBytes()); ctl.flush(); } } catch (Exception e) { say("APPHTTP STOP not sent: " + e); }
    }
    /** A PUBLIC file into the VM's encrypted store (the lane bundle, a drafter): u64 size, the first 8 bytes and the file's
     *  SHA-256; then 'K' (the VM's cached copy IS that file, by its own recorded digest) or 'S' + the bytes, which the VM hashes
     *  as they arrive and refuses if they are not the digest announced here. Size and magic alone reused a stale int8 bundle
     *  under an int4 lane: the two have the same size and the same first 8 bytes. */
    static void streamPublicFile(Object vm, int port, String path, String what) {
        byte[] sha;
        try (InputStream f = new FileInputStream(path)) {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256"); byte[] b = new byte[1 << 20]; int n;
            long t0 = System.nanoTime(); while ((n = f.read(b)) > 0) md.update(b, 0, n); sha = md.digest();
            StringBuilder hx = new StringBuilder(); for (byte x : sha) hx.append(String.format("%02x", x & 0xff));
            say(what + " sha256=" + hx + " (hashed in " + ((System.nanoTime() - t0) / 1_000_000) + " ms)");
        } catch (Exception e) { say(what + ": cannot hash " + path + ": " + e); return; }
        ParcelFileDescriptor pfd = connect(vm, port, 900);
        if (pfd == null) { say(what + " connect failed"); return; }
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new FileInputStream(pfd.getFileDescriptor()); InputStream f = new FileInputStream(path)) {
            final long bytes = new java.io.File(path).length(); byte[] hdr = new byte[8]; for (int i = 0; i < 8; i++) hdr[i] = (byte) (bytes >>> (8 * i));
            // ...followed by the file's first 8 bytes. The VM keeps a cached copy keyed on size, and the digit-split
            // lane bundle has exactly the same size as the a16w8 one, so size alone would silently reuse the wrong format.
            byte[] magic = new byte[8]; { int got = 0; while (got < 8) { int r = f.read(magic, got, 8 - got); if (r <= 0) break; got += r; } }
            out.write(hdr); out.write(magic); out.write(sha); out.flush(); int ans = in.read();
            if (ans == 'K') { say(what + " already in the VM's encrypted storage (" + (bytes >> 20) + " MiB, same sha256), not streamed"); return; }
            if (ans != 'S') { say(what + ": the VM answered " + ans); return; }
            byte[] buf = new byte[1 << 20]; long sent = 0, t0 = System.nanoTime(); int n;
            out.write(magic); sent += magic.length;          // the 8 bytes already consumed to form the header
            while ((n = f.read(buf)) > 0) { out.write(buf, 0, n); sent += n; }
            out.flush(); say(what + " streamed " + (sent >> 20) + " MiB in " + ((System.nanoTime() - t0) / 1_000_000) + " ms");
        } catch (Exception e) { say(what + " stream error " + e); }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }
    static void tpuWorker(Object vm, Plan plan) {
        if (!TpuWorker.available()) { say("TPU worker unavailable: the VM will wait for a worker that never comes and end the run"); return; }
        /* The VM's six vCPUs run with uclamp boost (LOCAL.md); this thread did not, and it is the one the VM waits
         * for 140 times per token. Of the 4.28 ms link, 1.19 ms is neither the TPU nor the copies -- it is the two
         * hand-offs -- and a worker that loses the scheduling contest to a boosted vCPU pays for it twice. Ask for
         * the same treatment: nice -19, and an ADPF session naming this tid with the exchange's own deadline so the
         * governor keeps a big core available for it. Both are best-effort and neither is required to be granted. */
        /* MEASURING (--ei tpu_prio): the worker and the VM's vCPUs share six big cores with no spare one,
         * and the VM's own non-exchange work measures 90-117 ms per token while the CPU-only path computes
         * the WHOLE model in 69 ms. The VM's share here is a strict subset of that, so something is taking
         * three to five times longer than it should, and a worker holding nice -19 against boosted vCPUs is
         * the obvious suspect. Lowering it trades TPU dispatch latency for VM throughput; which way that
         * trade goes is a measurement, not a guess. */
        android.os.Process.setThreadPriority(plan.tpuPrio == 99 ? android.os.Process.THREAD_PRIORITY_URGENT_AUDIO : plan.tpuPrio);
        Object hint = null;
        try {
            Object phm = appCtx == null ? null : appCtx.getSystemService("performance_hint");
            if (phm != null) hint = phm.getClass().getMethod("createHintSession", int[].class, long.class)
                    .invoke(phm, new int[] { android.os.Process.myTid() }, 4_000_000L);
        } catch (Throwable t) { hint = null; }
        say("TPU worker: thread priority " + android.os.Process.getThreadPriority(android.os.Process.myTid())
            + (hint != null ? ", ADPF hint session held" : ", no ADPF hint session"));
        long t0 = System.nanoTime();
        /* LiteRT dlopens the Tensor dispatch library from a DIRECTORY; this APK keeps its libraries inside itself
         * (extractNativeLibs=false, the payload needs that), so the one library is copied out of the APK once per install. */
        String dispatch = extractDispatch();
        if (dispatch == null) { say("TPU worker: the Tensor dispatch library could not be extracted from the APK"); return; }
        long h = TpuWorker.nativeOpen(dispatch, plan.tpuGraphs, plan.tpuLayers, 5);
        if (h == 0) { say("TPU worker: the compiled graphs did not load (logcat tag anchor-tpu has the reason)"); return; }
        say("TPU worker: " + plan.tpuLayers + " compiled blocks loaded in " + ((System.nanoTime() - t0) / 1_000_000) + " ms");
        say(TpuWorker.nativeBench(h));
        ParcelFileDescriptor pfd = connect(vm, WORKER_PORT, 1500);
        if (pfd == null) { say("TPU worker: no connection to the VM's worker port"); TpuWorker.nativeClose(h); return; }
        /* Set on EVERY open, zero included, on this handle only: a value left from an earlier run must not survive into
         * one that asked for none. A library without the setter cannot spin at all, so 0 is honoured by it; a positive
         * request it cannot honour is refused rather than silently measured as blocking. */
        try { TpuWorker.nativeSetSpin(h, plan.tpuWorkerSpin); }
        catch (UnsatisfiedLinkError e) {
            if (plan.tpuWorkerSpin > 0) { say("TPU worker: REFUSED tpu_worker_spin=" + plan.tpuWorkerSpin + ": this libanchortpu.so has no per-handle spin setter"); TpuWorker.nativeClose(h); return; }
        }
        say("TPU worker: link poll before sleeping " + plan.tpuWorkerSpin + " us");
        say("TPU worker: serving masked rows");
        say(TpuWorker.nativeServe(h, pfd.getFd()));
        try { pfd.close(); } catch (Exception ignored) { }
        TpuWorker.nativeClose(h);
    }
    static String apkPath = "";
    static String extractDispatch() {
        final String lib = "libLiteRtDispatch_GoogleTensor.so"; java.io.File dir = new java.io.File(filesDir, "tpu-dispatch"), out = new java.io.File(dir, lib);
        try (java.util.zip.ZipFile z = new java.util.zip.ZipFile(apkPath)) {
            java.util.zip.ZipEntry e = z.getEntry("lib/arm64-v8a/" + lib); if (e == null) return null;
            if (out.isFile() && out.length() == e.getSize() && out.lastModified() >= new java.io.File(apkPath).lastModified()) return dir.getPath();
            dir.mkdirs(); java.io.File tmp = new java.io.File(dir, lib + ".part");
            try (InputStream in = z.getInputStream(e); OutputStream o = new FileOutputStream(tmp)) { byte[] b = new byte[1 << 16]; int n; while ((n = in.read(b)) > 0) o.write(b, 0, n); }
            if (!tmp.renameTo(out)) return null;
            out.setReadOnly(); return dir.getPath();
        } catch (Exception ex) { say("TPU dispatch extraction: " + ex); return null; }
    }

    /* ---- mode local: the conversation with the engine that runs the WHOLE model in the VM (LocalChat, LOCAL.md) ---- */
    static void localState(String state, String detail) { say("LOCAL " + state + (detail.isEmpty() ? "" : ": " + detail)); }
    static void localSession(Object vm, Plan plan) {
        localState("loading", "the VM is staging and loading the model");
        ParcelFileDescriptor pfd = connect(vm, LocalChat.PORT, 1200);   /* the listener appears after RUN and the (cached) model stage */
        if (pfd == null) { localState("failed", "no chat connection to the VM"); return; }
        try (InputStream in = new FileInputStream(pfd.getFileDescriptor()); OutputStream out = new FileOutputStream(pfd.getFileDescriptor())) {
            LocalChat.Session s = new LocalChat.Session(in, out);
            java.util.Map<String, String> ready = s.awaitReady();
            {
                localState("ready", String.valueOf(ready));
                /* What arrived in --es ask, as a digest: a driver compares it to the digest of what it meant to send, so a
                 * prompt the shell or `am` mangled on the way (an apostrophe, a backslash) is caught instead of measured. */
                try { byte[] d = java.security.MessageDigest.getInstance("SHA-256").digest(plan.ask.getBytes(java.nio.charset.StandardCharsets.UTF_8));
                      StringBuilder hx = new StringBuilder(); for (byte x : d) hx.append(String.format("%02x", x & 0xff));
                      say("LOCAL ask sha256=" + hx + " bytes=" + plan.ask.getBytes(java.nio.charset.StandardCharsets.UTF_8).length); }
                catch (java.security.NoSuchAlgorithmException e) { say("LOCAL ask sha256=unavailable"); }
                int k = sTurnOffset;
                if (sRestartsUsed > 0) say("LOCAL restart ready boottime_ms=" + android.os.SystemClock.elapsedRealtime() + " (restart " + sRestartsUsed + ")");
                for (String q : plan.ask.split("\\|")) {
                    if (q.trim().isEmpty()) continue; k++; sInterruptedTurn = k;
                    final StringBuilder reply = new StringBuilder();
                    /* The turn's window on CLOCK_BOOTTIME (elapsedRealtime), the clock /proc/uptime reads, so a device-side
                     * CPU sampler can cut its samples to exactly this turn (tpu/cpu-window.py): start = request sent,
                     * first = first streamed piece (prefill done), end = STATS received. */
                    final long[] first = { -1 }; final long tStart = android.os.SystemClock.elapsedRealtime();
                    java.util.Map<String, String> st = s.turn(q.trim(), plan.maxNew, plan.temperatureMilli,
                        piece -> { if (first[0] < 0) first[0] = android.os.SystemClock.elapsedRealtime(); reply.append(piece); });
                    say("LOCAL turn " + k + " window boottime_ms start=" + tStart + " first=" + first[0] + " end=" + android.os.SystemClock.elapsedRealtime());
                    say("LOCAL turn " + k + " Q: " + q.trim());
                    say("LOCAL turn " + k + " A: " + reply.toString().replace("\n", "\\n"));
                    say("LOCAL turn " + k + " STATS " + st); sTurnsDone = k;
                }
                localState("done", k + " scripted turns");
            }
            s.close();
        } catch (Exception e) {
            if (sInterruptedTurn > sTurnsDone) say("LOCAL turn " + sInterruptedTurn + " INTERRUPTED: " + e.getMessage() + " (no answer is reported for it)");
            if (sRestartsUsed < restartsAllowed(sLivePlan != null ? sLivePlan : plan)) { sInterrupted = true; say("LOCAL interrupted: " + e.getMessage()); }
            else localState("failed", String.valueOf(e.getMessage()));
        }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
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

    /** The engine's ANCHOR_QUIET_PADS intent as the app sees it, read from the run plan's shenv.
     *  0 = off, -1 = present but not a canonical decimal in range. The engine parses the same
     *  variable itself; this is the app's independent read of the same intent, so a plan that
     *  asks for quiet trials cannot start senders that the app could not gate. */
    static long quietIntentMs(String shenv) {
        if (shenv == null || shenv.isEmpty()) return 0;
        long found = 0; int seen = 0;
        for (String kv : shenv.split(",")) {
            final int eq = kv.indexOf('=');
            if (eq < 0 || !kv.substring(0, eq).equals("ANCHOR_QUIET_PADS")) continue;
            seen++;
            final String v = kv.substring(eq + 1);
            if (!v.matches("0|[1-9][0-9]{0,4}")) return -1;          // canonical decimal only
            found = Long.parseLong(v);
        }
        if (seen > 1) return -1;                                      // said twice: ambiguous intent
        if (found != 0 && (found < 3000 || found > 45000)) return -1;
        return found;
    }

    /** The engine's opt-in quiet-pads gate: ONE session-owned serial worker.
     *
     *  The control reader only OFFERS a command to a bounded queue and goes straight back to
     *  readLine. That matters because it is the single consumer of PADWIN, RECEIPT and PADACK, and
     *  the pVM's pads receiver writes PADACK through a writer that holds the payload's output lock
     *  across a BLOCKING write: if this thread stopped reading, the control socket would fill, that
     *  write would pin the lock, and every engine line behind it - the resume included - would
     *  block.
     *
     *  ONE WORKER OWNS EVERYTHING ELSE. Pause, drain, answer, resume and the paused-trial state all
     *  happen on that one thread, in the order the commands arrived, so there are no competing
     *  generations to reconcile: a pause cannot be acknowledged after a resume because the same
     *  thread did the resume first. `paused` needs no lock at all, being touched only there.
     *
     *  CLOSE NEVER WAITS ON PUBLICATION. close() takes no monitor the worker uses to answer: it
     *  flips an atomic, interrupts the worker, closes the gate and closes the output - and closing
     *  the output is what releases a worker stuck on a full control buffer. It is tracked on the
     *  session, so a session stop performs exactly that.
     *
     *  Bounded and refusing rather than growing: a fixed queue, one worker started lazily and only
     *  for a session whose gate is armed, no per-command thread and no retry. Queue overflow or a
     *  worker that will not start ENDS the experimental session rather than answering inline.
     *
     *  It gates ONLY app-to-pVM sending on the pads port. HTTP fetching is untouched and no pad,
     *  seed, ledger window, grant or acknowledgment behaviour changes: refusing is always safe.
     *  No claim is made that the worker thread has exited when close() returns; the session's own
     *  end is the bound. */
    static final class QuietPadsControl implements Closeable {
        private static final int QUEUE_MAX = 8;
        private final PadDelivery.Session session;
        private final OutputStream out;
        private final java.util.concurrent.BlockingQueue<String> queue =
            new java.util.concurrent.ArrayBlockingQueue<>(QUEUE_MAX);
        private final java.util.concurrent.atomic.AtomicBoolean closed =
            new java.util.concurrent.atomic.AtomicBoolean(false);
        private volatile Thread worker = null;      // started at most once, lazily
        private String paused = null;               // WORKER THREAD ONLY: no lock, no sharing

        QuietPadsControl(PadDelivery.Session session, OutputStream out) {
            this.session = session; this.out = out;
        }

        /** Control reader thread: offer and return. Never blocks, never answers inline. */
        void offer(String line) {
            if (closed.get()) return;
            if (!start()) { endExperiment("worker unavailable"); return; }
            if (!queue.offer(line)) endExperiment("command queue overflow");
        }

        private synchronized boolean start() {
            if (closed.get()) return false;
            if (worker != null) return true;
            final VmSendGate gate = session.sendGate();
            if (gate == null || !gate.isEnabled()) return false;      // not an armed quiet session
            final Thread w = new Thread(this::run, "quiet-pads");
            w.setDaemon(true);
            try { w.start(); } catch (Throwable t) { say("QUIETPADS worker not started: " + t); return false; }
            worker = w;
            return true;
        }

        /** No inline reply: an experiment that cannot be driven correctly is ended, not guessed at. */
        private void endExperiment(String why) {
            say("QUIETPADS " + why + ": ending the quiet session rather than answering out of order");
            close();
        }

        private void run() {
            try {
                while (!closed.get()) {
                    final String line = queue.poll(250, java.util.concurrent.TimeUnit.MILLISECONDS);
                    if (line != null) handle(line);
                }
            } catch (InterruptedException ie) { Thread.currentThread().interrupt(); }
            catch (Throwable t) { say("QUIETPADS worker error " + t); }
            finally {
                if (paused != null) {                                  // never leave sending gated
                    paused = null;
                    try { final VmSendGate g = session.sendGate(); if (g != null) g.resume(); } catch (Throwable ignored) { }
                }
                // Whatever ended this loop - a close, an interrupt or a Throwable - the experiment
                // is over. Without this a worker that died would leave a stale thread reference and
                // a queue that still looks live. Idempotent, so the ordinary close path is a no-op.
                close();
            }
        }

        private void handle(String line) {
            String trial = "";
            try {
                // -1 keeps trailing empty fields, so "resume 1 " arrives as five tokens and is
                // refused by the exact-length checks below instead of passing as four.
                final String[] f = line.split(" ", -1);                 // QUIETPADS v1 <verb> <trial> [<ms>]
                if (f.length < 4) { answer("refused", "0", "malformed"); return; }
                final String verb = f[2];
                trial = f[3];
                if (!trial.matches("0|[1-9][0-9]{0,18}")) { answer("refused", "0", "malformed_trial"); return; }
                if (closed.get() || !session.active()) return;          // nothing left to answer to
                final VmSendGate gate = session.sendGate();
                if (gate == null || !gate.isEnabled() || gate.isClosed()) { answer("refused", trial, "gate_unavailable"); return; }

                if (verb.equals("resume")) {
                    if (f.length != 4) { answer("refused", trial, "malformed"); return; }
                    if (!trial.equals(paused)) { answer("refused", trial, "wrong_trial"); return; }
                    gate.resume(); paused = null;
                    answer("resumed", trial, null);
                    return;
                }
                if (!verb.equals("pause")) { answer("refused", trial, "unknown_verb"); return; }
                if (f.length != 5 || !f[4].matches("[1-9][0-9]{0,6}")) { answer("refused", trial, "malformed_budget"); return; }
                final long ms = Long.parseLong(f[4]);
                if (ms < 1000 || ms > 45000) { answer("refused", trial, "budget_out_of_range"); return; }
                if (paused != null) { answer("refused", trial, "in_progress"); return; }

                boolean drained = false;
                try { drained = gate.requestPauseAndDrain(ms); }
                catch (Throwable t) { say("QUIETPADS drain error " + t); }
                // Checked again AFTER the drain: a session that stopped meanwhile gets no late
                // "paused", and anything this call paused is released.
                if (closed.get() || !session.active()) {
                    if (drained) { try { gate.resume(); } catch (Throwable ignored) { } }
                    return;
                }
                if (!drained) { gate.resume(); answer("refused", trial, "drain_incomplete"); return; }
                paused = trial;
                try { answer("paused", trial, null); }
                catch (java.io.IOException e) {                        // never stay gated after a lost answer
                    paused = null;
                    try { gate.resume(); } catch (Throwable ignored) { }
                    throw e;
                }
            } catch (java.io.IOException io) {
                say("QUIETPADS answer failed: " + io);
                close();                                               // the channel is unusable
            } catch (Throwable t) {
                say("QUIETPADS error " + t);
                try { answer("refused", trial.isEmpty() ? "0" : trial, "error"); } catch (Throwable ignored) { }
            }
        }

        /** Checked immediately before publication, under the same monitor the write takes, so a
         *  session that ended cannot be answered. This is not an undo guarantee: bytes already in
         *  flight when a session closes cannot be recalled, which is exactly why a session
         *  termination invalidates the experiment rather than trying to reconcile it. */
        private void answer(String verb, String trial, String reason) throws java.io.IOException {
            synchronized (out) {                                       // reentrant with quietAnswer's own
                if (closed.get() || !session.active())
                    throw new java.io.IOException("quiet session ended before the answer could be published");
                quietAnswer(out, verb, trial, reason);
            }
        }

        /** Holds nothing the worker needs to publish an answer. */
        @Override public void close() {
            if (!closed.compareAndSet(false, true)) return;
            final Thread w = worker;
            if (w != null) { try { w.interrupt(); } catch (Throwable ignored) { } }
            try { final VmSendGate g = session.sendGate(); if (g != null) g.close(); } catch (Throwable ignored) { }
            try { out.close(); } catch (Throwable ignored) { }         // releases a worker stuck writing
        }
    }

    /** One whole line to the control channel, serialised on the stream itself.
     *
     *  REQUIRED OF EVERY OTHER CONTROL WRITER TOO. Until now every control write except the
     *  artifact feed's STOP happened on the vsock-control thread, so single-threadedness made a
     *  lock unnecessary and PadsClient.onWindow writes its PADWIN answer that way. The drain
     *  helper breaks that assumption, so any writer that can run concurrently must take the same
     *  monitor - `synchronized (out)`, already the convention the STOP write uses. */
    static void quietAnswer(OutputStream out, String verb, String trial, String reason) throws java.io.IOException {
        final String s = "QUIETPADS v1 " + verb + " " + trial + (reason == null ? "" : " " + reason) + "\n";
        synchronized (out) { out.write(s.getBytes()); out.flush(); }
        say("QUIETPADS -> " + s.trim());
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

    /** A benchmark link for the guest's link-scaling control (run_local's tpu_link_bench).
     *
     *  The guest announces a byte count as four little-endian bytes and this sends exactly that many, then
     *  waits for the next announcement. It carries benchmark bytes only: no masked row, no pad and no lane
     *  state ever crosses it, and the guest closes it before the engine is loaded.
     *
     *  It exists because the exchange path moves bytes at 22 MB/s while a plain stream over the same
     *  boundary reaches 34-42 MB/s, and the question of whether that boundary scales per connection could
     *  not be answered by comparing two averages taken over different windows. */
    static void benchLink(Object vm, int which) {
        /* the exchange-shaped round trips must meet a responder scheduled like the real TPU worker (URGENT_AUDIO, TpuWorker) */
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_URGENT_AUDIO);
        ParcelFileDescriptor pfd = connect(vm, BENCH_PORT, 200);
        if (pfd == null) { say("LINKBENCH " + which + ": could not connect"); return; }
        try {
            InputStream in = new FileInputStream(pfd.getFileDescriptor());
            OutputStream out = new FileOutputStream(pfd.getFileDescriptor());
            byte[] hdr = new byte[4], buf = new byte[262144];
            long total = 0;
            for (;;) {
                int n = 0;
                while (n < 4) { int r = in.read(hdr, n, 4 - n); if (r <= 0) { say("LINKBENCH " + which + ": closed after " + total + " bytes"); return; } n += r; }
                long count = (hdr[0] & 255L) | ((hdr[1] & 255L) << 8) | ((hdr[2] & 255L) << 16) | ((hdr[3] & 255L) << 24);
                if ((count & 0x80000000L) != 0) {   // exbench.h: an exchange-shaped round trip -- read the request whole, then reply
                    count &= 0x7fffffffL; int m = 0;
                    while (m < 4) { int r = in.read(hdr, m, 4 - m); if (r <= 0) { say("LINKBENCH " + which + ": closed mid-request"); return; } m += r; }
                    long req = (hdr[0] & 255L) | ((hdr[1] & 255L) << 8) | ((hdr[2] & 255L) << 16) | ((hdr[3] & 255L) << 24);
                    while (req > 0) { int r = in.read(buf, 0, (int) Math.min(req, buf.length)); if (r <= 0) { say("LINKBENCH " + which + ": closed mid-request"); return; } req -= r; }
                    int rep = (int) count; if (rep > buf.length) { byte[] big = new byte[rep]; out.write(big, 0, rep); } else out.write(buf, 0, rep);
                    out.flush(); total += rep; continue;
                }
                while (count > 0) { int w = (int) Math.min(count, buf.length); out.write(buf, 0, w); count -= w; total += w; }
                out.flush();
            }
        } catch (Exception e) { say("LINKBENCH " + which + ": " + e); }
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
                            say("BRIDGE reply batch: bytes=" + plan.bridgeBatch);
                            if (plan.bridgeIo) {
                                traceFile = java.io.File.createTempFile("bridge-io-", ".bin", filesDir);
                                traceFd = ParcelFileDescriptor.open(traceFile, ParcelFileDescriptor.MODE_WRITE_ONLY);
                                say("BRIDGE_IO file=" + traceFile.getName());
                            }
                            rc = NativeBridge.run(pfd.getFd(), spfd.getFd(), cancel[0].getFd(), 0, profile, plan.bridgeWriteMax, traceFd == null ? -1 : traceFd.getFd(), plan.bridgeBatch, st);
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
