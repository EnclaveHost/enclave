/*
 * Ws -- a dependency-free RFC 6455 WebSocket client, enough for the fleet
 * tunnel: one handshake with custom headers, masked text frames out, text /
 * ping / close frames in. Android ships no public WebSocket API and this APK
 * is built without a package manager, so this is the whole client.
 */
package host.enclave.anchor.avf;

import java.io.BufferedInputStream;
import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.Map;
import javax.net.ssl.SSLSocketFactory;

public final class Ws implements Closeable {
    private final Socket sock; private final InputStream in; private final OutputStream out;
    private final SecureRandom rnd = new SecureRandom();

    public Ws(String url, Map<String, String> headers) throws IOException {
        URI u = URI.create(url);
        boolean tls = "wss".equals(u.getScheme());
        int port = u.getPort() > 0 ? u.getPort() : (tls ? 443 : 80);
        Socket s = tls ? SSLSocketFactory.getDefault().createSocket(u.getHost(), port) : new Socket(u.getHost(), port);
        s.setTcpNoDelay(true);
        sock = s; in = new BufferedInputStream(s.getInputStream()); out = s.getOutputStream();
        byte[] key = new byte[16]; rnd.nextBytes(key);
        String path = (u.getRawPath() == null || u.getRawPath().isEmpty() ? "/" : u.getRawPath()) + (u.getRawQuery() != null ? "?" + u.getRawQuery() : "");
        StringBuilder req = new StringBuilder();
        req.append("GET ").append(path).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(u.getHost()).append(u.getPort() > 0 ? ":" + u.getPort() : "").append("\r\n");
        req.append("Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n");
        req.append("Sec-WebSocket-Key: ").append(Base64.getEncoder().encodeToString(key)).append("\r\n");
        for (Map.Entry<String, String> e : headers.entrySet()) req.append(e.getKey()).append(": ").append(e.getValue()).append("\r\n");
        req.append("\r\n");
        out.write(req.toString().getBytes(StandardCharsets.ISO_8859_1)); out.flush();
        String status = readLine();
        if (status == null || !status.contains(" 101 ")) throw new IOException("websocket handshake refused: " + status);
        String line; while ((line = readLine()) != null && !line.isEmpty()) { /* response headers */ }
    }

    private String readLine() throws IOException {
        ByteArrayOutputStream b = new ByteArrayOutputStream(); int c, prev = 0;
        while ((c = in.read()) >= 0) {
            if (prev == '\r' && c == '\n') { byte[] a = b.toByteArray(); return new String(a, 0, a.length - 1, StandardCharsets.ISO_8859_1); }
            b.write(c); prev = c;
        }
        return null;
    }

    public synchronized void sendText(String s) throws IOException { frame(0x1, s.getBytes(StandardCharsets.UTF_8)); }

    private void frame(int op, byte[] p) throws IOException {
        ByteArrayOutputStream f = new ByteArrayOutputStream();
        f.write(0x80 | op);
        int n = p.length;
        if (n < 126) f.write(0x80 | n);
        else if (n < 65536) { f.write(0x80 | 126); f.write(n >> 8); f.write(n); }
        else { f.write(0x80 | 127); for (int i = 7; i >= 0; i--) f.write((int) (((long) n) >> (8 * i))); }
        byte[] mask = new byte[4]; rnd.nextBytes(mask); f.write(mask);
        for (int i = 0; i < n; i++) f.write(p[i] ^ mask[i & 3]);
        out.write(f.toByteArray()); out.flush();
    }

    /** Blocks for the next text message; answers pings itself; null once the peer closes. */
    public String receive() throws IOException {
        ByteArrayOutputStream msg = null;
        for (;;) {
            int b0 = in.read(); if (b0 < 0) return null;
            int b1 = in.read(); if (b1 < 0) return null;
            boolean fin = (b0 & 0x80) != 0; int op = b0 & 0xf; long n = b1 & 0x7f;
            if (n == 126) n = ((long) in.read() << 8) | in.read();
            else if (n == 127) { n = 0; for (int i = 0; i < 8; i++) n = (n << 8) | in.read(); }
            byte[] mask = null; if ((b1 & 0x80) != 0) { mask = new byte[4]; readFully(mask); }
            byte[] p = new byte[(int) n]; readFully(p);
            if (mask != null) for (int i = 0; i < p.length; i++) p[i] ^= mask[i & 3];
            if (op == 0x9) { synchronized (this) { frame(0xA, p); } continue; }
            if (op == 0xA) continue;
            if (op == 0x8) return null;
            if (op == 0x1 || op == 0x2) msg = new ByteArrayOutputStream();
            if (msg != null) msg.write(p);
            if (fin && msg != null) { String s = msg.toString("UTF-8"); msg = null; return s; }
        }
    }
    private void readFully(byte[] b) throws IOException { int off = 0; while (off < b.length) { int r = in.read(b, off, b.length - off); if (r < 0) throw new EOFException(); off += r; } }

    @Override public void close() {
        try { synchronized (this) { frame(0x8, new byte[0]); } } catch (Exception ignored) { }
        try { sock.close(); } catch (Exception ignored) { }
    }
}
