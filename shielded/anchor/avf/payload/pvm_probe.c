/* pvm_probe -- what a Microdroid payload can do that the engine will need:
 * dlopen a second .so from the APK by absolute path, memfd_create + mmap a
 * large file-backed region (the model's home: the VM has no filesystem the
 * owner can populate), and how much memory the VM actually has. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <sys/sysinfo.h>
#include <sys/statvfs.h>
#include <errno.h>
#include <sys/resource.h>
#include <fcntl.h>
#include <unistd.h>
#include <android/log.h>
#include "vm_payload.h"
#define OUT(...) do { printf(__VA_ARGS__); printf("\n"); fflush(stdout); __android_log_print(ANDROID_LOG_INFO, "pvm-probe", __VA_ARGS__); } while (0)
int AVmPayload_main(void) {
    setvbuf(stdout, NULL, _IONBF, 0);
    AVmPayload_notifyPayloadReady();
    const char *apk = AVmPayload_getApkContentsPath();
    OUT("PROBE apk=%s", apk);
    struct sysinfo si; sysinfo(&si);
    OUT("PROBE mem total=%lu MiB free=%lu MiB procs=%d nproc=%ld", si.totalram * si.mem_unit >> 20, si.freeram * si.mem_unit >> 20, si.procs, sysconf(_SC_NPROCESSORS_ONLN));
    char p[512];
    static const char *libs[] = { "libc++_shared.so", "libggml-base.so", "libggml.so" };
    for (unsigned i = 0; i < sizeof libs / sizeof *libs; i++) {
        const char *lib = libs[i];
        snprintf(p, sizeof p, "%s/lib/arm64-v8a/%s", apk, lib);
        void *h = dlopen(p, RTLD_NOW | RTLD_GLOBAL);
        OUT("PROBE dlopen %s -> %s", lib, h ? "OK" : dlerror());
    }
    void *sym = dlsym(RTLD_DEFAULT, "ggml_backend_dev_by_type"); OUT("PROBE ggml_backend_dev_by_type visible=%s", sym ? "yes" : "no");
    { struct rlimit rl; getrlimit(RLIMIT_FSIZE, &rl); OUT("PROBE RLIMIT_FSIZE soft=%lld hard=%lld", (long long)rl.rlim_cur, (long long)rl.rlim_max);
      getrlimit(RLIMIT_AS, &rl); OUT("PROBE RLIMIT_AS soft=%lld hard=%lld", (long long)rl.rlim_cur, (long long)rl.rlim_max); }
    int fd = memfd_create("model", 0);
    size_t want = (size_t)794 << 20;
    int rc = fd >= 0 ? ftruncate(fd, (off_t)want) : -1;
    OUT("PROBE memfd fd=%d ftruncate(900MiB)=%d errno=%d(%s)", fd, rc, rc ? errno : 0, rc ? strerror(errno) : "");
    if (rc) { want = (size_t)300 << 20; rc = ftruncate(fd, (off_t)want); OUT("PROBE memfd ftruncate(300MiB)=%d errno=%d", rc, rc ? errno : 0); }
    static const char *dirs[] = { "/data", "/data/local/tmp", "/tmp", "/dev/shm", "/mnt", "/" };
    for (unsigned i = 0; i < sizeof dirs / sizeof *dirs; i++) {
        struct statvfs v; if (statvfs(dirs[i], &v) != 0) { OUT("PROBE fs %s: statvfs errno=%d", dirs[i], errno); continue; }
        snprintf(p, sizeof p, "%s/anchor-probe.tmp", dirs[i]); int t = open(p, O_CREAT | O_WRONLY | O_TRUNC, 0600);
        OUT("PROBE fs %s: free=%llu MiB ro=%d create=%s", dirs[i], (unsigned long long)v.f_bavail * v.f_frsize >> 20, !!(v.f_flag & ST_RDONLY), t >= 0 ? "OK" : strerror(errno));
        if (t >= 0) { close(t); unlink(p); }
    }
    if (rc == 0) {
        char *m = mmap(NULL, want, PROT_READ | PROT_WRITE, MAP_SHARED, fd, 0);
        OUT("PROBE mmap=%s", m == MAP_FAILED ? "FAILED" : "OK");
        if (m != MAP_FAILED) { for (size_t o = 0; o < want; o += 4096) m[o] = (char)o; sysinfo(&si); OUT("PROBE touched 900 MiB, free now=%lu MiB", si.freeram * si.mem_unit >> 20); snprintf(p, sizeof p, "/proc/self/fd/%d", fd); FILE *f = fopen(p, "rb"); OUT("PROBE fopen(%s)=%s", p, f ? "OK" : "FAILED"); if (f) fclose(f); munmap(m, want); }
    }
    snprintf(p, sizeof p, "%s/assets", apk); OUT("PROBE assets dir access=%d", access(p, R_OK));
    const char *es = AVmPayload_getEncryptedStoragePath();
    OUT("PROBE encrypted storage path=%s", es ? es : "(none)");
    if (es) {
        struct statvfs v; if (statvfs(es, &v) == 0) OUT("PROBE fs %s: free=%llu MiB ro=%d", es, (unsigned long long)v.f_bavail * v.f_frsize >> 20, !!(v.f_flag & ST_RDONLY));
        snprintf(p, sizeof p, "%s/model.bin", es); int t = open(p, O_CREAT | O_RDWR | O_TRUNC, 0600);
        OUT("PROBE create %s -> %s", p, t >= 0 ? "OK" : strerror(errno));
        if (t >= 0) {
            size_t sz = (size_t)794 << 20; int rc = ftruncate(t, (off_t)sz); OUT("PROBE ftruncate(794MiB)=%d errno=%d", rc, rc ? errno : 0);
            static char blk[1 << 20]; memset(blk, 0x5a, sizeof blk); size_t done = 0; int werr = 0;
            for (; done < sz; done += sizeof blk) if (write(t, blk, sizeof blk) != (ssize_t)sizeof blk) { werr = errno; break; }
            OUT("PROBE wrote %zu MiB, err=%d", done >> 20, werr);
            char *m = mmap(NULL, sz, PROT_READ, MAP_PRIVATE, t, 0); OUT("PROBE mmap file=%s first byte=%02x", m == MAP_FAILED ? "FAILED" : "OK", m == MAP_FAILED ? 0 : (unsigned char)m[0]);
            if (m != MAP_FAILED) munmap(m, sz);
            close(t); unlink(p);
        }
    }
    OUT("PROBE end"); sleep(1); return 0;
}
