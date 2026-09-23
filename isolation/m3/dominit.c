/* PID 1 of an M3 monitor guest (isolation/m3/PLAN.md, DESIGN.md section 12).
 *
 * M1 and M2 put one app inside one measured guest. M3 puts a MONITOR inside one measured guest and
 * loads apps into it at lease start, so the app is no longer part of the launch measurement and its
 * identity comes from what the monitor says instead (PLAN.md section 3).
 *
 * This init does the part that needs PID 1 and root, then hands over:
 *   1. mounts, including cgroup2 (the monitor gives each domain a share) and configfs (the monitor is
 *      the ONLY holder of the report interface: no domain ever sees /sys);
 *   2. loads the vsock transport (the guest's only channel to the host) and, under SNP, the report
 *      interface;
 *   3. delegates cpu, memory and pids to the cgroup subtree so the monitor can set per-domain limits;
 *   4. execs /monitor, which becomes PID 1 and does everything else.
 * Nothing here is privileged beyond what a guest kernel grants its own PID 1. */
#define _GNU_SOURCE
#include <cpuid.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <time.h>
#include <unistd.h>

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("MON insmod %s: %s\n", p, strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r != 0 && errno != EEXIST) printf("MON insmod %s failed: %s\n", p, strerror(errno));
    close(fd);
}

static void write_file(const char *p, const char *s) {
    int fd = open(p, O_WRONLY);
    if (fd < 0) { printf("MON open %s: %s\n", p, strerror(errno)); return; }
    if (write(fd, s, strlen(s)) < 0) printf("MON write %s: %s\n", p, strerror(errno));
    close(fd);
}

static void lo_up(void) {
    struct ifreq ifr = {0};
    strcpy(ifr.ifr_name, "lo");
    int s = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (s < 0 || ioctl(s, SIOCGIFFLAGS, &ifr) < 0) { printf("MON ERROR lo: %s\n", strerror(errno)); return; }
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(s, SIOCSIFFLAGS, &ifr) < 0) printf("MON ERROR lo up: %s\n", strerror(errno));
    close(s);
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
    mount("cgroup2", "/sys/fs/cgroup", "cgroup2", 0, 0);
    double boot_ms = now_ms();

    unsigned a, b, c, d;
    __cpuid(0x8000001f, a, b, c, d);
    int snp = (a >> 4) & 1;
    struct sysinfo si;
    sysinfo(&si);
    printf("\nMON snp=%d vcpus=%ld memMiB=%lu boot_ms=%.0f\n", snp, sysconf(_SC_NPROCESSORS_ONLN),
           (unsigned long)(si.totalram * si.mem_unit >> 20), boot_ms);

    insmod("/vsock.ko.zst");
    insmod("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod("/vmw_vsock_virtio_transport.ko.zst");
    if (snp) {
        insmod("/tsm_report.ko.zst");
        insmod("/sev-guest.ko.zst");
    }
    lo_up();
    /* a domain's share is a child cgroup, so these controllers have to be available in the subtree */
    write_file("/sys/fs/cgroup/cgroup.subtree_control", "+cpu +memory +pids");

    char snpflag[16];
    snprintf(snpflag, sizeof snpflag, "-snp=%d", snp);   /* one argv element: Go bool flags need = */
    char *argv[] = {"/monitor", snpflag, NULL};
    char *envp[] = {"HOME=/tmp", "PATH=/plat", NULL};
    execve(argv[0], argv, envp);
    printf("MON ERROR exec /monitor: %s\n", strerror(errno));
    return 1;
}
