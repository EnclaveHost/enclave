#!/bin/sh
# The handoff from the front to init (dominit.c read_front_msg), checked outside a guest: init starts the app only on
# "N" or on "C" + a config within the 64 KiB ENCLAVE_CONFIG ceiling, and refuses an empty pipe (the front died before
# it provisioned), another tag, one byte over the ceiling and a NUL. PID 1 itself cannot run here, so the harness
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
    if (ok != want_ok || (ok && !env_ok)) {
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
    return fails ? 1 : 0;
}
EOF
cp "$here/dominit.c" "$here/app-seccomp.h" "$d/"
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
