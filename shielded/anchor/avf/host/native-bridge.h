/* Opt-in native worker bridge for the anchor app: one thread pumps bytes both ways between two
 * descriptors (the guest's vsock and the worker's TCP socket) with bounded buffers, without owning
 * either descriptor. See native-bridge.c for the contract. */
#ifndef ANCHOR_NATIVE_BRIDGE_H
#define ANCHOR_NATIVE_BRIDGE_H
#include <stddef.h>
#include <stdint.h>
typedef struct {
    uint64_t a_to_b, b_to_a;      /* bytes delivered to each sink */
    uint64_t reads, writes, polls; /* syscalls */
    uint64_t max_chunk;           /* largest single read */
    int status;                   /* the return value */
    uint64_t trace_records, trace_dropped, trace_bytes;
    int trace_status;             /* negative errno, separate from bridge status */
} anchor_bridge_stats;
/* 0 when both directions reached EOF and were drained; -ECANCELED when cancel_fd became readable or
 * hung up; -ETIMEDOUT when idle_ms > 0 passed with nothing to move; -errno on an I/O error (the
 * caller closes and reconnects as it does today). buf_bytes per direction (0 = 1 MiB). */
int anchor_bridge_run_profile(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile);
/* Experimental VM-bound send cap: a_write_max is 0 (unchanged), 4096 or 8192.
 * Only sends to a are capped; buffer capacity and sends to b are unchanged. */
int anchor_bridge_run_profile_limit(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile, size_t a_write_max);
/* trace_fd=-1 disables the metadata timeline. Otherwise the caller supplies an
 * empty regular file, retains ownership, and reads trace_status separately. */
int anchor_bridge_run_profile_trace(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile, size_t a_write_max, int trace_fd);
/* Experimental response batching: 0 keeps opaque forwarding; 65536 batches
 * only b->a using Shielded's 9-byte response headers. Final frame tails and
 * EOF drain immediately. Buffer capacity, cancellation and ownership stay as above. */
int anchor_bridge_run_profile_trace_batch(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile, size_t a_write_max, int trace_fd, size_t reply_batch);
int anchor_bridge_run(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st);
#endif
