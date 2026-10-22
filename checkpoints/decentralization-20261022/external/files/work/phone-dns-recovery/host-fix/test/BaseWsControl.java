package host.enclave.anchor.avf;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLServerSocket;
import java.net.UnknownHostException;
import java.util.Map;
import javax.net.ssl.SSLContext;

/*
 * NEGATIVE CONTROL: the DEPLOYED Ws.java (ea8210a55), unchanged, run with the test trust store as the platform default
 * (-Djavax.net.ssl.trustStore). Shows the two gaps the candidate closes:
 *   - an outage of the device's DNS is final (UnknownHostException, the phone's log line);
 *   - a server presenting a trusted certificate for ANOTHER name completes the WebSocket handshake (no name check).
 * Args: <dir with other.p12 trust.p12>. Prints "base-ws-control: ..." lines; exit 0 when both gaps reproduce.
 */
public final class BaseWsControl {
    static final char[] PW = "testpass".toCharArray();
    static final String UPGRADE = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";
    static int serve(File ks) throws Exception {
        final KeyStore k = KeyStore.getInstance("PKCS12"); try (InputStream in = new FileInputStream(ks)) { k.load(in, PW); }
        final KeyManagerFactory kmf = KeyManagerFactory.getInstance("PKIX"); kmf.init(k, PW);
        final SSLContext c = SSLContext.getInstance("TLS"); c.init(kmf.getKeyManagers(), null, null);
        final SSLServerSocket ss = (SSLServerSocket) c.getServerSocketFactory().createServerSocket(0, 50, InetAddress.getLoopbackAddress());
        final Thread t = new Thread(() -> {
            while (true) {
                try (Socket s = ss.accept()) {
                    s.setSoTimeout(5000);
                    final InputStream in = s.getInputStream();
                    int st = 0, b;
                    while (st < 4 && (b = in.read()) >= 0) st = (b == (st % 2 == 0 ? '\r' : '\n')) ? st + 1 : (b == '\r' ? 1 : 0);
                    final OutputStream o = s.getOutputStream(); o.write(UPGRADE.getBytes(StandardCharsets.UTF_8)); o.flush();
                } catch (Exception ignored) { }
            }
        });
        t.setDaemon(true); t.start();
        return ss.getLocalPort();
    }
    public static void main(String[] a) throws Exception {
        final File dir = new File(a[0]);
        final int other = serve(new File(dir, "other.p12"));
        try { new Ws("wss://relay.enclave.test:443/v1/fleet-tunnel", Map.of()); System.out.println("base-ws-control: UNEXPECTED: relay.enclave.test resolved"); System.exit(2); }
        catch (UnknownHostException e) { System.out.println("base-ws-control: device DNS outage is final: " + e); }
        // localhost resolves; the server's certificate is for other.enclave.test, which is NOT localhost
        final Ws ws = new Ws("wss://localhost:" + other + "/v1/fleet-tunnel", Map.of());
        ws.close();
        System.out.println("base-ws-control: GAP REPRODUCED: the deployed Ws completed a wss:// handshake with a certificate for another name");
    }
}
