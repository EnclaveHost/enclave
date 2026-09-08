/* anchor-copy: exact stream-to-file copy under injected faults (payload/anchor_copy.c): EINTR mid-read, a stream
 * that ends early, a destination that refuses writes, and the fsync gate. */
#include "anchor_copy.h"
#include <assert.h>
#include <fcntl.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <unistd.h>
static void on_usr1(int s) { (void)s; }
static pthread_t g_reader;
static void *feeder(void *a) {          /* writes 1 MiB in 1000-byte pieces, poking the reader with SIGUSR1 to force EINTR */
    int fd = *(int *)a; unsigned char b[1000]; for (int i = 0; i < 1000; i++) b[i] = (unsigned char)i;
    for (int i = 0; i < 1048; i++) { if (i % 50 == 0) pthread_kill(g_reader, SIGUSR1); usleep(200); (void)!write(fd, b, sizeof b); }
    unsigned char tail[576]; memset(tail, 7, sizeof tail); (void)!write(fd, tail, sizeof tail); close(fd); return NULL;
}
int main(void) {
    struct sigaction sa; memset(&sa, 0, sizeof sa); sa.sa_handler = on_usr1; sigaction(SIGUSR1, &sa, NULL);   /* no SA_RESTART: reads return EINTR */
    g_reader = pthread_self();
    char dir[] = "/tmp/anchor-copy-XXXXXX"; assert(mkdtemp(dir)); char path[600]; snprintf(path, sizeof path, "%s/dst", dir);
    char err[160]; uint64_t got = 0;
    /* 1. exact copy of 1 MiB through EINTRs */
    { int sv[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0); pthread_t t; int w = sv[1]; pthread_create(&t, NULL, feeder, &w);
      int dst = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600); assert(dst >= 0);
      assert(anchor_copy_exact(sv[0], dst, 1048576, &got, err, sizeof err) == 0 && got == 1048576);
      assert(anchor_fsync_retry(dst) == 0);
      pthread_join(t, NULL); close(sv[0]);
      unsigned char chk[1000]; assert(pread(dst, chk, 1000, 1000 * 7) == 1000 && chk[3] == 3 && chk[999] == 231); close(dst); }
    /* 2. the stream ends early: error names the position, got says what landed */
    { int sv[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0); unsigned char b[512] = {1}; (void)!write(sv[1], b, 512); close(sv[1]);
      int dst = open(path, O_RDWR | O_CREAT | O_TRUNC, 0600);
      assert(anchor_copy_exact(sv[0], dst, 4096, &got, err, sizeof err) == -1 && got == 512 && strstr(err, "ended at 512 of 4096")); close(sv[0]); close(dst); }
    /* 3. the destination refuses writes (read-only descriptor): error names the write, nothing pretends success */
    { int sv[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sv) == 0); unsigned char b[64] = {2}; (void)!write(sv[1], b, 64); close(sv[1]);
      int dst = open(path, O_RDONLY);
      assert(anchor_copy_exact(sv[0], dst, 64, &got, err, sizeof err) == -1 && got == 0 && strstr(err, "write error")); close(sv[0]); close(dst); }
    /* 4. the fsync gate: a closed descriptor cannot be synced, so completion must not be remembered */
    assert(anchor_fsync_retry(-1) != 0);
    char cmd[700]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); (void)!system(cmd);
    printf("anchor-copy: ok\n"); return 0;
}
