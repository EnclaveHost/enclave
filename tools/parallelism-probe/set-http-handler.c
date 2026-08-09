/* enclave/SET: an HTTP guest that also SPAWNS.
 *
 * This is the residual `wasm/SET-DO-NOT-PROMOTE.md` has carried since round 3:
 * "Still unproven: an end-to-end `wasmtime serve` of a SET http guest." Round 8
 * proved that a SET-enabled `serve` can drive an ORDINARY http component. This
 * proves the other half: a component that exports `wasi:http/incoming-handler`
 * AND spawns real SET threads per request.
 *
 * Each request spawns N pthreads (which the SET toolchain lowers to
 * `thread.spawn-indirect`), each bumps a shared atomic and burns a little CPU,
 * main joins them and reports the count in the response body. A wrong answer
 * means the threads did not actually run; a hang means teardown is broken; a
 * 500 means the host refused the spawn.
 */
#include <pthread.h>
#include <stdatomic.h>
#include <stdio.h>
#include <string.h>

#include "gen/proxy.h"

#define NTHREADS 8
#define SPINS 200000

static _Atomic unsigned long counter;

static void *worker(void *arg) {
    unsigned long acc = 0;
    for (int i = 0; i < SPINS; ++i)
        acc += (unsigned long)(uintptr_t)arg ^ (unsigned long)i;
    atomic_fetch_add(&counter, 1);
    /* keep `acc` alive so the loop is not optimised away */
    atomic_fetch_add(&counter, acc == 0 ? 1 : 0);
    return NULL;
}

void exports_wasi_http_incoming_handler_handle(
    exports_wasi_http_incoming_handler_own_incoming_request_t request,
    exports_wasi_http_incoming_handler_own_response_outparam_t response_out) {
    (void)request;

    atomic_store(&counter, 0);
    pthread_t t[NTHREADS];
    int started = 0;
    for (int i = 0; i < NTHREADS; ++i) {
        if (pthread_create(&t[i], NULL, worker, (void *)(uintptr_t)(i + 1)) == 0)
            started++;
        else
            t[i] = (pthread_t)0;
    }
    for (int i = 0; i < NTHREADS; ++i)
        if (t[i])
            pthread_join(t[i], NULL);

    char body[128];
    int n = snprintf(body, sizeof body, "spawned=%d joined=%lu\n", started,
                     (unsigned long)atomic_load(&counter));

    wasi_http_types_own_headers_t headers = wasi_http_types_constructor_fields();
    wasi_http_types_own_outgoing_response_t resp =
        wasi_http_types_constructor_outgoing_response(headers);
    wasi_http_types_borrow_outgoing_response_t rb =
        wasi_http_types_borrow_outgoing_response(resp);
    wasi_http_types_method_outgoing_response_set_status_code(rb, 200);

    wasi_http_types_own_outgoing_body_t out_body;
    if (wasi_http_types_method_outgoing_response_body(rb, &out_body)) {
        wasi_http_types_own_output_stream_t stream;
        if (wasi_http_types_method_outgoing_body_write(
                wasi_http_types_borrow_outgoing_body(out_body), &stream)) {
            proxy_list_u8_t chunk;
            chunk.ptr = (uint8_t *)body;
            chunk.len = (size_t)n;
            wasi_io_streams_stream_error_t serr;
            wasi_io_streams_method_output_stream_blocking_write_and_flush(
                wasi_io_streams_borrow_output_stream(stream), &chunk, &serr);
            wasi_io_streams_output_stream_drop_own(stream);
        }
        wasi_http_types_error_code_t ferr;
        wasi_http_types_static_outgoing_body_finish(out_body, NULL, &ferr);
    }

    wasi_http_types_result_own_outgoing_response_error_code_t result;
    result.is_err = false;
    result.val.ok = resp;
    wasi_http_types_static_response_outparam_set(response_out, &result);
}
