/* frontuid-probe.c - TEST ONLY (never in an image), for m3/test-domexec-frontuid.sh: the NucBox domain's RUNTIME vs FRONT
 * model (enclave-87's ruling on enclave-bf's finding), checked from inside both workloads under the real domexec. Its
 * role is its argv[0]: containing "front", it is the front; anything else, the runtime.
 *   front   (its own uid): creates its listen socket /run/front.sock, and CAN reach the report socket /run/monitor.sock -
 *           the report channel is the front's;
 *   runtime (the domain's uid): must NOT list /run, reach the report socket, remove or replace the front's socket,
 *           signal the front, or open its /proc entries. Every one of those was possible while the two shared a uid.
 * Writes "ok ..." / "BAD ..." and "done ok=N bad=M" to /probe-out/<role>.frontuid (domexec passes no environment, and
 * /run is not the runtime's to write). Built static. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

static FILE *out;
static int n_ok, n_bad;
static void say(int good, const char *name, const char *fmt, ...) __attribute__((format(printf, 3, 4)));
static void say(int good, const char *name, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    fprintf(out, "%s %s: ", good ? "ok " : "BAD", name);
    vfprintf(out, fmt, ap);
    fputc('\n', out);
    va_end(ap);
    if (good) n_ok++; else n_bad++;
}
static int unix_at(const char *path, int do_bind) {
    int s = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0);
    if (s < 0) return -1;
    struct sockaddr_un a = {.sun_family = AF_UNIX};
    strncpy(a.sun_path, path, sizeof a.sun_path - 1);
    int r = do_bind ? bind(s, (struct sockaddr *)&a, sizeof a) : connect(s, (struct sockaddr *)&a, sizeof a);
    int e = errno;
    if (r != 0) { close(s); errno = e; return -1; }
    if (do_bind) listen(s, 4);
    return s;
}
/* refused: r must be -1 with errno EACCES or EPERM */
static void refused(const char *name, int r) {
    int e = errno;
    say(r < 0 && (e == EACCES || e == EPERM), name, "r=%d errno=%s", r, r < 0 ? strerror(e) : "-");
}
static pid_t find(const char *needle) {
    DIR *d = opendir("/proc");
    struct dirent *e;
    pid_t found = -1;
    while (d && (e = readdir(d))) {
        pid_t pid = (pid_t)atoi(e->d_name);
        if (pid <= 0 || pid == getpid()) continue;
        char p[64], buf[256] = {0};
        snprintf(p, sizeof p, "/proc/%d/cmdline", (int)pid);
        int fd = open(p, O_RDONLY | O_CLOEXEC);
        if (fd < 0) continue;
        ssize_t n = read(fd, buf, sizeof buf - 1);
        close(fd);
        if (n > 0 && strstr(buf, needle)) { found = pid; break; }
    }
    if (d) closedir(d);
    return found;
}

int main(int argc, char **argv) {
    (void)argc;
    /* FIRST, before this process opens anything: the seccomp statement pipe (domexec's fd 4) must not survive the exec */
    errno = 0;
    const int fd4_open = fcntl(4, F_GETFD) != -1, fd4_errno = errno;
    const int front = strstr(argv[0], "front") != NULL;
    char path[128];
    snprintf(path, sizeof path, "/probe-out/%s.frontuid", front ? "front" : "runtime");
    out = fopen(path, "w");
    if (!out) return 3;
    fprintf(out, "uid=%d\n", (int)getuid());
    say(!fd4_open && fd4_errno == EBADF, "the seccomp statement pipe (fd 4) is not held after exec", "%s",
        fd4_open ? "OPEN: this workload could write a statement" : "closed");
    if (front) {
        int l = unix_at("/run/front.sock", 1);
        say(l >= 0, "the front creates its listen socket in /run", "fd %d (%s)", l, l < 0 ? strerror(errno) : "ok");
        int c = unix_at("/run/monitor.sock", 0);
        say(c >= 0, "the front reaches the report socket", "fd %d (%s)", c, c < 0 ? strerror(errno) : "ok");
        fprintf(out, "done ok=%d bad=%d\n", n_ok, n_bad);
        fclose(out);
        sleep(3);                                   /* stay up while the runtime looks for it */
        return 0;
    }
    pid_t fp = -1;
    for (int i = 0; i < 40 && fp < 0; i++) { usleep(50000); fp = find("/plat/front"); }
    usleep(300000);                                 /* the front has made its socket by now */
    say(fp > 0, "the front is running (a different process)", "pid %d", (int)fp);
    DIR *r = opendir("/run");
    int re = errno;
    if (r) closedir(r);
    errno = re;
    refused("list /run", r ? 0 : -1);
    refused("reach the report socket /run/monitor.sock", unix_at("/run/monitor.sock", 0));
    refused("remove the front's socket /run/front.sock", unlink("/run/front.sock"));
    refused("bind its own /run/evil.sock", unix_at("/run/evil.sock", 1));
    refused("signal the front (kill 0)", fp > 0 ? kill(fp, 0) : (errno = ESRCH, -1));
    char p[64];
    snprintf(p, sizeof p, "/proc/%d/environ", (int)fp);
    refused("open the front's /proc/<pid>/environ", open(p, O_RDONLY | O_CLOEXEC));
    snprintf(p, sizeof p, "/proc/%d/mem", (int)fp);
    refused("open the front's /proc/<pid>/mem", open(p, O_RDONLY | O_CLOEXEC));
    fprintf(out, "done ok=%d bad=%d\n", n_ok, n_bad);
    fclose(out);
    return 0;
}
