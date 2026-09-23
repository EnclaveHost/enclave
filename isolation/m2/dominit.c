/* PID 1 of an M2 app domain (isolation/DESIGN.md section 10): M1's domain, now serving.
 *
 * The domain holds exactly one app and exposes exactly one port. This init:
 *   1. loads the vsock transport (the domain has no NIC: vsock to the host is its only channel) and,
 *      under SEV-SNP, the report interface;
 *   2. brings up loopback and starts the app natively under `wasmtime serve` on 127.0.0.1:8080 (the
 *      runtime JIT-compiles it inside this guest, as in M1);
 *   3. starts /front, which mints the domain's TLS key in guest memory, terminates TLS on vsock port
 *      443, serves the attestation document binding that key, and proxies everything else to the app;
 *   4. if either exits, powers the domain off: a domain that cannot serve should not linger.
 * The host ends a serving domain by stopping its VMM (lease end). */
#define _GNU_SOURCE
#include <cpuid.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("DOM insmod %s: %s\n", p, strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r != 0 && errno != EEXIST) printf("DOM insmod %s failed: %s\n", p, strerror(errno));
    close(fd);
}

/* the kernel gives lo 127.0.0.1/8 itself once it is up */
static void lo_up(void) {
    struct ifreq ifr = {0};
    strcpy(ifr.ifr_name, "lo");
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0 || ioctl(s, SIOCGIFFLAGS, &ifr) < 0) { printf("DOM ERROR lo: %s\n", strerror(errno)); return; }
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) printf("DOM ERROR lo up: %s\n", strerror(errno));
    close(s);
}

static pid_t spawn(char *const argv[]) {
    pid_t pid = fork();
    if (pid == 0) {
        char *envp[] = {"HOME=/tmp", "PATH=/rt", NULL};
        execve(argv[0], argv, envp);
        printf("DOM ERROR exec %s: %s\n", argv[0], strerror(errno));
        _exit(127);
    }
    return pid;
}

static double now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
    mount("configfs", "/sys/kernel/config", "configfs", 0, 0);
    double boot_ms = now_ms();   /* monotonic since guest boot: how long the kernel took to reach us */

    unsigned a, b, c, d;
    __cpuid(0x8000001f, a, b, c, d);
    int snp = (a >> 4) & 1;      /* SNP active for THIS guest (the CPUID table under SNP is the PSP's) */
    struct sysinfo si;
    sysinfo(&si);
    printf("\nDOM snp=%d vcpus=%ld memMiB=%lu boot_ms=%.0f\n", snp, sysconf(_SC_NPROCESSORS_ONLN),
           (unsigned long)(si.totalram * si.mem_unit >> 20), boot_ms);

    insmod("/vsock.ko.zst");
    insmod("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod("/vmw_vsock_virtio_transport.ko.zst");
    if (snp) {
        insmod("/tsm_report.ko.zst");
        insmod("/sev-guest.ko.zst");
    }
    lo_up();

    char *app[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "serve", "-S", "cli",
                   "--addr", "127.0.0.1:8080", "/app.wasm", NULL};
    char *front[] = {"/front", "-port", "443", "-upstream", "127.0.0.1:8080", snp ? "-snp=true" : "-snp=false", NULL};
    pid_t app_pid = spawn(app), front_pid = spawn(front);
    printf("DOM started app=%d front=%d at_ms=%.0f\n", app_pid, front_pid, now_ms());

    for (;;) {                   /* PID 1 reaps everything; either server ending ends the domain */
        int st = 0;
        pid_t w = wait(&st);
        if (w < 0 && errno == ECHILD) break;
        if (w == app_pid || w == front_pid) {
            printf("DOM ERROR %s exited status=%d\n", w == app_pid ? "app" : "front",
                   WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st));
            break;
        }
    }
    printf("DOM end\n");
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    return 0;
}
