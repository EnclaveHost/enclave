/* modelvol-qemu-init.c - TEST ONLY (never in an image): PID 1 of a throwaway QEMU/KVM guest for test-modelvol-qemu.sh.
 * It runs the per-app init's OWN model-volume code (dominit.c compiled in, its main renamed; modelvol.h + mverity.h)
 * against a real kernel: insmod the device-mapper modules, read the M1 block the test baked in (/m1), look the name up
 * in /rt/model-volumes.table, find the virtio disk by serial, bring dm-verity up against the PINNED root, mount ext4
 * read-only, then read the volume's file back and print its sha256. Every outcome is one "MVTEST ..." console line,
 * then the guest powers off. */
#define main dominit_main
#include "../dominit.c"
#undef main
#include <stdarg.h>
#include <sys/statvfs.h>

static void out(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vprintf(fmt, ap);
    va_end(ap);
    fflush(stdout);
}

int main(void) {
    mount("proc", "/proc", "proc", 0, 0);
    mount("sysfs", "/sys", "sysfs", 0, 0);
    mount("devtmpfs", "/dev", "devtmpfs", 0, 0);
    mount("tmpfs", "/tmp", "tmpfs", 0, "size=16m");
    char m1[512] = {0};
    FILE *f = fopen("/m1", "r");
    size_t n = f ? fread(m1, 1, sizeof m1 - 1, f) : 0;
    if (f) fclose(f);
    const char *why = model_block(m1, n);
    if (!why) why = mv_table();
    char who[80] = "";
    if (!why) why = mv_mount_all(who, sizeof who);
    if (why) {
        out("MVTEST mount-refused %s: %s (%s)\n", who, why, errno ? strerror(errno) : "-");
    } else {
        struct statvfs sv;
        char path[300];
        snprintf(path, sizeof path, MV_ROOT "/%s", mv[0].name);
        int ro = statvfs(path, &sv) == 0 && (sv.f_flag & ST_RDONLY);
        out("MVTEST mounted %s ro=%d\n", mv[0].name, ro);
        snprintf(path, sizeof path, MV_ROOT "/%s/payload.bin", mv[0].name);
        int fd = open(path, O_RDONLY);
        static unsigned char buf[16 << 20];
        ssize_t r = 0;
        size_t total = 0;
        while (fd >= 0 && total < sizeof buf && (r = read(fd, buf + total, sizeof buf - total)) > 0) total += (size_t)r;
        if (fd < 0 || r < 0) {
            out("MVTEST read-failed %s (%s) after %zu bytes\n", path, strerror(errno), total);
        } else {
            char hex[65];
            sha256_min_hex(buf, total, hex);
            out("MVTEST read %zu bytes sha256=%s\n", total, hex);
        }
        int w = open(path, O_WRONLY);
        out("MVTEST write-refused=%d\n", w < 0 && errno == EROFS);
    }
    out("MVTEST end\n");
    sync();
    reboot(RB_POWER_OFF);
    return 0;
}
