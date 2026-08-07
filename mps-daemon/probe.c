/* MPS attach probe: does what a tenant's first CUDA call does - cuInit and a
 * primary-context retain THROUGH the MPS pipe this container exports - then
 * exits. The point is the exit code, and above all that it exits AT ALL: a
 * healthy stack answers in well under a second (tens of seconds for the first
 * attach after a CC boot), while a wedged MPS daemon blocks the attach
 * forever - which the caller turns into a verdict via timeout(1). That wedge
 * is exactly what get_server_list cannot see: on 2026-08-07 the control
 * daemon chatted happily for hours while every attach on the node hung.
 *
 * Exit codes:
 *   0  attach ok
 *   1  the driver ANSWERED with an error (resource pressure, not a wedge -
 *      the caller must never bounce on this: live tenants may hold the card)
 *   2  environment broken (libcuda/symbols missing - runtime injection off)
 *   a hang never returns; timeout(1) kills us with 124/137
 *
 * dlopen instead of -lcuda so the build needs no CUDA SDK headers or stubs:
 * libcuda.so.1 exists only at runtime (injected by runtime: nvidia).
 * No context release before exit - the process exists to exit, and process
 * teardown releases everything.
 */
#include <dlfcn.h>
#include <stdio.h>

int main(void) {
    void *h = dlopen("libcuda.so.1", RTLD_NOW);
    if (!h) {
        fprintf(stderr, "mps-probe: libcuda.so.1 missing (%s)\n", dlerror());
        return 2;
    }
    int (*cu_init)(unsigned int) = (int (*)(unsigned int))dlsym(h, "cuInit");
    int (*ctx_retain)(void **, int) =
        (int (*)(void **, int))dlsym(h, "cuDevicePrimaryCtxRetain");
    if (!cu_init || !ctx_retain) {
        fprintf(stderr, "mps-probe: driver symbols missing\n");
        return 2;
    }
    int rc = cu_init(0);
    if (rc != 0) {
        fprintf(stderr, "mps-probe: cuInit rc=%d\n", rc);
        return 1;
    }
    void *ctx = NULL;
    rc = ctx_retain(&ctx, 0);
    if (rc != 0) {
        fprintf(stderr, "mps-probe: cuDevicePrimaryCtxRetain rc=%d\n", rc);
        return 1;
    }
    puts("mps-probe: attach ok");
    return 0;
}
