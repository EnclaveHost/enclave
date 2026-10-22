/* encvol E2E harness (front/encvol_e2e_test.go): init's REAL handling of the front's message, outside a guest.
 * dominit.c is compiled with its main renamed and ENC_ROOT pointed at the test's staging root; this reads the front's
 * message on stdin with read_front_msg (the trailer parser), builds the app's argv with app_argv over the serve base
 * dominit's main uses, and the app's environment with enc_env, then prints both, NUL-separated:
 *     argv[0] \0 argv[1] \0 ... \0 \1 \0 env[0] \0 env[1] \0 ...
 * A refused message prints "REFUSED: <why>" on stderr and exits 3. */
#define main dominit_main
#include "dominit.c"
#undef main

int main(void) {
    char *cfg_env; size_t len;
    const char *why = read_front_msg(0, &cfg_env, &len);
    if (why) { fprintf(stderr, "REFUSED: %s\n", why); return 3; }
    char *serve[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "serve", "-S", "cli",
                     "-W", "threads", "-C", "cache=n", "--addr", "127.0.0.1:8080", "/app.wasm", NULL};
    char *app[96];
    int n = app_argv(serve, app, cfg_env);
    for (int i = 0; i < n; i++) { fputs(app[i], stdout); fputc(0, stdout); }
    fputc(1, stdout); fputc(0, stdout);
    char *envp[16]; int ei = 0;
    if (cfg_env) envp[ei++] = cfg_env;
    ei = enc_env(envp, ei);
    for (int i = 0; i < ei; i++) { fputs(envp[i], stdout); fputc(0, stdout); }
    return 0;
}
