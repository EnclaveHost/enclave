#!/bin/sh
# The handoff from the front to init (dominit.c read_front_msg), checked outside a guest: init starts the app only on
# "N" or on "C" + a config within the 64 KiB ENCLAVE_CONFIG ceiling, and refuses an empty pipe (the front died before
# it provisioned), another tag, one byte over the ceiling and a NUL; and the optional secrets section after "\0S". PID 1 itself cannot run here, so the harness
# compiles dominit.c with its main renamed and calls the reader on a pipe for each case.
#
# usage: test-dominit-handoff.sh        (needs gcc)
set -e
here=$(cd "$(dirname "$0")" && pwd)
d=$(mktemp -d)
trap 'rm -rf "$d"' EXIT
cat > "$d/h.c" <<'EOF'
#define main dominit_main
#include "dominit.c"
#undef main

static int fails;

/* feed `n` bytes of `msg` through a pipe from a child (a pipe holds 64 KiB, and some cases are larger) */
static void check(const char *name, const char *msg, size_t n, int want_ok, const char *want_env) {
    int p[2];
    if (pipe(p) < 0) { perror("pipe"); exit(2); }
    pid_t w = fork();
    if (w == 0) {
        close(p[0]);
        for (size_t o = 0; o < n;) { ssize_t r = write(p[1], msg + o, n - o); if (r <= 0) _exit(1); o += (size_t)r; }
        _exit(0);
    }
    close(p[1]);
    char *env; size_t len;
    const char *why = read_front_msg(p[0], &env, &len);
    close(p[0]);
    waitpid(w, NULL, 0);
    int ok = why == NULL;
    int env_ok = want_env ? (env && strcmp(env, want_env) == 0 && len == strlen(want_env) - 15) : env == NULL;
    if (ok != want_ok || (ok && !env_ok) || public_https_egress != (ok && n > 1 && (msg[0] == 'P' || msg[0] == 'W')) || public_web_egress != (ok && n > 1 && msg[0] == 'W')) {
        printf("FAIL %s: why=%s env=%.40s\n", name, why ? why : "(none)", env ? env : "(null)");
        fails++;
    } else {
        printf("ok   %s%s%s\n", name, why ? ": " : "", why ? why : "");
    }
    free(env);
}

int main(void) {
    check("an empty pipe (the front died first)", "", 0, 0, NULL);
    check("N: no config", "N", 1, 1, NULL);
    check("C: a config", "C{\"a\":\"k\"}", 10, 1, "ENCLAVE_CONFIG={\"a\":\"k\"}");
    check("P: public HTTPS config", "P{}", 3, 1, "ENCLAVE_CONFIG={}");
    check("W: public web config", "W{}", 3, 1, "ENCLAVE_CONFIG={}");
    check("W without a config", "W", 1, 0, NULL);
    check("P without a config", "P", 1, 0, NULL);
    check("C after P does not retain public mode", "C{}", 3, 1, "ENCLAVE_CONFIG={}");
    check("C with nothing after it", "C", 1, 0, NULL);
    check("N followed by more", "NN", 2, 0, NULL);
    check("another tag", "X{}", 3, 0, NULL);
    check("a NUL inside the config", "C{\"a\0\"}", 7, 0, NULL);
    static char big[1 + 65536 + 1], want[15 + 65536 + 1];
    big[0] = 'C';
    memset(big + 1, 'x', 65536);
    memcpy(want, "ENCLAVE_CONFIG=", 15);
    memset(want + 15, 'x', 65536);
    check("exactly the 64 KiB ceiling", big, 1 + 65536, 1, want);
    big[1 + 65536] = 'x';
    check("one byte over the ceiling", big, 1 + 65536 + 1, 0, NULL);
    /* the secrets section: NUL, "S", NAME=VALUE entries each ending in NUL; they become runtime ARGUMENTS only */
#define M(lit) lit, sizeof lit - 1
    check("C + two secrets", M("C{}\0SAPI_KEY=v1\0DB_URL=postgres://u:p@h/x\0"), 1, "ENCLAVE_CONFIG={}");
    if (secret_n != 2 || strcmp(secret_args[0], "API_KEY=v1") || strcmp(secret_args[1], "DB_URL=postgres://u:p@h/x")) { printf("FAIL secrets parsed: %d\n", secret_n); fails++; }
    wipe_secrets();
    check("N + a secret (no config)", M("N\0SCAPACITY_WORK_TOKEN=abc\0"), 1, NULL);
    if (secret_n != 1 || strcmp(secret_args[0], "CAPACITY_WORK_TOKEN=abc")) { printf("FAIL secret without config\n"); fails++; }
    wipe_secrets();
    check("an empty value is a value", M("C{}\0SEMPTY=\0"), 1, "ENCLAVE_CONFIG={}"); wipe_secrets();
    check("a reserved ENCLAVE_ name", M("C{}\0Senclave_x=1\0"), 0, NULL);
    check("a name starting with a digit", M("C{}\0S1A=1\0"), 0, NULL);
    check("a name with a dash", M("C{}\0SA-B=1\0"), 0, NULL);
    check("no '='", M("C{}\0SNAME\0"), 0, NULL);
    check("a value with a newline", M("C{}\0SA=x\ny\0"), 0, NULL);
    check("a duplicate name", M("C{}\0SA=1\0A=2\0"), 0, NULL);
    check("a section not ending in NUL", M("C{}\0SA=1"), 0, NULL);
    check("a NUL not followed by S", M("C{}\0XA=1\0"), 0, NULL);
    check("an empty secrets section", M("C{}\0S"), 0, NULL);
    if (secret_n) { printf("FAIL a refused message left secrets behind\n"); fails++; }
    {   /* 65 entries: one over the count */
        static char many[4096]; size_t o = 0;
        memcpy(many, "C{}\0S", 5); o = 5;
        for (int i = 0; i < 65; i++) o += (size_t)sprintf(many + o, "K%d=v", i) + 1;
        check("65 secrets", many, o, 0, NULL);
        o = 5; for (int i = 0; i < 64; i++) o += (size_t)sprintf(many + o, "K%d=v", i) + 1;
        check("64 secrets", many, o, 1, "ENCLAVE_CONFIG={}"); wipe_secrets();
    }
    return fails ? 1 : 0;
}
EOF
cp "$here/dominit.c" "$here/app-seccomp.h" "$here/sha256-min.h" "$here/shield-memory.h" "$d/"
gcc -O2 -Wall -Wextra -Wno-unused-function -o "$d/h" "$d/h.c"
"$d/h" && echo "dominit handoff (glibc): PASS"
# ...and against the libc the IMAGE's init links: musl (app-image-template.sh), when its prefix exists
MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
if [ -r "$MUSL/lib/musl-gcc.specs" ]; then
  /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static -O2 -Wall -Wextra -Wno-unused-function -o "$d/hm" "$d/h.c"
  "$d/hm" && echo "dominit handoff (musl, as the image links it): PASS"
else
  echo "dominit handoff (musl): SKIPPED, no musl at $MUSL (sh isolation/m2/build-musl.sh)"
fi
