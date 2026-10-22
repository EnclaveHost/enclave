/*
 * RelayDial -- the socket under Ws: how this host reaches its control relay, including when the device's DNS cannot name
 * it (2026-10-20: the phone's DNS-only VPN lost its resolver; every re-attach failed with UnknownHostException
 * api.enclave.host for hours although the relay itself was up).
 *
 * Who is trusted for what does not change. The relay is authenticated by TLS for its own host name -- now verified
 * explicitly on every dial (an SSLSocket checks the chain but not the name unless asked) -- and the relay authenticates
 * this host by the VM's attestation, exactly as before. Only WHERE the bytes go may come from somewhere else, and only
 * when the device's own resolver has no answer at all (a DNS failure, never an answer it gave):
 *   1. the device's resolver (as before; its answers are remembered once a dial to them has completed a verified TLS
 *      handshake: files/relay-addresses, addresses only, nothing secret);
 *   2. those remembered addresses (at most KEEP_MS old);
 *   3. the APK's own authenticated DoH servers (build.json "dns": an IP, its TLS name, a JSON path -- the list the host
 *      agent already resolves with), asked for the relay's host name only.
 * A wrong address from 2 or 3 costs a failed handshake, never a wrong peer. Plain ws:// (the lab) never leaves 1: with
 * no TLS nothing would authenticate the peer. No resolver setting of the device is read or changed.
 */
package host.enclave.anchor.avf;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.UnknownHostException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.StandardCopyOption;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import javax.net.ssl.SNIHostName;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class RelayDial {
    private RelayDial() { }

    /** files/relay-addresses (Main sets it at start); null = nothing remembered. */
    static volatile File store = null;
    /** The authenticated DoH servers: {"1.1.1.1:443", "cloudflare-dns.com", "/dns-query"}; empty = no DoH tier. */
    static volatile List<String[]> doh = List.of();
    /** Main.say on the phone. */
    static volatile java.util.function.Consumer<String> log = (s) -> { };
    /** The device's resolver, and the TLS client (tests substitute both; the phone uses the platform's). */
    interface Resolver { InetAddress[] resolve(String host) throws UnknownHostException; }
    static volatile Resolver system = InetAddress::getAllByName;
    static volatile SSLSocketFactory tls = (SSLSocketFactory) SSLSocketFactory.getDefault();
    /** For tests: DoH servers are dialled on this port instead of the one their entry names (always 443 on a phone). */
    static volatile int dohPortOverride = 0;

    static final long KEEP_MS = 30L * 24 * 3600 * 1000;
    static final int DOH_MS = 8000, MAX_BODY = 65536, MAX_KEPT = 16;
    private static final Pattern HOST = Pattern.compile("^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.)+[a-z]{2,63}$");

    /** A connected socket to host:port -- TLS, host name verified, when tls. */
    static Socket open(String host, int port, boolean tls, int connectMs, int readMs) throws IOException {
        final String h = host.toLowerCase(java.util.Locale.ROOT);
        List<InetAddress> dns;
        try {
            dns = List.of(system.resolve(h));
        } catch (UnknownHostException e) {
            if (!tls || !HOST.matcher(h).matches()) throw e;
            dns = List.of();
            log.accept("RELAY " + h + ": the device's DNS has no answer (" + e.getMessage() + "); trying its last proven addresses, then authenticated DoH");
        }
        IOException last = null;
        final LinkedHashSet<InetAddress> tried = new LinkedHashSet<>();
        for (InetAddress a : dns) {
            tried.add(a);
            try { final Socket s = dial(a, h, port, tls, connectMs, readMs); if (tls) remember(h, dns); return s; }
            catch (IOException e) { last = e; }
        }
        if (!tls) throw last != null ? last : new UnknownHostException(h);
        // the device named nothing that answered as this host: the addresses proven before, then authenticated DoH
        for (int tier = 0; tier < 2; tier++) {
            final List<InetAddress> more = tier == 0 ? remembered(h) : viaDoh(h);
            for (InetAddress a : more) {
                if (!tried.add(a)) continue;
                try {
                    final Socket s = dial(a, h, port, true, connectMs, readMs);
                    log.accept("RELAY " + h + ": reached at " + a.getHostAddress() + " (" + (tier == 0 ? "last proven address" : "authenticated DoH") + "), TLS verified for " + h);
                    remember(h, List.of(a));
                    return s;
                } catch (IOException e) { last = e; }
            }
        }
        throw last != null ? last : new UnknownHostException(h + ": no address from the device's DNS, none remembered, no DoH answer");
    }

    /** One TCP connection, and for tls a handshake that must prove `host`: SNI and endpoint identification HTTPS. */
    static Socket dial(InetAddress a, String host, int port, boolean tls, int connectMs, int readMs) throws IOException {
        final Socket raw = new Socket();
        try {
            raw.connect(new InetSocketAddress(a, port), connectMs);
            raw.setSoTimeout(readMs);
            if (!tls) return raw;
            final SSLSocket s = (SSLSocket) RelayDial.tls.createSocket(raw, host, port, true);
            final SSLParameters p = s.getSSLParameters();
            p.setEndpointIdentificationAlgorithm("HTTPS");
            p.setServerNames(List.of(new SNIHostName(host)));
            s.setSSLParameters(p);
            s.startHandshake();
            return s;
        } catch (IOException e) {
            try { raw.close(); } catch (IOException ignored) { }
            throw e;
        }
    }

    // ---------------------------------------------------------------- remembered addresses

    static synchronized List<InetAddress> remembered(String host) {
        final List<InetAddress> out = new ArrayList<>();
        final File f = store;
        if (f == null || !f.isFile()) return out;
        final long now = System.currentTimeMillis();
        try {
            for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                final String[] p = line.trim().split(" ");
                if (p.length != 3 || !p[0].equals(host)) continue;
                final long at;
                try { at = Long.parseLong(p[2]); } catch (NumberFormatException e) { continue; }
                final InetAddress a = literal(p[1]);
                if (a != null && now - at <= KEEP_MS && at <= now + 60000) out.add(a);
            }
        } catch (IOException ignored) { }
        return out;
    }

    static synchronized void remember(String host, List<InetAddress> addrs) {
        final File f = store;
        if (f == null || addrs.isEmpty()) return;
        final long now = System.currentTimeMillis();
        final List<String> keep = new ArrayList<>();
        final LinkedHashSet<String> fresh = new LinkedHashSet<>();
        for (InetAddress a : addrs) if (literal(a.getHostAddress()) != null) fresh.add(a.getHostAddress());
        for (String ip : fresh) keep.add(host + " " + ip + " " + now);
        try {
            if (f.isFile()) for (String line : Files.readAllLines(f.toPath(), StandardCharsets.UTF_8)) {
                final String[] p = line.trim().split(" ");
                if (p.length == 3 && !(p[0].equals(host) && fresh.contains(p[1])) && keep.size() < MAX_KEPT) keep.add(line.trim());
            }
            final File tmp = new File(f.getPath() + ".tmp");
            Files.write(tmp.toPath(), (String.join("\n", keep) + "\n").getBytes(StandardCharsets.UTF_8));
            Files.move(tmp.toPath(), f.toPath(), StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
        } catch (IOException ignored) { }
    }

    // ---------------------------------------------------------------- authenticated DoH (JSON API)

    static List<InetAddress> viaDoh(String host) {
        final List<InetAddress> out = new ArrayList<>();
        for (String[] d : doh) {
            if (d == null || d.length != 3) continue;
            final InetAddress ip = literal(d[0].replaceFirst(":443$", ""));
            if (ip == null || !d[0].endsWith(":443") || !HOST.matcher(d[1]).matches() || !d[2].startsWith("/")) continue;
            final int port = dohPortOverride > 0 ? dohPortOverride : 443;
            for (String type : new String[] {"A", "AAAA"}) {
                try (Socket s = dial(ip, d[1], port, true, DOH_MS, DOH_MS)) {
                    final OutputStream o = s.getOutputStream();
                    o.write(("GET " + d[2] + "?name=" + host + "&type=" + type + " HTTP/1.0\r\nHost: " + d[1]
                        + "\r\nAccept: application/dns-json\r\nUser-Agent: enclave-host\r\n\r\n").getBytes(StandardCharsets.US_ASCII));
                    o.flush();
                    out.addAll(answers(readAll(s.getInputStream()), type.equals("A") ? 1 : 28));
                } catch (IOException e) {
                    log.accept("RELAY DoH " + d[1] + " (" + d[0] + "): " + e.getMessage());
                }
            }
            if (!out.isEmpty()) break;
        }
        return out;
    }

    /** The public addresses of the given type in a DoH JSON response (an HTTP/1.0 200 with Status 0); none otherwise. */
    static List<InetAddress> answers(String http, int type) {
        final List<InetAddress> out = new ArrayList<>();
        final int body = http.indexOf("\r\n\r\n");
        if (!http.startsWith("HTTP/1.") || !http.matches("(?s)^HTTP/1\\.[01] 200 .*") || body < 0) return out;
        final String j = http.substring(body + 4);
        if (!Pattern.compile("\"Status\"\\s*:\\s*0[,}\\s]").matcher(j).find()) return out;
        final Matcher m = Pattern.compile("\\{[^{}]*\\}").matcher(j);
        while (m.find()) {
            final String rec = m.group();
            final Matcher t = Pattern.compile("\"type\"\\s*:\\s*(\\d+)").matcher(rec), d = Pattern.compile("\"data\"\\s*:\\s*\"([0-9a-fA-F:.]{2,45})\"").matcher(rec);
            if (!t.find() || !d.find() || Integer.parseInt(t.group(1)) != type) continue;
            final InetAddress a = literal(d.group(1));
            if (a != null && (type == 1) == (a instanceof java.net.Inet4Address) && isPublic(a)) out.add(a);
        }
        return out;
    }

    /** An IP literal only (never a lookup), else null. */
    static InetAddress literal(String s) {
        if (s == null || !(s.matches("^[0-9]{1,3}(\\.[0-9]{1,3}){3}$") || (s.contains(":") && s.matches("^[0-9a-fA-F:.]{2,45}$")))) return null;
        try { return InetAddress.getByName(s); } catch (UnknownHostException e) { return null; }
    }

    static boolean isPublic(InetAddress a) {
        return !(a.isAnyLocalAddress() || a.isLoopbackAddress() || a.isLinkLocalAddress() || a.isSiteLocalAddress() || a.isMulticastAddress()
            || (a.getAddress().length == 16 && (a.getAddress()[0] & 0xfe) == 0xfc));
    }

    private static String readAll(InputStream in) throws IOException {
        final ByteArrayOutputStream b = new ByteArrayOutputStream();
        final byte[] buf = new byte[4096];
        int n;
        while ((n = in.read(buf)) > 0) {
            b.write(buf, 0, n);
            if (b.size() > MAX_BODY) throw new IOException("DoH answer too large");
        }
        return b.toString(StandardCharsets.UTF_8);
    }
}
