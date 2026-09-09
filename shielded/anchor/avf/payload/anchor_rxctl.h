/* Receiver control for the pads-port receiver thread (anchor_payload.c pads_receiver): a PREPARE run must know the receiver
 * is QUIET before it counts what is present, or a reception that completes after the snapshot makes the receipt wrong
 * (seen 2026-09-09: "present 1/48" reported, 2 found at the next boot). Pure: a host fixture drives it with a mock loop.
 *
 * Contract: the receiver loop calls anchor_rx_should_stop() before every accept and uses a SHORT accept poll; every accepted
 * connection is registered with anchor_rx_set_active(fd) (which refuses it if the stop already landed) and closed ONLY
 * through anchor_rx_close(fd), which clears the
 * registration under the mutex before close(2): a stopper can therefore shutdown(2) the active descriptor without ever
 * touching a closed or reused number. The loop signals anchor_rx_exited() when it returns. anchor_rx_quiesce() sets stop,
 * shuts down the active connection (the reception fails cleanly: temp removed, nothing published), waits (bounded) for
 * the exit signal and joins the thread. 0 = the receiver did not quiesce within the bound (the caller must NOT snapshot).
 * The guarantee is "no publication after the join": a reception that had already received every byte may still finish
 * publishing during the quiesce (it is then IN the snapshot); a reception still reading is refused (temp removed).
 * The process must ignore SIGPIPE: the shutdown makes the receiver's own later write fail with EPIPE instead of a kill. */
#ifndef ANCHOR_RXCTL_H
#define ANCHOR_RXCTL_H
#include <pthread.h>
#ifdef __cplusplus
extern "C" {
#endif
void anchor_rx_reset(void);                 /* fresh state for a new receiver thread (stop 0, no active fd, not exited) */
int  anchor_rx_should_stop(void);
/* 1 = registered; 0 = a stop arrived between the loop's check and this accept: the fd is already shut down, the loop must
 * close it (anchor_rx_close) and exit without reading anything from it */
int  anchor_rx_set_active(int fd);
void anchor_rx_close(int fd);
void anchor_rx_exited(void);
/* Requests a stop, shuts down the active connection, waits up to wait_ms for the exit signal, joins `th` on success. */
int  anchor_rx_quiesce(pthread_t th, unsigned wait_ms);
#ifdef __cplusplus
}
#endif
#endif
