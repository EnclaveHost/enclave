/* plane.h: the guest side of the SVSM's appid protocol - the sysfs writes, the staging loop, and the
 * evidence channel. Shared by the two PID 1s that admit a plane, so there is ONE copy of the parts that are
 * easy to get subtly wrong.
 *
 * EXTRACTED VERBATIM from admitinit.c after the step-2 fixture passed 15/15, and the extraction was checked by
 * diffing admitinit.c's PREPROCESSED source before and after - identical - so the fixture's behaviour cannot
 * have changed. The runtime-set staging at the end was added LATER and is not covered by that 15/15: the step-2
 * run staged the wasmtime ELF alone. Define EV_PREFIX before including to name the lines ("ADMIT", "PLANE"); it
 * defaults to ADMIT.
 *
 * The two subtleties, both of which cost a debugging session:
 *   a SHORT sysfs write is a FAILURE. kernfs caps one write at PAGE_SIZE and returns the truncated length with
 *   errno untouched, so a caller checking only "did write() fail" stages the first 4 KiB of every chunk.
 *   the evidence channel needs its OWN port. The console is shared with the SVSM and has no flow control, so
 *   concurrent writers drop bytes - a first run lost five consecutive result lines.
 */
#ifndef ENCLAVE_PLANE_H
#define ENCLAVE_PLANE_H

#ifndef EV_PREFIX
#define EV_PREFIX "ADMIT"
#endif

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <sys/syscall.h>
#include <unistd.h>

#define SYS "/sys/kernel/appid/"
#define CHUNK 4096            /* kernfs caps one sysfs write at PAGE_SIZE; more is silently truncated */

/* Results go to /dev/ttyS1 when it exists, and to the console either way.
 *
 * The console is shared with the SVSM's own output and has no flow control, so concurrent writers drop bytes:
 * a first run on hardware lost five consecutive result lines and mangled a sixth into an SVSM request-loop
 * message. A harness cannot score a channel that loses evidence, so the scoreable copy gets its own port. */
static int evfd = -1;

static void say(const char *k, const char *v) {
    char line[9000];
    int n = snprintf(line, sizeof line, EV_PREFIX " %s=%s\n", k, v);
    if (n < 0) return;
    if (n > (int)sizeof line - 1) n = sizeof line - 1;
    if (evfd >= 0) {
        ssize_t off = 0;
        while (off < n) {
            ssize_t w = write(evfd, line + off, n - off);
            if (w <= 0) break;
            off += w;
        }
        fsync(evfd);
    }
    fputs(line, stdout);
    fflush(stdout);
}

/* Load a module with arguments and report the outcome in the caller's own words.
 *
 * The first version printed "LOADED - this guest holds a message key" for WHICHEVER module loaded, including
 * tsm_report - which is the generic report core and loads with no key at all. That put a false sentence into a
 * committed evidence file, which is worse than a bug in code: a reviewer reading the evidence would have drawn
 * the opposite conclusion. Each step now says only what its own result means. */
static void __attribute__((unused)) insmod_args(const char *p, const char *args, const char *key,
                        const char *on_load, const char *on_fail_prefix) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    char msg[256];
    if (fd < 0) { say(key, "absent from the image"); return; }
    long r = syscall(SYS_finit_module, fd, args, 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r == 0) say(key, on_load);
    else { snprintf(msg, sizeof msg, "%s%s", on_fail_prefix, strerror(errno)); say(key, msg); }
    close(fd);
}

/* A COMPRESSED module (.ko.zst) needs MODULE_INIT_COMPRESSED_FILE; without it the kernel sees the zstd frame and
 * returns ENOEXEC, which reads as "Exec format error" and looks like a wrong-architecture build rather than a
 * missing flag. Measured: planeinit loaded the three vsock modules with flags 0 and all three failed that way,
 * leaving the domain with no transport at all. EEXIST is not a failure - the module is already in. */
static void __attribute__((unused)) insmod_zst(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { say("insmod_zst", strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 4 /* MODULE_INIT_COMPRESSED_FILE */);
    if (r != 0 && errno != EEXIST) {
        char msg[256];
        snprintf(msg, sizeof msg, "%s: %s", p, strerror(errno));
        say("insmod_zst", msg);
    }
    close(fd);
}

static void __attribute__((unused)) insmod(const char *p) {
    int fd = open(p, O_RDONLY | O_CLOEXEC);
    if (fd < 0) { say("insmod", strerror(errno)); return; }
    long r = syscall(SYS_finit_module, fd, "", 0);
    say("insmod", r == 0 ? "ok" : strerror(errno));
    close(fd);
}

/* A SHORT write is a failure: kernfs returns the truncated length with errno untouched, so a caller checking
 * only "did write() fail" would stage every first 4 KiB of each chunk and blame the digest later. */
static int put(const char *name, const void *buf, size_t n) {
    char path[128];
    snprintf(path, sizeof path, SYS "%s", name);
    int fd = open(path, O_WRONLY);
    if (fd < 0) return -errno;
    ssize_t w = write(fd, buf, n);
    int e = w == (ssize_t)n ? 0 : (w < 0 ? -errno : -EIO);
    close(fd);
    return e;
}

static int puts_(const char *name, const char *s) { return put(name, s, strlen(s)); }

static void __attribute__((unused)) show_path(const char *key, const char *path) {
    char buf[512] = {0};
    int fd = open(path, O_RDONLY | O_DIRECTORY);
    if (fd >= 0) { close(fd); say(key, "present"); return; }
    say(key, strerror(errno));
    (void)buf;
}

static void __attribute__((unused)) show(const char *key, const char *name) {
    char path[128], buf[8192] = {0};
    snprintf(path, sizeof path, SYS "%s", name);
    int fd = open(path, O_RDONLY);
    if (fd < 0) { say(key, strerror(errno)); return; }
    ssize_t n = read(fd, buf, sizeof buf - 1);
    close(fd);
    if (n < 0) { say(key, strerror(errno)); return; }
    while (n > 0 && (buf[n - 1] == '\n' || buf[n - 1] == ' ')) buf[--n] = 0;
    say(key, buf[0] ? buf : "(empty)");
}

/* stage a file into the active slot in PAGE_SIZE chunks, failing on the first short or refused write */
static int __attribute__((unused)) stage(const char *path, int flip_byte) {
    static char buf[CHUNK];
    int fd = open(path, O_RDONLY);
    if (fd < 0) return -errno;
    size_t total = 0;
    ssize_t n;
    int flipped = 0;
    while ((n = read(fd, buf, sizeof buf)) > 0) {
        if (flip_byte && !flipped) { buf[0] ^= 0xff; flipped = 1; }
        int e = put("artifact", buf, n);
        if (e != 0) { close(fd); return e; }
        total += n;
    }
    if (n < 0) { close(fd); return -errno; }
    close(fd);
    return total > 0 ? 0 : -EIO;
}

/* Stage bytes already in memory into the active slot, in whole-PAGE_SIZE sysfs writes. Used for the bundle, so the
 * bytes the SVSM admits are the very buffer the component is later cut from (appbundle.h). */
static int __attribute__((unused)) stage_bytes(const void *buf, size_t n) {
    const char *p = buf;
    if (n == 0) return -EIO;
    while (n) {
        size_t k = n < CHUNK ? n : CHUNK;
        int e = put("artifact", p, k);
        if (e != 0) return e;
        p += k;
        n -= k;
    }
    return 0;
}

/* Added 2026-09-24, after the extraction above: the RUNTIME kind admits the runtime SET of a directory, not one
 * file. See rtset.h for the format and for why a subdirectory refuses rather than being skipped. The encoder hands
 * this sink at most RTSET_CHUNK bytes at a time, so every write is one whole sysfs write. */
#include "rtset.h"

static int __attribute__((unused)) rtset_sysfs_sink(void *ctx, const void *buf, size_t n) {
    (void)ctx;
    return put("artifact", buf, n);
}

/* Stage the runtime set of `dir` into the active slot, leaving in `s` what was staged - its members, their sizes
 * and the file objects they were read from, which the maps check needs later. 0, or -1 with `err` set. */
static int __attribute__((unused)) stage_runtime_set(struct rtset *s, const char *dir, char *err, size_t el) {
    if (rtset_scan(s, dir, err, el)) return -1;
    return rtset_encode(s, rtset_sysfs_sink, NULL, err, el);
}

/* Say what the set holds, one line per member, so the evidence names every file the SVSM was asked to hash. */
static void __attribute__((unused)) say_runtime_set(const char *key, const struct rtset *s) {
    char line[512];
    for (int i = 0; i < s->n; i++) {
        snprintf(line, sizeof line, "%s size=%llu elf=%d", s->m[i].name, (unsigned long long)s->m[i].size,
                 s->m[i].elf);
        say(key, line);
    }
    snprintf(line, sizeof line, "members=%d elf=%d bytes=%llu (rtset v1 over %.256s, every entry)", s->n,
             rtset_elf_members(s), (unsigned long long)s->total, s->dir);
    say("runtime_set", line);
}


#endif /* ENCLAVE_PLANE_H */
