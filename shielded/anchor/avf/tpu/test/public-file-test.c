/* public-file-test.c -- the payload's REAL public-file receiver (payload/anchor_public_file.h), driven over a socketpair into
 * a temporary directory standing in for the encrypted store.
 *
 * The property under test is the one the int4 runs broke: the VM answers 'K' (reuse the stored copy) ONLY when the stored
 * bytes are the announced file. Every call below is checked for it -- whenever apf_receive returns 0, the stored file's
 * SHA-256 is recomputed here and must equal what was announced -- including after a simulated power loss at each step
 * (APF_CRASH), after an unlink that fails, after a leftover .part, and after the stored copy is altered in place.
 *
 *   cc -std=c11 -D_GNU_SOURCE -Ipayload tpu/test/public-file-test.c payload/anchor_pins.c -o pft && ./pft */
#include <stdio.h>
#include <stdlib.h>
#include <sys/socket.h>
#include <sys/wait.h>
static int g_crash = 0;
#define APF_CRASH(n) (g_crash == (n))
#include "anchor_public_file.h"

static int checks = 0, fails = 0;
static void expect(int ok, const char *what) { checks++; if (!ok) { fails++; printf("FAIL %s\n", what); } }
static void quiet(const char *line) { (void)line; }
static char dir[256], path[300];
enum { N = 3 << 20 };                                      /* crosses the receiver's 1 MiB buffer three times */
static uint8_t A[N], B[N];

static int file_is(const uint8_t *want) {
    FILE *f = fopen(path, "rb"); if (!f) return 0; static uint8_t got[N + 1]; size_t n = fread(got, 1, N + 1, f); fclose(f);
    return n == N && memcmp(got, want, N) == 0;
}
static int exists(const char *p) { struct stat sb; return stat(p, &sb) == 0; }

/* The owner's side, in a child: header (size, magic, announced digest), read the answer, and on 'S' send `send` bytes of
 * `body` and hang up. The answer comes back through the child's exit status. */
static int call(const uint8_t *body, const uint8_t announced[32], size_t send, uint64_t hdr_size, int *answer) {
    int sp[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, sp)) exit(2);
    pid_t pid = fork();
    if (pid == 0) {
        close(sp[0]); uint64_t h = hdr_size; char a = 0;
        if (write(sp[1], &h, 8) != 8 || write(sp[1], body, 8) != 8 || write(sp[1], announced, 32) != 32) _exit(9);
        if (read(sp[1], &a, 1) != 1) _exit(8);
        if (a == 'S') for (size_t o = 0; o < send; ) { ssize_t w = write(sp[1], body + o, send - o > 65536 ? 65536 : send - o); if (w <= 0) break; o += (size_t)w; }
        close(sp[1]); _exit(a == 'K' ? 1 : a == 'S' ? 2 : 7);
    }
    close(sp[1]);
    const int r = apf_receive(sp[0], N, path, "t", quiet);
    close(sp[0]); int st = 0; waitpid(pid, &st, 0);
    *answer = WIFEXITED(st) ? WEXITSTATUS(st) : -1;
    /* THE property, on every call: a reuse means the stored bytes are the announced file */
    if (r == 0) { uint8_t have[32]; uint64_t hb = 0; int fd = open(path, O_RDONLY);
                  expect(fd >= 0 && anchor_sha256_fd(fd, have, &hb) == 0 && hb == N && memcmp(have, announced, 32) == 0, "a 'K' was answered for bytes that are not the announced file");
                  if (fd >= 0) close(fd); }
    return r;
}

int main(void) {
    snprintf(dir, sizeof dir, "/tmp/pft.%d", (int)getpid()); mkdir(dir, 0700); snprintf(path, sizeof path, "%s/tpu.bundle", dir);
    char part[320]; snprintf(part, sizeof part, "%s.part", path);
    for (size_t i = 0; i < N; i++) { A[i] = (uint8_t)(i * 2654435761u >> 13); B[i] = A[i]; }
    B[N - 1] ^= 0x5a; B[N / 2] ^= 1;                        /* same size, same first 8 bytes (the magic), different file */
    uint8_t ha[32], hb[32]; anchor_sha256(A, N, ha); anchor_sha256(B, N, hb);
    int ans, r;

    r = call(A, ha, N, N, &ans); expect(r == 1 && ans == 2 && file_is(A), "a fresh store streams A");
    r = call(A, ha, N, N, &ans); expect(r == 0 && ans == 1 && file_is(A), "A again is reused (K)");
    r = call(B, hb, N, N, &ans); expect(r == 1 && ans == 2 && file_is(B), "same size + same magic + different content: RESTREAMED");
    r = call(A, ha, N, N, &ans); expect(r == 1 && ans == 2 && file_is(A), "and back again: restreamed, not reused");

    unlink(path);                                          /* an empty store, so the announced digest must be STREAMED */
    r = call(B, ha, N, N, &ans); expect(r == -1 && !exists(path) && !exists(part), "bytes that are not the announced digest: REFUSED, nothing kept");
    r = call(A, ha, N / 2, N, &ans); expect(r == -1 && !exists(path) && !exists(part), "a truncated stream: REFUSED, nothing kept");
    r = call(A, ha, N, N + 1, &ans); expect(r == -1, "a header announcing another size: refused");
    r = call(A, ha, N, N, &ans); expect(r == 1 && file_is(A), "after refusals the next call restreams");

    { int fd = open(path, O_WRONLY); expect(fd >= 0 && pwrite(fd, "\xff", 1, N / 3) == 1, "alter the stored copy in place"); if (fd >= 0) close(fd); }
    r = call(A, ha, N, N, &ans); expect(r == 1 && ans == 2 && file_is(A), "a stored copy altered in place (same size, same magic): not reused");

    /* a power loss at every step, then every possible next call: never a K for other bytes (checked inside call()) */
    for (int cp = 1; cp <= 4; cp++) {
        for (int first = 0; first < 2; first++) {
            g_crash = 0; r = call(A, ha, N, N, &ans);                        /* start from a good stored A */
            g_crash = cp; r = call(first ? B : A, first ? hb : ha, N, N, &ans);
            if (cp == 1 && !first) { int fd = open(path, O_WRONLY); if (fd >= 0) { (void)!pwrite(fd, "\x01", 1, 7); close(fd); } }
            g_crash = 0;
            char w[96]; snprintf(w, sizeof w, "crash at step %d (%s), then A: served correctly", cp, first ? "restreaming B" : "reusing A");
            r = call(A, ha, N, N, &ans); expect(r >= 0 && file_is(A), w);
            snprintf(w, sizeof w, "crash at step %d (%s), then B: served correctly", cp, first ? "restreaming B" : "reusing A");
            r = call(B, hb, N, N, &ans); expect(r >= 0 && file_is(B), w);
        }
    }
    g_crash = 0;

    /* a leftover .part from an earlier death does not leak into the next stream */
    { FILE *f = fopen(part, "wb"); fwrite(B, 1, N / 2, f); fclose(f); }
    r = call(A, ha, N, N, &ans); expect(r == 1 && file_is(A) && !exists(part), "a stale .part is overwritten, never renamed in");

    /* an unlink that FAILS must refuse, not stream past a copy it could not remove */
    r = call(A, ha, N, N, &ans);
    if (geteuid() != 0) {
        chmod(dir, 0500);
        r = call(B, hb, N, N, &ans); expect(r == -1 && ans != 1, "cannot remove the stored copy: refused, no K");
        chmod(dir, 0700);
        r = call(B, hb, N, N, &ans); expect(r == 1 && file_is(B), "and once it can, B is streamed");
    } else printf("(running as root: the unlink-failure case cannot be provoked by permissions; skipped)\n");

    unlink(path); unlink(part); rmdir(dir);
    printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails);
    return fails ? 1 : 0;
}
