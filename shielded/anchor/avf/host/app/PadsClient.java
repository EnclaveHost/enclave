/* The owner app's part of dealt pads (shielded/dealer/PLAN.md): untrusted
 * plumbing between the pVM and the platform's ledger (relay/pads.mjs). It
 * never sees a secret: the pVM signs every request with its attested transport
 * key, the seed comes back boxed to the pVM's pad key, and windows come back
 * signed by the relay's ledger key for the pVM to verify. This class only
 * carries bytes: HTTP to the relay, lines on the control socket, and shipment
 * files into the VM over vsock 7780 (PADS <name> <bytes>, then the bytes). */
package host.enclave.anchor.avf;

import android.os.ParcelFileDescriptor;
import java.io.BufferedReader;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import org.json.JSONObject;

final class PadsClient {
    static final int PADS_PORT = 7780;

    /** The relay's HTTP base from its fleet-tunnel websocket URL. */
    static String httpBase(String wsUrl) {
        String u = wsUrl.replaceFirst("^wss://", "https://").replaceFirst("^ws://", "http://");
        int p = u.indexOf("/v1/"); return p > 0 ? u.substring(0, p) : u;
    }

    static JSONObject http(PadDelivery.Session session, String method, String url, JSONObject body) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(url).openConnection();
        java.io.Closeable connection = c::disconnect;
        if (!session.track(connection)) throw new java.io.IOException("pad session ended");
        try {
        c.setConnectTimeout(20000); c.setReadTimeout(30000); c.setRequestMethod(method);
        if (body != null) {
            c.setDoOutput(true); c.setRequestProperty("Content-Type", "application/json");
            try (OutputStream o = c.getOutputStream()) { o.write(body.toString().getBytes(StandardCharsets.UTF_8)); }
        }
        int code = c.getResponseCode();
        InputStream in = code < 400 ? c.getInputStream() : c.getErrorStream();
        String text = in == null ? "{}" : new String(in.readAllBytes(), StandardCharsets.UTF_8);
        JSONObject j = new JSONObject(text.isEmpty() ? "{}" : text);
        j.put("_status", code);
        return j;
        } finally { session.untrack(connection); c.disconnect(); }
    }

    static String nonce() { byte[] n = new byte[16]; new SecureRandom().nextBytes(n); return RelayAttach.hex(n); }

    /** Keep retrying a signed acknowledgment during this control run, including
     * a temporarily old relay. Never permanently mute future sessions on a 404. */
    static void onAck(PadDelivery.Session session, String line, String name) {
        try {
            PadAckQueue.Ack ack = PadAckQueue.Ack.parse(line, session.seed());
            final java.util.concurrent.atomic.AtomicBoolean warned = new java.util.concurrent.atomic.AtomicBoolean();
            PadAckQueue queue = session.acknowledgments(a -> {
                JSONObject body = new JSONObject().put("name", name).put("seed_id", a.seed).put("index0", a.index0).put("count", a.count)
                    .put("sha256", a.sha256).put("nonce", a.nonce).put("sig", a.sig);
                JSONObject res = http(session, "POST", session.base() + "/v1/pads/ack", body);
                int status = res.optInt("_status");
                if (status == 200) {
                    Main.say("PADS ack " + a.index0 + "+" + a.count + " recorded, floor " + res.optLong("ack_floor"));
                    return true;
                }
                String error = res.optString("error");
                if (status == 400 || (status == 403 && !error.equals("unknown_tunnel")) || error.equals("digest_mismatch")) {
                    Main.say("PADS ack " + a.index0 + "+" + a.count + " refused " + error); return true;
                }
                if (warned.compareAndSet(false,true)) Main.say("PADS acknowledgments pending retry: HTTP " + status + " " + error);
                return false; // unavailable route/store, range pressure, server failure: retry
            });
            if (queue != null && !queue.offer(ack)) Main.say("PADS acknowledgment queue full: delivery progress cannot advance");
        } catch (IllegalArgumentException e) { Main.say("PADS acknowledgment refused locally: " + e.getMessage()); }
    }

    /** Read control lines until one starts with `prefix`; everything else is logged as usual. */
    static String until(BufferedReader r, String prefix) throws Exception {
        String line;
        while ((line = r.readLine()) != null) {
            Main.say("VSOCK " + (line.length() > 160 ? line.substring(0, 160) + "…" : line));
            if (line.startsWith(prefix)) return line;
        }
        return null;
    }

    /** After the tunnel is bound: the ledger key to the VM, the VM's signed seed request to the
     *  platform, the boxed seed back to the VM. True when the VM confirmed it opened the seed. */
    static boolean bootstrap(PadDelivery.Session session, String httpBase, String name, OutputStream out, BufferedReader r) {
        final String base = httpBase;
        try {
            JSONObject key = http(session, "GET", base + "/v1/pads/key", null);
            if (key.optInt("_status") != 200) { Main.say("PADS no ledger key: " + key); return false; }
            out.write(("PADLEDGER " + key.getString("key") + "\n").getBytes()); out.flush();
            String l = until(r, "PADLEDGER ");
            if (l == null || !l.startsWith("PADLEDGER ok")) { Main.say("PADS the VM refused the ledger key: " + l); return false; }
            // Authenticated bootstrap (PAD-BOOTSTRAP.md): the VM generates the request nonce and the model /
            // calibration digests itself, signs the seed-v2 request, and accepts only a grant the platform
            // signed over that whole context under the ledger key the VM pins. This app only carries bytes.
            out.write(("PADREQ2 " + name + "\n").getBytes()); out.flush();
            l = until(r, "PADREQ2 ");
            if (l != null && !l.startsWith("PADREQ2 fail")) {
                String[] q = l.split(" ");
                if (q.length != 6) { Main.say("PADS malformed request from the VM: " + l); return false; }
                JSONObject res = http(session, "POST", base + "/v1/pads/seed", new JSONObject().put("name", q[1]).put("model_digest", q[2]).put("calib_digest", q[3]).put("nonce", q[4]).put("sig", q[5]));
                if (res.optInt("_status") != 200) { Main.say("PADS seed grant refused: " + res); return false; }
                if (res.optInt("grant_version", 0) != 1 || !res.has("grant_sig")) { Main.say("PADS the platform returned no signed grant (legacy relay?): " + res); return false; }
                String seedId = res.getString("seed_id");
                out.write(("PADGRANT 1 " + seedId + " " + res.getLong("epoch") + " " + res.getString("epk") + " " + res.getString("nonce") + " " + res.getString("box") + " " + res.getString("grant_sig") + "\n").getBytes());
                out.flush();
                l = until(r, "PADGRANT ");
                boolean ok = l != null && l.startsWith("PADGRANT ok");
                Main.say("PADS signed seed grant " + (ok ? "accepted by the VM: " + seedId + (l.contains("UNPINNED") ? " (UNPINNED ledger key: dev build)" : "") : "REJECTED by the VM: " + l));
                if (ok) session.bind(base, seedId);
                return ok;
            }
            Main.say("PADS v2 request unavailable (" + l + "); trying the legacy unsigned seed (a pinned build refuses it)");
            String n = nonce();
            out.write(("PADSIGN seed " + n + " " + name + "\n").getBytes()); out.flush();
            l = until(r, "PADSIG ");
            if (l == null || l.endsWith("fail")) { Main.say("PADS the VM did not sign the seed request"); return false; }
            JSONObject res = http(session, "POST", base + "/v1/pads/seed", new JSONObject().put("name", name).put("nonce", n).put("sig", l.substring(7).trim()));
            if (res.optInt("_status") != 200) { Main.say("PADS seed refused: " + res); return false; }
            String seedId = res.getString("seed_id");
            out.write(("PADSEED " + name + " " + seedId + " " + res.getInt("epoch") + " " + res.getString("epk") + " " + res.getString("nonce") + " " + res.getString("box") + "\n").getBytes());
            out.flush();
            l = until(r, "PADSEED ");
            boolean ok = l != null && l.startsWith("PADSEED ok");
            Main.say("PADS seed " + (ok ? "installed in the VM (legacy, unsigned): " + seedId : "NOT installed: " + l));
            if (ok) session.bind(base, seedId);
            return ok;
        } catch (Exception e) { Main.say("PADS bootstrap error " + e); return false; }
    }

    /** A window request from the engine (PADWIN want nonce sig): relay it, hand back the signed window. */
    static void onWindow(PadDelivery.Session session, String line, String name, OutputStream out) {
        final String base = session.base(), seedId = session.seed();
        try {
            String[] f = line.trim().split(" ");
            if (f.length != 4) { out.write("PADWIN fail malformed\n".getBytes()); out.flush(); return; }
            JSONObject res = http(session, "POST", base + "/v1/pads/reserve", new JSONObject().put("name", name).put("seed_id", seedId)
                .put("want", Long.parseLong(f[1])).put("nonce", f[2]).put("sig", f[3]));
            if (res.optInt("_status") == 200)
                out.write(("PADWIN " + res.getLong("lo") + " " + res.getLong("hi") + " " + res.getLong("iat") + " " + res.getString("sig") + (res.has("sig_v2") ? " " + res.getString("sig_v2") : "") + "\n").getBytes());   // sig_v2: over the VM's request nonce (PAD-BOOTSTRAP.md)
            else out.write(("PADWIN fail " + res.optString("error", "http " + res.optInt("_status")) + "\n").getBytes());
            out.flush();
            Main.say("PADS window " + (res.optInt("_status") == 200 ? res.getLong("lo") + ".." + res.getLong("hi") + (res.has("sig_v2") ? " sig_v2" : " LEGACY-ONLY (relay without window v2)") : "refused " + res));
        } catch (Exception e) { Main.say("PADS window error " + e); try { out.write("PADWIN fail error\n".getBytes()); out.flush(); } catch (Exception ignored) { } }
    }

    /** The engine's usage receipt (RECEIPT name seed_id pads tokens nonce sig): relay it as signed.
     *  Nothing to hand back; the platform's totals are what billing reads. */
    static void onReceipt(PadDelivery.Session session, String line) {
        final String base = session.base();
        try {
            String[] f = line.trim().split(" ");
            if (f.length != 7) { Main.say("PADS receipt malformed"); return; }
            JSONObject res = http(session, "POST", base + "/v1/pads/receipt", new JSONObject().put("name", f[1]).put("seed_id", f[2])
                .put("pads", Long.parseLong(f[3])).put("tokens", Long.parseLong(f[4])).put("nonce", f[5]).put("sig", f[6]));
            Main.say("PADS receipt " + (res.optInt("_status") == 200 ? "recorded: " + f[3] + " pads, " + f[4] + " tokens (seed total " + res.optLong("pads") + "/" + res.optLong("tokens") + ", runs " + res.optLong("runs") + ")" : "refused " + res));
        } catch (Exception e) { Main.say("PADS receipt error " + e); }
    }

    /** Prefetch: the platform's store lists this seed's shipments; download the ones this phone
     *  does not hold yet (whole files, tmp-then-rename, so streamBank never sees a partial). */
    static void syncBank(PadDelivery.Session session, java.io.File dir) {
        if (!session.ready()) return;
        final String base = session.base(), seed = session.seed();
        try {
            dir.mkdirs();
            JSONObject list = http(session, "GET", base + "/v1/pads/shipments?seed_id=" + seed, null);
            org.json.JSONArray ships = list.optJSONArray("shipments");
            if (ships == null || list.optInt("_status") != 200) return;
            JSONObject led = http(session, "GET", base + "/v1/pads/ledger?seed_id=" + seed, null);
            // Prune the app's prefetch copy by the ACK FLOOR (durably acknowledged coverage) rather than
            // the reservation mark. This is an ALIGNMENT with durable delivery progress, not a fix for a
            // proven pad loss: the drop already required this run's H/K (the accepted predicate below), so
            // reservation alone never authorized deleting an unacknowledged copy, and ack_floor is not a
            // proof of consumption either. It keys the prefetch-cache drop on delivery the platform has
            // durably acknowledged (a re-offer of an acknowledged range is a no-op; the relay store still
            // holds anything above the floor for a re-fetch).
            long ackFloor = led.optInt("_status") == 200 ? led.optLong("ack_floor", 0) : 0;
            java.io.File[] have = dir.listFiles((d, n) -> n.endsWith(".pads"));
            if (have != null) for (java.io.File f : have) {
                if (session.prune(f, ackFloor)) Main.say("PADS dropped " + f.getName() + " (below ack_floor " + ackFloor + ")");
                else if (session.pruneForeign(f)) Main.say("PADS dropped " + f.getName() + " (another seed)");
            }
            // Index order prevents a later 117 MiB file from blocking index zero.
            java.util.List<JSONObject> order = new java.util.ArrayList<>();
            for (int i = 0; i < ships.length(); i++) order.add(ships.getJSONObject(i));
            order.sort((x, y) -> Long.compare(PadDelivery.indexOf(x.optString("name", "")), PadDelivery.indexOf(y.optString("name", ""))));
            for (JSONObject s : order) {
                if (!session.active()) return;
                String name = s.getString("name");
                // A reserved range can still be missing from the VM. Only its H/K acknowledgment
                // can suppress a fetch; a remote ledger mark cannot establish delivery.
                if (!session.shouldFetch(name)) continue;
                long bytes = s.getLong("bytes");
                if (bytes <= 0) continue;
                java.io.File f = new java.io.File(dir, name);
                if (f.exists() && f.length() == bytes) continue;
                java.io.File tmp = java.io.File.createTempFile("." + name + ".", ".part", dir);
                HttpURLConnection c = (HttpURLConnection) new URL(base + "/v1/pads/shipments/" + seed + "/" + name).openConnection();
                java.io.Closeable connection = c::disconnect;
                try {
                    if (!session.track(connection)) return;
                    c.setConnectTimeout(20000); c.setReadTimeout(120000);
                    int code = c.getResponseCode();
                    if (code != 200) { Main.say("PADS fetch " + name + " http " + code); continue; }
                    try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                        session.copy(in, out, bytes);
                    }
                    if (session.publish(tmp, f)) Main.say("PADS fetched " + f.getName() + " (" + (f.length() >> 20) + " MiB)");
                } finally { session.untrack(connection); c.disconnect(); tmp.delete(); }
            }
        } catch (Exception e) { if (session.active()) Main.say("PADS sync error " + e); }
    }

    /** The platform's shared-prefix artifacts (prefix-kv.h) for (model digest, name): prefix.kv,
     *  prefix.kv.sig and prefix.txt fetched into `dir` (whole files, tmp-then-rename). True when all three are present. */
    static boolean fetchPrefix(String httpBase, String digest, String name, java.io.File dir) {
        try {
            dir.mkdirs();
            for (String ext : new String[] { ".kv", ".kv.sig", ".txt" }) {
                java.io.File f = new java.io.File(dir, "prefix" + ext);
                HttpURLConnection c = (HttpURLConnection) new URL(httpBase + "/v1/prefix-kv/" + digest + "/" + name + ext).openConnection();
                c.setConnectTimeout(20000); c.setReadTimeout(120000);
                if (c.getResponseCode() != 200) { Main.say("PREFIX fetch " + name + ext + " http " + c.getResponseCode()); return false; }
                java.io.File tmp = new java.io.File(dir, ".prefix" + ext + ".part");
                try (InputStream in = c.getInputStream(); OutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[1 << 20]; int n; while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
                }
                if (!tmp.renameTo(f)) { tmp.delete(); return false; }
                Main.say("PREFIX fetched " + name + ext + " (" + (f.length() >> 10) + " KiB)");
            }
            return true;
        } catch (Exception e) { Main.say("PREFIX fetch error " + e); return false; }
    }

    /** One file into the VM over the pads port (the H/G handshake, then the bytes). */
    static boolean streamOne(Object vm, java.io.File f) {
        ParcelFileDescriptor pfd = Main.connect(vm, PADS_PORT, 50);
        if (pfd == null) { Main.say("PADS connect failed"); return false; }
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new java.io.FileInputStream(f)) {
            out.write(("PADS " + f.getName() + " " + f.length() + "\n").getBytes()); out.flush();
            java.io.FileInputStream ackIn = new java.io.FileInputStream(pfd.getFileDescriptor());
            int go = ackIn.read();
            if (go == 'H') { Main.say("PADS " + f.getName() + " already in the VM"); return true; }
            if (go != 'G') { Main.say("PADS " + f.getName() + " VM refused the header"); return false; }
            byte[] buf = new byte[1 << 20]; int n; long sent = 0;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); sent += n; }
            out.flush();
            int ack = ackIn.read();
            Main.say("PADS " + f.getName() + " " + (sent >> 10) + " KiB " + (ack == 'K' ? "accepted" : "REFUSED"));
            return ack == 'K';
        } catch (Exception e) { Main.say("PADS stream error " + e); return false; }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }

    /** A fixed set of files (the shared-prefix KV, its sidecar and the prefix text) into the VM. */
    static void streamFiles(Object vm, java.io.File dir, String[] names) {
        for (String name : names) {
            java.io.File f = new java.io.File(dir, name);
            if (!f.exists()) { Main.say("PREFIX missing " + f); continue; }
            for (int attempt = 0; attempt < 30 && !streamOne(vm, f); attempt++) { try { Thread.sleep(1000); } catch (InterruptedException e) { return; } }
        }
    }

    /** Public encoded-weight artifacts ("<64 lowercase hex>.i8", named by their own content digest) into the VM over the pads
     *  port, in file-name order. The VM admits a name only against its measured encoded catalog and block-verifies every
     *  byte before it publishes the file; 'H' means a same-name, same-size file is already there (an availability hint:
     *  the local copy is kept), 'K' means this reception was verified (the local copy may be consumed), 'E' is a refusal
     *  (the VM says why on its own console; retried with backoff while the VM has not admitted its catalog yet). Bounded:
     *  at most 300 attempts per file, one second apart. */
    static void streamArtifacts(Object vm, java.io.File dir, boolean consume) {
        java.io.File[] files = dir.listFiles((d, n) -> n.matches("[0-9a-f]{64}\\.i8"));
        if (files == null || files.length == 0) { Main.say("ARTIFACTS none in " + dir); return; }
        java.util.Arrays.sort(files, (x, y) -> x.getName().compareTo(y.getName()));
        int accepted = 0, present = 0, refused = 0; long bytes = 0, t0 = System.nanoTime();
        for (java.io.File f : files) {
            int outcome = 0;
            for (int attempt = 0; attempt < 300 && outcome == 0 && !Thread.currentThread().isInterrupted(); attempt++) {
                outcome = streamArtifact(vm, f);
                if (outcome == 0) { try { Thread.sleep(1000); } catch (InterruptedException e) { return; } }
            }
            if (outcome == 'K') { accepted++; bytes += f.length(); if (consume && !f.delete()) Main.say("ARTIFACT " + f.getName() + " accepted but the local copy could not be deleted"); }
            else if (outcome == 'H') present++;
            else { refused++; Main.say("ARTIFACT " + f.getName() + " NOT delivered after 300 attempts"); }
        }
        Main.say("ARTIFACTS " + files.length + " offered: " + accepted + " accepted (" + (bytes >> 20) + " MiB), " + present + " already present, " + refused + " not delivered, " + ((System.nanoTime() - t0) / 1000000L) + " ms");
    }
    /** The host feed (artifact-feed.py through adb reverse) straight into the VM's artifact receiver: ArtifactFeed does the bounded
     *  work (manifest rounds, exact lengths, deadline/ended closer); this only supplies pads-port connections and the app's log. */
    static void feedArtifacts(Object vm, String base, int deadlineS) {
        /* ONE bounded connector for the whole feed: the raw connect is a single reflective connectVsock call (Main.connect with one
         * try) on the connector's own thread; ArtifactFeed.open() waits at most its budget slice and abandons the request, and a
         * descriptor that comes back late is closed by the connector. No thread is spawned per retry. */
        final ArtifactFeed.Connect connect = () -> {
            final ParcelFileDescriptor pfd;
            try { pfd = Main.connect(vm, PADS_PORT, 1); } catch (RuntimeException e) { throw new java.io.IOException("pads port connect failed: " + e); }
            if (pfd == null) throw new java.io.IOException("pads port not connectable yet");
            final InputStream in = new java.io.FileInputStream(pfd.getFileDescriptor()); final OutputStream out = new FileOutputStream(pfd.getFileDescriptor());
            return new ArtifactFeed.Conn() {
                public InputStream in() { return in; }
                public OutputStream out() { return out; }
                public void close() throws java.io.IOException { try { pfd.close(); } finally { try { in.close(); } catch (java.io.IOException ignored) { } try { out.close(); } catch (java.io.IOException ignored) { } } }
            };
        };
        final ArtifactFeed.BoundedConnector connector = new ArtifactFeed.BoundedConnector(connect, Main::ended);
        try { ArtifactFeed.run(base, connector, deadlineS * 1000L, Main::ended, Main::say); }
        finally { connector.close(); }
    }
    /** One artifact offer: 'K' verified and stored, 'H' already there (kept locally), 0 = not now (retry). */
    static int streamArtifact(Object vm, java.io.File f) {
        ParcelFileDescriptor pfd = Main.connect(vm, PADS_PORT, 5);
        if (pfd == null) return 0;
        try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new java.io.FileInputStream(f)) {
            out.write(("PADS " + f.getName() + " " + f.length() + "\n").getBytes()); out.flush();
            java.io.FileInputStream ackIn = new java.io.FileInputStream(pfd.getFileDescriptor());
            int go = ackIn.read();
            if (go == 'H') { Main.say("ARTIFACT " + f.getName() + " already in the VM (local copy kept)"); return 'H'; }
            if (go != 'G') { return 0; }                                                    // 'E' or a dropped connection: the VM said why; retry later
            byte[] buf = new byte[1 << 20]; int n; long sent = 0;
            while ((n = in.read(buf)) > 0) { out.write(buf, 0, n); sent += n; }
            out.flush();
            int ack = ackIn.read();
            Main.say("ARTIFACT " + f.getName() + " " + (sent >> 10) + " KiB " + (ack == 'K' ? "verified and stored" : "REFUSED"));
            return ack == 'K' ? 'K' : 0;
        } catch (Exception e) { Main.say("ARTIFACT stream error " + e); return 0; }
        finally { try { pfd.close(); } catch (Exception ignored) { } }
    }

    /** Fetch and stream independently, with immutable run ownership and per-run acknowledgments. */
    static void fetchLoop(PadDelivery.Session session, java.io.File dir) {
        for (int round = 0; round < 3600 && session.active() && !Thread.currentThread().isInterrupted(); round++) {
            syncBank(session, dir);
            try { Thread.sleep(2000); } catch (InterruptedException e) { return; }
        }
    }
    static void streamBank(PadDelivery.Session session, Object vm, java.io.File dir) {
        Thread fetcher = new Thread(() -> fetchLoop(session, dir), "pads-fetch");
        java.io.Closeable cancelFetch = fetcher::interrupt;
        try {
            if (!session.ready() || !session.track(cancelFetch)) return;
            fetcher.start();
            for (int round = 0; round < 3600 && session.active(); round++) {
                java.io.File[] files = dir.listFiles((d, n) -> session.belongs(n));
                if (files != null) {
                    java.util.Arrays.sort(files, (x, y) -> Long.compare(PadDelivery.indexOf(x.getName()), PadDelivery.indexOf(y.getName())));
                    for (java.io.File f : files) {
                        if (!session.active()) return;
                        if (session.accepted(f.getName())) continue;
                        ParcelFileDescriptor pfd = Main.connect(vm, PADS_PORT, 50);
                        if (pfd == null) { Main.say("PADS connect failed"); return; }
                        try {
                            if (!session.track(pfd)) return;
                            try (OutputStream out = new FileOutputStream(pfd.getFileDescriptor()); InputStream in = new java.io.FileInputStream(f)) {
                                out.write(("PADS " + f.getName() + " " + f.length() + "\n").getBytes()); out.flush();
                                java.io.FileInputStream ackIn = new java.io.FileInputStream(pfd.getFileDescriptor());
                                int go = ackIn.read();
                                if (go == 'H') { session.accept(f.getName()); Main.say("PADS " + f.getName() + " already in the VM"); continue; }
                                if (go != 'G') { Main.say("PADS " + f.getName() + " VM refused the header"); continue; }
                                session.copy(in, out, f.length()); out.flush();
                                int ack = ackIn.read();
                                Main.say("PADS " + f.getName() + " " + (f.length() >> 20) + " MiB " + (ack == 'K' ? "accepted" : "REFUSED"));
                                if (ack == 'K') session.accept(f.getName());
                            }
                        } catch (Exception e) { if (session.active()) Main.say("PADS stream error " + e); }
                        finally { session.untrack(pfd); try { pfd.close(); } catch (Exception ignored) { } }
                    }
                }
                try { Thread.sleep(1000); } catch (InterruptedException e) { return; }
            }
        } catch (Exception e) { if (session.active()) Main.say("PADS bank error " + e); }
        finally { session.untrack(cancelFetch); fetcher.interrupt(); }
    }
}
