/* jit_probe -- can a protected VM's payload JIT? (PVM-CPU.md, portable runtime.)
 * The portable app is a WebAssembly component compiled INSIDE the pVM to ARM64. That needs executable pages the payload
 * creates itself. A VBS enclave refuses every such page (VTL1: ERROR_DYNAMIC_CODE_BLOCKED); this measures the Microdroid pVM:
 *   1. the payload's SELinux context and the CPU's features (AT_HWCAP/AT_HWCAP2, /proc/cpuinfo) -- the CPU feature policy;
 *   2. RWX: an anonymous PROT_READ|PROT_WRITE|PROT_EXEC mapping. The runtime must never use one; this records whether the
 *      platform even allows it (W^X enforced by policy, or only by the runtime);
 *   3. W^X: map RW, write ARM64 code (mov w0,#42; ret), mprotect to R+X (never both W and X), flush the icache, call it;
 *   4. the process's maps: any mapping that is writable and executable at once.
 * Prints JIT_PROBE lines and exits 0 when the W^X path works. */
#define _GNU_SOURCE
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/auxv.h>
#include <sys/mman.h>
#include <unistd.h>
#include <fcntl.h>
#include <android/log.h>
#include "vm_payload.h"
#define OUT(...) do { printf(__VA_ARGS__); printf("\n"); fflush(stdout); __android_log_print(ANDROID_LOG_INFO, "jit-probe", __VA_ARGS__); } while (0)

static void read_line(const char *path, const char *prefix, char *out, size_t cap) {
    out[0] = 0; FILE *f = fopen(path, "r"); if (!f) { snprintf(out, cap, "unreadable: %s", strerror(errno)); return; }
    char l[1024];
    while (fgets(l, sizeof l, f)) if (!prefix || !strncmp(l, prefix, strlen(prefix))) { l[strcspn(l, "\n")] = 0; snprintf(out, cap, "%s", l); break; }
    fclose(f);
}
int AVmPayload_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    AVmPayload_notifyPayloadReady();
    char s[1024];
    read_line("/proc/self/attr/current", NULL, s, sizeof s); OUT("JIT_PROBE selinux=%s", s);
    OUT("JIT_PROBE hwcap=0x%lx hwcap2=0x%lx", getauxval(AT_HWCAP), getauxval(AT_HWCAP2));
    read_line("/proc/cpuinfo", "Features", s, sizeof s); OUT("JIT_PROBE cpuinfo %s", s);
    const long ps = sysconf(_SC_PAGESIZE);
    /* 2. RWX */
    void *rwx = mmap(NULL, (size_t)ps, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    OUT("JIT_PROBE rwx_anonymous=%s", rwx == MAP_FAILED ? strerror(errno) : "ALLOWED (the runtime must still never use it)");
    if (rwx != MAP_FAILED) munmap(rwx, (size_t)ps);
    /* 3. W^X: RW, write, then RX */
    int rc = 1;
    uint32_t *code = mmap(NULL, (size_t)ps, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (code == MAP_FAILED) OUT("JIT_PROBE wx_map_rw=FAILED %s", strerror(errno));
    else {
        code[0] = 0x52800540u;   /* mov w0, #42 */
        code[1] = 0xd65f03c0u;   /* ret */
        if (mprotect(code, (size_t)ps, PROT_READ | PROT_EXEC) != 0) OUT("JIT_PROBE wx_mprotect_rx=REFUSED %s", strerror(errno));
        else {
            __builtin___clear_cache((char *)code, (char *)code + 8);
            int (*fn)(void) = (int (*)(void))(uintptr_t)code;
            const int v = fn();
            OUT("JIT_PROBE wx_call=%d (%s)", v, v == 42 ? "PASS: code written RW, executed RX" : "WRONG RESULT");
            if (v == 42) rc = 0;
            /* a page that was RX must not become writable again silently: record what the platform does */
            OUT("JIT_PROBE rx_to_rw=%s", mprotect(code, (size_t)ps, PROT_READ | PROT_WRITE) == 0 ? "allowed (a runtime must not do it while the code can run)" : strerror(errno));
        }
        munmap(code, (size_t)ps);
    }
    /* 5-8. file-backed code: write through a RW mapping, UNMAP it, then map the same file R+X (never W and X at once).
     * SELinux judges a file mapping by the file's type, not by execmem. */
    static const uint32_t prog[2] = { 0x52800540u, 0xd65f03c0u };
    struct { const char *name; int fd; } files[4] = { { "memfd", -1 }, { "memfd-mprotect", -1 }, { "vm-data", -1 }, { "encryptedstore", -1 } };
    files[0].fd = memfd_create("jit-code", MFD_CLOEXEC); files[1].fd = memfd_create("jit-code2", MFD_CLOEXEC);
    files[2].fd = open("/data/local/tmp/jit-code.bin", O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0700);
    if (files[2].fd < 0) files[2].fd = open("/data/jit-code.bin", O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0700);
    { const char *es = AVmPayload_getEncryptedStoragePath(); char ep[512]; if (es) { snprintf(ep, sizeof ep, "%s/jit-code.bin", es); files[3].fd = open(ep, O_RDWR | O_CREAT | O_TRUNC | O_CLOEXEC, 0700); } }
    for (int k = 0; k < 4; k++) {
        const int fd = files[k].fd;
        if (fd < 0) { OUT("JIT_PROBE file_%s=unavailable %s", files[k].name, strerror(errno)); continue; }
        if (ftruncate(fd, ps) != 0) { OUT("JIT_PROBE file_%s=ftruncate %s", files[k].name, strerror(errno)); close(fd); continue; }
        uint32_t *w = mmap(NULL, (size_t)ps, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        if (w == MAP_FAILED) { OUT("JIT_PROBE file_%s=map_rw %s", files[k].name, strerror(errno)); close(fd); continue; }
        memcpy(w, prog, sizeof prog);
        void *x = MAP_FAILED; const char *how;
        if (k == 1) { how = "mprotect"; x = mprotect(w, (size_t)ps, PROT_READ | PROT_EXEC) == 0 ? (void *)w : MAP_FAILED; }
        else { how = "unmap+map_rx"; munmap(w, (size_t)ps); x = mmap(NULL, (size_t)ps, PROT_READ | PROT_EXEC, MAP_SHARED, fd, 0); }
        if (x == MAP_FAILED) { OUT("JIT_PROBE file_%s=%s REFUSED %s", files[k].name, how, strerror(errno)); if (k == 1) munmap(w, (size_t)ps); close(fd); continue; }
        __builtin___clear_cache((char *)x, (char *)x + 8);
        const int v = ((int (*)(void))(uintptr_t)x)();
        OUT("JIT_PROBE file_%s=%s call=%d (%s)", files[k].name, how, v, v == 42 ? "PASS" : "WRONG");
        if (v == 42 && k != 1 && rc) rc = 0;
        munmap(x, (size_t)ps); close(fd);
    }
    /* 4. any writable+executable mapping in this process */
    FILE *m = fopen("/proc/self/maps", "r"); int wx = 0; char l[1024];
    if (m) { while (fgets(l, sizeof l, m)) { char perm[8] = ""; if (sscanf(l, "%*s %7s", perm) == 1 && strchr(perm, 'w') && strchr(perm, 'x')) { wx++; OUT("JIT_PROBE wx_mapping %s", l); } } fclose(m); }
    OUT("JIT_PROBE wx_mappings=%d", wx);
    OUT("JIT_PROBE end rc=%d", rc);
    return rc;
}
