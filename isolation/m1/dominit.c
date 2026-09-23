/* PID 1 of an M1 app domain (isolation/DESIGN.md section 7).
 *
 * The domain holds exactly one app. This init:
 *   1. reads the app's sha256 from /app.sha256 (written at build time, inside the measured initramfs)
 *      and the host's nonce from fw_cfg opt/enclave.nonce (runtime input, deliberately NOT measured:
 *      a nonce on the kernel command line would change the launch digest on every boot);
 *   2. runs the app natively: the runtime JIT-compiles the Wasm inside this guest, which owns its page
 *      tables (the AOT-vs-JIT choice is open; this is the provisional one);
 *   3. under SEV-SNP, asks the PSP for a report whose 64-byte report_data is
 *      app_sha256 (32 bytes) || nonce (32 bytes), so a verifier sees which app and which challenge;
 *   4. prints DOM lines the host harness parses, and powers off.
 * Nothing here is privileged beyond what a guest kernel grants its own PID 1. */
#define _GNU_SOURCE
#include <cpuid.h>
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/reboot.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/sysinfo.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long slurp(const char *p, unsigned char *b, long cap) {
    int fd = open(p, O_RDONLY);
    if (fd < 0) return -1;
    long n = 0, r;
    while (n < cap && (r = read(fd, b + n, cap - n)) > 0) n += r;
    close(fd);
    return n;
}

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return;
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r != 0 && errno != EEXIST) printf("DOM insmod %s failed: %s\n", p, strerror(errno));
    close(fd);
}

static int unhex(const unsigned char *h, long n, unsigned char *out, int want) {
    int k = 0;
    for (long i = 0; i + 1 < n && k < want; i += 2) {
        unsigned v;
        if (sscanf((const char *)h + i, "%2x", &v) != 1) break;
        out[k++] = (unsigned char)v;
    }
    return k;
}

static void hex(const char *label, const unsigned char *p, int n) {
    printf("DOM %s=", label);
    for (int i = 0; i < n; i++) printf("%02x", p[i]);
    printf("\n");
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

    unsigned char rd[64] = {0};
    unsigned char buf[256];
    long n = slurp("/app.sha256", buf, 64);
    if (unhex(buf, n, rd, 32) != 32) { printf("DOM ERROR no app.sha256\n"); goto out; }
    insmod("/qemu_fw_cfg.ko.zst");
    n = slurp("/sys/firmware/qemu_fw_cfg/by_name/opt/enclave.nonce/raw", buf, 64);
    int got = n > 0 ? unhex(buf, n, rd + 32, 32) : 0;
    hex("app_sha256", rd, 32);
    hex("nonce", rd + 32, 32);
    if (got != 32) printf("DOM WARN nonce missing (%d bytes)\n", got);

    /* The app, natively. stdout goes straight to the console; the harness reads the APP line. */
    double t0 = now_ms();
    pid_t pid = fork();
    if (pid == 0) {
        char *argv[] = {"/rt/ld-linux-x86-64.so.2", "--library-path", "/rt", "/rt/wasmtime", "run", "/app.wasm", NULL};
        char *envp[] = {"HOME=/tmp", "PATH=/rt", NULL};
        execve(argv[0], argv, envp);
        printf("DOM ERROR exec: %s\n", strerror(errno));
        _exit(127);
    }
    int st = 0;
    waitpid(pid, &st, 0);
    printf("DOM app_exit=%d app_ms=%.0f\n", WIFEXITED(st) ? WEXITSTATUS(st) : 128 + WTERMSIG(st), now_ms() - t0);

    if (snp) {
        insmod("/tsm_report.ko.zst");
        insmod("/sev-guest.ko.zst");
        mkdir("/sys/kernel/config/tsm/report/r0", 0755);
        int fd = open("/sys/kernel/config/tsm/report/r0/inblob", O_WRONLY);
        if (fd < 0 || write(fd, rd, 64) != 64) { printf("DOM ERROR inblob: %s\n", strerror(errno)); goto out; }
        close(fd);
        static unsigned char rep[8192];
        n = slurp("/sys/kernel/config/tsm/report/r0/outblob", rep, sizeof rep);
        printf("DOM report_bytes=%ld\n", n);
        if (n >= 0x1a0) {
            printf("DOM report_version=%u vmpl=%u\n", *(unsigned *)rep, *(unsigned *)(rep + 0x30));
            hex("policy", rep + 0x8, 8);
            hex("report_data", rep + 0x50, 64);
            hex("measurement", rep + 0x90, 48);
        }
    }
out:
    printf("DOM end\n");
    fflush(stdout);
    sync();
    reboot(RB_POWER_OFF);
    return 0;
}
