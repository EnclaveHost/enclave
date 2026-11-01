/* Same-boot ERPCONE4 transport consumed by rpcservice. Production callers use
 * origin 0: kernel startup and every guest preparation step spend the window.
 * This cannot transport a different machine's monotonic clock. The independently
 * owned host/export deadlines still include preparation before guest boot.
 * A sealed clock is not platform acceptance, authorization, or a watchdog. */
#ifndef ENCLAVE_RPC_BOOT_CLOCK_H
#define ENCLAVE_RPC_BOOT_CLOCK_H
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/syscall.h>
#include <time.h>
#include <unistd.h>

#define RPC_WINDOW_NS UINT64_C(900000000000)

static int rpc_clock_read(const char *path, char *buf, size_t cap) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct statfs fs;
    if (fd < 0) return -1;
    if (fstatfs(fd, &fs) || fs.f_type != 0x9fa0) { close(fd); return -1; }
    ssize_t n = read(fd, buf, cap);
    close(fd);
    if (n < 0 || (size_t)n >= cap) return -1;
    buf[n] = 0;
    return (int)n;
}

static int rpc_hex(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
}

static void rpc_le64(unsigned char *p, uint64_t n) {
    for (unsigned i = 0; i < 8; i++) p[i] = (unsigned char)(n >> (8 * i));
}

static int rpc_clock_create(uint64_t origin) {
    unsigned char b[40] = "ERPCONE4", check[40];
    char raw[256], name[32], sec[32], nano[32], extra;
    struct timespec t;
    unsigned seen = 0, nonzero = 0, index = 8;
    if (origin > INT64_MAX - RPC_WINDOW_NS || clock_gettime(CLOCK_MONOTONIC, &t) ||
        t.tv_sec < 0 || (uint64_t)t.tv_sec > INT64_MAX / UINT64_C(1000000000) ||
        t.tv_nsec < 0 || t.tv_nsec >= 1000000000) return -1;
    uint64_t now = (uint64_t)t.tv_sec * UINT64_C(1000000000) + (uint64_t)t.tv_nsec;
    if (now < origin || now >= origin + RPC_WINDOW_NS) { errno = ETIMEDOUT; return -1; }
    if (rpc_clock_read("/proc/self/timens_offsets", raw, sizeof raw) < 0) return -1;
    char *save = NULL;
    for (char *line = strtok_r(raw, "\n", &save); line; line = strtok_r(NULL, "\n", &save)) {
        if (sscanf(line, "%31s %31s %31s %c", name, sec, nano, &extra) != 3 ||
            strcmp(sec, "0") || strcmp(nano, "0")) return -1;
        unsigned bit = !strcmp(name, "monotonic") ? 1 : !strcmp(name, "boottime") ? 2 : 0;
        if (!bit || (seen & bit)) return -1;
        seen |= bit;
    }
    if (seen != 3 || rpc_clock_read("/proc/sys/kernel/random/boot_id", raw, sizeof raw) != 37 || raw[36] != '\n') return -1;
    for (unsigned i = 0; i < 36;) {
        if (i == 8 || i == 13 || i == 18 || i == 23) {
            if (raw[i++] != '-') return -1;
        } else {
            int hi = rpc_hex(raw[i]), lo = rpc_hex(raw[i + 1]);
            if (hi < 0 || lo < 0 || index >= 24) return -1;
            b[index] = (unsigned char)((hi << 4) | lo);
            nonzero |= b[index++];
            i += 2;
        }
    }
    if (!nonzero || index != 24) return -1;
    rpc_le64(b + 24, origin);
    rpc_le64(b + 32, origin + RPC_WINDOW_NS);
    int fd = (int)syscall(SYS_memfd_create, "enclave-rpc-entry", 3 /* CLOEXEC | ALLOW_SEALING */);
    if (fd < 0) return -1;
    if (write(fd, b, sizeof b) != sizeof b || fcntl(fd, F_ADD_SEALS, 15) ||
        fcntl(fd, F_GET_SEALS) != 15 || pread(fd, check, sizeof check, 0) != sizeof check ||
        memcmp(b, check, sizeof b)) { close(fd); return -1; }
    return fd;
}
#endif
