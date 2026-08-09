/* enclave/SET round-14 probe: after a worker TRAPS inside `vfprintf(stderr,...)`,
 * a LIVE sibling's own `fprintf(stderr, "%s"/"%d", ...)` output is silently
 * discarded until an 80-byte window overflows.
 *
 * ============================ UNRESOLVED ============================
 * ROUND 14 DID NOT SETTLE THIS. Committed so round 15 starts from the
 * evidence rather than from the claim. DO NOT treat the header below as
 * established, and DO NOT change musl's buffer handling on the strength of
 * it without a run that reproduces.
 *
 * Its author reported this file measuring byte loss on r10f, r12a AND r13c
 * alike (burst-trap -> 0,0,0), concluding the round-12 dead-stack detach is
 * INCOMPLETE: it sets `f->buf = 0` while `buf_size == 0`, violating musl's
 * invariant that an unbuffered stream has a non-NULL `buf`, so `vfprintf`
 * reads `saved_buf == 0` and skips both its terminal flush and its restore.
 *
 * What the orchestrator measured, running THIS file as committed:
 *
 *     r14a  exit 0   one-trap: bytes_in_file=29 marker=1 PRESENT
 *     r13c  exit 0   (same)
 *     r10f  exit 1   one-trap: bytes_in_file=0  marker=0 LOST
 *
 * That is the OPPOSITE conclusion: the current image SURVIVES and only the
 * pre-detach image loses, i.e. round 12's detach fixed this rather than half-
 * fixing it. An earlier probe from the same author (worker-stderr-detach-loss.c,
 * not committed) discriminated nothing at all -- marker PRESENT on r13c, r12a
 * and r10f.
 *
 * So either the file that landed here is not the revision that produced the
 * reported table, or the analysis is wrong. Both are possible and neither is
 * established. The mechanism is plausible on a reading of musl's vfprintf,
 * which is why this is OPEN rather than rejected.
 *
 * To settle it, in this order:
 *   1. Re-run this file as committed and see which table you get.
 *   2. If the loss reproduces, the decisive A/B is a libc built with ONLY the
 *      detach hunk in ftrylockfile.c reverted -- not r10f, which differs in
 *      many other ways.
 *   3. Only then consider the proposed fix (restore a valid non-stack buffer,
 *      `f->buf = fallback + UNGET; f->buf_size = 0;`, mirroring stderr.c's own
 *      initialisation) -- and note a SHARED fallback buffer is only safe
 *      because `buf_size == 0` forces every writer to swap away before
 *      writing, which needs checking against a readable unbuffered stream
 *      where the UNGET area is live.
 *
 * There is no native control for this shape: natively a trap kills the
 * process, so no sibling survives to observe anything. The in-image control is
 * the no-trap arm.
 * ====================================================================
 *
 * TWO TRAPS FOR ANYONE EXTENDING THIS PROBE, both of which produced a
 * false PASS in an earlier draft:
 *
 *  1. `fprintf(f, "literal")` with NO conversion specifier is optimised by
 *     clang into `fwrite`/`fputs`, which NEVER ENTERS `vfprintf`. On an
 *     unbuffered stream in the broken state (`buf==0, wend==wpos==0`),
 *     `__fwritex` takes its `l > f->wend - f->wpos` branch and writes
 *     STRAIGHT to the fd -- so the bytes land and the defect is invisible.
 *     Every write under test here therefore carries a real conversion.
 *  2. A trailing `fflush(stderr)` drains the stranded buffer and masks the
 *     effect. There is deliberately no fflush anywhere below.
 *
 * MECHANISM. `stderr` is unbuffered (`buf_size == 0`), so `vfprintf`
 * (vfprintf.c:720-734) swaps `f->buf` to an 80-byte `internal_buf` in its own
 * stack frame, runs `printf_core`, then flushes and restores:
 *
 *     if (!f->buf_size) { saved_buf = f->buf; f->buf = internal_buf;
 *                         f->buf_size = 80; wpos=wbase=wend=0; }
 *     ret = printf_core(f, ...);
 *     if (saved_buf) { f->write(f,0,0); f->buf = saved_buf; f->buf_size = 0; }
 *
 * A `%s` argument is dereferenced only in the SECOND printf_core pass
 * (vfprintf.c:566 `if (!f) continue;`, `case 's'`/strnlen at :635) -- after
 * the swap and after FLOCK. So an OOB `%s` traps with the shared stderr
 * locked and its `buf` inside the dying thread's stack. Confirmed by the
 * engine's own backtrace: memchr <- strnlen <- printf_core <- vfprintf.
 *
 * The death hook's dead-stack detach (ftrylockfile.c:50-55, added in round 12)
 * then sets `f->buf = 0; f->buf_size = 0; wpos = wbase = wend = 0;`.
 * `buf == 0` with `buf_size == 0` violates musl's invariant that an unbuffered
 * stream has a non-NULL buf (stderr.c statically sets `.buf = buf+UNGET`), so
 * in every later `vfprintf` `saved_buf` is 0 and the terminal flush AND the
 * restore are both skipped: the bytes stay in the caller's own dead frame and
 * `stderr` is left with `buf_size == 80` pointing at popped stack.
 *
 * ARMS (argv[1]). Each `*-trap` arm has a byte-identical `*-ok` control that
 * differs ONLY in whether the worker trapped, so the probe discriminates
 * within a single image:
 *
 *   one-ok    / one-trap    : one `fprintf(stderr, "%s", MARKER)`.
 *                             control -> 29 bytes; trap -> 0 bytes (LOST).
 *   burst-ok  / burst-trap  : three 38-byte `%d` writes, file size sampled
 *                             after each. THIS IS THE DISCRIMINATING ARM.
 *                             MEASURED, r10f / r12a / r13c all identical:
 *                               control -> 38, 76, 114 (each write self-flushes)
 *                               trap    -> 0, 0, 0     (every byte discarded,
 *                                          with fprintf reporting success)
 *                             Also reports whether "WORKERPFX" -- bytes the
 *                             dying worker had already placed in the buffer --
 *                             reappears in the file.
 *   state-ok  / state-trap  : read stderr's own fields through `file_mirror`
 *                             before and after, which answers "did the detach
 *                             fire?" mechanically rather than by inference.
 *                             MEASURED:
 *                               r10f (pre-detach): buf=0x212c0 buf_size=80
 *                                    wpos=wbase+10 -- i.e. still pointing into
 *                                    the DEAD WORKER's stack, holding its
 *                                    10-byte "WORKERPFX-" (this is exactly the
 *                                    round-12 dead-stack finding)
 *                               r12a, r13c:        buf=0x0 buf_size=0
 *                                    -- the detach fired and zeroed it
 *                               either way a healthy stream reads
 *                                    buf=0x10f68 buf_size=0 (the static buffer)
 *
 * Verdicts go to fd 1 via write(2) only, so the verdict never depends on the
 * stdio state under test. Exit 0 = behaved as a healthy stream, 2 = bytes lost.
 *
 * Build: docker run --rm -v "$PWD":/src enclave-wasipsetc-build:r13c \
 *            worker-stderr-vfprintf-state.c -O2 -o wsvs.wasm
 * Run:   wasmtime run -W threads,shared-everything-threads,\
 *            component-model-threading,shared-memory -S cli --dir .::/d \
 *            wsvs.wasm <arm>
 */
#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>

#define MARKER "MARKER-AFTER-TRAP-0123456789\n"   /* 29 bytes: < 80 */

/* Mirror of musl's `struct _IO_FILE` prefix for wasm32, taken from
 * libc-top-half/musl/src/internal/stdio_impl.h with the two
 * `__wasilibc_unmodified_upstream` back-compat fields absent (WASI drops
 * them). Read-only, and only in the `state` arm: it is how this probe answers
 * "did the detach fire?" mechanically instead of inferring it from behaviour. */
struct file_mirror {
    unsigned flags;                 /*  0 */
    unsigned char *rpos, *rend;     /*  4,  8 */
    void *close;                    /* 12 */
    unsigned char *wend, *wpos;     /* 16, 20 */
    unsigned char *wbase;           /* 24 */
    void *read_fn, *write_fn, *seek_fn; /* 28, 32, 36 */
    unsigned char *buf;             /* 40 */
    size_t buf_size;                /* 44 */
};

static volatile unsigned long g_worker_frame;   /* an address in the worker's stack */

static int readfd = -1;      /* independent offset; NOT a dup of fd 2 */

static void say(const char *s) { write(1, s, strlen(s)); }

static void sayf(const char *fmt, long a, long b, long c)
{
    char t[256];
    int n = snprintf(t, sizeof t, fmt, a, b, c);  /* memory FILE: no fd */
    if (n > 0) write(1, t, (size_t)n);
}

static long file_bytes(char *out, size_t outsz)
{
    if (lseek(readfd, 0, SEEK_SET) < 0) return -1;
    ssize_t r = read(readfd, out, outsz - 1);
    if (r < 0) r = 0;
    out[r] = 0;
    return (long)r;
}

static void *worker_normal(void *arg)
{
    (void)arg;
    fprintf(stderr, "%s", "worker-normal-use");    /* same shape, no trap */
    return 0;
}

static void *worker_trap(void *arg)
{
    (void)arg;
    /* First byte past linear memory. strnlen() traps here inside printf_core's
     * SECOND pass, with stderr locked and stderr->buf pointing at this frame's
     * internal_buf -- into which "WORKERPFX-" has already been deposited. */
    char here;
    g_worker_frame = (unsigned long)(uintptr_t)&here;   /* this worker's stack */
    size_t bytes = (size_t)__builtin_wasm_memory_size(0) * 65536u;
    volatile char *oob = (char *)(bytes + 4096);
    fprintf(stderr, "WORKERPFX-%s", (char *)oob);
    return 0;                                      /* unreachable */
}

static void dump_stderr_state(const char *when)
{
    const struct file_mirror *f = (const struct file_mirror *)(const void *)stderr;
    say("  stderr ");
    say(when);
    sayf(": buf=0x%lx buf_size=%lu wbase=0x%lx",
         (long)(uintptr_t)f->buf, (long)f->buf_size, (long)(uintptr_t)f->wbase);
    sayf(" wpos=0x%lx wend=0x%lx flags=0x%lx\n",
         (long)(uintptr_t)f->wpos, (long)(uintptr_t)f->wend, (long)f->flags);
}

int main(int argc, char **argv)
{
    const char *arm = argc > 1 ? argv[1] : "one-trap";
    int is_trap  = strstr(arm, "-trap") != 0;
    int is_burst = strncmp(arm, "burst", 5) == 0;

    char path[64];
    snprintf(path, sizeof path, "/d/wsvs-%s.log", arm);

    int wfd = open(path, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (wfd < 0) { say("open(w) failed\n"); return 1; }
    /* Route fd 2 into the file. On the main thread this also claims the shared
     * stderr FILE for main, so main -- the thread whose post-trap write is
     * under test -- is its legitimate owner and is never refused. */
    if (dup2(wfd, 2) < 0) { say("dup2 failed\n"); return 1; }
    /* Separate descriptor for reading: a dup shares the file offset, and
     * seeking it would move where stderr's next write lands. */
    readfd = open(path, O_RDONLY);
    if (readfd < 0) { say("open(r) failed\n"); return 1; }

    int is_state = strncmp(arm, "state", 5) == 0;
    if (is_state) dump_stderr_state("before");

    pthread_t t;
    if (pthread_create(&t, 0, is_trap ? worker_trap : worker_normal, 0) != 0)
        return 1;
    pthread_join(t, 0);              /* the death hook runs during this join */

    if (is_state) {
        dump_stderr_state("after ");
        const struct file_mirror *f = (const struct file_mirror *)(const void *)stderr;
        sayf("  worker stack frame was near 0x%lx%.0s%.0s\n",
             (long)g_worker_frame, 0L, 0L);
        if (f->buf == 0 && f->buf_size == 0)
            say("  VERDICT: buf==NULL with buf_size==0 -> the round-12 detach FIRED,\n"
                "           and this state breaks vfprintf's swap/restore invariant\n");
        else if ((unsigned long)(uintptr_t)f->buf > g_worker_frame - 4096 &&
                 (unsigned long)(uintptr_t)f->buf < g_worker_frame + 4096)
            say("  VERDICT: buf still points into the DEAD WORKER's stack -> detach did NOT fire\n");
        else
            say("  VERDICT: buf looks intact -> stderr was left healthy\n");
        return 0;
    }

    char got[1024];

    if (is_burst) {
        long sz[3];
        for (int i = 0; i < 3; i++) {
            fprintf(stderr, "CHUNK%d-890123456789012345678901234567\n", i);
            sz[i] = file_bytes(got, sizeof got);
        }
        long fin = file_bytes(got, sizeof got);
        int pfx = strstr(got, "WORKERPFX") != 0;
        say(arm);
        sayf(": after#1=%ld after#2=%ld after#3=%ld", sz[0], sz[1], sz[2]);
        sayf(" final=%ld WORKERPFX=%ld%.0s\n", fin, (long)pfx, 0L);
        /* Healthy: an unbuffered stream makes each write visible immediately. */
        int healthy = (sz[0] == 38);
        say(healthy ? "  -> self-flushed (healthy)\n"
                    : "  -> LOST: formatted stderr output silently discarded\n");
        return healthy ? 0 : 2;
    }

    /* one-ok / one-trap: a single short write THROUGH vfprintf, no fflush. */
    fprintf(stderr, "%s", MARKER);

    long n = file_bytes(got, sizeof got);
    int ok = strstr(got, "MARKER-AFTER-TRAP-0123456789") != 0;
    say(arm);
    sayf(": bytes_in_file=%ld marker=%ld%.0s", n, (long)ok, 0L);
    say(ok ? " PRESENT\n" : " LOST\n");
    return ok ? 0 : 2;
}
