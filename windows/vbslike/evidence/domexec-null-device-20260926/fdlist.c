/* stands in for the runtime / front: records its own fd table to /run/fds-<role>-<pid>.txt, then writes a marker to stdout */
#define _GNU_SOURCE
#include <dirent.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>
int main(int argc, char **argv) {
  const char *role = strstr(argv[0], "ld-linux") ? "runtime" : strstr(argv[0], "front") ? "front" : "other";
  char path[128]; snprintf(path, sizeof path, "/run/fds-%s-%d.txt", role, (int)getpid());
  int out = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0644);
  DIR *d = opendir("/proc/self/fd"); struct dirent *e;
  while (d && (e = readdir(d))) {
    if (e->d_name[0] < '0' || e->d_name[0] > '9') continue;
    int fd = atoi(e->d_name); if (fd == dirfd(d) || fd == out) continue;
    char l[256] = {0}, p[64]; snprintf(p, sizeof p, "/proc/self/fd/%d", fd); readlink(p, l, sizeof l - 1);
    struct stat st; fstat(fd, &st);
    dprintf(out, "fd=%d -> %s rdev=%u:%u chr=%d cloexec=%d\n", fd, l, major(st.st_rdev), minor(st.st_rdev), S_ISCHR(st.st_mode), (fcntl(fd, F_GETFD) & FD_CLOEXEC) ? 1 : 0);
  }
  dprintf(out, "uid=%d euid=%d\n", (int)getuid(), (int)geteuid());
  close(out);
  printf("MARKER-%s-STDOUT pid=%d\n", role, (int)getpid()); fflush(stdout);
  fprintf(stderr, "MARKER-%s-STDERR\n", role);
  sleep(2); return 0;
}
