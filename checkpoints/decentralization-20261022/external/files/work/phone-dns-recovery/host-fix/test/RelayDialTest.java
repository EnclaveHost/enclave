package host.enclave.anchor.avf;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.KeyStore;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import javax.net.ssl.KeyManagerFactory;
import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLServerSocket;
import javax.net.ssl.TrustManagerFactory;

/*
 * RelayDial on the JVM, against real TLS servers on loopback:
 *   relay.enclave.test  -- the relay's own certificate
 *   other.enclave.test  -- a certificate the SAME trust store accepts, for ANOTHER name
 *   doh.enclave.test    -- a DoH JSON server
 * The device's DNS is a stub that fails (the outage) or answers. Args: <dir with relay.p12 other.p12 doh.p12 trust.p12>
 */
public final class RelayDialTest {
    static final char[] PW = "testpass".toCharArray();
    static int checks = 0;
    static void ok(boolean c, String what) { if (!c) throw new AssertionError(what); checks++; System.out.println("ok " + what); }

    static SSLContext ctx(File ks, File trust) throws Exception {
        final KeyStore k = KeyStore.getInstance("PKCS12"); try (InputStream in = new FileInputStream(ks)) { k.load(in, PW); }
        final KeyManagerFactory kmf = KeyManagerFactory.getInstance("PKIX"); kmf.init(k, PW);
        final SSLContext c = SSLContext.getInstance("TLS"); c.init(kmf.getKeyManagers(), null, null); return c;
    }
    static SSLContext client(File trust) throws Exception {
        final KeyStore t = KeyStore.getInstance("PKCS12"); try (InputStream in = new FileInputStream(trust)) { t.load(in, PW); }
        final TrustManagerFactory tmf = TrustManagerFactory.getInstance("PKIX"); tmf.init(t);
        final SSLContext c = SSLContext.getInstance("TLS"); c.init(null, tmf.getTrustManagers(), null); return c;
    }

    /** A TLS server on 127.0.0.1 answering every connection with `reply` (after reading the request head). */
    static int serve(SSLContext c, String reply) throws Exception {
        final SSLServerSocket ss = (SSLServerSocket) c.getServerSocketFactory().createServerSocket(0, 50, InetAddress.getLoopbackAddress());
        final Thread t = new Thread(() -> {
            while (true) {
                try (Socket s = ss.accept()) {
                    s.setSoTimeout(5000);
                    final InputStream in = s.getInputStream();
                    int st = 0, b;   // read to the end of the request head
                    while (st < 4 && (b = in.read()) >= 0) st = (b == (st % 2 == 0 ? '\r' : '\n')) ? st + 1 : (b == '\r' ? 1 : 0);
                    final OutputStream o = s.getOutputStream(); o.write(reply.getBytes(StandardCharsets.UTF_8)); o.flush();
                } catch (Exception ignored) { }
            }
        });
        t.setDaemon(true); t.start();
        return ss.getLocalPort();
    }
    static int closedPort() throws Exception { try (ServerSocket s = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) { return s.getLocalPort(); } }

    static final String UPGRADE = "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n";

    public static void main(String[] a) throws Exception {
        final File dir = new File(a[0]), trust = new File(dir, "trust.p12");
        final SSLContext cl = client(trust);
        RelayDial.tls = cl.getSocketFactory();
        final List<String> log = new ArrayList<>();
        RelayDial.log = log::add;
        final File store = new File(dir, "relay-addresses"); store.delete();
        RelayDial.store = store;
        final InetAddress lo = InetAddress.getLoopbackAddress();
        final int relay = serve(ctx(new File(dir, "relay.p12"), trust), UPGRADE);
        final int other = serve(ctx(new File(dir, "other.p12"), trust), UPGRADE);
        final String H = "relay.enclave.test";
        final RelayDial.Resolver down = (h) -> { throw new UnknownHostException(h + ": Unable to resolve host (the outage)"); };
        final RelayDial.Resolver up = (h) -> new InetAddress[] {lo};

        // 1. the outage with nothing remembered and no DoH: the original failure, unchanged
        RelayDial.system = down; RelayDial.doh = List.of();
        try { RelayDial.open(H, relay, true, 2000, 5000); ok(false, "nothing to dial"); }
        catch (UnknownHostException e) { ok(true, "outage, nothing remembered, no DoH: UnknownHostException as before"); }

        // 2. DNS works: the dial verifies the name, and the proven address is remembered
        RelayDial.system = up;
        try (Socket s = RelayDial.open(H, relay, true, 2000, 5000)) { ok(s.isConnected(), "DNS up: TLS verified for " + H); }
        ok(RelayDial.remembered(H).contains(lo), "the proven address is remembered (files/relay-addresses)");
        ok(Files.readString(store.toPath()).startsWith(H + " 127.0.0.1 "), "the store holds host, address, time only");

        // 3. the outage again: the remembered address is reached, TLS still verified for the relay's name
        RelayDial.system = down; log.clear();
        try (Socket s = RelayDial.open(H, relay, true, 2000, 5000)) { ok(s.isConnected(), "outage: reached through the last proven address"); }
        ok(log.stream().anyMatch((l) -> l.contains("last proven address") && l.contains("TLS verified for " + H)), "logged as such");

        // 4. a server with a certificate the trust store accepts but for ANOTHER name is refused, outage or not
        try { RelayDial.open(H, other, true, 2000, 5000); ok(false, "wrong name accepted"); }
        catch (javax.net.ssl.SSLException e) { ok(true, "outage: a trusted certificate for another name is refused (" + e.getClass().getSimpleName() + ")"); }
        RelayDial.system = up;
        try { RelayDial.open(H, other, true, 2000, 5000); ok(false, "wrong name accepted"); }
        catch (javax.net.ssl.SSLException e) { ok(true, "DNS up: a trusted certificate for another name is refused"); }

        // 5. plain ws:// (the lab) never leaves the device's DNS: nothing authenticates a fallback peer
        RelayDial.system = down;
        try { RelayDial.open(H, relay, false, 2000, 5000); ok(false, "plain dial used a fallback"); }
        catch (UnknownHostException e) { ok(true, "ws:// in an outage: no fallback, UnknownHostException"); }

        // 6. DNS answers an address that does not serve: the remembered proven one still does (DNS answers are not trusted
        //    for identity; TLS is)
        RelayDial.system = (h) -> new InetAddress[] {InetAddress.getByName("127.0.0.2")};
        try (Socket s = RelayDial.open(H, relay, true, 1000, 5000)) { ok(s.isConnected(), "DNS answer unreachable: the proven address answers"); }
        catch (java.net.ConnectException e) { ok(false, "127.0.0.2 must refuse, then 127.0.0.1 serve: " + e); }

        // 7. a stale store entry (older than KEEP_MS) is not used
        Files.writeString(store.toPath(), H + " 127.0.0.1 " + (System.currentTimeMillis() - RelayDial.KEEP_MS - 1000) + "\n");
        ok(RelayDial.remembered(H).isEmpty(), "an address older than " + RelayDial.KEEP_MS / 86400000 + " days is forgotten");
        Files.writeString(store.toPath(), "other.host 127.0.0.1 " + System.currentTimeMillis() + "\nbad line\n" + H + " not-an-ip " + System.currentTimeMillis() + "\n");
        ok(RelayDial.remembered(H).isEmpty(), "another host's entry, malformed lines and non-IP entries are ignored (no lookup)");

        // 8. DoH, authenticated: a DoH server proves ITS name; its answers must be public addresses of the asked type
        final String cf = "HTTP/1.1 200 OK\r\nContent-Type: application/dns-json\r\n\r\n"
            + "{\"Status\":0,\"TC\":false,\"Question\":[{\"name\":\"" + H + "\",\"type\":1}],\"Answer\":[{\"name\":\"" + H + "\",\"type\":1,\"TTL\":60,\"data\":\"134.199.235.187\"},{\"name\":\"" + H + "\",\"type\":1,\"TTL\":60,\"data\":\"10.0.0.9\"},{\"name\":\"" + H + "\",\"type\":1,\"TTL\":60,\"data\":\"127.0.0.1\"}]}";
        ok(RelayDial.answers(cf, 1).equals(List.of(InetAddress.getByName("134.199.235.187"))), "DoH JSON: public A records only (private and loopback dropped)");
        ok(RelayDial.answers(cf, 28).isEmpty(), "DoH JSON: AAAA asked, A records not taken");
        ok(RelayDial.answers(cf.replace("\"Status\":0", "\"Status\":2"), 1).isEmpty(), "DoH JSON: SERVFAIL gives nothing");
        ok(RelayDial.answers(cf.replace("200 OK", "403 Forbidden"), 1).isEmpty(), "DoH: a non-200 gives nothing");
        final String google = "HTTP/1.0 200 OK\r\n\r\n{\"Status\": 0,\"TC\": false,\"Answer\": [{\"name\": \"" + H + ".\",\"type\": 28,\"TTL\": 30,\"data\": \"2a03:b0c0:2:f0::1\"}]}";
        ok(RelayDial.answers(google, 28).equals(List.of(InetAddress.getByName("2a03:b0c0:2:f0::1"))), "DoH JSON (dns.google shape): public AAAA taken");

        final int doh = serve(ctx(new File(dir, "doh.p12"), trust), cf.replace("134.199.235.187", "192.0.2.10"));
        final int dohWrong = serve(ctx(new File(dir, "other.p12"), trust), cf.replace("134.199.235.187", "192.0.2.11"));
        store.delete(); RelayDial.system = down; RelayDial.dohPortOverride = doh; log.clear();
        RelayDial.doh = List.of(new String[][] {{"127.0.0.1:443", "doh.enclave.test", "/dns-query"}});
        // the DoH server is asked; its (public, documentation-range) answer is dialled -- and must then prove the relay's name
        ok(RelayDial.viaDoh(H).contains(InetAddress.getByName("192.0.2.10")), "outage: authenticated DoH answers for the relay host");
        RelayDial.dohPortOverride = dohWrong;
        ok(RelayDial.viaDoh(H).isEmpty(), "a DoH server that cannot prove its own name is not believed");
        ok(log.stream().anyMatch((l) -> l.contains("RELAY DoH doh.enclave.test")), "logged");
        RelayDial.doh = List.of(new String[][] {{"127.0.0.1:53", "doh.enclave.test", "/dns-query"}, {"127.0.0.1:443", "bad name!", "/q"}});
        ok(RelayDial.viaDoh(H).isEmpty(), "malformed DoH entries (not :443, bad name) are skipped");
        RelayDial.doh = List.of(); RelayDial.dohPortOverride = 0;

        // 9. the whole WebSocket handshake through Ws in the outage, as RelayAttach.challenge() does it
        store.delete(); RelayDial.system = up;
        try (Socket s = RelayDial.open(H, relay, true, 2000, 5000)) { }
        RelayDial.system = down;
        final Ws ws = new Ws("wss://" + H + ":" + relay + "/v1/fleet-tunnel", Map.of("x-metal-name", "pixel", "x-metal-attest", "1"));
        ws.close();
        ok(true, "Ws: wss:// handshake (101) completed during the outage through the last proven address");
        try { new Ws("wss://" + H + ":" + other + "/v1/fleet-tunnel", Map.of()); ok(false, "Ws accepted another name"); }
        catch (java.io.IOException e) { ok(true, "Ws: refuses a trusted certificate for another name"); }

        System.out.println("relay-dial: ok (" + checks + " checks)");
    }
}
