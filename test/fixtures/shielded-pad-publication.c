#define _GNU_SOURCE
#include <assert.h>
#include <errno.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

static int write_mode, write_calls, sync_fail_fd = -1, close_fail_fd = -1;
static ssize_t fault_pwrite(int, const void *, size_t, off_t);
static int fault_fsync(int), fault_close(int);
#define pwrite fault_pwrite
#define fsync fault_fsync
#define close fault_close
#include "../../wasm/ggml-shielded/shielded-pads.c"
#undef pwrite
#undef fsync
#undef close

static ssize_t fault_pwrite(int fd, const void *buf, size_t bytes, off_t off) {
    if (write_mode) {
        write_calls++;
        if (write_mode == 1 && write_calls == 1) {errno = EINTR; return -1;}
        if (write_mode == 2) return 0;
        if (write_mode == 3 && write_calls > 1) {errno = EIO; return -1;}
        if (bytes > 7) bytes = 7;
    }
    return pwrite(fd, buf, bytes, off);
}
static int fault_fsync(int fd) {
    if (fd == sync_fail_fd) {errno = EIO; return -1;}
    return fsync(fd);
}
static int fault_close(int fd) {
    int rc = close(fd);
    if (fd == close_fail_fd) {errno = EIO; return -1;}
    return rc;
}

enum { GROUPS = 3, ROWS = 17, WIDTH = 7 };
static uint8_t digest[32], seed_id[16], pk[32], sk[32];
static sh_pads_group groups[GROUPS];

static void values(uint64_t row, uint32_t group, int32_t u[WIDTH]) {
    for (unsigned i = 0; i < WIDTH; i++) u[i] = (int32_t)(row * 13 + group * 17 + i) - 100;
}
static sh_pads_writer *writer(const char *path, unsigned rows) {
    int err = 123;
    sh_pads_writer *w = sh_pads_writer_open(path, digest, seed_id, groups, GROUPS, 10, rows, pk, &err);
    assert(w && err == SH_OK && access(path, F_OK) != 0);
    struct stat st; assert(fstat(w->fd, &st) == 0 && (st.st_mode & 0777) == 0600);
    assert(fcntl(w->fd, F_GETFD) & FD_CLOEXEC);
    return w;
}
static void all(sh_pads_writer *w, unsigned rows) {
    int32_t u[WIDTH];
    for (unsigned row = 10; row < 10 + rows; row++) for (unsigned g = 0; g < GROUPS; g++) {
        values(row, g, u); assert(sh_pads_writer_cell(w, row, g, u) == SH_OK);
    }
}
static void verify(const char *dir, unsigned rows) {
    int err = 123;
    sh_pads_reader *r = sh_pads_reader_open(dir, seed_id, sk, &err);
    assert(r && err == SH_OK && sh_pads_reader_bind(r, groups, GROUPS) == SH_OK);
    int32_t got[WIDTH], expected[WIDTH];
    for (unsigned row = 10; row < 10 + rows; row++) for (unsigned g = 0; g < GROUPS; g++) {
        values(row, g, expected); assert(sh_pads_reader_cell(r, g, row, got) == SH_OK);
        assert(!memcmp(got, expected, sizeof got));
    }
    sh_pads_reader_close(r);
}
static unsigned cleanup_temps(const char *dir) {
    DIR *d = opendir(dir); assert(d); struct dirent *e; unsigned count = 0;
    while ((e = readdir(d))) if (strstr(e->d_name, ".tmp.")) {
        char p[1024]; snprintf(p, sizeof p, "%s/%s", dir, e->d_name);
        assert(unlink(p) == 0); count++;
    }
    closedir(d); return count;
}
typedef struct {sh_pads_writer *w; unsigned group; int duplicate, rc;} task;
static void *write_thread(void *arg) {
    task *t = (task *)arg; const size_t n = sh_pads_writer_scratch_bytes(t->w);
    uint8_t *plain = (uint8_t *)malloc(n), *cell = (uint8_t *)malloc(n);
    assert(plain && cell); int32_t u[WIDTH]; t->rc = SH_OK;
    for (int row = t->duplicate ? 10 : 10 + ROWS - 1; row >= 10; row--) {
        values((unsigned)row, t->group, u);
        t->rc = sh_pads_writer_cell_with(t->w, (unsigned)row, t->group, u, plain, cell);
        if (t->rc != SH_OK) break;
    }
    free(plain); free(cell); return NULL;
}

int main(int argc, char **argv) {
    assert(argc == 2); const char *dir = argv[1]; char path[1024];
    snprintf(path, sizeof path, "%s/ship.pads", dir);
    crypto_box_keypair(pk, sk);
    for (unsigned g = 0; g < GROUPS; g++) {
        groups[g].group = g; groups[g].K = 16; groups[g].u_len = WIDTH;
        snprintf(groups[g].name, sizeof groups[g].name, "group.%u", g);
    }
    /* Neither an empty file nor a partially completed file can be published. */
    sh_pads_writer *w = writer(path, 1);
    assert(sh_pads_writer_close(w) == SH_ERR_RANGE && access(path, F_OK) != 0);
    assert(cleanup_temps(dir) == 0);
    w = writer(path, 1); int32_t u[WIDTH]; values(10, 0, u);
    assert(sh_pads_writer_cell(w, 10, 0, u) == SH_OK);
    assert(sh_pads_writer_close(w) == SH_ERR_RANGE && access(path, F_OK) != 0);

    /* Short writes/EINTR resume the SAME ciphertext, including header writes. */
    write_mode = 1; write_calls = 0; w = writer(path, ROWS); all(w, ROWS);
    assert(write_calls > GROUPS * ROWS && access(path, F_OK) != 0);
    write_mode = 0;
    assert(sh_pads_writer_close(w) == SH_OK); verify(dir, ROWS);
    int err = 0;
    assert(!sh_pads_writer_open(path, digest, seed_id, groups, GROUPS, 10, 1, pk, &err));
    assert(err == SH_ERR_IO); verify(dir, ROWS); assert(unlink(path) == 0);

    /* A duplicate claim cannot overwrite or reseal even an already complete file. */
    w = writer(path, 1); all(w, 1);
    uint8_t before[37], after[37];
    assert(pread(w->fd, before, sizeof before, (off_t)w->hdr.data_off) == sizeof before);
    values(10, 0, u); u[0]++;
    assert(sh_pads_writer_cell(w, 10, 0, u) == SH_ERR_RANGE);
    assert(pread(w->fd, after, sizeof after, (off_t)w->hdr.data_off) == sizeof after);
    assert(!memcmp(before, after, sizeof before));
    assert(sh_pads_writer_close(w) == SH_ERR_RANGE && access(path, F_OK) != 0);

    for (int mode = 2; mode <= 3; mode++) {
        w = writer(path, 1); values(10, 0, u); write_mode = mode; write_calls = 0;
        assert(sh_pads_writer_cell(w, 10, 0, u) == SH_ERR_IO); write_mode = 0;
        assert(sh_pads_writer_cell(w, 10, 1, u) == SH_ERR_IO);
        assert(sh_pads_writer_close(w) == SH_ERR_IO && access(path, F_OK) != 0);
    }
    w = writer(path, 1); values(10, 0, u); u[3] = INT32_MAX;
    assert(sh_pads_writer_cell(w, 10, 0, u) == SH_ERR_RANGE);
    assert(sh_pads_writer_close(w) == SH_ERR_RANGE && access(path, F_OK) != 0);
    for (int failure = 0; failure < 3; failure++) {
        w = writer(path, 1); all(w, 1);
        if (failure == 0) sync_fail_fd = w->fd;
        if (failure == 1) close_fail_fd = w->fd;
        if (failure == 2) sync_fail_fd = w->dirfd;
        assert(sh_pads_writer_close(w) == SH_ERR_IO);
        sync_fail_fd = close_fail_fd = -1;
        if (failure == 2) {verify(dir, 1); assert(unlink(path) == 0);}
        else assert(access(path, F_OK) != 0);
    }
    /* Concurrent publications never replace a destination that appeared later. */
    w = writer(path, 1); all(w, 1);
    FILE *existing = fopen(path, "wb"); assert(existing);
    assert(fwrite("existing", 1, 8, existing) == 8 && fclose(existing) == 0);
    assert(sh_pads_writer_close(w) == SH_ERR_IO);
    existing = fopen(path, "rb"); assert(existing); char saved[8];
    assert(fread(saved, 1, 8, existing) == 8 && !memcmp(saved, "existing", 8));
    fclose(existing); assert(unlink(path) == 0);

    w = writer(path, ROWS); pthread_t threads[GROUPS]; task tasks[GROUPS];
    for (unsigned g = 0; g < GROUPS; g++) {tasks[g] = (task){w, g, 0, 123}; assert(!pthread_create(&threads[g], NULL, write_thread, &tasks[g]));}
    for (unsigned g = 0; g < GROUPS; g++) {assert(!pthread_join(threads[g], NULL)); assert(tasks[g].rc == SH_OK);}
    assert(sh_pads_writer_close(w) == SH_OK); verify(dir, ROWS); assert(unlink(path) == 0);
    w = writer(path, 1);
    for (unsigned g = 0; g < GROUPS; g++) {tasks[g] = (task){w, 0, 1, 123}; assert(!pthread_create(&threads[g], NULL, write_thread, &tasks[g]));}
    unsigned successes = 0;
    for (unsigned g = 0; g < GROUPS; g++) {assert(!pthread_join(threads[g], NULL)); successes += tasks[g].rc == SH_OK;}
    assert(successes == 1 && sh_pads_writer_close(w) == SH_ERR_RANGE && access(path, F_OK) != 0);

    /* A crashed process leaves only an ignored temp name, never a .pads entry. */
    pid_t child = fork(); assert(child >= 0);
    if (!child) {w = writer(path, 1); values(10, 0, u); assert(sh_pads_writer_cell(w, 10, 0, u) == SH_OK); _exit(0);}
    int status; assert(waitpid(child, &status, 0) == child && WIFEXITED(status) && WEXITSTATUS(status) == 0);
    assert(access(path, F_OK) != 0 && cleanup_temps(dir) == 1);
    sh_pads_group capped[5]; memset(capped, 0, sizeof capped);
    for (unsigned i = 0; i < 5; i++) {
        capped[i].group = i; capped[i].K = 16; capped[i].u_len = WIDTH;
        snprintf(capped[i].name, sizeof capped[i].name, "capped.%u", i);
    }
    assert(!sh_pads_writer_open(path, digest, seed_id, capped, 5,
                0, SH_PADS_INDEX_LIMIT, pk, &err) && err == SH_ERR_RANGE);
    assert(cleanup_temps(dir) == 0 && access(path, F_OK) != 0);
    puts("pad-publication: PASS"); return 0;
}
