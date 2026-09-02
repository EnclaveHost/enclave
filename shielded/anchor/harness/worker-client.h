/*
 * worker-client.h -- the NORMAL-WORLD half of the spike: everything
 * shielded-tee.c does on the socket, with none of what it does with secrets.
 *
 * Replays sh_link_start's install sequence (HELLO, ALLOC x2, chunked
 * SET_TENSOR of the public weights, GRAPH_INSTALL) and then carries
 * FIELD_GEMM/FIELD_GEMM24 exchanges whose payloads are ciphertext produced
 * by the anchor core. This code is fine outside the TEE precisely because
 * nothing it touches is secret: public weights out, masked planes out,
 * masked products back. That is the phone topology's socket rule
 * ("if sockets terminate in normal world, only ciphertext frames may
 * transit it") made concrete.
 */
#ifndef ANCHOR_WORKER_CLIENT_H
#define ANCHOR_WORKER_CLIENT_H

#include "shielded-wire.h"
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define WC_MAX_NODES 8

typedef struct {
    int64_t K, N;
    int64_t w_off, x_off, y_off;
} wc_node;

typedef struct {
    sh_pipe *pipe;
    wc_node  nodes[WC_MAX_NODES];
    int      n_nodes;
    int64_t  wbytes, abytes;
    int      ywidth;              /* 4 or 3, decided by HELLO minor (and force32) */
    char     err[256];
} wc_client;

/* Register a node's geometry (layout math mirrors sh_link_add_weight). */
int wc_add(wc_client *c, int64_t K, int64_t N);

/* Connect TCP, HELLO, upload w[i] ((N,K) int8, public), install the graph.
 * force32 keeps FIELD_GEMM/int32 replies against a 1.2+ worker. */
int wc_connect_install(wc_client *c, const char *host, int port,
                       const int8_t *const *w, int force32);

/* The same install over a pipe the caller already holds (a pVM's accepted
 * worker fd, wrapped by sh_pipe_open_fd from wire-fd.c). */
int wc_install(wc_client *c, sh_pipe *pipe, const int8_t *const *w, int force32);
sh_pipe *sh_pipe_open_fd(int fd);
/* pVM build of the complete trusted half: the next sh_pipe_open (renamed to the
 * hook with -Dsh_pipe_open=sh_pipe_open_hook) returns this accepted fd. */
void sh_pipe_adopt_fd(int fd);

/* One exchange over every registered node (they share the activation):
 * planes is the 3*m*K ciphertext block. *reply / *len point into the pipe's
 * buffer -- consume before the next exchange. */
int wc_exchange(wc_client *c, const int8_t *planes, int m,
                const uint8_t **reply, size_t *len);

size_t wc_reply_len(const wc_client *c, int m);
void wc_close(wc_client *c);

#ifdef __cplusplus
}
#endif
#endif
