#define _GNU_SOURCE
#include "shielded-wire.h"

#include <errno.h>
#include <linux/vm_sockets.h>
#include <netdb.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/uio.h>
#include <limits.h>
#include <time.h>
#include <unistd.h>

/* A single frame is capped well below the point where a bad length header could
 * make us allocate the machine. Mirrors wire.py's MAX_FRAME. */
#define SH_MAX_FRAME ((size_t)256 << 20)
#define SH_HDR 9

struct sh_pipe {
    int  fd;
    char err[256];
    /* The reply buffer: grows to the largest reply ever seen, never shrinks,
     * and is reused by every exchange. Before this each decode exchange paid a
     * malloc and a free of the reply (608 KB for one lm_head row of the 0.5B)
     * on the request path. */
    uint8_t *rbuf;
    size_t   rcap;
};

/* Frames per exchange that fit the stack-resident iovec/header arrays. Every
 * production exchange is one frame; the pipelined batches of the older
 * protocol were three. Beyond this the arrays are malloc'd. */
#define SH_STACK_FRAMES 16

static int reply_reserve(sh_pipe *p, size_t want) {
    if (p->rcap >= want) return SH_OK;
    size_t cap = p->rcap ? p->rcap : 4096;
    while (cap < want) cap *= 2;
    uint8_t *nb = (uint8_t *)realloc(p->rbuf, cap);
    if (!nb) return SH_ERR_NOMEM;
    p->rbuf = nb; p->rcap = cap;
    return SH_OK;
}

static void put_u32(uint8_t *p, uint32_t v) {
    p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); p[2] = (uint8_t)(v >> 16); p[3] = (uint8_t)(v >> 24);
}
static void put_u64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) p[i] = (uint8_t)(v >> (8 * i));
}
static uint64_t get_u64(const uint8_t *p) {
    uint64_t v = 0;
    for (int i = 0; i < 8; i++) v |= (uint64_t)p[i] << (8 * i);
    return v;
}

size_t sh_pack_hello(void *dst, uint32_t major) {
    put_u32((uint8_t *)dst, major); return 4;
}
size_t sh_pack_alloc(void *dst, uint64_t size, const char *role) {
    uint8_t *p = (uint8_t *)dst; size_t n = strlen(role);
    put_u64(p, size); put_u32(p + 8, (uint32_t)n); memcpy(p + 12, role, n);
    return 12 + n;
}
size_t sh_pack_region(void *dst, uint64_t bid, uint64_t offset, uint64_t nbytes) {
    uint8_t *p = (uint8_t *)dst;
    put_u64(p, bid); put_u64(p + 8, offset); put_u64(p + 16, nbytes);
    return 24;
}
size_t sh_pack_set_tensor_header(void *dst, uint64_t bid, uint64_t offset, uint64_t nbytes) {
    return sh_pack_region(dst, bid, offset, nbytes);
}
size_t sh_pack_recompute(void *dst, uint32_t node, uint32_t m) {
    uint8_t *p = (uint8_t *)dst; put_u32(p, node); put_u32(p + 4, m); return 8;
}
size_t sh_pack_field_gemm(void *dst, uint32_t n_nodes, uint32_t m, const int *nodes) {
    uint8_t *p = (uint8_t *)dst; put_u32(p, n_nodes); put_u32(p + 4, m);
    for (uint32_t i = 0; i < n_nodes; i++) put_u32(p + 8 + 4 * i, (uint32_t)nodes[i]);
    return 8 + 4 * (size_t)n_nodes;
}

const char *sh_pipe_last_error(const sh_pipe *p) { return p ? p->err : ""; }

sh_pipe *sh_pipe_open(const char *host, int port, int *err) {
    if (err) *err = SH_OK;
    /* "vsock" or "vsock:<cid>": AF_VSOCK to the host (CID 2 unless told
     * otherwise). A vsock round trip is a small fraction of slirp's, and at
     * ~50 exchanges per token that fraction is most of the decode budget. */
    if (!strncmp(host, "vsock", 5)) {
        int fd = socket(AF_VSOCK, SOCK_STREAM, 0);
        if (fd < 0) { if (err) *err = SH_ERR_IO; return NULL; }
        struct sockaddr_vm vm; memset(&vm, 0, sizeof vm);
        vm.svm_family = AF_VSOCK;
        vm.svm_cid = host[5] == ':' ? (unsigned)atoi(host + 6) : VMADDR_CID_HOST;
        vm.svm_port = (unsigned)port;
        if (connect(fd, (struct sockaddr *)&vm, sizeof vm) != 0) { close(fd); if (err) *err = SH_ERR_IO; return NULL; }
        sh_pipe *p = (sh_pipe *)calloc(1, sizeof *p);
        if (!p) { close(fd); if (err) *err = SH_ERR_NOMEM; return NULL; }
        p->fd = fd;
        return p;
    }
    char portstr[16]; snprintf(portstr, sizeof portstr, "%d", port);
    struct addrinfo hints, *res = NULL;
    memset(&hints, 0, sizeof hints);
    hints.ai_family = AF_UNSPEC; hints.ai_socktype = SOCK_STREAM;
    if (getaddrinfo(host, portstr, &hints, &res) != 0) { if (err) *err = SH_ERR_IO; return NULL; }
    int fd = -1;
    for (struct addrinfo *a = res; a; a = a->ai_next) {
        fd = socket(a->ai_family, a->ai_socktype, a->ai_protocol);
        if (fd < 0) continue;
        if (connect(fd, a->ai_addr, a->ai_addrlen) == 0) break;
        close(fd); fd = -1;
    }
    freeaddrinfo(res);
    if (fd < 0) { if (err) *err = SH_ERR_IO; return NULL; }
    /* Mandatory, not an optimisation: without it Nagle holds the small SET_TENSOR
     * frame waiting for an ACK that the pipelined GET_TENSOR is itself waiting on,
     * and the exchange stalls for a full delayed-ACK timer. */
    int one = 1;
    setsockopt(fd, IPPROTO_TCP, TCP_NODELAY, &one, sizeof one);
    sh_pipe *p = (sh_pipe *)calloc(1, sizeof *p);
    if (!p) { close(fd); if (err) *err = SH_ERR_NOMEM; return NULL; }
    p->fd = fd;
    return p;
}

void sh_pipe_close(sh_pipe *p) {
    if (!p) return;
    if (p->fd >= 0) close(p->fd);
    free(p->rbuf);
    free(p);
}

/* Not every libc exposes IOV_MAX; POSIX guarantees at least 16. */
#ifndef IOV_MAX
#define IOV_MAX 1024
#endif

static int write_all(int fd, struct iovec *iov, int iovcnt) {
    while (iovcnt > 0) {
        ssize_t n = writev(fd, iov, iovcnt > IOV_MAX ? IOV_MAX : iovcnt);
        if (n < 0) { if (errno == EINTR) continue; return SH_ERR_IO; }
        while (iovcnt > 0 && (size_t)n >= iov->iov_len) { n -= (ssize_t)iov->iov_len; iov++; iovcnt--; }
        if (iovcnt > 0 && n > 0) {
            iov->iov_base = (char *)iov->iov_base + n;
            iov->iov_len -= (size_t)n;
        }
    }
    return SH_OK;
}

/* How long a reply read spins before it blocks, in microseconds.
 *
 * Inside a CVM a blocking read is a vCPU halt, and getting the thread back is
 * an interrupt injected into an SEV-SNP guest plus the VM exits around it --
 * tens of microseconds each way, paid 49 times per token, and the term that
 * the host-loopback measurements never see. The reply to a decode exchange
 * arrives ~50-150 us after the request went out, so a bounded spin on a
 * non-blocking receive catches almost every reply with the vCPU still
 * running; a long one (lm_head, a cold worker) falls through to the blocking
 * read after the budget. Costs one core for the spin, which this thread was
 * spending in the halt anyway.
 *
 * OFF by default: it is an in-guest experiment, not a measured win. On the
 * host it is a wash over TCP (-2 us) and a LOSS over vsock loopback (+10 to
 * +24 us: the spinner starves the loopback transport's kernel worker on its
 * own CPU), and the guest, where it should pay, is exactly where it has not
 * been measured. Set SHIELDED_SPIN_US in the tenant's environment to try it. */
static int spin_us(void) {
    static int v = -1;
    if (v < 0) { const char *e = getenv("SHIELDED_SPIN_US"); v = (e && *e) ? atoi(e) : 0; if (v < 0) v = 0; }
    return v;
}

static int read_all(int fd, void *buf, size_t n) {
    uint8_t *p = (uint8_t *)buf;
    const int budget = spin_us();
    if (budget > 0) {
        struct timespec t0, t1; clock_gettime(CLOCK_MONOTONIC, &t0);
        for (int spins = 0; n; spins++) {
            ssize_t r = recv(fd, p, n, MSG_DONTWAIT);
            if (r > 0) { p += r; n -= (size_t)r; continue; }
            if (r == 0) return SH_ERR_IO;
            if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) return SH_ERR_IO;
            if ((spins & 63) == 63) {
                clock_gettime(CLOCK_MONOTONIC, &t1);
                if ((t1.tv_sec - t0.tv_sec) * 1000000L + (t1.tv_nsec - t0.tv_nsec) / 1000L > budget) break;
            }
        }
    }
    while (n) {
        ssize_t r = read(fd, p, n);
        if (r < 0) { if (errno == EINTR) continue; return SH_ERR_IO; }
        if (r == 0) return SH_ERR_IO;             /* peer closed mid-frame */
        p += r; n -= (size_t)r;
    }
    return SH_OK;
}

void sh_reply_free(sh_reply *r) {
    /* The bytes live in the pipe's buffer; only the view is cleared. */
    if (!r) return;
    r->data = NULL; r->len = 0;
}

int sh_pipe_exchange(sh_pipe *p, const sh_frame *frames, size_t n, sh_reply *out) {
    if (!p || p->fd < 0) return SH_ERR_IO;
    memset(out, 0, n * sizeof *out);

    /* One writev for every frame: 3 iovecs per frame (header, payload, payload2).
     * On the stack: a decode exchange is one frame, and two mallocs per
     * exchange are measurable against a ~60 us round trip. */
    struct iovec  iov_stack[3 * SH_STACK_FRAMES];
    uint8_t       hdr_stack[SH_HDR * SH_STACK_FRAMES];
    struct iovec *iov  = iov_stack;
    uint8_t      *hdrs = hdr_stack;
    if (n > SH_STACK_FRAMES) {
        iov  = (struct iovec *)malloc(3 * n * sizeof *iov);
        hdrs = (uint8_t *)malloc(n * SH_HDR);
        if (!iov || !hdrs) { free(iov); free(hdrs); return SH_ERR_NOMEM; }
    }
    int iovcnt = 0;
    for (size_t i = 0; i < n; i++) {
        size_t total = frames[i].len + frames[i].len2;
        uint8_t *h = hdrs + i * SH_HDR;
        h[0] = frames[i].cmd;
        put_u64(h + 1, total);
        iov[iovcnt].iov_base = h; iov[iovcnt].iov_len = SH_HDR; iovcnt++;
        if (frames[i].len) {
            iov[iovcnt].iov_base = (void *)frames[i].payload;
            iov[iovcnt].iov_len  = frames[i].len; iovcnt++;
        }
        if (frames[i].len2) {
            iov[iovcnt].iov_base = (void *)frames[i].payload2;
            iov[iovcnt].iov_len  = frames[i].len2; iovcnt++;
        }
    }
    int rc = write_all(p->fd, iov, iovcnt);
    if (n > SH_STACK_FRAMES) { free(iov); free(hdrs); }
    if (rc != SH_OK) { snprintf(p->err, sizeof p->err, "write failed: %s", strerror(errno)); return rc; }

    /* Replies land back to back in the pipe's buffer. Growing it can move the
     * earlier ones, so pointers are assigned once the whole batch is in. */
    size_t used = 0;
    for (size_t i = 0; i < n; i++) {
        uint8_t h[SH_HDR];
        if ((rc = read_all(p->fd, h, SH_HDR)) != SH_OK) {
            snprintf(p->err, sizeof p->err, "short response header at frame %zu", i);
            goto fail;
        }
        uint64_t size = get_u64(h + 1);
        if (size > SH_MAX_FRAME) {
            snprintf(p->err, sizeof p->err, "response frame %llu exceeds cap", (unsigned long long)size);
            rc = SH_ERR_PROTO; goto fail;
        }
        if (size && (rc = reply_reserve(p, used + (size_t)size)) != SH_OK) goto fail;
        out[i].status = h[0];
        out[i].len = (size_t)size;
        if (size && (rc = read_all(p->fd, p->rbuf + used, (size_t)size)) != SH_OK) {
            snprintf(p->err, sizeof p->err, "short response body at frame %zu", i);
            goto fail;
        }
        if (out[i].status != 0) {
            /* A violation is always the last frame: the worker closes after it.
             * Surface the reason verbatim -- it names the node and the op, which
             * is the difference between a five-minute fix and an afternoon. */
            int m = (int)(out[i].len < sizeof p->err - 1 ? out[i].len : sizeof p->err - 1);
            memcpy(p->err, p->rbuf + used, (size_t)m); p->err[m] = 0;
            rc = SH_ERR_VIOLATION; goto fail;
        }
        used += (size_t)size;
    }
    used = 0;
    for (size_t i = 0; i < n; i++) { out[i].data = out[i].len ? p->rbuf + used : NULL; used += out[i].len; }
    return SH_OK;
fail:
    for (size_t i = 0; i < n; i++) sh_reply_free(&out[i]);
    return rc;
}

int sh_pipe_call(sh_pipe *p, uint8_t cmd, const void *payload, size_t len, sh_reply *out) {
    sh_frame f = { cmd, payload, len, NULL, 0 };
    return sh_pipe_exchange(p, &f, 1, out);
}
