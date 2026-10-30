/* modelvol-serve.c - TEST ONLY (never in an image), for isolation/m4/test-modelvol-preload.sh: the per-app init's OWN
 * model-volume code (modelvol.h, as dominit.c and m3/domexec.c run it) builds the runtime's argv and environment for
 * volumes already mounted under MV_ROOT, then execs the REAL nn-capable wasmtime with them, serving the app. So what
 * is tested is the exact staging, budget, -S nn / nn-graph / --dir / --env arguments and values a measured guest gives
 * its runtime, against the runtime that must honour them.
 *   modelvol-serve <rtdir> <app.wasm> <addr> <memory MiB>     (MV_ROOT, MV_STAGE, MV_TABLE, MV_NN_MARKER, MV_BACKEND_DIR
 *                                                             and MV_M1, the "M1" block's file, are compiled in) */
#define MV_NO_MOUNT
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include "../modelvol.h"

int main(int argc, char **argv) {
    if (argc != 5) { fprintf(stderr, "usage: modelvol-serve <rtdir> <app.wasm> <addr> <memory MiB>\n"); return 2; }
    char m1[1025] = {0};
    FILE *f = fopen(MV_M1, "r");
    size_t n = f ? fread(m1, 1, sizeof m1 - 1, f) : 0;
    if (f) fclose(f);
    const char *why = model_block(m1, n);
    if (!why) why = mv_table();
    if (!why) why = mv_dirs();
    if (why) { fprintf(stderr, "MVSERVE refused: %s\n", why); return 3; }
    mv_preloads(strtoull(argv[4], NULL, 10) << 20);
    static char ld[600], wt[600];
    snprintf(ld, sizeof ld, "%s/ld-linux-x86-64.so.2", argv[1]);
    snprintf(wt, sizeof wt, "%s/wasmtime", argv[1]);
    char *app[128] = {ld, "--library-path", argv[1], wt, "serve", "-S", "cli", "-C", "cache=n", "--addr", argv[3], NULL};
    int k = mv_argv(app, 11);
    app[k++] = argv[2];
    app[k] = NULL;
    char *envp[32] = {"HOME=/tmp", "PATH=/usr/bin:/bin", NULL};
    envp[mv_env(envp, 2)] = NULL;
    for (int i = 0; app[i]; i++) fprintf(stderr, "MVSERVE argv %s\n", app[i]);
    for (int i = 0; envp[i]; i++) fprintf(stderr, "MVSERVE env %s\n", envp[i]);
    fflush(stderr);
    execve(app[0], app, envp);
    fprintf(stderr, "MVSERVE exec: %s\n", strerror(errno));
    return 127;
}
