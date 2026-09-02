/* worker-client.c -- see worker-client.h. */
#include "worker-client.h"
#include "shielded-field.h"

#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define WC_ALIGN 64
static int64_t align_up(int64_t x) { return (x + WC_ALIGN - 1) & ~(int64_t)(WC_ALIGN - 1); }

int wc_add(wc_client *c, int64_t K, int64_t N) {
    if (!c || c->n_nodes == WC_MAX_NODES || K <= 0 || N <= 0) return SH_ERR_PROTO;
    if (K % SH_QK != 0 || K % 16 != 0) {
        snprintf(c->err, sizeof c->err, "K=%lld not a multiple of %d", (long long)K, SH_QK);
        return SH_ERR_PROTO;
    }
    wc_node *n = &c->nodes[c->n_nodes];
    n->K = K; n->N = N;
    n->w_off = align_up(c->wbytes);
    c->wbytes = n->w_off + K * N;
    n->x_off = align_up(c->abytes);
    n->y_off = align_up(n->x_off + 3 * K);            /* max_m = 1 */
    c->abytes = n->y_off + N * 4;
    return c->n_nodes++;
}

static int json_append(char **buf, size_t *len, size_t *cap, const char *fmt, ...) {
    va_list ap; va_start(ap, fmt);
    for (;;) {
        size_t avail = *cap - *len;
        va_list cp; va_copy(cp, ap);
        int n = vsnprintf(*buf + *len, avail, fmt, cp);
        va_end(cp);
        if (n < 0) { va_end(ap); return SH_ERR_NOMEM; }
        if ((size_t)n < avail) { *len += (size_t)n; va_end(ap); return SH_OK; }
        size_t ncap = (*cap ? *cap : 1024) * 2;
        while (ncap < *len + (size_t)n + 1) ncap *= 2;
        char *nb = (char *)realloc(*buf, ncap);
        if (!nb) { va_end(ap); return SH_ERR_NOMEM; }
        *buf = nb; *cap = ncap;
    }
}

int wc_connect_install(wc_client *c, const char *host, int port,
                       const int8_t *const *w, int force32) {
    int err = SH_OK;
    sh_pipe *pipe = sh_pipe_open(host, port, &err);
    if (!pipe) { snprintf(c->err, sizeof c->err, "connect %s:%d failed", host, port); return err; }
    return wc_install(c, pipe, w, force32);
}

/* Install over a pipe the caller already holds: inside a protected VM the
 * worker socket is ACCEPTED (the owner connects in), so there is no dial. */
int wc_install(wc_client *c, sh_pipe *pipe, const int8_t *const *w, int force32) {
    int rc;
    uint8_t pay[256]; sh_reply rep;
    c->pipe = pipe;

    size_t n = sh_pack_hello(pay, 1, 0);
    rc = sh_pipe_call(c->pipe, SH_CMD_HELLO, pay, n, &rep);
    if (rc != SH_OK) { snprintf(c->err, sizeof c->err, "HELLO: %s", sh_pipe_last_error(c->pipe)); return rc; }
    {
        char hello[1024] = { 0 };
        int major = -1, minor = -1;
        if (rep.data) snprintf(hello, sizeof hello, "%.*s",
                               (int)(rep.len < sizeof hello - 1 ? rep.len : sizeof hello - 1),
                               (const char *)rep.data);
        const char *p = strstr(hello, "\"version\"");
        if (p) {
            p += 9;
            while (*p && (*p < '0' || *p > '9')) p++;
            major = atoi(p);
            while (*p >= '0' && *p <= '9') p++;
            while (*p && (*p < '0' || *p > '9')) p++;
            minor = atoi(p);
        }
        sh_reply_free(&rep);
        if (major != 1 || minor < 1) {
            snprintf(c->err, sizeof c->err, "worker speaks %d.%d, need 1.1", major, minor);
            return SH_ERR_PROTO;
        }
        c->ywidth = (minor >= 2 && !force32) ? 3 : 4;
    }

    const struct { int64_t size; const char *role; } bufs[2] = {
        { c->wbytes, "weights" }, { c->abytes, "activations" } };
    for (int i = 0; i < 2; i++) {
        n = sh_pack_alloc(pay, (uint64_t)bufs[i].size, bufs[i].role);
        rc = sh_pipe_call(c->pipe, SH_CMD_ALLOC_BUFFER, pay, n, &rep);
        if (rc != SH_OK) { snprintf(c->err, sizeof c->err, "ALLOC(%s): %s", bufs[i].role, sh_pipe_last_error(c->pipe)); return rc; }
        sh_reply_free(&rep);
    }

    for (int i = 0; i < c->n_nodes; i++) {
        const wc_node *nd = &c->nodes[i];
        const size_t bytes = (size_t)(nd->K * nd->N);
        const size_t CHUNK = 32u << 20;
        for (size_t off = 0; off < bytes; off += CHUNK) {
            size_t part = bytes - off < CHUNK ? bytes - off : CHUNK;
            uint8_t hdr[24];
            sh_pack_set_tensor_header(hdr, 1, (uint64_t)(nd->w_off + (int64_t)off), part);
            sh_frame f = { SH_CMD_SET_TENSOR, hdr, 24, (const uint8_t *)w[i] + off, part };
            rc = sh_pipe_exchange(c->pipe, &f, 1, &rep);
            if (rc != SH_OK) { snprintf(c->err, sizeof c->err, "upload node %d: %s", i, sh_pipe_last_error(c->pipe)); return rc; }
            sh_reply_free(&rep);
        }
    }

    char *js = NULL; size_t jl = 0, jc = 0;
    json_append(&js, &jl, &jc, "{\"nodes\":[");
    for (int i = 0; i < c->n_nodes; i++) {
        const wc_node *nd = &c->nodes[i];
        json_append(&js, &jl, &jc,
            "%s{\"op\":\"FIELD_GEMM\",\"id\":\"anchor%d\",\"w\":{\"bid\":1,\"offset\":%lld},"
            "\"x\":{\"bid\":2,\"offset\":%lld},\"y\":{\"bid\":2,\"offset\":%lld},"
            "\"K\":%lld,\"N\":%lld,\"max_m\":1}",
            i ? "," : "", i, (long long)nd->w_off,
            (long long)nd->x_off, (long long)nd->y_off,
            (long long)nd->K, (long long)nd->N);
    }
    json_append(&js, &jl, &jc, "],\"outputs\":[");
    for (int i = 0; i < c->n_nodes; i++)
        json_append(&js, &jl, &jc, "%s{\"bid\":2,\"offset\":%lld,\"nbytes\":%lld}",
                    i ? "," : "", (long long)c->nodes[i].y_off, (long long)(c->nodes[i].N * 4));
    json_append(&js, &jl, &jc, "]}");
    rc = sh_pipe_call(c->pipe, SH_CMD_GRAPH_INSTALL, js, jl, &rep);
    free(js);
    if (rc != SH_OK) { snprintf(c->err, sizeof c->err, "GRAPH_INSTALL: %s", sh_pipe_last_error(c->pipe)); return rc; }
    sh_reply_free(&rep);
    return SH_OK;
}

size_t wc_reply_len(const wc_client *c, int m) {
    size_t want = 0;
    for (int i = 0; i < c->n_nodes; i++)
        want += (size_t)m * (size_t)c->nodes[i].N * (size_t)c->ywidth;
    return want;
}

int wc_exchange(wc_client *c, const int8_t *planes, int m,
                const uint8_t **reply, size_t *len) {
    uint8_t hdr[8 + 4 * WC_MAX_NODES];
    int idx[WC_MAX_NODES];
    for (int i = 0; i < c->n_nodes; i++) idx[i] = i;
    const size_t hn = sh_pack_field_gemm(hdr, (uint32_t)c->n_nodes, (uint32_t)m, idx);
    sh_frame f = { c->ywidth == 3 ? SH_CMD_FIELD_GEMM24 : SH_CMD_FIELD_GEMM,
                   hdr, hn, planes, (size_t)3 * m * c->nodes[0].K };
    sh_reply rep;
    int rc = sh_pipe_exchange(c->pipe, &f, 1, &rep);
    if (rc != SH_OK) { snprintf(c->err, sizeof c->err, "exchange: %s", sh_pipe_last_error(c->pipe)); return rc; }
    const size_t want = wc_reply_len(c, m);
    if (rep.len != want) {
        snprintf(c->err, sizeof c->err, "worker returned %zu bytes, expected %zu", rep.len, want);
        return SH_ERR_VIOLATION;
    }
    *reply = rep.data; *len = rep.len;
    return SH_OK;
}

void wc_close(wc_client *c) {
    if (c && c->pipe) { sh_pipe_close(c->pipe); c->pipe = NULL; }
}
