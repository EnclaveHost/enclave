/* front role: optionally PR_SET_DUMPABLE 0 first (as dumpable.go), then read its own and the runtime's maps (the W^X scan).
 * runtime role: after the front is up, try what a compromised runtime of the same uid would: the front's maps, its fd 1
 * link, and pidfd_getfd of its fd 1. Reports to /run/<role>-report.txt. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>
static int find(const char *needle) {
  DIR *d = opendir("/proc"); struct dirent *e; int found = -1;
  while (d && (e = readdir(d))) {
    int pid = atoi(e->d_name); if (pid <= 0 || pid == getpid()) continue;
    char p[64], buf[256] = {0}; snprintf(p, sizeof p, "/proc/%d/cmdline", pid);
    int fd = open(p, O_RDONLY); if (fd < 0) continue; read(fd, buf, sizeof buf - 1); close(fd);
    if (strstr(buf, needle)) { found = pid; break; }
  }
  if (d) closedir(d); return found;
}
static const char *tryopen(const char *p) { int fd = open(p, O_RDONLY); if (fd < 0) return strerror(errno); char b[64]; ssize_t n = read(fd, b, sizeof b); close(fd); return n > 0 ? "READ OK" : n == 0 ? "empty" : strerror(errno); }
int main(int argc, char **argv) {
  int front = strstr(argv[0], "front") != NULL;
  FILE *out;
  if (front) {
    int nd = strstr(argv[0], "front") && access("/plat/NODUMP", F_OK) == 0;
    if (nd) prctl(PR_SET_DUMPABLE, 0, 0, 0, 0);
    usleep(300000);
    int rt = find("ld-linux");
    char p[64]; snprintf(p, sizeof p, "/proc/%d/maps", rt);
    char q[64]; snprintf(q, sizeof q, "/proc/%d/maps", (int)getpid());
    out = fopen("/run/front-report.txt", "w");
    fprintf(out, "front dumpable=%d | own maps via /proc/self: %s | own maps via /proc/<pid>: %s | own cgroup: %s | runtime(%d) maps: %s\n",
            prctl(PR_GET_DUMPABLE), tryopen("/proc/self/maps"), tryopen(q), tryopen("/proc/self/cgroup"), rt, tryopen(p));
  } else {
    usleep(600000);
    int fr = find("/plat/front");
    char p[64], l[256] = {0}; snprintf(p, sizeof p, "/proc/%d/maps", fr);
    char f1[64]; snprintf(f1, sizeof f1, "/proc/%d/fd/1", fr);
    ssize_t n = readlink(f1, l, sizeof l - 1);
    int pfd = syscall(SYS_pidfd_open, fr, 0); int got = pfd >= 0 ? syscall(SYS_pidfd_getfd, pfd, 1, 0) : -1; int ge = errno;
    out = fopen("/run/runtime-report.txt", "w");
    fprintf(out, "runtime -> front(%d): maps: %s | fd/1 link: %s | pidfd_getfd(fd 1): %s\n", fr, tryopen(p),
            n >= 0 ? l : strerror(errno), got >= 0 ? "GOT THE FD" : strerror(ge));
  }
  fclose(out); sleep(1); return 0;
}
