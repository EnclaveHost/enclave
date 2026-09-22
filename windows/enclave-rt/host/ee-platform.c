/* ee-platform.c -- the two things wasmtime's no_std runtime asks of a platform.
 *
 * That is the entire list, measured by linking it: wasmtime_tls_get and wasmtime_tls_set. No
 * virtual memory, no signal handling, no threads, no clock. Pulley is why: an interpreter does
 * its own bounds checks, so there are no guard pages to map and no faults to catch, which is
 * exactly what makes it fit inside an enclave.
 *
 * TWO slots, and the slot argument is load-bearing: wasmtime keeps its activation list in slot 0
 * and a second pointer in slot 1 (runtime/vm/sys/custom/mod.rs). Collapsing them into one global
 * makes the two aliases of each other, and the first thing that happens is the activation list
 * eating itself: "assertion failed: core::ptr::eq(head, self)" on the way out of a call.
 *
 * EE_ENCLAVE_TLS: inside the enclave these are kept in a small table keyed by THREAD ID rather
 * than in `__declspec(thread)` storage, because an enclave image cannot rely on a TLS directory.
 * Per-thread is not optional any more: a wasi:cli app runs its own server thread inside the
 * enclave (ee_rt_run) while the gate serves wasi:http apps on another, and sharing one slot
 * between two threads running wasm corrupts wasmtime's activation list.
 */
#include <stddef.h>
#ifdef EE_ENCLAVE_TLS
#include <windows.h>
#endif

#define EE_TLS_SLOTS 2

#ifdef EE_ENCLAVE_TLS
/* One row per thread that has ever run wasm in here. Small and fixed: an enclave runs a handful of
 * app threads, not a pool, and a fixed table needs no allocator on a path wasmtime takes on every
 * call into the guest. A row is claimed with an interlocked compare-and-swap, so two threads
 * racing for their first row cannot take the same one. */
#define EE_TLS_THREADS 16
static struct { volatile LONG tid; void *slot[EE_TLS_SLOTS]; } g_tls[EE_TLS_THREADS];

static void **tls_row(void) {
    const LONG me = (LONG)GetCurrentThreadId();
    for (int i = 0; i < EE_TLS_THREADS; i++) if (g_tls[i].tid == me) return g_tls[i].slot;
    for (int i = 0; i < EE_TLS_THREADS; i++)
        if (InterlockedCompareExchange(&g_tls[i].tid, me, 0) == 0) return g_tls[i].slot;
    return NULL;                       /* out of rows: the caller's get returns NULL, which traps */
}
void *wasmtime_tls_get(size_t slot) {
    void **row = tls_row();
    return (row && slot < EE_TLS_SLOTS) ? row[slot] : NULL;
}
void wasmtime_tls_set(size_t slot, void *p) {
    void **row = tls_row();
    if (row && slot < EE_TLS_SLOTS) row[slot] = p;
}
#else
static __declspec(thread) void *g_wasmtime_tls[EE_TLS_SLOTS];
void *wasmtime_tls_get(size_t slot) {
    return slot < EE_TLS_SLOTS ? g_wasmtime_tls[slot] : NULL;
}
void wasmtime_tls_set(size_t slot, void *p) {
    if (slot < EE_TLS_SLOTS) g_wasmtime_tls[slot] = p;
}
#endif
