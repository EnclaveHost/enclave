package host.enclave.anchor.avf;

import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.function.BooleanSupplier;
import java.util.function.Consumer;

/** Streams PUBLIC encoded-weight artifacts from a loopback HTTP feed (artifact-feed.py, reached through adb reverse) straight into
 *  the pVM's artifact receiver over the pads port: no phone storage copy, no local file ever written or deleted. The guest is the
 *  only authority: it admits a name only against its measured catalog and block-verifies every byte before publishing; this class is
 *  a bounded transport. Pure Java (no Android imports) so the host fixture can drive it against the real server and a fake receiver.
 *
 *  Bounds: whole feed <= deadlineMs (default 300 s, max 600 s) measured from run(); every blocking HTTP/vsock operation uses a
 *  timeout capped by the remaining time AND is registered with a closer that closes it at the deadline or when `ended` says the run
 *  is over, so a blocked vsock write or ack read cannot outlive the budget. Manifest: <= 1 MiB, <= 4096 entries, names exactly
 *  "<64 lowercase hex>.i8", sizes positive integers <= 4 GiB (a 27B output.weight is 1,271,398,400 B), duplicates or any invalid
 *  entry, a duplicate key, a declared count/total_bytes/order that does not match the entries, or a total above 64 GiB = the WHOLE
 *  manifest is malformed; the identities must not change between rounds. HTTP: loopback base only, no redirects, status 200, exact
 *  Content-Length and a body of exactly that length (a short body is a server fault and the feed stops). HttpURLConnection frames
 *  the body by Content-Length, so bytes a misbehaving server might append beyond that frame are not observable here and no claim
 *  about them is made; the guest's block verification is the authority over every byte it stores.
 *
 *  Coalescing (run(..., coalesce=true), app extra artifacts_coalesce=1, default off): each vsock write carries a full 1 MiB chunk
 *  instead of whatever HTTP fragment arrived. TIMEOUT INTERACTION: while a chunk fills, nothing reaches the guest, and the
 *  guest's receiver refuses a reception after 30 s without bytes (its per-read timeout); so coalescing is safe only while the
 *  HTTP side sustains more than 1 MiB per 30 s (~35 KB/s) for every chunk. On a stalled or very slow source it refuses safely
 *  (the guest removes its temp, the file is retried next round) where byte-by-byte forwarding would have survived. It is an
 *  A/B option for a measured phone comparison, not a general production gain claim. */
final class ArtifactFeed {
    static final long MANIFEST_MAX = 1L << 20, FILE_MAX = 4L << 30, TOTAL_MAX = 64L << 30, DEADLINE_DEFAULT_MS = 300_000L, DEADLINE_MAX_MS = 600_000L;
    static final int COUNT_MAX = 4096, IO_TIMEOUT_MS = 30_000;

    static final class Entry { final String name, tensor; final long bytes; Entry(String n, String t, long b) { name = n; tensor = t; bytes = b; } }
    static final class Manifest { String model = "", encodedCatalog = "", orderSource = ""; final List<Entry> files = new ArrayList<>(); }
    /** One pads-port connection into the guest (production: a vsock ParcelFileDescriptor; fixture: a socket). */
    interface Conn extends Closeable { InputStream in(); OutputStream out(); }
    /** open one connection within timeoutMs; production uses BoundedConnector so a blocked connect can never hold the feed */
    interface Port { Conn open(int timeoutMs) throws IOException; }
    /** one raw connect attempt (production: ONE reflective connectVsock call); it may block, and it may return late */
    interface Connect { Conn call() throws IOException; }
    /** ONE worker thread per feed session performs the raw connects; open() waits at most timeoutMs (in slices, so a
     *  cancelled feed returns at once). A connect that returns after its request was abandoned is CLOSED by the worker,
     *  never handed out; the worker is reused for every retry (no thread per attempt) and close() ends it. */
    static final class BoundedConnector implements Port, Closeable {
        private static final class Request { final Object lock = new Object(); Conn conn; IOException error; boolean done, abandoned; }
        private final Connect connect; private final BooleanSupplier cancelled;
        private final java.util.concurrent.LinkedBlockingQueue<Request> queue = new java.util.concurrent.LinkedBlockingQueue<>();
        private final Thread worker; private volatile boolean closed;
        final AtomicInteger lateClosed = new AtomicInteger();                 /* connections that returned after their request was abandoned (fixture-visible) */
        BoundedConnector(Connect connect, BooleanSupplier cancelled) {
            this.connect = connect; this.cancelled = cancelled;
            worker = new Thread(this::serve, "artifact-feed-connector"); worker.setDaemon(true); worker.start();
        }
        private void serve() {
            while (!closed) {
                Request q;
                try { q = queue.poll(200, java.util.concurrent.TimeUnit.MILLISECONDS); } catch (InterruptedException e) { return; }
                if (q == null) continue;
                synchronized (q.lock) { if (q.abandoned) { q.done = true; q.lock.notifyAll(); continue; } }   /* timed out while queued: no pointless raw connect */
                Conn c = null; IOException err = null;
                try { c = connect.call(); } catch (IOException e) { err = e; } catch (RuntimeException e) { err = new IOException("connect: " + e); }
                boolean handOver;
                synchronized (q.lock) { handOver = !q.abandoned && !closed; if (handOver) { q.conn = c; q.error = err; } q.done = true; q.lock.notifyAll(); }
                if (!handOver && c != null) { lateClosed.incrementAndGet(); try { c.close(); } catch (IOException ignored) { } }   /* late or after close: never leaked, never used */
            }
        }
        public Conn open(int timeoutMs) throws IOException {
            if (closed) throw new IOException("connector closed");
            Request q = new Request(); queue.add(q);
            final long until = System.nanoTime() + Math.max(1L, timeoutMs) * 1_000_000L;
            synchronized (q.lock) {
                while (!q.done) {
                    if (cancelled.getAsBoolean() || closed || System.nanoTime() >= until) { q.abandoned = true; throw new IOException(cancelled.getAsBoolean() ? "connect abandoned: feed cancelled" : "connect timed out after " + timeoutMs + " ms"); }
                    try { q.lock.wait(50); } catch (InterruptedException e) { q.abandoned = true; throw new IOException("connect interrupted"); }
                }
                if (q.error != null) throw q.error;
                if (q.conn == null) throw new IOException("connect returned nothing");
                return q.conn;
            }
        }
        /** ends the worker; a connect still blocked inside the raw call finishes on its own and its result is closed */
        public void close() { closed = true; worker.interrupt(); try { worker.join(500); } catch (InterruptedException ignored) { } }
        boolean workerAlive() { return worker.isAlive(); }
    }
    static final class Result {
        int offered, verified, present, pending, refused, rounds; long bytes, ms, bodyReads, bodyWrites, writtenBytes; String reason = "";
        boolean complete() { return reason.equals("complete"); }
        String line() { return "ARTIFACTS feed: offered " + offered + ", verified " + verified + " (" + (bytes >> 20) + " MiB), already-present " + present + ", pending " + pending + ", refused " + refused + ", rounds " + rounds + ", " + ms + " ms, reason=" + reason; }
    }

    /** "http://127.0.0.1:<port>/v1/artifacts" and nothing else: the feed is reached through adb reverse only. */
    static boolean validBase(String base) {
        if (base == null || !base.startsWith("http://127.0.0.1:") || !base.endsWith("/v1/artifacts")) return false;
        String port = base.substring("http://127.0.0.1:".length(), base.length() - "/v1/artifacts".length());
        if (port.isEmpty() || port.length() > 5) return false;
        for (int i = 0; i < port.length(); i++) if (port.charAt(i) < '0' || port.charAt(i) > '9') return false;
        int p = Integer.parseInt(port); return p >= 1 && p <= 65535;
    }
    static boolean validName(String n) {
        if (n == null || n.length() != 67 || !n.endsWith(".i8")) return false;
        for (int i = 0; i < 64; i++) { char c = n.charAt(i); if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; }
        return true;
    }
    static boolean validHex64(String s) { if (s == null || s.length() != 64) return false; for (int i = 0; i < 64; i++) { char c = s.charAt(i); if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return false; } return true; }

    /* ---- a strict parser for exactly the manifest's shape (objects, arrays, strings, non-negative integers, true/false/null);
     *      anything else, any duplicate name, any invalid entry: IOException("manifest malformed: ...") ---- */
    static final class Json {
        final byte[] b; int i = 0; Json(byte[] b) { this.b = b; }
        void ws() { while (i < b.length && (b[i] == ' ' || b[i] == '\n' || b[i] == '\r' || b[i] == '\t')) i++; }
        void expect(char c) throws IOException { ws(); if (i >= b.length || b[i] != c) throw new IOException("manifest malformed: expected '" + c + "' at " + i); i++; }
        boolean peek(char c) { ws(); return i < b.length && b[i] == c; }
        String str() throws IOException {
            expect('"'); StringBuilder s = new StringBuilder();
            while (true) {
                if (i >= b.length) throw new IOException("manifest malformed: unterminated string");
                int c = b[i++] & 0xff;
                if (c == '"') break;
                if (c == '\\') { if (i >= b.length) throw new IOException("manifest malformed: escape"); int e = b[i++]; if (e == 'n') s.append('\n'); else if (e == 't') s.append('\t'); else if (e == '"' || e == '\\' || e == '/') s.append((char) e); else if (e == 'u') { if (i + 4 > b.length) throw new IOException("manifest malformed: \\u"); int v = 0; for (int k = 0; k < 4; k++) { int h = Character.digit((char) b[i + k], 16); if (h < 0) throw new IOException("manifest malformed: \\u escape"); v = (v << 4) | h; } s.append((char) v); i += 4; } else throw new IOException("manifest malformed: escape"); }
                else if (c < 0x20) throw new IOException("manifest malformed: control character");
                else if (c < 0x80) s.append((char) c);
                else { int start = i - 1, len = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : 2; if (start + len > b.length) throw new IOException("manifest malformed: utf-8"); s.append(new String(b, start, len, StandardCharsets.UTF_8)); i = start + len; }
                if (s.length() > 1024) throw new IOException("manifest malformed: string too long");
            }
            return s.toString();
        }
        /** a non-negative integer literal (no sign, fraction, exponent, bool or string): the only number the manifest may carry */
        long integer() throws IOException {
            ws(); int start = i; while (i < b.length && b[i] >= '0' && b[i] <= '9') i++;
            if (i == start || i - start > 18) throw new IOException("manifest malformed: not a positive integer at " + start);
            if (i - start > 1 && b[start] == '0') throw new IOException("manifest malformed: leading zero at " + start);
            if (i < b.length && (b[i] == '.' || b[i] == 'e' || b[i] == 'E' || b[i] == '-' || b[i] == '+')) throw new IOException("manifest malformed: not an integer at " + start);
            return Long.parseLong(new String(b, start, i - start, StandardCharsets.US_ASCII));
        }
        void skipValue() throws IOException {   /* values we do not use, bounded by depth */
            skipValue(0);
        }
        private void skipValue(int depth) throws IOException {
            if (depth > 4) throw new IOException("manifest malformed: nesting");
            ws(); if (i >= b.length) throw new IOException("manifest malformed: value");
            if (b[i] == '"') { str(); return; }
            if (b[i] == '{') { i++; if (peek('}')) { i++; return; } do { str(); expect(':'); skipValue(depth + 1); } while (comma()); expect('}'); return; }
            if (b[i] == '[') { i++; if (peek(']')) { i++; return; } do { skipValue(depth + 1); } while (comma()); expect(']'); return; }
            if (b[i] >= '0' && b[i] <= '9') { integer(); return; }
            for (String lit : new String[] { "true", "false", "null" }) if (i + lit.length() <= b.length && new String(b, i, lit.length(), StandardCharsets.US_ASCII).equals(lit)) { i += lit.length(); return; }
            throw new IOException("manifest malformed: value at " + i);
        }
        boolean comma() { ws(); if (i < b.length && b[i] == ',') { i++; return true; } return false; }
    }
    static Manifest parseManifest(byte[] json) throws IOException {
        if (json == null || json.length == 0 || json.length > MANIFEST_MAX) throw new IOException("manifest malformed: size");
        Json j = new Json(json); Manifest m = new Manifest(); Set<String> seen = new HashSet<>(), keys = new HashSet<>(); long total = 0, declaredCount = -1, declaredTotal = -1;
        j.expect('{');
        if (!j.peek('}')) do {
            String k = j.str(); j.expect(':');
            if (!keys.add(k)) throw new IOException("manifest malformed: duplicate key " + k);          /* a repeated key never silently overwrites */
            if (k.equals("model_sha256")) { m.model = j.str(); if (!validHex64(m.model)) throw new IOException("manifest malformed: model_sha256"); }
            else if (k.equals("encoded_catalog_sha256")) { m.encodedCatalog = j.str(); if (!validHex64(m.encodedCatalog)) throw new IOException("manifest malformed: encoded_catalog_sha256"); }
            else if (k.equals("order_source")) { m.orderSource = j.str(); }
            else if (k.equals("count")) { declaredCount = j.integer(); }
            else if (k.equals("total_bytes")) { declaredTotal = j.integer(); }
            else if (k.equals("files")) {
                j.expect('['); if (j.peek(']')) throw new IOException("manifest malformed: no files");
                do {
                    j.expect('{'); String name = null, tensor = ""; long bytes = -1, order = -1; Set<String> ekeys = new HashSet<>();
                    if (!j.peek('}')) do {
                        String f = j.str(); j.expect(':');
                        if (!ekeys.add(f)) throw new IOException("manifest malformed: duplicate entry key " + f);
                        if (f.equals("name")) name = j.str(); else if (f.equals("tensor")) tensor = j.str(); else if (f.equals("bytes")) bytes = j.integer(); else if (f.equals("order")) order = j.integer(); else j.skipValue();
                    } while (j.comma());
                    j.expect('}');
                    if (!validName(name)) throw new IOException("manifest malformed: entry name");
                    if (bytes <= 0 || bytes > FILE_MAX) throw new IOException("manifest malformed: entry bytes for " + name);
                    if (order != m.files.size()) throw new IOException("manifest malformed: order " + order + " at position " + m.files.size());   /* exactly 0,1,2,... */
                    if (!seen.add(name)) throw new IOException("manifest malformed: duplicate " + name);
                    if (m.files.size() >= COUNT_MAX) throw new IOException("manifest malformed: more than " + COUNT_MAX + " entries");
                    total += bytes; if (total > TOTAL_MAX) throw new IOException("manifest malformed: total above " + TOTAL_MAX);
                    m.files.add(new Entry(name, tensor, bytes));
                } while (j.comma());
                j.expect(']');
            }
            else j.skipValue();
        } while (j.comma());
        j.expect('}'); j.ws(); if (j.i != json.length) throw new IOException("manifest malformed: bytes after the object");
        if (m.files.isEmpty()) throw new IOException("manifest malformed: no files");
        if (m.model.isEmpty() || m.encodedCatalog.isEmpty()) throw new IOException("manifest malformed: identities");
        if (declaredCount != m.files.size()) throw new IOException("manifest malformed: count " + declaredCount + " != " + m.files.size());
        if (declaredTotal != total) throw new IOException("manifest malformed: total_bytes " + declaredTotal + " != " + total);
        return m;
    }

    /* ---- the bounded run ---- */
    private final String base; private final Port port; private final long deadline; private final BooleanSupplier ended; private final Consumer<String> say;
    private final boolean coalesce;
    private final AtomicBoolean cancelled = new AtomicBoolean(false);
    private final AtomicReference<Closeable> active = new AtomicReference<>();   /* the one resource a blocking operation is using right now */
    private volatile String cancelReason = "";
    private volatile Manifest lastManifest = null; private final Set<String> done = new HashSet<>();   /* pending is always recomputed from these, whatever path ends the run */
    private ArtifactFeed(String base, Port port, long deadlineMs, BooleanSupplier ended, Consumer<String> say, boolean coalesce) {
        this.coalesce = coalesce;
        this.base = base; this.port = port; this.ended = ended; this.say = say;
        long d = deadlineMs <= 0 ? DEADLINE_DEFAULT_MS : Math.min(deadlineMs, DEADLINE_MAX_MS);
        this.deadline = System.nanoTime() + d * 1_000_000L;
    }
    long remainingMs() { return Math.max(0L, (deadline - System.nanoTime()) / 1_000_000L); }
    int ioTimeout() { return (int) Math.max(1L, Math.min(IO_TIMEOUT_MS, remainingMs())); }
    private void cancel(String why) { if (cancelled.compareAndSet(false, true)) { cancelReason = why; Closeable c = active.get(); if (c != null) try { c.close(); } catch (IOException ignored) { } } }
    private boolean cancelledNow() { return cancelled.get(); }
    /** register the resource a blocking call is about to use; the closer closes it if the budget ends meanwhile */
    private <T extends Closeable> T use(T c) throws IOException { active.set(c); if (cancelled.get()) { try { c.close(); } catch (IOException ignored) { } throw new IOException("feed " + cancelReason); } return c; }
    private void done() { active.set(null); }

    static Result run(String base, Port port, long deadlineMs, BooleanSupplier ended, Consumer<String> say) {
        return run(base, port, deadlineMs, ended, say, false);
    }
    static Result runCoalesced(String base, Port port, long deadlineMs, BooleanSupplier ended, Consumer<String> say) {
        return run(base, port, deadlineMs, ended, say, true);
    }
    static Result run(String base, Port port, long deadlineMs, BooleanSupplier ended, Consumer<String> say, boolean coalesce) {
        Result r = new Result(); long t0 = System.nanoTime();
        if (!validBase(base)) { r.reason = "invalid base url (loopback http://127.0.0.1:<port>/v1/artifacts only)"; say.accept(r.line()); return r; }
        ArtifactFeed f = new ArtifactFeed(base, port, deadlineMs, ended, say, coalesce);
        Thread closer = new Thread(() -> {
            while (!f.cancelled.get()) {
                if (f.remainingMs() == 0) { f.cancel("deadline"); break; }
                if (ended.getAsBoolean()) { f.cancel("ended"); break; }
                try { Thread.sleep(100); } catch (InterruptedException e) { break; }
            }
        }, "artifact-feed-closer");
        closer.setDaemon(true); closer.start();
        String outcome = "cancelled"; boolean closerAlive = false;
        try {
            try { outcome = f.rounds(r); }                                                   /* "complete" | "cancelled" */
            catch (IOException e) {
                if (!f.cancelledNow() && f.remainingMs() == 0) f.cancel("deadline");       /* an I/O timeout that lands exactly on the budget's end IS the deadline, not a server fault */
                outcome = f.cancelledNow() ? "cancelled" : "server fault: " + e.getMessage();
            }
            catch (RuntimeException e) { outcome = "adapter fault: " + e; }                  /* a Port/Consumer bug is a terminal reason, never a hang */
            finally { r.pending = f.pendingNow(); }                                          /* on EVERY exit path: files not verified/present, attempted or not */
        } finally {
            f.cancelled.set(true); closer.interrupt();                                       /* whatever happened above, the closer is stopped and joined here */
            try { closer.join(2000); } catch (InterruptedException ignored) { }
            closerAlive = closer.isAlive();
        }
        final boolean wasCancelled = f.cancelReason.length() > 0; final String why = f.cancelReason;
        if (outcome.equals("complete") && !wasCancelled) r.reason = "complete";
        else if (wasCancelled) r.reason = why;
        else r.reason = outcome;
        if (r.reason.isEmpty()) r.reason = "cancelled";                                       /* never an empty terminal reason */
        if (closerAlive) r.reason += " (closer thread still alive)";
        r.ms = (System.nanoTime() - t0) / 1_000_000L; say.accept(r.line()); say.accept("ARTIFACTS transfer: coalesced=" + coalesce + " body_reads=" + r.bodyReads + " completed_writes=" + r.bodyWrites + " completed_write_bytes=" + r.writtenBytes); return r;
    }
    /** every listed file that is neither verified nor present; before the first manifest nothing is known, so nothing is claimed done */
    int pendingNow() { Manifest m = lastManifest; if (m == null) return 0; int n = 0; for (Entry e : m.files) if (!done.contains(e.name)) n++; return n; }
    /** the feed server's manifest is static: identities AND the whole (order, name, bytes, tensor) list must not change between
     *  rounds, otherwise a dropped pending entry could make the remaining set look complete */
    private static void sameManifest(Manifest a, Manifest b) throws IOException {
        if (!a.model.equals(b.model) || !a.encodedCatalog.equals(b.encodedCatalog)) throw new IOException("manifest identities changed between rounds");
        if (a.files.size() != b.files.size()) throw new IOException("manifest entry count changed between rounds");
        for (int i = 0; i < a.files.size(); i++) { Entry x = a.files.get(i), y = b.files.get(i); if (!x.name.equals(y.name) || x.bytes != y.bytes || !x.tensor.equals(y.tensor)) throw new IOException("manifest entry " + i + " changed between rounds"); }
    }
    private String rounds(Result r) throws IOException {
        Manifest first = null;
        while (!cancelled.get()) {
            Manifest m = fetchManifest();
            if (first == null) first = m; else sameManifest(first, m);
            lastManifest = m; r.rounds++; r.offered = m.files.size();
            int progress = 0;
            for (Entry e : m.files) {
                if (cancelled.get()) break;
                if (done.contains(e.name)) continue;
                int outcome = offer(e, r);
                if (outcome == 'K' || outcome == 'H') { done.add(e.name); progress++; }
            }
            final int pendingNow = pendingNow();                                                   /* every file not yet done counts, attempted or not */
            if (cancelled.get()) return "cancelled";
            if (pendingNow == 0) return "complete";
            try { Thread.sleep(progress > 0 ? 200 : 1000); } catch (InterruptedException ie) { return "cancelled"; }
        }
        return "cancelled";
    }
    private HttpURLConnection http(String path, int timeout) throws IOException {
        HttpURLConnection c = (HttpURLConnection) new URL(base + path).openConnection();
        c.setInstanceFollowRedirects(false); c.setUseCaches(false); c.setConnectTimeout(timeout); c.setReadTimeout(timeout); c.setRequestMethod("GET");
        return c;
    }
    private Manifest fetchManifest() throws IOException {
        HttpURLConnection c = http("/manifest", ioTimeout()); Closeable closeable = c::disconnect; use(closeable);
        try {
            if (c.getResponseCode() != 200) throw new IOException("manifest http " + c.getResponseCode());
            long len = c.getContentLengthLong();
            if (len <= 0 || len > MANIFEST_MAX) throw new IOException("manifest length " + len);
            byte[] body = new byte[(int) len]; int got = 0;
            try (InputStream in = c.getInputStream()) {
                while (got < body.length) { int n = in.read(body, got, body.length - got); if (n < 0) throw new IOException("manifest short"); got += n; }
                if (in.read() != -1) throw new IOException("manifest trailing bytes");
            }
            return parseManifest(body);
        } finally { done(); c.disconnect(); }
    }
    /** Fill one bounded chunk when enabled. The existing registered closer still interrupts a blocked HTTP read.
     * A cancelled or short chunk is not forwarded; the guest removes its incomplete temporary file. */
    static int readTransferChunk(InputStream in, byte[] buffer, int want, boolean coalesce,
                                 BooleanSupplier cancelled, Result result) throws IOException {
        if (want <= 0 || want > buffer.length) throw new IllegalArgumentException("chunk size");
        int got = 0;
        do {
            if (cancelled.getAsBoolean()) throw new IOException("feed cancelled while filling chunk");
            int n = in.read(buffer, got, want - got);
            if (n < 0) throw new IOException("short body while filling chunk: " + got + " of " + want);
            if (n == 0) throw new IOException("body read made no progress");
            result.bodyReads++;
            got += n;
        } while (coalesce && got < want);
        if (cancelled.getAsBoolean()) throw new IOException("feed cancelled before chunk write");
        return got;
    }
    /** one offer of one artifact: returns 'K' (verified by the guest now), 'H' (already there), 'E' (not now: retry next round), or 'X' (refused, no retry this round) */
    private int offer(Entry e, Result r) throws IOException {
        if (cancelled.get()) throw new IOException("feed " + cancelReason);
        Conn conn; try { conn = port.open((int) Math.max(1L, Math.min(5_000L, remainingMs()))); } catch (IOException ex) { if (cancelled.get()) throw new IOException("feed " + cancelReason); return 'E'; }   /* at most 5 s per open, never past the budget; not up yet (model staging) = later */
        if (cancelled.get()) { try { conn.close(); } catch (IOException ignored) { } throw new IOException("feed " + cancelReason); }   /* the deadline passed during the connect */
        use(conn);
        try {
            int go;
            try { conn.out().write(("PADS " + e.name + " " + e.bytes + "\n").getBytes(StandardCharsets.US_ASCII)); conn.out().flush(); go = conn.in().read(); }
            catch (IOException ge) { if (cancelled.get()) throw new IOException("feed " + cancelReason); return 'E'; }
            if (go == 'H') { r.present++; return 'H'; }
            if (go != 'G') return 'E';
            HttpURLConnection c = http("/" + e.name, ioTimeout()); Closeable both = () -> { try { conn.close(); } finally { c.disconnect(); } }; use(both);   /* the vsock first: a blocked write/read must unblock even if the HTTP side stalls (its own timeout bounds it) */
            try {
                /* the feed server is ours: a wrong status, a wrong Content-Length or a short body is a SERVER FAULT and stops the
                 * feed (IOException out of here); the guest going away mid-transfer is a guest refusal: counted, retried next round */
                if (c.getResponseCode() != 200) throw new IOException(e.name + ": http " + c.getResponseCode());
                if (c.getContentLengthLong() != e.bytes) throw new IOException(e.name + ": content-length " + c.getContentLengthLong() + " != " + e.bytes);
                byte[] buf = new byte[1 << 20]; long sent = 0; boolean guestGone = false;
                try (InputStream in = c.getInputStream()) {
                    while (sent < e.bytes) {
                        if (cancelled.get()) throw new IOException("feed " + cancelReason);
                        int n = readTransferChunk(in, buf, (int) Math.min(buf.length, e.bytes - sent), coalesce, cancelled::get, r);   /* a short body throws in there: nothing partial is forwarded */
                        try { conn.out().write(buf, 0, n); } catch (IOException ge) { if (cancelled.get()) throw new IOException("feed " + cancelReason); guestGone = true; break; }
                        sent += n; r.bodyWrites++; r.writtenBytes += n;
                    }
                    if (!guestGone && in.read() != -1) throw new IOException(e.name + ": trailing bytes after " + e.bytes);
                }
                if (guestGone) { r.refused++; say.accept("ARTIFACT " + e.name + " guest closed the connection at " + sent + " of " + e.bytes + " bytes (retried next round)"); return 'X'; }
                int ack;
                try { conn.out().flush(); ack = conn.in().read(); } catch (IOException ge) { if (cancelled.get()) throw new IOException("feed " + cancelReason); ack = -1; }
                if (ack == 'K') { r.verified++; r.bytes += e.bytes; say.accept("ARTIFACT " + e.name + " " + (e.bytes >> 10) + " KiB verified and stored by the guest"); return 'K'; }
                r.refused++; say.accept("ARTIFACT " + e.name + " REFUSED by the guest after a complete body (retried next round)"); return 'X';
            } finally { c.disconnect(); }
        } finally { done(); try { conn.close(); } catch (IOException ignored) { } }
    }
}
