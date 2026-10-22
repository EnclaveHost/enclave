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
    if (ok != want_ok || (ok && !env_ok) || public_https_egress != (ok && n > 1 && msg[0] == 'P')) {
        printf("FAIL %s: why=%s env=%.40s\n", name, why ? why : "(none)", env ? env : "(null)");
        fails++;
    } else {
        printf("ok   %s%s%s\n", name, why ? ": " : "", why ? why : "");
    }
    free(env);
}

/* the encrypted-volume trailer: after the config's NUL. want_n < 0 = refused (and nothing enabled) */
static void check_enc(const char *name, const char *msg, size_t n, int want_n, const char *want_cfg, const char *want_names,
                      const char *want_api, const char *want_tok) {
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
    int good;
    if (want_n < 0) good = why != NULL && env == NULL && enc_n == 0;
    else good = why == NULL && env && strcmp(env, want_cfg) == 0 && enc_n == want_n
        && strcmp(enc_env_names, want_names) == 0 && strcmp(enc_env_api, want_api) == 0 && strcmp(enc_env_token, want_tok) == 0
        && strcmp(enc_dir_args[0], "/enc/docs::/enc/docs") == 0;
    if (!good) { printf("FAIL %s: why=%s enc_n=%d env=%.40s\n", name, why ? why : "(none)", enc_n, env ? env : "(null)"); fails++; }
    else printf("ok   %s%s%s\n", name, why ? ": " : "", why ? why : "");
    free(env);
}

int main(void) {
    check("an empty pipe (the front died first)", "", 0, 0, NULL);
    check("N: no config", "N", 1, 1, NULL);
    check("C: a config", "C{\"a\":\"k\"}", 10, 1, "ENCLAVE_CONFIG={\"a\":\"k\"}");
    check("P: public HTTPS config", "P{}", 3, 1, "ENCLAVE_CONFIG={}");
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

    /* encrypted volumes */
    const char *api = "http://127.0.0.1:50080/encvol/0x" "11111111111111111111111111111111" "11111111111111111111111111111111";
    const char *tok = "abcdef0123456789abcdef0123456789abcdef0123456789";
    char good[600], wn[64], wa[200], wt[80];
    snprintf(wn, sizeof wn, "ENCLAVE_ENC=docs,models");
    snprintf(wa, sizeof wa, "ENCLAVE_ENC_API=%s", api);
    snprintf(wt, sizeof wt, "ENCLAVE_ENC_TOKEN=%s", tok);
    int gl = snprintf(good, sizeof good, "C{}%cE1\napi=%s\ntoken=%s\nvol=docs\nvol=models\n", 0, api, tok);
    check_enc("C + config + a valid trailer", good, (size_t)gl, 2, "ENCLAVE_CONFIG={}", wn, wa, wt);
    gl = snprintf(good, sizeof good, "P{}%cE1\napi=%s\ntoken=%s\nvol=docs\nvol=models\n", 0, api, tok);
    check_enc("P + config + a valid trailer", good, (size_t)gl, 2, "ENCLAVE_CONFIG={}", wn, wa, wt);
    if (!public_https_egress) { printf("FAIL P trailer lost public mode\n"); fails++; }
    static const struct { const char *name, *fmt; } bad[] = {
        {"a trailer that is not E1", "C{}%cE2\napi=%s\ntoken=%s\nvol=docs\n"},
        {"a plane off this guest's loopback", "C{}%cE1\napi=http://10.0.0.1:50080/encvol/0x%.64s\ntoken=%s\nvol=docs\n"},
        {"a short token", "C{}%cE1\napi=%s\ntoken=%.40s\nvol=docs\n"},
        {"no token", "C{}%cE1\napi=%s\nvol=docs\n%.0s"},
        {"no volume", "C{}%cE1\napi=%s\ntoken=%s\n"},
        {"a duplicate volume", "C{}%cE1\napi=%s\ntoken=%s\nvol=docs\nvol=docs\n"},
        {"an uppercase volume", "C{}%cE1\napi=%s\ntoken=%s\nvol=Docs\n"},
        {"a path in a volume name", "C{}%cE1\napi=%s\ntoken=%s\nvol=../etc\n"},
        {"an unexpected line", "C{}%cE1\napi=%s\ntoken=%s\nvol=docs\nx=1\n"},
        {"an unterminated line", "C{}%cE1\napi=%s\ntoken=%s\nvol=docs"},
        {"two tokens", "C{}%cE1\napi=%s\ntoken=%s\ntoken=%s\nvol=docs\n"},
        {"nine volumes", "C{}%cE1\napi=%s\ntoken=%s\nvol=a\nvol=b\nvol=c\nvol=d\nvol=e\nvol=f\nvol=g\nvol=h\nvol=i\n"},
    };
    for (size_t i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        int bl = snprintf(good, sizeof good, bad[i].fmt, 0, api, tok, tok);
        if (strstr(bad[i].fmt, "10.0.0.1")) bl = snprintf(good, sizeof good, bad[i].fmt, 0, api + 32, tok);
        check_enc(bad[i].name, good, (size_t)bl, -1, NULL, NULL, NULL, NULL);
    }
    gl = snprintf(good, sizeof good, "N%cE1\napi=%s\ntoken=%s\nvol=docs\n", 0, api, tok);
    check_enc("a trailer after N (no config)", good, (size_t)gl, -1, NULL, NULL, NULL, NULL);
    gl = snprintf(good, sizeof good, "C{}%cE1\napi=%s\ntoken=%s\nvol=docs\n%c", 0, api, tok, 0);
    check_enc("a NUL inside the trailer", good, (size_t)gl, -1, NULL, NULL, NULL, NULL);
    /* the config keeps its own 64 KiB ceiling with a trailer behind it */
    static char bigt[1 + 65536 + 1 + 600];
    bigt[0] = 'C'; memset(bigt + 1, 'x', 65536);
    int tl = snprintf(bigt + 1 + 65536, 600, "%cE1\napi=%s\ntoken=%s\nvol=docs\n", 0, api, tok);
    snprintf(wn, sizeof wn, "ENCLAVE_ENC=docs");
    check_enc("a 64 KiB config with a trailer", bigt, 1 + 65536 + (size_t)tl, 1, want, wn, wa, wt);
    static char overt[1 + 65537 + 1 + 600];
    overt[0] = 'C'; memset(overt + 1, 'x', 65537);
    tl = snprintf(overt + 1 + 65537, 600, "%cE1\napi=%s\ntoken=%s\nvol=docs\n", 0, api, tok);
    check_enc("a config one byte over the ceiling, with a trailer", overt, 1 + 65537 + (size_t)tl, -1, NULL, NULL, NULL, NULL);
    check("C without a trailer after a trailer leaves no volumes", "C{}", 3, 1, "ENCLAVE_CONFIG={}");
    if (enc_n != 0) { printf("FAIL volumes survived a later message without a trailer\n"); fails++; }
    return fails ? 1 : 0;
}
EOF
cp "$here/dominit.c" "$here/app-seccomp.h" "$here/sha256-min.h" "$here/shield-memory.h" "$here/shield-config.h" "$d/"
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
