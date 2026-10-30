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
 * Nothing here is privileged beyond what a guest kernel grants its own PID 1.
 *
 * NATIVE_DESKTOP build (isolation/m3/desktop/README.md): the measured native desktop image runs on a
 * fixed enclave kernel with the Hyper-V vsock transport, the report interface and the guest TPM all
 * built in, so there is nothing to insmod and no probe medium. That build takes a separate, strict
 * path: every mount is checked and any failure powers off, the cgroup delegation is read back and
 * verified, and after the guest TPM is validated a fixed /plat/native-boot helper is run under a
 * bounded wait to stand up the read-only root/models/platform before /monitor is executed. The
 * ordinary (non-NATIVE_DESKTOP) build below is unchanged. */
#define _GNU_SOURCE
#include <cpuid.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <net/if.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/reboot.h>
#include <sys/mount.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "vtpm-boot.h"

#ifdef NATIVE_DESKTOP
/* The native desktop image is pinned to one measured kernel; a mismatch, or not being PID 1, means
 * this is not the image we think it is. The helper, its timeout and the kernel string are fixed here
 * so nothing the host supplies can select or relax them. */
#define NATIVE_KERNEL_RELEASE "6.6.87.2-enclave-kvm-box"
#define NATIVE_BOOT_HELPER    "/plat/native-boot"
#define NATIVE_BOOT_TIMEOUT_MS 90000.0
#endif

#ifndef NATIVE_DESKTOP
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
#endif /* !NATIVE_DESKTOP */

static double now_ms(void) {
    struct timespec t;
#ifdef NATIVE_DESKTOP
    if (clock_gettime(CLOCK_MONOTONIC, &t) != 0) return -1;
#else
    clock_gettime(CLOCK_MONOTONIC, &t);
#endif
    return t.tv_sec * 1e3 + t.tv_nsec / 1e6;
}

/* list_tree names what is under a directory, a few levels deep, on the current console line */
static void list_tree(const char *dir, int depth) {
    DIR *d = opendir(dir);
    if (!d) return;
    struct dirent *e;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) continue;
        char p[512];
        snprintf(p, sizeof p, "%s/%s", dir, e->d_name);
        printf(" %s", p);
        if (e->d_type == DT_DIR && depth < 3) list_tree(p, depth + 1);
    }
    closedir(d);
}

#ifdef NATIVE_DESKTOP
/* Fail closed: say why, flush the console, and power the guest off. PID 1 must not return. */
static _Noreturn void poweroff_now(const char *msg) {
    printf("MON ERROR %s\n", msg);
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    _exit(1);
}

static void checked_mount(const char *src, const char *tgt, const char *fs,
                          unsigned long flags, const void *data) {
    if (mount(src, tgt, fs, flags, data) != 0) {
        char msg[256];
        snprintf(msg, sizeof msg, "mount %s on %s failed: %s", fs, tgt, strerror(errno));
        poweroff_now(msg);
    }
}

/* Every mount point is part of the measured initrd; only /run is created here, and tolerating an
 * existing directory is the only slack. proc hides other pids, /sys is read-only, and cgroup2 is a
 * writable submount over a directory inside that read-only /sys (mounting over a node does not write
 * to the underlying superblock, so the read-only parent does not block it). */
static void native_mounts(void) {
    if (mkdir("/run", 0755) != 0 && errno != EEXIST)
        poweroff_now("mkdir /run failed");
    checked_mount("proc", "/proc", "proc",
                  MS_NOSUID | MS_NODEV | MS_NOEXEC, "hidepid=2");
    checked_mount("sysfs", "/sys", "sysfs",
                  MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
    checked_mount("devtmpfs", "/dev", "devtmpfs", MS_NOSUID, NULL);
    checked_mount("tmpfs", "/run", "tmpfs",
                  MS_NOSUID | MS_NODEV, "mode=0755");
    checked_mount("tmpfs", "/tmp", "tmpfs",
                  MS_NOSUID | MS_NODEV, "mode=1777");
    checked_mount("cgroup2", "/sys/fs/cgroup", "cgroup2",
                  MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL);
}

static void native_loopback(void) {
    struct ifreq ifr = {0};
    strcpy(ifr.ifr_name, "lo");
    int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
    if (fd < 0 || ioctl(fd, SIOCGIFFLAGS, &ifr) != 0)
        poweroff_now("read loopback flags failed");
    ifr.ifr_flags |= IFF_UP;
    if (ioctl(fd, SIOCSIFFLAGS, &ifr) != 0 || ioctl(fd, SIOCGIFFLAGS, &ifr) != 0 ||
        !(ifr.ifr_flags & IFF_UP))
        poweroff_now("enable loopback failed");
    close(fd);
}

/* token_present matches a whole space/newline-separated word, so "cpu" does not match "cpuset" */
static int token_present(const char *list, const char *tok) {
    size_t tl = strlen(tok);
    const char *p = list;
    while (*p) {
        while (*p == ' ' || *p == '\t' || *p == '\n') p++;
        const char *s = p;
        while (*p && *p != ' ' && *p != '\t' && *p != '\n') p++;
        if ((size_t)(p - s) == tl && memcmp(s, tok, tl) == 0) return 1;
    }
    return 0;
}

/* Delegate cpu, memory and pids to the subtree and then prove it took: read cgroup.subtree_control
 * back and require every controller to be listed, or power off. A monitor that cannot set per-domain
 * limits must not run. */
static void native_delegate(void) {
    static const char *const want[] = {"cpu", "memory", "pids"};
    const char *ctrl = "/sys/fs/cgroup/cgroup.subtree_control";
    static const char req[] = "+cpu +memory +pids";

    int fd = open(ctrl, O_WRONLY | O_CLOEXEC);
    if (fd < 0) poweroff_now("open cgroup.subtree_control for write failed");
    if (write(fd, req, sizeof req - 1) != (ssize_t)(sizeof req - 1)) {
        close(fd);
        poweroff_now("writing cgroup controller delegation failed");
    }
    close(fd);

    fd = open(ctrl, O_RDONLY | O_CLOEXEC);
    if (fd < 0) poweroff_now("reopen cgroup.subtree_control for verify failed");
    char buf[256];
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 0) poweroff_now("reading back cgroup.subtree_control failed");
    buf[n] = 0;
    for (size_t i = 0; i < sizeof want / sizeof *want; i++)
        if (!token_present(buf, want[i]))
            poweroff_now("cgroup controller delegation not confirmed");
}

/* Wait up to timeout_ms (monotonic) for pid to exit cleanly. Returns 0 only on a zero exit status;
 * on any failure, and on timeout after killing and reaping the child, returns non-zero. */
static int native_wait(pid_t pid, double timeout_ms) {
    double start = now_ms();
    int status;
    for (;;) {
        pid_t r = waitpid(pid, &status, WNOHANG);
        if (r == pid)
            return (WIFEXITED(status) && WEXITSTATUS(status) == 0) ? 0 : 1;
        if (r < 0 && errno != EINTR) break;
        double now = now_ms();
        if (start < 0 || now < 0 || now - start >= timeout_ms) break;
        struct timespec ts = {0, 50 * 1000 * 1000}; /* 50 ms */
        nanosleep(&ts, NULL);
    }
    kill(pid, SIGKILL);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    return 1;
}

/* Run the fixed native-boot helper in the same mount namespace with a minimal environment and no
 * arguments. It succeeds only after it has verified the read-only root, models and platform setup;
 * any other outcome (fork/exec failure, non-zero exit, or the bounded wait expiring) powers off. */
static void native_boot(void) {
    pid_t pid = fork();
    if (pid < 0) poweroff_now("native-boot fork failed");
    if (pid == 0) {
        char *hargv[] = {(char *)NATIVE_BOOT_HELPER, NULL};
        char *henvp[] = {"PATH=/plat", NULL};
        execve(NATIVE_BOOT_HELPER, hargv, henvp);
        _exit(127);
    }
    if (native_wait(pid, NATIVE_BOOT_TIMEOUT_MS) != 0)
        poweroff_now("native-boot helper failed or timed out; RO root/models/platform not verified");
}
#endif /* NATIVE_DESKTOP */

/* Returning from PID 1 panics the kernel and may leave the VM consuming its
 * allocation indefinitely. A failed native image must power off instead. */
static int init_error(void) {
#ifdef NATIVE_DESKTOP
    poweroff_now("native initialization failed");
#else
    return 1;
#endif
}

int main(void) {
#ifdef NATIVE_DESKTOP
    /* Before anything privileged: confirm we are the guest's PID 1 and that this is exactly the
     * measured native kernel. Neither is a host-controlled selector; both only ever fail closed. */
    if (getpid() != 1 || getuid() != 0 || geteuid() != 0)
        poweroff_now("refusing to start: native init is not PID 1");
    {
        struct utsname k;
        if (uname(&k) != 0 || strcmp(k.release, NATIVE_KERNEL_RELEASE) != 0)
            poweroff_now("refusing to start: not the measured native desktop kernel");
    }
    native_mounts();
#else
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=64m");
    mount("configfs", "/sys/kernel/config", "configfs", 0, 0);
    mount("cgroup2", "/sys/fs/cgroup", "cgroup2", 0, 0);
#endif
    double boot_ms = now_ms();
#ifdef NATIVE_DESKTOP
    if (boot_ms < 0) poweroff_now("monotonic clock unavailable");
#endif

    unsigned a, b, c, d;
    __cpuid(0x8000001f, a, b, c, d);
    int snp = (a >> 4) & 1;
    struct sysinfo si;
    sysinfo(&si);
    printf("\nMON snp=%d vcpus=%ld memMiB=%lu boot_ms=%.0f\n", snp, sysconf(_SC_NPROCESSORS_ONLN),
           (unsigned long)(si.totalram * si.mem_unit >> 20), boot_ms);

#ifndef NATIVE_DESKTOP
    /* The native kernel has the vsock transport (and the report interface) built in: nothing to load
     * and no legacy .zst modules, so this whole step is skipped there. */
    insmod("/vsock.ko.zst");
    insmod("/vmw_vsock_virtio_transport_common.ko.zst");
    insmod("/vmw_vsock_virtio_transport.ko.zst");
    if (snp) {
        insmod("/tsm_report.ko.zst");
        insmod("/sev-guest.ko.zst");
    }
    /* MODEL VOLUMES (monitor/modelvol.go): an image built with a measured table carries the disk and device-mapper
     * modules beside vsock's - Hyper-V's SCSI (virtio's block driver is built in) and dm-verity. Without the table the
     * image carries neither, and nothing is loaded. */
    if (access("/plat/rt/model-volumes.table", F_OK) == 0) {
        insmod("/scsi_transport_fc.ko.zst");
        insmod("/hv_storvsc.ko.zst");
        insmod("/dm-mod.ko.zst");
        insmod("/dm-bufio.ko.zst");
        insmod("/reed_solomon.ko.zst");
        insmod("/dm-verity.ko.zst");
    }
    lo_up();
    /* a domain's share is a child cgroup, so these controllers have to be available in the subtree */
    write_file("/sys/fs/cgroup/cgroup.subtree_control", "+cpu +memory +pids");
#else
    native_loopback();
    native_delegate();
#endif

    char snpflag[16];
    snprintf(snpflag, sizeof snpflag, "-snp=%d", snp);   /* one argv element: Go bool flags need = */
    /* A Hyper-V child partition (windows/vbslike) has no hardware signer: its launcher names, on the
     * kernel command line, the host vsock port that signs report_data. Absent on QEMU, so nothing
     * changes there. The image is the same either way; only the launcher differs. */
    char hostflag[48] = "";
    {
        FILE *f = fopen("/proc/cmdline", "r");
        char line[1024] = "";
        if (f) { if (!fgets(line, sizeof line, f)) line[0] = 0; fclose(f); }
        char *p = strstr(line, "report_host=");
        if (p) snprintf(hostflag, sizeof hostflag, "-report-host=%d", atoi(p + 12));
        /* ON THE UKI PATH the whole command line is pinned. Under UEFI with Secure Boot off the host can replace the
         * UKI's .cmdline (LoadOptions from a boot entry) or extend it (SMBIOS type 11
         * io.systemd.stub.kernel-cmdline-extra), and the stub can add an extra initrd from files beside it on the ESP
         * (credentials, system/config extensions), unpacked under /.extra. None of that is measured
         * (isolation/m3/UEFI-BOOT.md). systemd-stub always leaves /.extra/os-release (the UKI's own .osrel), which is how
         * a stub boot is recognised; on it, a line that is not exactly the pinned one, or anything under /.extra besides
         * os-release, and this guest does not start. A direct boot (HCS linux-direct, QEMU -kernel) makes no UKI claim:
         * its loader supplies the line (OVMF prefixes "initrd=initrd"), so it is not pinned here. On the partition types run so
         * far (HCS, OpenHCL type 16) the host can read the guest's memory anyway: fail-closed hygiene, not a boundary
         * (a VBS-isolated type 1 changes that premise; see VBS-ISOLATION.md). */
        struct stat st;
        if (p && stat("/.extra", &st) == 0) {
            static const char pinned[] = "console=ttyS0 rdinit=/init loglevel=3 report_host=9001";
            size_t n = strcspn(line, "\n");
            if (n != sizeof pinned - 1 || memcmp(line, pinned, n) != 0) {
                printf("MON ERROR refusing to start: the kernel command line is not the pinned one (got \"%.*s\")\n",
                       (int)(n > 200 ? 200 : n), line);
                fflush(stdout); sync(); reboot(RB_POWER_OFF);
            }
            int other = 0;
            DIR *d = opendir("/.extra");
            struct dirent *e;
            while (d && (e = readdir(d)))
                if (strcmp(e->d_name, ".") && strcmp(e->d_name, "..") && strcmp(e->d_name, "os-release")) other = 1;
            if (d) closedir(d);
            if (other) {
                printf("MON ERROR refusing to start: the boot stub added files under /.extra (credentials or extensions):");
                list_tree("/.extra", 0);
                printf("\n");
                fflush(stdout); sync(); reboot(RB_POWER_OFF);
            }
        }
    }
#ifndef NATIVE_DESKTOP
    /* A PROBE image - never a production medium - may carry /probe.ko (isolation/m3/probe/): loaded once, uncompressed,
     * after the guards above and before anything is served, and announced. The file is part of the initrd, so a probe
     * image never has a production image's hash; a production image has no such file and this does nothing. The native
     * desktop image is never a probe medium, so this step is compiled out there. */
    {
        int fd = open("/probe.ko", O_RDONLY | O_CLOEXEC);
        if (fd >= 0) {
            printf("MON PROBE IMAGE: loading /probe.ko (this is not a production medium)\n");
            fflush(stdout);
            long r = syscall(SYS_finit_module, fd, "", 0);
            printf("MON PROBE finished: %s\n", r == 0 ? "loaded" : strerror(errno));
            close(fd);
        }
    }
#endif
    /* Presence is part of the measured image, not an untrusted host switch.
     * With this driver included, startup requires a normally version-checked
     * module load and every app report requires the guest TPM report. */
    char *vtpmflag = NULL;
    struct utsname kernel;
    if (uname(&kernel) != 0) return init_error();
    /* This measured desktop kernel has the transport built in. A missing
     * marker is a broken image, never permission to use a host-only report. */
    int required_vtpm = strstr(kernel.release, "-enclave-kvm-box") != NULL;
    int vtpm_mode = enclave_vtpm_boot_mode("/enclave_openhcl_tpm.builtin", "/enclave_openhcl_tpm.ko", snp, hostflag[0] != 0, required_vtpm);
    if (vtpm_mode == ENCLAVE_VTPM_ERROR) {
        printf("MON ERROR invalid required guest TPM transport selection\n");
        return init_error();
    }
    if (vtpm_mode == ENCLAVE_VTPM_MODULE) {
        int fd = open("/enclave_openhcl_tpm.ko", O_RDONLY | O_CLOEXEC);
        if (fd < 0 || syscall(SYS_finit_module, fd, "", 0) != 0) {
            printf("MON ERROR required guest TPM driver failed: %s\n", strerror(errno));
            if (fd >= 0) close(fd);
            return init_error();
        }
        close(fd);
    }
    if (vtpm_mode != ENCLAVE_VTPM_NONE) {
        if (!enclave_vtpm_device_ready("/dev/tpm0")) {
            printf("MON ERROR required guest TPM device is absent or has unsafe permissions\n");
            return init_error();
        }
        vtpmflag = "-vbs-tpm=/dev/tpm0";
    }
#ifdef NATIVE_DESKTOP
    /* The guest TPM is validated; now stand up the read-only root/models/platform through the fixed
     * helper, under a bounded wait, before the monitor ever runs. */
    native_boot();
#endif
    char *argv[] = {"/monitor", snpflag, hostflag[0] ? hostflag : NULL, vtpmflag, NULL};
    char *envp[] = {"HOME=/tmp", "PATH=/plat", NULL};
    execve(argv[0], argv, envp);
    printf("MON ERROR exec /monitor: %s\n", strerror(errno));
    return init_error();
}
