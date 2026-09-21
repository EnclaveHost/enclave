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
 * EE_ENCLAVE_TLS: inside the enclave the slot is an ORDINARY global, because an enclave image
 * cannot rely on a TLS directory and does not need one here - the gate lets exactly one call into
 * VTL1 at a time per app, so there is one wasm thread and a global IS its thread-local. The host
 * harness (and any future multi-threaded host) gets the real thread-local instead, so the two
 * builds differ in one #ifdef rather than in behaviour that has to be reasoned about twice.
 */
#include <stddef.h>

#define EE_TLS_SLOTS 2

#ifdef EE_ENCLAVE_TLS
static void *g_wasmtime_tls[EE_TLS_SLOTS];
#else
static __declspec(thread) void *g_wasmtime_tls[EE_TLS_SLOTS];
#endif

void *wasmtime_tls_get(size_t slot) {
    return slot < EE_TLS_SLOTS ? g_wasmtime_tls[slot] : NULL;
}
void wasmtime_tls_set(size_t slot, void *p) {
    if (slot < EE_TLS_SLOTS) g_wasmtime_tls[slot] = p;
}
