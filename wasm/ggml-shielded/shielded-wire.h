/*
 * shielded-wire.h -- the socket half of the shielded protocol, in C.
 *
 * Mirrors shielded/wire.py. Request framing is | cmd u8 | size u64 LE | payload |,
 * response framing is | status u8 | size u64 LE | payload |, and status 1 means
 * the worker refused: it is always the last frame on that connection.
 *
 * Three failure modes have to stay distinguishable, which is the whole reason the
 * response carries a status byte rather than just closing:
 *   SH_ERR_VIOLATION  the worker refused us -- OUR protocol bug, loud in tests
 *   SH_ERR_IO         the socket died -- a liveness event, retryable
 *   (a lying worker)  not visible here at all; Freivalds in shielded-tee catches it
 * Collapsing them, as stock ggml-rpc does, makes the first two indistinguishable
 * in production, and the tier rests on telling them apart.
 */
#ifndef SHIELDED_WIRE_H
#define SHIELDED_WIRE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define SH_CMD_HELLO            0
#define SH_CMD_ALLOC_BUFFER     1
#define SH_CMD_FREE_BUFFER      2
#define SH_CMD_SET_TENSOR       8
#define SH_CMD_GET_TENSOR       9
#define SH_CMD_GRAPH_INSTALL   10
#define SH_CMD_GRAPH_RECOMPUTE 11
/* The one-frame exchange: | n u32 | m u32 | node u32[n] | planes int8[3][m][K] |
 * answered by the products of exactly those nodes, | y int32[m][N_i] |...
 * A decode exchange is one write and one read instead of five of each, and
 * the batch is whatever m is -- no power-of-two bucketing, because the reply
 * is defined by the request rather than matched against a declared region. */
#define SH_CMD_FIELD_GEMM      12

#define SH_OK             0
#define SH_ERR_IO        -1
#define SH_ERR_VIOLATION -2
#define SH_ERR_PROTO     -3
#define SH_ERR_NOMEM     -4

typedef struct sh_pipe sh_pipe;

/* One outbound frame in a pipelined batch. Both segments are borrowed, never
 * copied. The second exists for SET_TENSOR, whose payload is a fixed header
 * followed by tensor bytes: without it every masked activation would be
 * memcpy'd into a staging buffer once per node per token, which at decode is
 * pure overhead against a payload that is already the right bytes in the right
 * order. Frame size is len + len2; leave payload2 NULL for everything else. */
typedef struct {
    uint8_t      cmd;
    const void  *payload;
    size_t       len;
    const void  *payload2;
    size_t       len2;
} sh_frame;

/* One inbound response. `data` points into a buffer the PIPE owns and reuses
 * on the next exchange: read it before exchanging again, and never free it.
 * sh_reply_free only clears the view, so existing call sites stay correct.
 * The buffer grows monotonically to the largest reply seen and dies with the
 * pipe -- which is what makes a decode exchange allocation-free. */
typedef struct {
    uint8_t  status;
    uint8_t *data;
    size_t   len;
} sh_reply;

sh_pipe *sh_pipe_open(const char *host, int port, int *err);
void     sh_pipe_close(sh_pipe *p);

/* The last violation reason the worker sent, or "" -- diagnostics only. */
const char *sh_pipe_last_error(const sh_pipe *p);

/* Write every frame in ONE writev and then read all n responses. This is what
 * makes a masked exchange (SET_TENSOR, RECOMPUTE, GET_TENSOR) cost one RTT
 * instead of three; at 32 layers that is the difference between transport being
 * a rounding error and the second-largest term in the token budget.
 * Replies borrow the pipe's buffer (see sh_reply); a batch of up to 16 frames
 * allocates nothing. */
int sh_pipe_exchange(sh_pipe *p, const sh_frame *frames, size_t n, sh_reply *out);

/* Convenience: one frame, one response. */
int sh_pipe_call(sh_pipe *p, uint8_t cmd, const void *payload, size_t len, sh_reply *out);

void sh_reply_free(sh_reply *r);

/* Payload builders. Each writes little-endian into `dst` and returns the length.
 * Buffers are caller-provided so the hot path allocates nothing. */
size_t sh_pack_hello(void *dst, uint32_t major);
size_t sh_pack_alloc(void *dst, uint64_t size, const char *role);
size_t sh_pack_region(void *dst, uint64_t bid, uint64_t offset, uint64_t nbytes);
size_t sh_pack_set_tensor_header(void *dst, uint64_t bid, uint64_t offset, uint64_t nbytes);
size_t sh_pack_recompute(void *dst, uint32_t node, uint32_t m);
/* Header of a FIELD_GEMM frame; the planes follow as payload2. Returns 8 + 4n. */
size_t sh_pack_field_gemm(void *dst, uint32_t n_nodes, uint32_t m, const int *nodes);

#ifdef __cplusplus
}
#endif
#endif
