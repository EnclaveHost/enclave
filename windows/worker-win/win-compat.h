/* win-compat.h -- POSIX socket names over Winsock, so worker.cu does not change.
 *
 * THE POINT OF THIS FILE IS THAT IT IS THE ONLY FILE.
 *
 * shielded/worker-cuda/worker.cu holds the admission rules: the op allowlist
 * ({FIELD_GEMM, VIEW, RESHAPE, PERMUTE, TRANSPOSE, CONT, CPY}), the named
 * refusal for everything else, the reservation accounting, and the framing the
 * CVM's boot probe asserts against. Those rules are the reason a card can be
 * sold from a machine nobody attested, and a Windows build that drifted from
 * the Linux one on any of them would be a different security artifact wearing
 * the same name. So the port is a compatibility header plus a build file, and
 * worker.cu is compiled unmodified.
 *
 * Consequence worth stating: if a future change to worker.cu needs a POSIX call
 * that is not shimmed here, add it HERE. Do not add an #ifdef _WIN32 to
 * worker.cu.
 *
 * ---------------------------------------------------------------------------
 * What the worker uses, and what each maps to
 *
 *   read() / write() on a socket -> recv() / send()
 *       Windows SOCKETs are not file descriptors, so the CRT's read/write will
 *       not accept them. This is the one mapping that compiles cleanly on a
 *       naive port and then fails at run time.
 *   recv(..., MSG_DONTWAIT)      -> non-blocking socket + recv()
 *       Winsock has no MSG_DONTWAIT. Sockets are switched to non-blocking at
 *       accept, so the flag becomes an accurate no-op and the caller's meaning
 *       is preserved: read_exact()'s spin loop and the shm header poll both
 *       treat EAGAIN as "nothing yet, keep spinning".
 *   writev(fd, iov, 2)           -> WSASend() with two WSABUFs
 *       A real scatter-gather send, not two calls: header and body are one
 *       exchange, and splitting them would add a packet per reply at ~49
 *       exchanges per decoded token.
 *   poll()                       -> WSAPoll()   (signature-compatible, Vista+)
 *   close()                      -> closesocket()
 *   errno                        -> set from WSAGetLastError()
 *       The wrappers store into the CRT errno on failure, so worker.cu's
 *       `errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR` tests and
 *       its strerror() logging keep working verbatim.
 *
 * NOT ported, deliberately:
 *
 *   AF_VSOCK    Linux-only. The Windows host side of the same link is
 *               AF_HYPERV, addressed by a (VmId, ServiceId) GUID pair rather
 *               than (cid, port) -- a different addressing model, not a rename,
 *               so it is a separate listener rather than a shim. The GUEST
 *               keeps using AF_VSOCK: Linux carries an hv_sock transport that
 *               backs AF_VSOCK over Hyper-V's VMBus, so
 *               wasm/ggml-shielded/shielded-wire.c needs no change at all.
 *   --shm ring  The shared-memory ring is the ivshmem backing store of a QEMU
 *               CVM. There is no ivshmem under Hyper-V, so that path compiles
 *               out; the TCP and AF_HYPERV listeners remain.
 */
#ifndef SHIELDED_WIN_COMPAT_H
#define SHIELDED_WIN_COMPAT_H

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX          /* <windows.h> min/max macros break std::min/std::max */
#endif

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <errno.h>
#include <stdlib.h>
#include <string.h>
#include <stddef.h>

#pragma comment(lib, "ws2_32.lib")

/* ------------------------------------------------------------------------ */
/* errno bridging                                                           */
/*                                                                          */
/* Winsock reports through WSAGetLastError(), not errno. Rather than teach   */
/* worker.cu about that, every wrapper translates and stores into the CRT    */
/* errno on failure, so existing EAGAIN/EWOULDBLOCK/EINTR tests behave as    */
/* they do on Linux.                                                        */
/* ------------------------------------------------------------------------ */
static inline int sh_win_translate(int wsaErr) {
    switch (wsaErr) {
        case WSAEWOULDBLOCK:   return EAGAIN;
        case WSAEINTR:         return EINTR;
        case WSAECONNRESET:    return ECONNRESET;
        case WSAECONNABORTED:  return ECONNABORTED;
        case WSAENOTCONN:      return ENOTCONN;
        case WSAENOBUFS:       return ENOBUFS;
        case WSAEADDRINUSE:    return EADDRINUSE;
        case WSAEACCES:        return EACCES;
        case WSAEINVAL:        return EINVAL;
        case WSAEMFILE:        return EMFILE;
        case WSAETIMEDOUT:     return ETIMEDOUT;
        case WSAEAFNOSUPPORT:  return EAFNOSUPPORT;
        case 0:                return 0;
        default:               return EIO;
    }
}
static inline void sh_win_seterr(void) { _set_errno(sh_win_translate(WSAGetLastError())); }

/* One-time Winsock init; WSAStartup refcounts, so repeat calls are safe. */
static inline int sh_win_startup(void) {
    WSADATA wsa;
    if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) { _set_errno(EIO); return -1; }
    return 0;
}
#define SH_WIN_STARTUP() sh_win_startup()

/* ------------------------------------------------------------------------ */
/* iovec + the socket calls                                                 */
/* ------------------------------------------------------------------------ */
struct iovec { void *iov_base; size_t iov_len; };

#ifndef MSG_DONTWAIT
#define MSG_DONTWAIT 0        /* accurate: sockets are non-blocking already */
#endif

static inline int sh_win_set_nonblocking(int fd, int on) {
    u_long mode = on ? 1u : 0u;
    if (ioctlsocket((SOCKET)fd, FIONBIO, &mode) == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return 0;
}

static inline int sh_win_close(int fd) {
    if (closesocket((SOCKET)fd) == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return 0;
}

static inline ptrdiff_t sh_win_read(int fd, void *buf, size_t n) {
    int r = recv((SOCKET)fd, (char *)buf, (int)n, 0);
    if (r == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return r;
}
static inline ptrdiff_t sh_win_write(int fd, const void *buf, size_t n) {
    int r = send((SOCKET)fd, (const char *)buf, (int)n, 0);
    if (r == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return r;
}
static inline ptrdiff_t sh_win_recv(int fd, void *buf, size_t n, int flags) {
    int r = recv((SOCKET)fd, (char *)buf, (int)n, flags & ~MSG_DONTWAIT);
    if (r == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return r;
}

/* Header + body in ONE send. worker.cu already falls back to plain writes for
 * a short count, so a partial WSASend is handled exactly as on Linux. */
static inline ptrdiff_t sh_win_writev(int fd, const struct iovec *iov, int cnt) {
    WSABUF bufs[8];
    if (cnt < 0 || cnt > (int)(sizeof bufs / sizeof bufs[0])) { _set_errno(EINVAL); return -1; }
    for (int i = 0; i < cnt; i++) {
        bufs[i].buf = (CHAR *)iov[i].iov_base;
        bufs[i].len = (ULONG)iov[i].iov_len;
    }
    DWORD sent = 0;
    if (WSASend((SOCKET)fd, bufs, (DWORD)cnt, &sent, 0, NULL, NULL) == SOCKET_ERROR) {
        sh_win_seterr();
        return -1;
    }
    return (ptrdiff_t)sent;
}

static inline int sh_win_poll(struct pollfd *fds, unsigned long nfds, int timeout) {
    int r = WSAPoll((LPWSAPOLLFD)fds, (ULONG)nfds, timeout);
    if (r == SOCKET_ERROR) { sh_win_seterr(); return -1; }
    return r;
}

#define read(fd, buf, n)          sh_win_read((fd), (buf), (n))
#define write(fd, buf, n)         sh_win_write((fd), (buf), (n))
#define recv(fd, buf, n, flags)   sh_win_recv((fd), (buf), (n), (flags))
#define writev(fd, iov, cnt)      sh_win_writev((fd), (iov), (cnt))
#define poll(fds, nfds, timeout)  sh_win_poll((fds), (nfds), (timeout))
#define close(fd)                 sh_win_close((fd))

#ifndef _SSIZE_T_DEFINED
typedef ptrdiff_t ssize_t;
#define _SSIZE_T_DEFINED
#endif

/* ------------------------------------------------------------------------ */
/* AF_HYPERV: the host side of the guest's AF_VSOCK link.                   */
/*                                                                          */
/* A Linux guest on Hyper-V reaches the host with ordinary AF_VSOCK, backed  */
/* by the in-kernel hv_sock transport over VMBus -- so the guest half of the */
/* shielded wire is unchanged. The HOST half is AF_HYPERV, addressed by a    */
/* (VmId, ServiceId) GUID pair rather than (cid, port).                      */
/*                                                                          */
/* ServiceId convention: Hyper-V derives a service GUID from a port number   */
/* by substituting the port into the first field of the VSOCK template GUID, */
/* so a guest connecting to vsock port 9500 arrives at ServiceId             */
/* 0000251c-facb-11e6-bd58-64006a7986d3. A wildcard VmId accepts a           */
/* connection from any VM on this host.                                     */
/* ------------------------------------------------------------------------ */
#ifndef AF_HYPERV
#define AF_HYPERV 34
#endif
#ifndef HV_PROTOCOL_RAW
#define HV_PROTOCOL_RAW 1
#endif

typedef struct sh_sockaddr_hv {
    ADDRESS_FAMILY Family;
    USHORT         Reserved;
    GUID           VmId;
    GUID           ServiceId;
} SH_SOCKADDR_HV;

static inline GUID sh_hv_service_id(unsigned port) {
    GUID g = { 0x00000000, 0xfacb, 0x11e6, { 0xbd, 0x58, 0x64, 0x00, 0x6a, 0x79, 0x86, 0xd3 } };
    g.Data1 = (unsigned long)port;
    return g;
}
static inline GUID sh_hv_wildcard(void) {
    GUID g = { 0x00000000, 0x0000, 0x0000, { 0, 0, 0, 0, 0, 0, 0, 0 } };
    return g;
}

#else  /* !_WIN32 */
#define SH_WIN_STARTUP() (0)
#endif /* _WIN32 */

#endif /* SHIELDED_WIN_COMPAT_H */
