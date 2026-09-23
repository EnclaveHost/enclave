/* Positive control for the SNP question: runs as PID 1 in an SEV-SNP guest and reports
 * (1) whether memory encryption / SNP is active, (2) whether SVM is exposed to the guest --
 * i.e. whether a nested hypervisor (Windows' own Hyper-V, hence VBS) could even start inside
 * an SNP guest -- and (3) a real attestation report via configfs-tsm. */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <sys/reboot.h>
#include <cpuid.h>

static void insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { printf("CTL insmod %s: open failed\n", p); return; }
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    printf("CTL insmod %s -> %ld\n", p, r); close(fd);
}
static long slurp(const char *p, unsigned char *b, long cap) {
    int fd = open(p, O_RDONLY); if (fd < 0) return -1;
    long n = 0, r; while ((r = read(fd, b + n, cap - n)) > 0) n += r; close(fd); return n;
}
static void hex(const char *l, const unsigned char *p, int n) {
    printf("CTL %s ", l); for (int i = 0; i < n; i++) printf("%02x", p[i]); printf("\n");
}
int main(void) {
    mount("proc", "/proc", "proc", 0, 0); mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("configfs", "/sys/kernel/config", "configfs", 0, 0);
    unsigned a, b, c, d;
    __cpuid(0x80000001, a, b, c, d);
    printf("CTL cpuid 8000_0001 ecx.SVM(bit2)=%u  -> nested hypervisor %s\n", (c >> 2) & 1,
           ((c >> 2) & 1) ? "POSSIBLE" : "IMPOSSIBLE (SVM hidden from this guest)");
    __cpuid(0x8000001f, a, b, c, d);
    printf("CTL cpuid 8000_001F eax=0x%08x (SME=%u SEV=%u SEV-ES=%u SNP=%u VMPL=%u) ebx=0x%08x\n",
           a, a & 1, (a >> 1) & 1, (a >> 3) & 1, (a >> 4) & 1, (a >> 5) & 1, b);
    static unsigned char k[1 << 16];
    int kfd = open("/dev/kmsg", O_RDONLY | O_NONBLOCK);
    if (kfd >= 0) { long r; while ((r = read(kfd, k, sizeof k - 1)) > 0) { k[r] = 0;
        if (strcasestr((char*)k, "SEV") || strcasestr((char*)k, "SNP") || strcasestr((char*)k, "Memory Encryption"))
            printf("CTL kmsg %s", strchr((char*)k, ';') ? strchr((char*)k, ';') + 1 : (char*)k); } close(kfd); }
    insmod("/tsm_report.ko.zst"); insmod("/sev-guest.ko.zst");
    mkdir("/sys/kernel/config/tsm/report/r0", 0755);
    unsigned char in[64]; for (int i = 0; i < 64; i++) in[i] = (unsigned char)(0xC0 + i);
    int fd = open("/sys/kernel/config/tsm/report/r0/inblob", O_WRONLY);
    if (fd >= 0) { printf("CTL inblob write %zd\n", write(fd, in, 64)); close(fd); }
    static unsigned char pv[64]; long pn = slurp("/sys/kernel/config/tsm/report/r0/provider", pv, 63);
    if (pn > 0) { pv[pn] = 0; printf("CTL provider %s", pv); }
    static unsigned char rep[8192]; long n = slurp("/sys/kernel/config/tsm/report/r0/outblob", rep, sizeof rep);
    printf("CTL report bytes=%ld\n", n);
    if (n >= 0x1a0) {
        printf("CTL report version=%u guest_svn=%u vmpl=%u\n", *(unsigned*)rep, *(unsigned*)(rep + 4), *(unsigned*)(rep + 0x30));
        hex("policy", rep + 0x8, 8); hex("report_data[0:16]", rep + 0x50, 16);
        hex("measurement", rep + 0x90, 48); hex("chip_id[0:16]", rep + 0x1a0, 16);
    }
    fflush(stdout); sync(); reboot(RB_POWER_OFF); return 0;
}
