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
} anchor_bridge_stats;
/* 0 when both directions reached EOF and were drained; -ECANCELED when cancel_fd became readable or
 * hung up; -ETIMEDOUT when idle_ms > 0 passed with nothing to move; -errno on an I/O error (the
 * caller closes and reconnects as it does today). buf_bytes per direction (0 = 1 MiB). */
int anchor_bridge_run_profile(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st, int profile);
int anchor_bridge_run(int a, int b, int cancel_fd, int idle_ms, size_t buf_bytes, anchor_bridge_stats *st);
#endif
