/* ee-net-host.c -- the broker's API, implemented with plain Winsock, for the VTL0 harness.
 *
 * Inside the enclave these eight functions are call-outs (windows/enclave-engine/ee-app.cpp): the
 * host owns every socket and the enclave asks it to act. Out here the harness IS the host, so they
 * are the sockets themselves. Same signatures, same semantics - including the ones that matter for
 * a guest: a listener is loopback-only, accept and recv are non-blocking and answer -EAGAIN, and
 * poll is where a guest actually waits.
 *
 * Keeping this file beside the enclave version is what makes the harness worth having: an app that
 * works here and fails in VTL1 has an ENCLAVE problem, not a socket problem.
 */
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <winsock2.h>
#include <ws2tcpip.h>

#define EE_MAX_SOCK 256
static SOCKET g_net[EE_MAX_SOCK];
static int g_wsa;

static void net_start(void) { if (!g_wsa) { WSADATA w; WSAStartup(MAKEWORD(2, 2), &w); g_wsa = 1; } }
static int net_slot(SOCKET s) {
    for (int i = 1; i < EE_MAX_SOCK; i++) if (g_net[i] == 0) { g_net[i] = s; return i; }
    closesocket(s); return -24;
}
static int net_err(void) {
    /* Same table as the enclave host's (windows/enclave-engine/ee-host.c wsa_errno), negated.
     * WSAEWOULDBLOCK -> -EAGAIN is the one that matters: a guest must be able to tell "no data
     * yet" from a failure, or a non-blocking app drops the connection it was about to answer. */
    switch (WSAGetLastError()) {
    case WSAEWOULDBLOCK: return -11; case WSAEINPROGRESS: return -115;
    case WSAECONNREFUSED: return -111; case WSAETIMEDOUT: return -110;
    case WSAECONNRESET: return -104; case WSAECONNABORTED: return -103;
    case WSAENOTCONN: return -107; case WSAEHOSTUNREACH: return -113;
    case WSAENETUNREACH: return -101; case WSAEADDRINUSE: return -98; case WSAEMFILE: return -24;
    default: return -5; }
}

int ee_net_listen(uint16_t port, uint16_t *bound) {
    net_start();
    SOCKET ls = socket(AF_INET, SOCK_STREAM, 0);
    if (ls == INVALID_SOCKET) return net_err();
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_addr.s_addr = htonl(INADDR_LOOPBACK); a.sin_port = htons(port);
    /* Exclusive, mirroring the enclave host (ee-host.c EE_OP_LISTEN): a tenant's port is one app's,
     * so a second bind to it fails rather than silently sharing. */
    BOOL one = TRUE; setsockopt(ls, SOL_SOCKET, SO_EXCLUSIVEADDRUSE, (const char *)&one, sizeof one);
    if (bind(ls, (struct sockaddr *)&a, sizeof a) || listen(ls, 64)) { int e = net_err(); closesocket(ls); return e; }
    int alen = sizeof a;
    if (getsockname(ls, (struct sockaddr *)&a, &alen) == 0 && bound) *bound = ntohs(a.sin_port);
    u_long nb = 1; ioctlsocket(ls, FIONBIO, &nb);
    const int h = net_slot(ls);
    if (h > 0) fprintf(stderr, "[harness] app listening on 127.0.0.1:%u (handle %d)\n", bound ? *bound : port, h);
    return h;
}
int ee_net_accept(int h) {
    if (h <= 0 || h >= EE_MAX_SOCK || !g_net[h]) return -9;
    SOCKET cs = accept(g_net[h], NULL, NULL);
    if (cs == INVALID_SOCKET) return net_err();
    BOOL one = TRUE; setsockopt(cs, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
    u_long nb = 1; ioctlsocket(cs, FIONBIO, &nb);
    return net_slot(cs);
}
int ee_net_connect(const char *addr, uint16_t port) {
    net_start();
    char p[16]; snprintf(p, sizeof p, "%u", port);
    struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(addr, p, &hints, &res)) return -113;
    SOCKET s = INVALID_SOCKET;
    for (struct addrinfo *a = res; a; a = a->ai_next) {
        s = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (s == INVALID_SOCKET) continue;
        if (connect(s, a->ai_addr, (int)a->ai_addrlen) == 0) break;
        closesocket(s); s = INVALID_SOCKET;
    }
    freeaddrinfo(res);
    if (s == INVALID_SOCKET) return net_err();
    BOOL one = TRUE; setsockopt(s, IPPROTO_TCP, TCP_NODELAY, (const char *)&one, sizeof one);
    u_long nb = 1; ioctlsocket(s, FIONBIO, &nb);
    return net_slot(s);
}
int64_t ee_net_send(int h, const uint8_t *p, size_t n) {
    if (h <= 0 || h >= EE_MAX_SOCK || !g_net[h]) return -9;
    size_t done = 0;
    while (done < n) {
        const int r = send(g_net[h], (const char *)p + done, (int)(n - done), 0);
        if (r <= 0) {
            const int e = net_err();
            if (e == -11 && done) break;                 /* partial: the guest retries the rest */
            if (e == -11) {
                /* The send buffer is full and the guest has no partial-write answer: wait for
                 * writability rather than fail a write it cannot resume. */
                fd_set wr; FD_ZERO(&wr); FD_SET(g_net[h], &wr);
                struct timeval tv = { 5, 0 };
                if (select(0, NULL, &wr, NULL, &tv) > 0) continue;
            }
            return done ? (int64_t)done : e;
        }
        done += (size_t)r;
    }
    return (int64_t)done;
}
int64_t ee_net_recv(int h, uint8_t *p, size_t n) {
    if (h <= 0 || h >= EE_MAX_SOCK || !g_net[h]) return -9;
    const int r = recv(g_net[h], (char *)p, (int)n, 0);
    return r < 0 ? net_err() : r;
}
void ee_net_close(int h) {
    if (h > 0 && h < EE_MAX_SOCK && g_net[h]) { closesocket(g_net[h]); g_net[h] = 0; }
}
int ee_net_poll(uint32_t *handles, uint32_t *events, size_t n, uint32_t timeout_ms) {
    if (!n || n > 64) return -22;
    fd_set rd, wr; FD_ZERO(&rd); FD_ZERO(&wr);
    for (size_t i = 0; i < n; i++) {
        const uint32_t h = handles[i];
        if (h == 0 || h >= EE_MAX_SOCK || !g_net[h]) continue;
        if (events[i] & 1u) FD_SET(g_net[h], &rd);
        if (events[i] & 2u) FD_SET(g_net[h], &wr);
    }
    struct timeval tv; tv.tv_sec = (long)(timeout_ms / 1000); tv.tv_usec = (long)((timeout_ms % 1000) * 1000);
    const int r = select(0, &rd, &wr, NULL, timeout_ms == 0xFFFFFFFFu ? NULL : &tv);
    if (r < 0) return net_err();
    int ready = 0;
    for (size_t i = 0; i < n; i++) {
        const uint32_t h = handles[i];
        uint32_t got = 0;
        if (h && h < EE_MAX_SOCK && g_net[h]) {
            if (FD_ISSET(g_net[h], &rd)) got |= 1u;
            if (FD_ISSET(g_net[h], &wr)) got |= 2u;
        }
        events[i] = got;
        if (got) ready++;
    }
    return ready;
}
int ee_net_resolve(const char *name, char *out, size_t cap) {
    net_start();
    struct addrinfo hints, *res = NULL; memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(name, NULL, &hints, &res)) return -113;
    size_t off = 0;
    for (struct addrinfo *a = res; a && off + 64 < cap; a = a->ai_next) {
        char txt[64] = { 0 };
        if (a->ai_family == AF_INET) InetNtopA(AF_INET, &((struct sockaddr_in *)a->ai_addr)->sin_addr, txt, sizeof txt);
        else if (a->ai_family == AF_INET6) InetNtopA(AF_INET6, &((struct sockaddr_in6 *)a->ai_addr)->sin6_addr, txt, sizeof txt);
        else continue;
        const size_t k = strlen(txt);
        memcpy(out + off, txt, k); off += k; out[off++] = '\n';
    }
    freeaddrinfo(res);
    return (int)off;
}

/* The enclave's sleep, for the harness: in VTL1 this is ee-rt.c's, which the app runtime uses to
 * idle an event loop between polls instead of spinning. */
void ee_sleep_ms(uint32_t ms) { Sleep(ms); }
