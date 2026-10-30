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

/* the model-volume block (modelvol.h): want_n < 0 = refused (and nothing enabled) */
static void check_model(const char *name, const char *msg, size_t n, int want_n, int want_enc, const char *want_first) {
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
    int good = want_n < 0 ? (why != NULL && env == NULL && mv_n == 0 && enc_n == 0)
                          : (why == NULL && env && mv_n == want_n && enc_n == want_enc && strcmp(mv[0].name, want_first) == 0);
    if (!good) { printf("FAIL %s: why=%s mv_n=%d enc_n=%d\n", name, why ? why : "(none)", mv_n, enc_n); fails++; }
    else printf("ok   %s%s%s\n", name, why ? ": " : "", why ? why : "");
    free(env);
}

static void put(const char *path, const char *text) { FILE *f = fopen(path, "w"); if (!f) { perror(path); exit(2); } fputs(text, f); fclose(f); }
static void blob(const char *path, size_t bytes) { FILE *f = fopen(path, "w"); if (!f) { perror(path); exit(2); } for (size_t i = 0; i < bytes; i++) fputc('w', f); fclose(f); }
static void expect(const char *name, int cond) { if (cond) printf("ok   %s\n", name); else { printf("FAIL %s\n", name); fails++; } }
static int has(char **v, int n, const char *s) { for (int i = 0; i < n; i++) if (!strcmp(v[i], s)) return 1; return 0; }
static int at(char **v, int n, const char *s) { for (int i = 0; i < n; i++) if (!strcmp(v[i], s)) return i; return -1; }

#define ROOTA "a1b2c3d4e5f60718293a4b5c6d7e8f9011223344556677889900aabbccddeeff"
#define ROOTB "0f1e2d3c4b5a69788796a5b4c3d2e1f00112233445566778899aabbccddeeff0"
#define ROOTC "ffeeddccbbaa99887766554433221100ffeeddccbbaa99887766554433221100"
#define PIN "1111111111111111111111111111111111111111111111111111111111111111"
static void model_units(void) {
    /* the measured table: three volumes; lookups by the M1 names */
    put(MV_TABLE,
        "big-gguf " ROOTA " 00ff 4096 4096 1000 1001 4198400 ggml weights/big.gguf " PIN "\n"
        "small-gguf " ROOTB " 0a0b 4096 4096 10 11 49152 ggml model-00001-of-00002.gguf " PIN "\n"
        "data-vol " ROOTC " 01 4096 4096 10 11 49152 none - " PIN "\n");
    model_block("M1\nvol=small-gguf\nvol=big-gguf\nvol=data-vol\n", strlen("M1\nvol=small-gguf\nvol=big-gguf\nvol=data-vol\n"));
    expect("the table resolves every M1 name", mv_table() == NULL && !strcmp(mv[0].root, ROOTB) && mv[1].dblocks == 1000 &&
           !strcmp(mv[2].preload, "none") && !strcmp(mv[0].serial, "mv0f1e2d3c4b5a697887"));
    model_block("M1\nvol=unknown\n", strlen("M1\nvol=unknown\n"));
    expect("a name the measured table does not carry is refused", mv_table() != NULL);
    static const char *badt[] = {
        "x " ROOTA " 00ff 4096 4096 10 11 49152 ggml a.gguf " PIN "\n",                 /* the volume is absent (x) */
        "unknown " ROOTA " 00ff 512 4096 10 11 49152 ggml a.gguf " PIN "\n",            /* a data block size not 4096 */
        "unknown " ROOTA " 00ff 4096 4096 10 10 49152 ggml a.gguf " PIN "\n",           /* the hash area inside the data */
        "unknown " ROOTA " 00ff 4096 4096 10 11 49152 onnx a.gguf " PIN "\n",           /* a preload kind not offered */
        "unknown " ROOTA " 00ff 4096 4096 10 11 49152 ggml ../a.gguf " PIN "\n",        /* a graph outside the volume */
        "unknown " "G2b3c4d5e6f70718293a4b5c6d7e8f9011223344556677889900aabbccddeeff" " 00ff 4096 4096 10 11 49152 ggml a.gguf " PIN "\n",
        "unknown " ROOTA " 00ff 4096 4096 10 11 49152 ggml a.gguf " PIN "\nunknown " ROOTA " 00ff 4096 4096 10 11 49152 ggml a.gguf " PIN "\n",
        "unknown " ROOTA " 00ff 4096 4096 10 11 49152 ggml a.gguf",                       /* unterminated, short */
    };
    for (size_t i = 0; i < sizeof badt / sizeof badt[0]; i++) {
        put(MV_TABLE, badt[i]);
        model_block("M1\nvol=unknown\n", strlen("M1\nvol=unknown\n"));
        char nm[64]; snprintf(nm, sizeof nm, "a malformed or missing table entry is refused (%zu)", i);
        expect(nm, mv_table() != NULL);
    }
    /* disks by serial: mv + the root's first 18 hex digits, nothing else */
    put(MV_TABLE,
        "big-gguf " ROOTA " 00ff 4096 4096 1000 1001 4198400 ggml weights/big.gguf " PIN "\n"
        "small-gguf " ROOTB " 0a0b 4096 4096 10 11 49152 ggml model-00001-of-00002.gguf " PIN "\n"
        "data-vol " ROOTC " 01 4096 4096 10 11 49152 none - " PIN "\n");
    model_block("M1\nvol=small-gguf\nvol=big-gguf\nvol=data-vol\n", strlen("M1\nvol=small-gguf\nvol=big-gguf\nvol=data-vol\n"));
    mv_table();
    mkdir(MV_SYS_BLOCK, 0755);
    mkdir(MV_SYS_BLOCK "/vda", 0755); put(MV_SYS_BLOCK "/vda/serial", "mva1b2c3d4e5f6071829\n");
    mkdir(MV_SYS_BLOCK "/vdb", 0755); put(MV_SYS_BLOCK "/vdb/serial", "mv0f1e2d3c4b5a697887\n");
    mkdir(MV_SYS_BLOCK "/sda", 0755); put(MV_SYS_BLOCK "/sda/serial", "mvffeeddccbbaa998877\n");
    char disk[128];
    expect("each volume finds its own disk by serial", mv_find_disk(&mv[0], disk, sizeof disk) && !strcmp(disk, MV_DEV "/vdb") &&
           mv_find_disk(&mv[1], disk, sizeof disk) && !strcmp(disk, MV_DEV "/vda"));
    expect("a disk that is not virtio, or a wrong serial, is never a volume's", !mv_find_disk(&mv[2], disk, sizeof disk));

    /* preloads: the mounted trees (here plain dirs), the stage, the runtime marker, the budget */
    mkdir(MV_ROOT, 0755);
    mkdir(MV_ROOT "/small-gguf", 0755);
    blob(MV_ROOT "/small-gguf/model-00001-of-00002.gguf", 3000);
    blob(MV_ROOT "/small-gguf/model-00002-of-00002.gguf", 2000);
    blob(MV_ROOT "/small-gguf/other-00001-of-00002.gguf", 9);       /* another family: not staged */
    blob(MV_ROOT "/small-gguf/vision-mmproj-f16.gguf", 500);       /* a projector: staged beside it */
    mkdir(MV_ROOT "/big-gguf", 0755); mkdir(MV_ROOT "/big-gguf/weights", 0755);
    blob(MV_ROOT "/big-gguf/weights/big.gguf", 40000);
    blob(MV_ROOT "/big-gguf/weights/alt.gguf", 7);                 /* not the pinned graph: not staged */
    mkdir(MV_ROOT "/data-vol", 0755);
    for (int k = 0; k < mv_n; k++)
        snprintf(mv_dir_args[k], sizeof mv_dir_args[k], MV_ROOT "/%s::/models/%s", mv[k].name, mv[k].name);
    unlink(MV_NN_MARKER);
    mv_preloads(1ULL << 40);
    char *app[64]; int n = mv_argv(app, 0); app[n] = NULL;
    char *envp[16]; int ne = mv_env(envp, 0);
    expect("without the runtime's ggml marker: mounted and listed, no -S nn, no preload", !mv_nn && !has(app, n, "nn") &&
           has(app, n, "--dir") && has(app, n, "ENCLAVE_MODELS") && ne == 1 && !strcmp(envp[0], "ENCLAVE_MODELS=small-gguf,big-gguf,data-vol"));
    put(MV_NN_MARKER, "1\n");
    for (int k = 0; k < mv_n; k++) mv[k].staged_bytes = 0, mv[k].preloaded = 0;
    mv_preloads((256ULL << 20) + 46000);   /* room for small (5500) + big (40000), with the reserve */
    n = mv_argv(app, 0); app[n] = NULL; ne = mv_env(envp, 0);
    struct stat st;
    char l1[400], l2[400];
    ssize_t r1 = readlink(MV_STAGE "/big-gguf/model.gguf", l1, sizeof l1 - 1), r2 = readlink(MV_STAGE "/small-gguf/model-00002-of-00002.gguf", l2, sizeof l2 - 1);
    if (r1 > 0) l1[r1] = 0;
    if (r2 > 0) l2[r2] = 0;
    expect("a single graph stages as model.gguf, a split family under its real part names, a projector beside it",
           r1 > 0 && !strcmp(l1, MV_ROOT "/big-gguf/weights/big.gguf") && r2 > 0 && !strcmp(l2, MV_ROOT "/small-gguf/model-00002-of-00002.gguf") &&
           lstat(MV_STAGE "/small-gguf/model-00001-of-00002.gguf", &st) == 0 && lstat(MV_STAGE "/small-gguf/vision-mmproj-f16.gguf", &st) == 0 &&
           lstat(MV_STAGE "/small-gguf/other-00001-of-00002.gguf", &st) != 0 && lstat(MV_STAGE "/big-gguf/alt.gguf", &st) != 0 &&
           lstat(MV_STAGE "/data-vol", &st) != 0);
    int s1 = at(app, n, "nn-graph=ggml::" MV_STAGE "/small-gguf"), s2 = at(app, n, "nn-graph=ggml::" MV_STAGE "/big-gguf");
    expect("-S nn, then every preload smallest first, then the read-only preopens and env names", has(app, n, "nn") && s1 > 0 && s2 > s1 &&
           !strcmp(app[s1 - 1], "-S") && has(app, n, MV_ROOT "/data-vol::/models/data-vol") && has(app, n, "ENCLAVE_NN_PRELOADS") &&
           has(app, n, "ENCLAVE_NN_SERVE_BYTES"));
    expect("ENCLAVE_NN_PRELOADS names exactly the preloaded volumes, smallest first; the ggml CPU backend is the runtime's",
           ne == 6 && !strcmp(envp[1], "ENCLAVE_NN_PRELOADS=small-gguf,big-gguf") && !strcmp(envp[3], "ENCLAVE_NN_SERVE_KIND=RAM") &&
           !strcmp(envp[5], "ENCLAVE_GGML_N_GPU_LAYERS=0"));
    /* a budget that holds only the small model: the big one stays mounted, listed, NOT preloaded */
    for (int k = 0; k < mv_n; k++) mv[k].staged_bytes = 0, mv[k].preloaded = 0;
    system("rm -rf " MV_STAGE);
    mv_preloads((256ULL << 20) + 6000);
    n = mv_argv(app, 0); app[n] = NULL; ne = mv_env(envp, 0);
    expect("past the memory budget a volume is mounted only (wasm_manager's emission stops at the budget)",
           at(app, n, "nn-graph=ggml::" MV_STAGE "/big-gguf") < 0 && at(app, n, "nn-graph=ggml::" MV_STAGE "/small-gguf") > 0 &&
           !strcmp(envp[1], "ENCLAVE_NN_PRELOADS=small-gguf") && has(app, n, MV_ROOT "/big-gguf::/models/big-gguf"));
}

int main(void) {
    model_units();
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

    /* model volumes: an M1 block, alone or with E1, each at most once */
    char mm[1200];
    int ml = snprintf(mm, sizeof mm, "C{}%cM1\nvol=qwen2.5-0.5b-gguf\nvol=maya1-gguf\n", 0);
    check_model("C + config + an M1 block", mm, (size_t)ml, 2, 0, "qwen2.5-0.5b-gguf");
    ml = snprintf(mm, sizeof mm, "C{}%cE1\napi=%s\ntoken=%s\nvol=docs\n%cM1\nvol=qwen2.5-0.5b-gguf\n", 0, api, tok, 0);
    check_model("E1 then M1", mm, (size_t)ml, 1, 1, "qwen2.5-0.5b-gguf");
    ml = snprintf(mm, sizeof mm, "C{}%cM1\nvol=qwen2.5-0.5b-gguf\n%cE1\napi=%s\ntoken=%s\nvol=docs\n", 0, 0, api, tok);
    check_model("M1 then E1", mm, (size_t)ml, 1, 1, "qwen2.5-0.5b-gguf");
    static const struct { const char *name, *fmt; } mbad[] = {
        {"an M2 block", "C{}%cM2\nvol=a\n"},
        {"an empty M1 block", "C{}%cM1\n"},
        {"a duplicate model volume", "C{}%cM1\nvol=a\nvol=a\n"},
        {"an uppercase model volume", "C{}%cM1\nvol=Qwen\n"},
        {"a path in a model volume name", "C{}%cM1\nvol=../rt\n"},
        {"nine model volumes", "C{}%cM1\nvol=a\nvol=b\nvol=c\nvol=d\nvol=e\nvol=f\nvol=g\nvol=h\nvol=i\n"},
        {"an unterminated model line", "C{}%cM1\nvol=a"},
        {"another line in M1", "C{}%cM1\nvol=a\nroot=00\n"},
        {"two M1 blocks", "C{}%cM1\nvol=a\n%cM1\nvol=b\n"},
        {"a third block", "C{}%cM1\nvol=a\n%cE1\napi=x\n%cM1\n"},
        {"an empty block after M1", "C{}%cM1\nvol=a\n%c"},
        {"M1 after N (no config)", "N%cM1\nvol=a\n"},
    };
    for (size_t i = 0; i < sizeof mbad / sizeof mbad[0]; i++) {
        ml = snprintf(mm, sizeof mm, mbad[i].fmt, 0, 0, 0);
        check_model(mbad[i].name, mm, (size_t)ml, -1, 0, NULL);
    }
    check("C without blocks after M1 leaves no model volumes", "C{}", 3, 1, "ENCLAVE_CONFIG={}");
    if (mv_n != 0) { printf("FAIL model volumes survived a later message without a block\n"); fails++; }
    return fails ? 1 : 0;
}
EOF
cp "$here/dominit.c" "$here/app-seccomp.h" "$here/sha256-min.h" "$here/shield-memory.h" "$here/shield-config.h" "$here/modelvol.h" "$here/mverity.h" "$d/"
mkdir -p "$d/mv"
MVDEFS="-DMV_TABLE='\"$d/mv/table\"' -DMV_ROOT='\"$d/mv/models\"' -DMV_SYS_BLOCK='\"$d/mv/sys\"' -DMV_DEV='\"$d/mv/dev\"' -DMV_NN_MARKER='\"$d/mv/nn\"' -DMV_STAGE='\"$d/mv/stage\"'"
eval gcc -O2 -Wall -Wextra -Wno-unused-function -Wno-unused-result $MVDEFS -o "$d/h" "$d/h.c"
"$d/h" && echo "dominit handoff (glibc): PASS"
# ...and against the libc the IMAGE's init links: musl (app-image-template.sh), when its prefix exists
MUSL=${MUSL_PREFIX:-$HOME/.cache/enclave-isolation/musl-1.2.6}
if [ -r "$MUSL/lib/musl-gcc.specs" ]; then
  rm -rf "$d/mv"; mkdir -p "$d/mv"
  eval /usr/bin/gcc -specs "$MUSL/lib/musl-gcc.specs" -static -O2 -Wall -Wextra -Wno-unused-function -Wno-unused-result $MVDEFS -o "$d/hm" "$d/h.c"
  "$d/hm" && echo "dominit handoff (musl, as the image links it): PASS"
else
  echo "dominit handoff (musl): SKIPPED, no musl at $MUSL (sh isolation/m2/build-musl.sh)"
fi
