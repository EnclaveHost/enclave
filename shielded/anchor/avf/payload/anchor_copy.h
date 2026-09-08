/* Exact byte transfer for the pVM's receivers: a stream (vsock) into a file, every failure mode named. */
#ifndef ANCHOR_COPY_H
#define ANCHOR_COPY_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
/* Copy exactly `bytes` from src_fd (a stream) into dst_fd at its current position: read EINTR/EAGAIN retried
 * (EAGAIN waits with poll), short writes looped, EINTR on write retried. 0 on success with *got == bytes;
 * -1 with err filled on end-of-stream before `bytes`, a read error, a write error or a write that makes
 * no progress. *got always says how much reached dst. Nothing is synced or renamed here. */
int anchor_copy_exact(int src_fd, int dst_fd, uint64_t bytes, uint64_t *got, char *err, size_t errcap);
/* fsync with EINTR retried: 0 or -1 (errno kept). A receiver remembers completion only after this returns 0. */
int anchor_fsync_retry(int fd);
#ifdef __cplusplus
}
#endif
#endif
