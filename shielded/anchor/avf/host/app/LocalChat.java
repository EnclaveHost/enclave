/*
 * LocalChat -- the owner side of the local engine's conversation (payload/engine_local.cpp, LOCAL.md).
 *
 * Pure java.*: the VM connection arrives as two streams, so the grammar helpers and the session are
 * host-testable without Android (test/anchor-local-proto.test.mjs cross-feeds request() and plan()
 * into the VM's own parsers).
 *
 *   -> GEN <max_new_tokens> <temperature_milli> <hex utf-8 message>   |  RESET  |  BYE
 *   <- READY ...  |  TXT <hex bytes>  |  STATS k=v ...  |  ERR <reason>
 *
 * A piece may end inside a multi-byte character (the tokenizer's byte pieces): Utf8Joiner holds the
 * incomplete tail until the rest arrives, so the screen never shows a replacement character.
 */
package host.enclave.anchor.avf;

import java.io.BufferedReader;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

public final class LocalChat {
    private LocalChat() { }
    public static final int PORT = 7781;
    static final int MAX_MSG = 256 * 1024;

    /** The owner's control line for the mode (payload/anchor_local.h): strict, canonical decimal. */
    public static String plan(long modelBytes, int threads, int ctx) {
        return "LOCAL model_bytes=" + modelBytes + " threads=" + Math.max(1, Math.min(16, threads)) + " ctx=" + Math.max(512, Math.min(32768, ctx));
    }
    /** The same line with the Shielded-TPU tail: the lane bundle's size and how many pad positions to mint before READY. */
    public static String plan(long modelBytes, int threads, int ctx, long tpuBundleBytes, int bank, int refill) {
        return plan(modelBytes, threads, ctx) + " tpu_bundle_bytes=" + tpuBundleBytes + " bank=" + Math.max(0, Math.min(4096, bank)) + " refill=" + Math.max(0, Math.min(8, refill));
    }
    /** Appends the drafter tail to either plan line: the drafter's size and how many tokens it proposes per step (1..4). */
    public static String withDraft(String plan, long draftBytes, int draftMax) { return plan + " draft_bytes=" + draftBytes + " draft_max=" + Math.max(1, Math.min(4, draftMax)); }
    /** One turn's request line, or null when the message is empty or over the VM's bound. */
    public static String request(String message, int maxNew, int temperatureMilli) {
        if (message == null) return null;
        byte[] b = message.getBytes(StandardCharsets.UTF_8);
        if (b.length == 0 || b.length > MAX_MSG) return null;
        return "GEN " + Math.max(1, Math.min(8192, maxNew)) + " " + Math.max(0, Math.min(2000, temperatureMilli)) + " " + hex(b);
    }
    public static String hex(byte[] b) {
        final char[] d = "0123456789abcdef".toCharArray(); char[] o = new char[b.length * 2];
        for (int i = 0; i < b.length; i++) { o[2 * i] = d[(b[i] >> 4) & 15]; o[2 * i + 1] = d[b[i] & 15]; }
        return new String(o);
    }
    public static byte[] unhex(String s) {
        if (s == null || (s.length() & 1) != 0) return null;
        byte[] o = new byte[s.length() / 2];
        for (int i = 0; i < o.length; i++) {
            int hi = Character.digit(s.charAt(2 * i), 16), lo = Character.digit(s.charAt(2 * i + 1), 16);
            if (hi < 0 || lo < 0) return null;
            o[i] = (byte) ((hi << 4) | lo);
        }
        return o;
    }
    public static Map<String, String> stats(String line) {
        Map<String, String> m = new LinkedHashMap<>();
        if (line == null || !line.startsWith("STATS ")) return m;
        for (String kv : line.substring(6).split(" ")) { int eq = kv.indexOf('='); if (eq > 0) m.put(kv.substring(0, eq), kv.substring(eq + 1)); }
        return m;
    }

    /** Reassembles UTF-8 across pieces: returns the text completed by these bytes, keeps an unfinished tail. */
    public static final class Utf8Joiner {
        private byte[] tail = new byte[0];
        public String push(byte[] piece) {
            byte[] all = new byte[tail.length + piece.length];
            System.arraycopy(tail, 0, all, 0, tail.length); System.arraycopy(piece, 0, all, tail.length, piece.length);
            int end = all.length, i = all.length - 1, back = 0;
            while (i >= 0 && back < 4 && (all[i] & 0xC0) == 0x80) { i--; back++; }          /* walk back over continuation bytes */
            if (i >= 0) {
                int lead = all[i] & 0xFF, need = lead >= 0xF0 ? 4 : lead >= 0xE0 ? 3 : lead >= 0xC0 ? 2 : 1;
                if (need > 1 && all.length - i < need) end = i;                             /* the last character is still arriving */
            }
            tail = new byte[all.length - end]; System.arraycopy(all, end, tail, 0, tail.length);
            return new String(all, 0, end, StandardCharsets.UTF_8);
        }
    }

    public interface Listener { void text(String delta); }

    /** One conversation with the VM. Not thread-safe: one turn at a time. */
    public static final class Session implements Closeable {
        private final BufferedReader in; private final OutputStream out;
        public Session(InputStream in, OutputStream out) { this.in = new BufferedReader(new InputStreamReader(in, StandardCharsets.US_ASCII), 1 << 16); this.out = out; }
        /** Blocks until the engine has loaded the model; returns the READY line's fields (ctx, threads, vocab, model, load_s). */
        public Map<String, String> awaitReady() throws IOException {
            String l;
            while ((l = in.readLine()) != null) { if (l.startsWith("READY ")) return stats("STATS " + l.substring(6)); if (l.startsWith("ERR ")) throw new IOException(l.substring(4)); }
            throw new IOException("the VM closed the conversation before READY");
        }
        /** Runs one turn, streaming text to the listener; returns the STATS fields. An ERR line becomes an IOException and leaves the conversation as it was. */
        public Map<String, String> turn(String message, int maxNew, int temperatureMilli, Listener listener) throws IOException {
            String req = request(message, maxNew, temperatureMilli);
            if (req == null) throw new IOException("the message is empty or longer than " + MAX_MSG + " bytes");
            out.write((req + "\n").getBytes(StandardCharsets.US_ASCII)); out.flush();
            Utf8Joiner joiner = new Utf8Joiner(); String l;
            while ((l = in.readLine()) != null) {
                if (l.startsWith("TXT ")) { byte[] b = unhex(l.substring(4)); if (b != null && listener != null) { String d = joiner.push(b); if (!d.isEmpty()) listener.text(d); } }
                else if (l.startsWith("STATS ")) return stats(l);
                else if (l.startsWith("ERR ")) throw new IOException(l.substring(4));
            }
            throw new IOException("the VM closed the conversation mid-turn");
        }
        public void reset() throws IOException {
            out.write("RESET\n".getBytes(StandardCharsets.US_ASCII)); out.flush();
            String l; while ((l = in.readLine()) != null) if (l.startsWith("STATS ")) return;
            throw new IOException("the VM closed the conversation");
        }
        @Override public void close() { try { out.write("BYE\n".getBytes(StandardCharsets.US_ASCII)); out.flush(); } catch (IOException ignored) { } }
    }
}
