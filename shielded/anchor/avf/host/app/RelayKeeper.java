/*
 * RelayKeeper -- the ONE reconnector for a serving pVM's relay tunnel (RUNNER-AGENT.md "Reconnect in place"; design reviewed
 * with the verifier session). When the tunnel ends -- the relay closed it, or it went silent for RelayAttach.SILENT_MS -- the
 * RUNNING VM attaches again, without a restart:
 *   a new socket and the relay's NEW nonce; `REATTACH <nonce hex>` to the VM, which builds its own transcript from its boot
 *   keys and answers with a NEW certificate, the attested key's signature and its instance proof (anchor_reattach.h); the
 *   owner's co-signer (unchanged request); the attest frame; then hello, serving, and ABI/2 for the hub's fresh nonce from
 *   the VM's own evidence endpoint (EVIDENCE3), passed through.
 * At most one RelayAttach serves at any time: the old one is closed before a new one is dialled, and only the current one's
 * loss is acted on. Backoff 2 s, doubling to 60 s, reset once a tunnel has stayed up for 60 s. Armed only once the app
 * serves (before that the VM's control channel is still taking its plan), stopped when the VM's session ends. It holds no key
 * and judges nothing: every refusal is the hub's or the co-signer's, logged as said. The pVM CPU tier is NOT re-admitted on a
 * tunnel attached in place (the relay needs a self-test after the attach; the engine runs it once): routing only.
 */
package host.enclave.anchor.avf;

import android.os.ParcelFileDescriptor;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.TreeMap;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

final class RelayKeeper {
    static final long BACKOFF_MIN_MS = 2000, BACKOFF_MAX_MS = 60000, STABLE_MS = 60000, VM_ANSWER_MS = 30000;
    static final int EVIDENCE_PORT = 7787;
    private final Object vm; private final Main.Plan plan; private final byte[] spki; private final String padKey; private final OutputStream ctl;
    private final AtomicReference<RelayAttach> cur = new AtomicReference<>();
    private final Semaphore lost = new Semaphore(0);
    private final LinkedBlockingQueue<String> inbox = new LinkedBlockingQueue<>();
    private volatile boolean armed = false, stopped = false, reattaching = false;
    private volatile long upSince = 0;
    private int attempts = 0, attached = 0;
    private Thread thread;

    RelayKeeper(Object vm, Main.Plan plan, byte[] spki, String padKey, OutputStream ctl) { this.vm = vm; this.plan = plan; this.spki = spki; this.padKey = padKey; this.ctl = ctl; }

    /** The boot tunnel (or null when the boot attach failed): its loss is what the keeper acts on. */
    void adopt(RelayAttach r) { if (r != null) { r.onClosed = () -> lost(r); cur.set(r); upSince = System.currentTimeMillis(); } }

    /** From "APP serving https": re-attaching is safe from now on (the VM takes REATTACH only while it serves). */
    synchronized void arm() {
        if (armed || stopped) return;
        armed = true;
        thread = new Thread(this::run, "relay-keeper"); thread.start();
        if (cur.get() == null) { Main.say("RELAY keeper: no tunnel at serve time; attaching in place"); lost.release(); }
        else Main.say("RELAY keeper armed: a lost tunnel re-attaches in place (fresh nonce, fresh certificate, the owner's co-signer)");
    }

    void stop() { stopped = true; lost.release(); final RelayAttach r = cur.getAndSet(null); if (r != null) { r.onClosed = null; r.close(); } }

    RelayAttach current() { return cur.get(); }

    /** Every control line the VM prints after RUN passes through here; the ones that answer a pending REATTACH are queued. */
    void onVmLine(String line) {
        if (!reattaching) return;
        if (line.startsWith("REATTACH ") || line.startsWith("CERT") || line.startsWith("SIG[") || line.startsWith("INSTANCEATTACH ") || line.startsWith("ATTEST ")) inbox.offer(line);
    }

    private void lost(RelayAttach r) {
        if (cur.compareAndSet(r, null)) { Main.say("RELAY keeper: the tunnel is gone (" + (System.currentTimeMillis() - upSince) / 1000 + " s up)"); lost.release(); }
    }

    private void run() {
        long backoff = BACKOFF_MIN_MS;
        try {
            while (!stopped && !Main.ended()) {
                lost.acquire();
                if (stopped || Main.ended()) break;
                lost.drainPermits();
                if (upSince > 0 && System.currentTimeMillis() - upSince >= STABLE_MS) backoff = BACKOFF_MIN_MS;
                while (!stopped && !Main.ended() && cur.get() == null) {
                    Main.say("RELAY keeper: re-attach in " + backoff / 1000.0 + " s");
                    Thread.sleep(backoff);
                    if (stopped || Main.ended()) break;
                    if (attempt()) break;
                    backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
                }
            }
        } catch (InterruptedException ignored) { }
        Main.say("RELAY keeper stopped after " + attempts + " attempts, " + attached + " re-attached");
    }

    /** One re-attach: true when the hub accepted it and the new tunnel serves. */
    private boolean attempt() {
        final int n = ++attempts;
        final RelayAttach r = new RelayAttach(plan.relay, plan.name, spki);
        r.attachSigner = plan.attachSigner; r.padKey = padKey;
        try { r.challenge(); }
        catch (Exception e) { Main.say("RELAY re-attach " + n + ": dial failed: " + e); r.close(); return false; }
        // the VM's answer to the relay's new nonce: collected between "REATTACH begin" and "REATTACH end"
        final TreeMap<Integer, TreeMap<Integer, String>> certs = new TreeMap<>(); final TreeMap<Integer, String> sig = new TreeMap<>();
        String refused = null; boolean end = false;
        inbox.clear(); reattaching = true;
        try {
            synchronized (ctl) { ctl.write(("REATTACH " + RelayAttach.hex(r.nonce) + "\n").getBytes(StandardCharsets.US_ASCII)); ctl.flush(); }
            final long deadline = System.currentTimeMillis() + VM_ANSWER_MS;
            while (!end) {
                final long left = deadline - System.currentTimeMillis();
                final String line = left > 0 ? inbox.poll(left, TimeUnit.MILLISECONDS) : null;
                if (line == null) { refused = "no answer from the VM in " + VM_ANSWER_MS / 1000 + " s"; break; }
                java.util.regex.Matcher m;
                if (line.equals("REATTACH end")) end = true;
                else if (line.startsWith("REATTACH refused: ")) refused = "the VM refused: " + line.substring(18);
                else if ((m = java.util.regex.Pattern.compile("^CERT(\\d+)\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches())
                    certs.computeIfAbsent(Integer.parseInt(m.group(1)), (k) -> new TreeMap<>()).put(Integer.parseInt(m.group(2)), m.group(3));
                else if ((m = java.util.regex.Pattern.compile("^SIG\\[(\\d+)\\] ([0-9a-f]+)$").matcher(line)).matches()) sig.put(Integer.parseInt(m.group(1)), m.group(2));
                else if ((m = java.util.regex.Pattern.compile("^INSTANCEATTACH key=(302a300506032b6570032100[0-9a-f]{64}) sig=([0-9a-f]{128})$").matcher(line)).matches()) { r.instanceKey = m.group(1); r.instanceSig = m.group(2); }
            }
        } catch (Exception e) { refused = "the control channel: " + e; }
        finally { reattaching = false; }
        if (refused != null || certs.isEmpty() || sig.isEmpty()) { Main.say("RELAY re-attach " + n + ": no certificate (" + (refused != null ? refused : "the VM's answer had no chain or signature") + ")"); r.close(); return false; }
        // the co-signer and the hub: exactly the boot path's present()
        final JSONObject res;
        try { res = r.present(certs, sig); } catch (Exception e) { Main.say("RELAY re-attach " + n + ": " + e); r.close(); return false; }
        if (res == null || !res.optBoolean("ok")) { Main.say("RELAY re-attach " + n + ": refused by the hub"); r.close(); return false; }
        r.vmConnect = (port) -> Main.connect(vm, port, 50);   // the VM already serves: streams may open at once
        r.onClosed = () -> lost(r);
        cur.set(r); upSince = System.currentTimeMillis(); attached++;
        new Thread(() -> r.serve(android.os.Build.MODEL), "relay-serve").start();
        Main.say("RELAY re-attach " + n + ": ACCEPTED in place (the same VM, transport key and instance)");
        // ABI/2 for the hub's fresh nonce: the VM's own v3 evidence from its evidence endpoint (1 answer per 2 s: 3 tries, 2.5 s apart)
        try {
            final String an = r.abi2Nonce.get(20, TimeUnit.SECONDS);
            JSONObject ev = null;
            for (int i = 0; i < 3 && r == cur.get(); i++) {
                if (i > 0) Thread.sleep(2500);
                ev = evidence3(an);
                if (ev != null && !ev.has("error")) break;
                Main.say("RELAY re-attach " + n + ": evidence endpoint " + (ev == null ? "gave no answer" : "said: " + ev.optString("error")));
            }
            if (ev != null && !ev.has("error")) r.sendAbi2FromEvidence(ev, an);
        } catch (Exception e) { Main.say("RELAY re-attach " + n + ": no ABI/2 for the hub's nonce: " + e); }
        return true;
    }

    /** One EVIDENCE3 exchange with the VM's evidence endpoint, bounded: the VM answers one JSON line and closes. */
    private JSONObject evidence3(String nonceHex) {
        final ParcelFileDescriptor pfd = Main.connect(vm, EVIDENCE_PORT, 50);
        if (pfd == null) return null;
        final java.util.concurrent.FutureTask<String> t = new java.util.concurrent.FutureTask<>(() -> {
            final OutputStream o = new FileOutputStream(pfd.getFileDescriptor());
            o.write(("EVIDENCE3 " + nonceHex + "\n").getBytes(StandardCharsets.US_ASCII)); o.flush();
            return new BufferedReader(new InputStreamReader(new FileInputStream(pfd.getFileDescriptor()), StandardCharsets.UTF_8)).readLine();
        });
        new Thread(t, "relay-evidence3").start();
        try { final String line = t.get(15, TimeUnit.SECONDS); return line == null ? null : new JSONObject(line); }
        catch (Exception e) { return null; }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }
}
