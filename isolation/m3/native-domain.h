/* Dedicated native domexec build only. The monitor has already verified and
 * pinned the resources, consumed the guest claim, configured its cgroup and
 * acquired the masked worker lease. No host request can supply these paths.
 */
#ifdef NATIVE_DESKTOP
#include <sched.h>
#include <sys/syscall.h>
#include <time.h>
#include "native-proc-privacy.h"

static unsigned native_vcpus;
static unsigned native_mem;

static unsigned native_decimal(const char *s, unsigned low, unsigned high) {
    unsigned n = 0;
    if (!s || !*s) die("native argument missing");
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p < '0' || *p > '9' || n > high / 10) die("native argument malformed");
        n = n * 10 + *p - '0';
        if (n > high) die("native argument exceeds profile");
    }
    if (n < low) die("native argument below profile");
    return n;
}
static void native_args(int argc, char **argv, uid_t uid, uid_t front_uid) {
    if (getuid() || geteuid() || getpid() != 1 || argc != 7 ||
        strcmp(argv[3], "native") || uid != 5001 || front_uid != 1053577 || strcmp(argv[5], "8000"))
        die("dedicated native domexec contract");
    (void)native_decimal(argv[1], 1, 1048575);
    native_mem = native_decimal(argv[4], 8192, 65536);
    native_vcpus = native_decimal(argv[6], 4, 16);
}
static void native_quiet(void) {
    for (int i = 0; i < 3; i++) if (dup2(NULL_FD, i) < 0) _exit(126);
}
static void native_close_fds(void) {
    if (syscall(SYS_close_range, 3U, ~0U, 0)) _exit(126);
}
static void native_policy(void) {
    int proc = open("/proc", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (proc < 0 || native_ancestor_proc_private(proc)) die("native ancestor proc privacy");
    close(proc);
    if (mount("/proc", "/native/proc", NULL, MS_BIND, NULL) ||
        mount(NULL, "/native/proc", NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL))
        die("native supervisor proc view");
    int policy = open("/native-network.nft", O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat st;
    if (policy < 0 || fstat(policy, &st) || !S_ISREG(st.st_mode) || st.st_uid != 0 ||
        (st.st_mode & 0222) || st.st_size < 1 || st.st_size > 16384) die("native network policy");
    pid_t pid = fork();
    if (pid < 0) die("native network fork");
    if (!pid) {
        native_quiet();
        if (dup2(policy, 0) < 0 || setgroups(0, NULL) ||
            chroot("/native/plat/native-desktop/rootfs") || chdir("/")) _exit(126);
        native_close_fds();
        char *const av[] = {"/usr/sbin/nft", "-f", "-", NULL};
        char *const env[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", "LANG=C", NULL};
        execve(av[0], av, env); _exit(127);
    }
    close(policy);
    int status; pid_t got;
    do { got = waitpid(pid, &status, 0); } while (got < 0 && errno == EINTR);
    if (got != pid || !WIFEXITED(status) || WEXITSTATUS(status)) die("native network install");
}
static pid_t native_supervisor(void) {
    char cpus[16], mem[16];
    snprintf(cpus, sizeof cpus, "%u", native_vcpus);
    snprintf(mem, sizeof mem, "%u", native_mem);
    pid_t pid = fork();
    if (pid < 0) die("native supervisor fork");
    if (!pid) {
        native_quiet();
        if (setgroups(0, NULL) || chroot("/native") || chdir("/")) _exit(126);
        native_close_fds();
        char *const av[] = {"/plat/native-desktop/rootfs/usr/local/libexec/kvm-box/supervisor", cpus, mem, NULL};
        char *const env[] = {"PATH=/usr/sbin:/usr/bin:/sbin:/bin", NULL};
        execve(av[0], av, env); _exit(127);
    }
    struct timespec start, now;
    if (clock_gettime(CLOCK_MONOTONIC, &start)) die("native supervisor clock");
    for (;;) {
        int status;
        if (waitpid(pid, &status, WNOHANG) != 0) die("native supervisor exited before readiness");
        struct stat st;
        if (lstat("/run/native-desktop/control.sock", &st) == 0) {
            if (!S_ISSOCK(st.st_mode) || st.st_uid != 0 || st.st_gid != 1002 || (st.st_mode & 07777) != 0660)
                die("native supervisor endpoint metadata");
            return pid;
        }
        if (errno != ENOENT || clock_gettime(CLOCK_MONOTONIC, &now)) die("native supervisor readiness");
        if ((now.tv_sec - start.tv_sec) * 1000000000LL + now.tv_nsec - start.tv_nsec >= 5000000000LL)
            die("native supervisor readiness timeout");
        usleep(10000);
    }
}
#endif
