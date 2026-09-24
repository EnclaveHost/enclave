/*
 * RelayAttach -- the phone presents its protected VM to the fleet relay.
 *
 * The same gate a self-hosted SEV-SNP box crosses (relay/tunnel.js), in the
 * shape AVF offers. The relay sends a nonce; the app binds it to the VM's
 * transport key (bound = SPKI || nonce) and asks the VM for a certificate over
 * sha256(bound) and a signature over bound with the attested key; the relay
 * verifies the chain to Google's root, the anchor's code hash and the
 * signature (relay/avf-verify.mjs), and binds the tunnel with mode "avf".
 *
 * The app sees the certificate chain (public) and the transport key's PUBLIC
 * half; the VM keeps the private halves. It cannot forge any of it, which is
 * the point: the operator owns this app and it changes nothing.
 */
package host.enclave.anchor.avf;

import org.json.JSONArray;
import org.json.JSONObject;

import java.security.MessageDigest;
import java.util.Base64;
import java.util.Map;
import java.util.TreeMap;

public final class RelayAttach {
    final String url, name; final byte[] spki;
    Ws ws; byte[] nonce, bound; String challengeHex;
    String padKey = "";                       // the VM's X25519 pad key (PADKEY), presented with the attestation
    /* LAB serving prototype (PVM-CPU.md): the relay's fresh nonce for the app's ABI/2 evidence, hex, from abi2-challenge */
    final java.util.concurrent.CompletableFuture<String> abi2Nonce = new java.util.concurrent.CompletableFuture<>();
    /* opens a stream to a VM port; set once the VM serves https (TLS terminates IN the VM, this app never holds a key) */
    volatile java.util.function.IntFunction<android.os.ParcelFileDescriptor> vmConnect;
    /* the only stream kinds this app carries, and the VM port each goes to: the TLS app port and the evidence endpoint */
    static int portOf(String kind) { return "pvm-app-tls".equals(kind) ? 7786 : "pvm-evidence".equals(kind) ? 7787 : "pvm-app-sealed".equals(kind) ? 7788 : -1; }
    private final java.util.concurrent.ConcurrentHashMap<Long, Pipe> pipes = new java.util.concurrent.ConcurrentHashMap<>();
    /* One relay raw stream spliced to one VM connection. The bytes are TLS ciphertext end to end: they are copied, counted
     * and never logged, parsed or kept. */
    static final class Pipe { final android.os.ParcelFileDescriptor pfd; final java.io.OutputStream toVm; long in, out;
        Pipe(android.os.ParcelFileDescriptor p) { pfd = p; toVm = new java.io.FileOutputStream(p.getFileDescriptor()); } }
    /* every frame goes out through here: the receive loop, the stream pumps and the control thread all send */
    private synchronized void sendFrame(JSONObject o) throws Exception { ws.sendText(o.toString()); }
    static final String AVF_PAD_FORMAT = "android-avf-pvm/v2", AVF_PAD_DOMAIN = "enclave-avf-pad-bind-v1\n";

    RelayAttach(String url, String name, byte[] spki) { this.url = url; this.name = name; this.spki = spki; }

    static byte[] sha256(byte[] b) { try { return MessageDigest.getInstance("SHA-256").digest(b); } catch (Exception e) { throw new RuntimeException(e); } }
    static String hex(byte[] b) { StringBuilder s = new StringBuilder(); for (byte x : b) s.append(String.format("%02x", x)); return s.toString(); }
    static byte[] unhex(String h) { byte[] b = new byte[h.length() / 2]; for (int i = 0; i < b.length; i++) b[i] = (byte) Integer.parseInt(h.substring(2 * i, 2 * i + 2), 16); return b; }
    static String b64(byte[] b) { return Base64.getEncoder().encodeToString(b); }
    /* wss://host[:port]/v1/fleet-tunnel (or ws:// in the lab) -> https://host[:port]/t/<name>; null when not a ws(s) URL */
    static String selfRoutedUrl(String relayUrl, String name) {
        try { final java.net.URI u = new java.net.URI(relayUrl);
              if (!"wss".equals(u.getScheme()) && !"ws".equals(u.getScheme()) || u.getHost() == null) return null;
              return "https://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + "/t/" + name; }
        catch (Exception e) { return null; }
    }

    /** Dial the relay and take its nonce; returns the hex challenge the VM must certify. */
    String challenge() throws Exception {
        ws = new Ws(url, Map.of("x-metal-name", name, "x-metal-attest", "1"));
        String f; JSONObject ch = null;
        while (ch == null && (f = ws.receive()) != null) { JSONObject o = new JSONObject(f); if ("challenge".equals(o.optString("t"))) ch = o; }
        if (ch == null) throw new Exception("relay closed before sending a challenge");
        nonce = Base64.getDecoder().decode(ch.getString("nonce"));
        // android-avf-pvm/v2 (PAD-BOOTSTRAP.md): the attested key signs the whole pad-binding transcript
        //   "enclave-avf-pad-bind-v1\n" || Ed25519 SPKI (44) || X25519 pad key (32) || relay nonce (32)
        // and the certificate challenge is sha256 of it. The VM rebuilds this from ITS OWN keys and
        // refuses anything else, so this app cannot have it attest a key it does not hold.
        if (padKey.length() != 64) throw new Exception("no pad key from the VM: cannot build the v2 binding");
        byte[] domain = AVF_PAD_DOMAIN.getBytes("US-ASCII"), pad = unhex(padKey);
        bound = new byte[domain.length + spki.length + pad.length + nonce.length];
        int off = 0;
        System.arraycopy(domain, 0, bound, off, domain.length); off += domain.length;
        System.arraycopy(spki, 0, bound, off, spki.length); off += spki.length;
        System.arraycopy(pad, 0, bound, off, pad.length); off += pad.length;
        System.arraycopy(nonce, 0, bound, off, nonce.length);
        challengeHex = hex(sha256(bound));
        Main.say("RELAY " + url + " as " + name + ": nonce=" + hex(nonce).substring(0, 16) + "… challenge=" + challengeHex.substring(0, 16) + "…");
        return challengeHex;
    }

    /** Present what the VM produced; returns the relay's verdict frame. */
    JSONObject present(TreeMap<Integer, TreeMap<Integer, String>> certs, TreeMap<Integer, String> sig) throws Exception {
        JSONArray chain = new JSONArray();
        for (TreeMap<Integer, String> chunks : certs.values()) chain.put(b64(unhex(String.join("", chunks.values()))));
        JSONObject ev = new JSONObject().put("chain", chain);
        if (!sig.isEmpty()) ev.put("signature", b64(unhex(String.join("", sig.values()))));
        JSONObject rad = new JSONObject().put("format", AVF_PAD_FORMAT).put("body", b64(ev.toString().getBytes("UTF-8")))
            .put("transportKey", b64(spki)).put("transportKeyFp", hex(sha256(spki))).put("name", name);
        if (!padKey.isEmpty()) rad.put("padKey", padKey);
        ws.sendText(new JSONObject().put("t", "attest").put("rad", rad).toString());
        Main.say("RELAY presented chain=" + chain.length() + " certs signature=" + (sig.isEmpty() ? "none" : "yes"));
        String f; JSONObject res = null;
        while (res == null && (f = ws.receive()) != null) { JSONObject o = new JSONObject(f); if ("attest-result".equals(o.optString("t"))) res = o; }
        if (res == null) { Main.say("RELAY closed without a verdict"); return null; }
        Main.say("RELAY attest " + (res.optBoolean("ok") ? "ACCEPTED measurement=" + res.optString("measurement") : "REJECTED: " + res.optString("reason")));
        return res;
    }

    /** Bound: announce the identity, then answer the hub until the socket ends. */
    void serve(String phone) {
        try {
            // publicUrl: this tunnel's own relay route, https://<relay host>/t/<name> -- the only form the hub honors
            // (tunnel.js selfRoutedUrl). keccak256 of it is the registry id a lease records as `runner`, so without it the
            // phone could never be a deployment's runner. Stating it registers nothing: it matches a ledger row only once
            // the owner registers this exact URL on-chain and holds a lease (RELAY-SERVING.md "Runner registration").
            final String pub = selfRoutedUrl(url, name);
            final JSONObject hello = new JSONObject().put("t", "hello").put("name", name).put("mode", "avf").put("transportKeyFp", hex(sha256(spki)));
            if (pub != null) hello.put("publicUrl", pub);
            sendFrame(hello);
            String f;
            while ((f = ws.receive()) != null) {
                JSONObject o = new JSONObject(f); String t = o.optString("t");
                if ("ping".equals(t)) { sendFrame(new JSONObject().put("t", "pong")); continue; }
                if ("abi2-challenge".equals(t)) {   // LAB: the relay's own fresh nonce, for the VM to bind into the app's evidence
                    try { abi2Nonce.complete(hex(Base64.getDecoder().decode(o.getString("nonce")))); Main.say("RELAY abi2 nonce received (fresh, relay-owned)"); }
                    catch (Exception e) { Main.say("RELAY abi2 nonce malformed: " + e); } continue; }
                if ("abi2-result".equals(t)) { Main.say("RELAY abi2 " + (o.optBoolean("ok") ? "VERIFIED by the relay" : "REFUSED: " + o.optJSONArray("reasons"))); continue; }
                if ("caps-result".equals(t)) {   // the relay's pVM CPU verdict on this VM's capability report (relay/pvm-cpu-tier.mjs)
                    Main.say("RELAY caps " + (o.optBoolean("ok") ? "ADMITTED tier=" + o.optString("tier") : "REFUSED: " + o.optJSONArray("reasons"))); continue; }
                if ("s+".equals(t)) {
                    final long sid = o.optLong("sid", -1);
                    final int port = portOf(o.optString("kind"));
                    if (port < 0 || vmConnect == null || sid < 0) {
                        sendFrame(new JSONObject().put("t", "s=").put("sid", o.opt("sid")).put("ok", false).put("err", "phone anchor carries no streams"));
                        continue;
                    }
                    new Thread(() -> openPipe(sid, port), "relay-stream-" + sid).start();   // connecting must not stall this loop
                    continue;
                }
                if ("sd".equals(t)) { Pipe pp = pipes.get(o.optLong("sid", -1)); if (pp != null) { byte[] b = Base64.getDecoder().decode(o.optString("d"));
                    try { pp.toVm.write(b); pp.toVm.flush(); pp.in += b.length; } catch (Exception e) { closePipe(o.optLong("sid"), "VM write failed"); } } continue; }
                if ("sx".equals(t)) { closePipe(o.optLong("sid", -1), "closed by the relay"); continue; }
                if (!"req".equals(t)) continue;
                String path = o.optString("path").split("\\?")[0]; int status; JSONObject body;
                if (path.equals("/availability")) { status = 200; body = new JSONObject().put("ok", true).put("role", "phone-anchor").put("name", name).put("phone", phone).put("gpu", false); }   // no teeCpu/tier self-claim: the relay tiers this row from its verified verdict (PVM-CPU.md)
                else if (path.equals("/v1/health")) { status = 200; body = new JSONObject().put("ok", true).put("role", "phone-anchor").put("name", name); }
                else { status = 404; body = new JSONObject().put("error", "not_found"); }
                sendFrame(new JSONObject().put("t", "res").put("id", o.opt("id")).put("status", status)
                    .put("headers", new JSONObject().put("content-type", "application/json")).put("body", b64(body.toString().getBytes("UTF-8"))));
            }
            for (Long sid : pipes.keySet()) closePipe(sid, "tunnel closed");
            Main.say("RELAY tunnel closed");
        } catch (Exception e) { Main.say("RELAY serve error " + e); }
    }

    /** The pVM's capability report (PVM-CPU.md): report hex -> base64 as the relay parses it, signature as hex. The app only
     *  carries these bytes; the relay verifies them against the key this VM attested (relay/pvm-cpu-tier.mjs). */
    /* LAB: one relay raw stream -> one connection to the VM's TLS app port; VM -> relay pumped here, relay -> VM in serve() */
    private void openPipe(long sid, int port) {
        android.os.ParcelFileDescriptor pfd = null;
        try { java.util.function.IntFunction<android.os.ParcelFileDescriptor> c = vmConnect; pfd = c == null ? null : c.apply(port); } catch (Exception ignored) { }
        try {
            if (pfd == null) { sendFrame(new JSONObject().put("t", "s=").put("sid", sid).put("ok", false).put("err", "the VM's port " + port + " did not answer")); return; }
            Pipe p = new Pipe(pfd); pipes.put(sid, p);
            sendFrame(new JSONObject().put("t", "s=").put("sid", sid).put("ok", true));
            Main.say("RELAY stream " + sid + " opened to the VM's " + (port == 7786 ? "TLS app port (the bytes are ciphertext" : port == 7788 ? "sealed-request port (the bytes are HPKE ciphertext" : "evidence endpoint (public evidence") + "; sizes only are logged)");
            java.io.InputStream fromVm = new java.io.FileInputStream(pfd.getFileDescriptor()); byte[] buf = new byte[1 << 16]; int n;
            while ((n = fromVm.read(buf)) > 0) { p.out += n; sendFrame(new JSONObject().put("t", "sd").put("sid", sid).put("d", Base64.getEncoder().encodeToString(java.util.Arrays.copyOf(buf, n)))); }
        } catch (Exception ignored) { }
        if (pipes.containsKey(sid)) { try { sendFrame(new JSONObject().put("t", "sx").put("sid", sid)); } catch (Exception ignored) { } closePipe(sid, "the VM closed it"); }
        else if (pfd != null) try { pfd.close(); } catch (Exception ignored) { }
    }
    private void closePipe(long sid, String why) {
        Pipe p = pipes.remove(sid); if (p == null) return;
        try { p.pfd.close(); } catch (Exception ignored) { }
        Main.say("RELAY stream " + sid + " closed (" + why + "): " + p.in + " bytes to the VM, " + p.out + " bytes from it");
    }

    /* LAB: the VM's ABI/2 evidence for the relay to verify with ITS nonce: the chain (public), the runtime identity and the
     * self-test tuple exactly as the VM printed them, and the app's digest. Nothing here is secret or from this app. */
    /* instanceLine (v3, INSTANCE-BINDING.md): the VM's "ABI2 instance key=<spki hex> sig=<hex> id=<hex>" line, or null. Its key
     * and signature go to the relay as printed; the relay recomputes the InstanceID and checks Bind3 over its own nonce. */
    void sendAbi2(java.util.List<String> chainB64, String identity, String selftest, String appHex, String instanceLine) {
        try { JSONArray c = new JSONArray(); for (String x : chainB64) c.put(x);
              final JSONObject f = new JSONObject().put("t", "abi2").put("chain", c).put("identity", identity).put("selftest", selftest).put("app", appHex);
              if (instanceLine != null) {
                  final java.util.regex.Matcher m = java.util.regex.Pattern.compile("^ABI2 instance key=([0-9a-f]{88}) sig=([0-9a-f]{128}) id=[0-9a-f]{64}$").matcher(instanceLine);
                  if (!m.matches()) { Main.say("RELAY abi2 not sent: the VM's instance line is malformed"); return; }
                  f.put("instanceKey", m.group(1)).put("instanceSig", m.group(2));
              }
              sendFrame(f);
              Main.say("RELAY abi2 evidence sent (" + chainB64.size() + " certificates" + (instanceLine != null ? ", instance-bound" : "") + ")"); }
        catch (Exception e) { Main.say("RELAY abi2 not sent: " + e); }
    }

    void sendCaps(String reportHex, String sigHex) {
        try { sendFrame(new JSONObject().put("t", "caps").put("report", b64(unhex(reportHex))).put("sig", sigHex));
              Main.say("RELAY caps sent (" + reportHex.length() / 2 + " bytes, signed by the VM's attested key)"); }
        catch (Exception e) { Main.say("RELAY caps not sent: " + e); }
    }

    void close() { try { if (ws != null) ws.close(); } catch (Exception ignored) { } }
}
