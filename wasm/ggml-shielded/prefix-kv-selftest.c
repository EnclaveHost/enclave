/* prefix-kv-selftest: the signed sidecar of a shared-prefix KV artifact
 * (prefix-kv.h) opens only for the platform's key, this model, this exact
 * prefix text and this exact file; anything else is refused before a byte
 * of state would be loaded. Runs from `make all`; shielded-cbackend.test.mjs
 * asserts the line it prints. */
#include "prefix-kv.h"
#include "shielded-pads.h"
#include "tweetnacl.h"
#include <assert.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#ifdef SH_PREFIX_TEST_IO
static int io_mode, io_calls, mutation_fd = -1;
ssize_t __real_pread(int, void *, size_t, off_t);
ssize_t __wrap_pread(int fd, void *buf, size_t n, off_t off) {
    io_calls++;
    if (io_mode == 1 && io_calls == 1) { errno = EINTR; return -1; }
    if (io_mode == 2 && io_calls == 2) return 0;
    if (io_mode == 3) { errno = EIO; return -1; }
    if (n > 997) n = 997; // force actual short reads
    const ssize_t r = __real_pread(fd, buf, n, off);
    if (io_mode == 4 && io_calls == 1) {
        uint8_t byte = 1;
        assert(mutation_fd >= 0 && pwrite(mutation_fd, &byte, 1, 50000) == 1);
    }
    return r;
}
#endif

int main(void) {
    char dir[] = "/tmp/prefix-kv-selftest-XXXXXX";
    assert(mkdtemp(dir));
    char kv[600]; snprintf(kv, sizeof kv, "%s/prefix.kv", dir);
    /* a stand-in artifact: the sidecar binds the file's bytes, not its meaning */
    { FILE *f = fopen(kv, "wb"); assert(f); for (int i = 0; i < 100000; i++) fputc((i * 7) & 0xff, f); fclose(f); }
    uint8_t pk[32], sk[64], pk2[32], sk2[64];
    crypto_sign_keypair(pk, sk); crypto_sign_keypair(pk2, sk2);
    uint8_t model[32]; for (int i = 0; i < 32; i++) model[i] = (uint8_t)(i * 3);
    const char *prefix = "You are a terse assistant.\nUser:";
    char err[256]; uint64_t n = 0;

    assert(sh_prefix_kv_sign(kv, model, prefix, strlen(prefix), 25, sk, err, sizeof err) == 0);
    assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0 && n == 25);

    /* State-file envelope checks precede llama parsing; all views stay within
     * the retained bytes, and the embedded count must equal the signed count. */
    {
        uint8_t bytes[] = {0x67,0x67,0x73,0x71, 2,0,0,0, 2,0,0,0, 7,0,0,0, 11,0,0,0, 1,2,3};
        sh_prefix_kv_snapshot snap = {bytes, sizeof bytes, 2};
        const uint8_t *state = NULL; size_t len = 0;
        const uint32_t magic = 0x71736767;
        assert(sh_prefix_kv_snapshot_state(&snap, magic, 2, 12, &state, &len, err, sizeof err) == 0);
        assert(state == bytes + 20 && len == 3);
        for (int mode = 0; mode < 7; mode++) {
            sh_prefix_kv_snapshot bad = snap;
            if (mode == 0) bad.size = 11;
            if (mode == 1) bad.size = 19;
            if (mode == 2) bad.size = 20;
            if (mode == 3) bad.n_tokens++;
            assert(sh_prefix_kv_snapshot_state(&bad, magic + (mode == 4), 2 + (mode == 5),
                                               mode == 6 ? 11 : 12, &state, &len, err, sizeof err) != 0);
            assert(!state && !len);
        }
    }

    /* by descriptor: the inode the consumer holds is what is verified, even after the name is taken by another file */
    {
        int fd = open(kv, O_RDONLY); assert(fd >= 0);
        assert(sh_prefix_kv_verify_fd(kv, fd, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0 && n == 25);
        char other[600]; snprintf(other, sizeof other, "%s/other.kv", dir);
        { FILE *f = fopen(other, "wb"); assert(f); for (int i = 0; i < 100000; i++) fputc((i * 11) & 0xff, f); fclose(f); }
        assert(rename(other, kv) == 0);                                                     /* the name now means other bytes */
        assert(sh_prefix_kv_verify_fd(kv, fd, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0);      /* the held inode still verifies */
        assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "does not match"));   /* the name does not */
        char fdpath[64]; snprintf(fdpath, sizeof fdpath, "/proc/self/fd/%d", fd);
        FILE *f = fopen(fdpath, "rb"); assert(f); int c0 = fgetc(f); fclose(f); assert(c0 == 0);                   /* unchanged inode in this test; does not prove later-read integrity */
        close(fd);
        /* put the signed file back for the cases below */
        { FILE *g = fopen(kv, "wb"); assert(g); for (int i = 0; i < 100000; i++) fputc((i * 7) & 0xff, g); fclose(g); }
        assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0);
    }

    /* Retain authenticated bytes; changing the SAME inode after verification
     * cannot affect what the state loader consumes. FD-only verification did
     * not provide this guarantee. Every failure leaves an empty snapshot. */
    {
        int fd = open(kv, O_RDONLY), writer = open(kv, O_RDWR); assert(fd >= 0 && writer >= 0);
        sh_prefix_kv_snapshot snap = {0};
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 99999, 25, &snap, err, sizeof err) != 0);
        assert(!snap.bytes && !snap.size && !snap.n_tokens);
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 24, &snap, err, sizeof err) != 0);
        assert(!snap.bytes && !snap.size && !snap.n_tokens);
        assert(lseek(fd, 7, SEEK_SET) == 7);
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 25, &snap, err, sizeof err) == 0);
        assert(snap.size == 100000 && snap.n_tokens == 25 && lseek(fd, 0, SEEK_CUR) == 7);
        uint8_t changed = 1;
        assert(pwrite(writer, &changed, 1, 50000) == 1);
        for (size_t i = 0; i < snap.size; i++) assert(snap.bytes[i] == ((i * 7) & 0xff));
        sh_prefix_kv_snapshot_free(&snap);
        assert(!snap.bytes && !snap.size && !snap.n_tokens);
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 25, &snap, err, sizeof err) != 0);
        assert(!snap.bytes && !snap.size && !snap.n_tokens);
        changed = (50000 * 7) & 0xff; assert(pwrite(writer, &changed, 1, 50000) == 1);
#ifdef SH_PREFIX_TEST_IO
        io_calls = 0; io_mode = 1;
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 25, &snap, err, sizeof err) == 0);
        assert(io_calls > 100); sh_prefix_kv_snapshot_free(&snap);
        for (int mode = 2; mode <= 4; mode++) {
            io_calls = 0; io_mode = mode; mutation_fd = writer;
            assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 25, &snap, err, sizeof err) != 0);
            assert(!snap.bytes && !snap.size && !snap.n_tokens);
        }
        io_mode = 0; mutation_fd = -1;
        assert(pwrite(writer, &changed, 1, 50000) == 1);
#endif
        assert(ftruncate(writer, 1000) == 0);
        assert(sh_prefix_kv_snapshot_read(kv, fd, pk, model, prefix, strlen(prefix), 100000, 25, &snap, err, sizeof err) != 0);
        close(writer); close(fd);
        { FILE *g = fopen(kv, "wb"); assert(g); for (int i = 0; i < 100000; i++) fputc((i * 7) & 0xff, g); fclose(g); }
        assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0);
    }

    /* wrong key */
    assert(sh_prefix_kv_verify(kv, pk2, model, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "REJECTED"));
    /* another model */
    uint8_t model2[32]; memcpy(model2, model, 32); model2[0] ^= 1;
    assert(sh_prefix_kv_verify(kv, pk, model2, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "another model"));
    /* another prefix text (one byte) */
    assert(sh_prefix_kv_verify(kv, pk, model, "You are a terse assistant.\nUser:!", strlen(prefix) + 1, &n, err, sizeof err) != 0 && strstr(err, "another prefix"));
    /* the file changes under its signature */
    { FILE *f = fopen(kv, "r+b"); assert(f); fseek(f, 50000, SEEK_SET); int c = fgetc(f); fseek(f, 50000, SEEK_SET); fputc(c ^ 1, f); fclose(f); }
    assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "does not match"));
    { FILE *f = fopen(kv, "r+b"); assert(f); fseek(f, 50000, SEEK_SET); int c = fgetc(f); fseek(f, 50000, SEEK_SET); fputc(c ^ 1, f); fclose(f); }
    assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) == 0);
    /* the sidecar's token count changes under its signature */
    { char side[700]; snprintf(side, sizeof side, "%s.sig", kv); FILE *f = fopen(side, "r+b"); assert(f);
      char buf[1024]; size_t got = fread(buf, 1, sizeof buf - 1, f); buf[got] = 0; char *t = strstr(buf, "tokens 25"); assert(t); t[7] = '2'; t[8] = '6';
      rewind(f); fwrite(buf, 1, got, f); fclose(f); }
    assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "REJECTED"));
    /* no sidecar at all */
    { char side[700]; snprintf(side, sizeof side, "%s.sig", kv); unlink(side); }
    assert(sh_prefix_kv_verify(kv, pk, model, prefix, strlen(prefix), &n, err, sizeof err) != 0 && strstr(err, "no sidecar"));

    char cmd[700]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); (void)!system(cmd);
    printf("prefix-kv-selftest: ok\n");
    return 0;
}
