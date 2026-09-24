/* rtset.h: the RUNTIME SET - every file a plane's runtime executes from, as ONE canonical byte string.
 *
 * WHY THIS EXISTS. The SVSM used to admit the wasmtime ELF alone, while the plane runs
 *
 *     /rt/ld-linux-x86-64.so.2 --library-path /rt /rt/wasmtime serve ...
 *
 * so the interpreter, libc, libm and libgcc_s executed without the SVSM ever hashing them: the executing bytes
 * included unadmitted code, and both 2026-09-24 evidence files said so. Admission takes one byte string per kind,
 * so rather than a third kind (a protocol change on both sides) the RUNTIME kind now admits this encoding of the
 * WHOLE runtime directory, and ENCLAVE_RUNTIME_SHA256 is sha256 of it. A changed, missing, added or renamed file
 * changes the digest, and the SVSM's existing hash-freeze-rehash refuses it (0x80001004) - the same comparison
 * the tampered-bundle run exercised on hardware. Nothing in appid.rs had to change to enforce it.
 *
 * ONE implementation, compiled into the guest inits (through plane.h) AND into the host tool m4/rtset.c that
 * prints the digest the SVSM is built with. A second producer of a canonical encoding is a second thing to get
 * wrong. m4/test-rtset.sh reads the format below independently, as a SPEC check, and never as a producer.
 *
 * THE FORMAT, version 1:
 *
 *     "enclave-runtime-set-v1\n"                     23 bytes; an ELF starts \x7fELF, so no set digest can be
 *                                                    the digest of a bare runtime image, and an SVSM built for
 *                                                    either meaning refuses the other
 *     u32le n                                        members, 1..RTSET_MAX_MEMBERS
 *     n records, in strictly increasing bytewise order of name:
 *         u32le len, name[len]                       1..RTSET_MAX_NAME bytes, exactly as the directory holds it
 *         u64le size, content[size]
 *
 * A member is EVERY entry of the directory except "." and "..", and each must be a regular file. Anything else -
 * a subdirectory, a symlink, a device, a FIFO - REFUSES THE WHOLE SET rather than being skipped. That is not
 * tidiness: the loader searches /rt/glibc-hwcaps/x86-64-v4, -v3 and -v2 BEFORE /rt itself (observed with
 * LD_DEBUG=libs on this command line, 2026-09-24), so a skipped subdirectory could hold the libc that actually
 * runs while the set that was admitted holds another.
 *
 * Deliberately NOT encoded: modes, owners, timestamps. They are not bytes that execute, and encoding them would
 * make the digest depend on how a directory was copied rather than on what it holds.
 *
 * THE MAPS CHECK (rtset_wait_coverage). Admitting a set proves the SVSM hashed those files; it does not prove they
 * are what the running process loaded. So once the runtime has started, its /proc/<pid>/maps is read and
 *   - every EXECUTABLE file-backed mapping must be an admitted member, by path AND by the file object (device and
 *     inode) that was encoded - a file renamed over a member after admission has the path and not the inode;
 *   - every ELF member must be mapped. This is what keeps the check from passing vacuously: reading the maps
 *     before the loader has finished, or of a process that loaded something else entirely, sees no violation,
 *     and without this condition that would read as success.
 * Non-executable file mappings outside the set are data, not code, and are REPORTED rather than refused - on a
 * host the loader maps /etc/ld.so.cache read-only even with --inhibit-cache; the plane's image has no /etc.
 */
#ifndef ENCLAVE_RTSET_H
#define ENCLAVE_RTSET_H

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

#define RTSET_MAGIC "enclave-runtime-set-v1\n"
#define RTSET_MAGIC_LEN (sizeof RTSET_MAGIC - 1)
#define RTSET_MAX_MEMBERS 64
#define RTSET_MAX_NAME 255
/* MAX_ARTIFACT_BYTES in appid.rs, and the size of the module's runtime slot: a set the SVSM would refuse by length
 * is refused HERE, with a reason, rather than surfacing as a staging error inside the guest. */
#define RTSET_MAX_BYTES (64ULL * 1024 * 1024)
/* The sink is handed at most this much at once. The guest's sink is a sysfs write, and kernfs caps one write at
 * PAGE_SIZE and silently truncates beyond it, so the chunking is done once, here, for every sink. */
#define RTSET_CHUNK 4096

struct rtset_member {
    char name[RTSET_MAX_NAME + 1];
    uint64_t size;
    dev_t dev;
    ino_t ino;
    int elf;     /* content starts \x7fELF: the maps check requires every such member to be MAPPED */
    int mapped;  /* scratch for rtset_check_maps */
};

struct rtset {
    char dir[4096];
    int n;
    uint64_t total;   /* the encoded length, computed at scan time and checked against what was emitted */
    struct rtset_member m[RTSET_MAX_MEMBERS];
};

typedef int (*rtset_sink)(void *ctx, const void *buf, size_t n);

static const char *rtset_kind(mode_t m) {
    if (S_ISDIR(m)) return "a directory";
    if (S_ISLNK(m)) return "a symlink";
    if (S_ISFIFO(m)) return "a FIFO";
    if (S_ISSOCK(m)) return "a socket";
    if (S_ISCHR(m) || S_ISBLK(m)) return "a device";
    return "not a regular file";
}

static int rtset_cmp(const void *a, const void *b) {
    /* strcmp compares as unsigned char, which is the bytewise order the format specifies */
    return strcmp(((const struct rtset_member *)a)->name, ((const struct rtset_member *)b)->name);
}

/* List the members of `dir`, refusing the whole set on anything the format does not admit. */
static int rtset_scan(struct rtset *s, const char *dir, char *err, size_t el) {
    memset(s, 0, sizeof *s);
    if (strlen(dir) >= sizeof s->dir) { snprintf(err, el, "the directory path is too long"); return -1; }
    strcpy(s->dir, dir);
    DIR *d = opendir(dir);
    if (!d) { snprintf(err, el, "%s: %s", dir, strerror(errno)); return -1; }
    int dfd = dirfd(d), rc = 0;
    s->total = RTSET_MAGIC_LEN + 4;
    struct dirent *e;
    errno = 0;
    while ((e = readdir(d))) {
        if (!strcmp(e->d_name, ".") || !strcmp(e->d_name, "..")) { errno = 0; continue; }
        size_t len = strlen(e->d_name);
        struct stat st;
        if (len > RTSET_MAX_NAME) { snprintf(err, el, "%s: a name longer than %d bytes", dir, RTSET_MAX_NAME); rc = -1; break; }
        if (s->n == RTSET_MAX_MEMBERS) { snprintf(err, el, "%s: more than %d entries", dir, RTSET_MAX_MEMBERS); rc = -1; break; }
        if (fstatat(dfd, e->d_name, &st, AT_SYMLINK_NOFOLLOW) != 0) {
            snprintf(err, el, "%s/%s: %s", dir, e->d_name, strerror(errno)); rc = -1; break;
        }
        if (!S_ISREG(st.st_mode)) {
            snprintf(err, el, "%s/%s is %s: the whole set is refused, not that entry skipped", dir, e->d_name,
                     rtset_kind(st.st_mode));
            rc = -1; break;
        }
        struct rtset_member *m = &s->m[s->n++];
        memcpy(m->name, e->d_name, len + 1);
        m->size = (uint64_t)st.st_size;
        m->dev = st.st_dev;
        m->ino = st.st_ino;
        s->total += 4 + len + 8 + m->size;
        errno = 0;
    }
    if (rc == 0 && errno != 0) { snprintf(err, el, "%s: readdir: %s", dir, strerror(errno)); rc = -1; }
    closedir(d);
    if (rc) return rc;
    if (s->n == 0) {
        snprintf(err, el, "%s is empty: an empty set would admit nothing and still name a runtime", dir);
        return -1;
    }
    if (s->total > RTSET_MAX_BYTES) {
        snprintf(err, el, "%s encodes to %llu bytes, over the %llu the SVSM will hash", dir,
                 (unsigned long long)s->total, (unsigned long long)RTSET_MAX_BYTES);
        return -1;
    }
    qsort(s->m, s->n, sizeof s->m[0], rtset_cmp);
    return 0;
}

struct rtset_out {
    rtset_sink sink;
    void *ctx;
    unsigned char buf[RTSET_CHUNK];
    size_t fill;
    uint64_t written;
    int err;   /* the sink's own error, so the caller can report it */
};

static int rtset_flush(struct rtset_out *o) {
    if (!o->fill) return 0;
    int e = o->sink(o->ctx, o->buf, o->fill);
    if (e) { o->err = e; return -1; }
    o->written += o->fill;
    o->fill = 0;
    return 0;
}

static int rtset_put(struct rtset_out *o, const void *p, size_t n) {
    const unsigned char *b = p;
    while (n) {
        size_t k = RTSET_CHUNK - o->fill;
        if (k > n) k = n;
        memcpy(o->buf + o->fill, b, k);
        o->fill += k;
        b += k;
        n -= k;
        if (o->fill == RTSET_CHUNK && rtset_flush(o)) return -1;
    }
    return 0;
}

static int rtset_put_u32(struct rtset_out *o, uint32_t v) {
    unsigned char b[4] = {v, v >> 8, v >> 16, v >> 24};
    return rtset_put(o, b, 4);
}

static int rtset_put_u64(struct rtset_out *o, uint64_t v) {
    unsigned char b[8];
    for (int i = 0; i < 8; i++) b[i] = (unsigned char)(v >> (8 * i));
    return rtset_put(o, b, 8);
}

/* Emit the encoding of a scanned set to `sink`. Each member is re-opened and must still be the file object the
 * scan saw, with the size the scan saw, and must end exactly there: a file that changes under the encoder refuses
 * the set rather than producing a digest of something that no longer exists. */
static int rtset_encode(struct rtset *s, rtset_sink sink, void *ctx, char *err, size_t el) {
    static struct rtset_out o;
    static unsigned char rbuf[65536];
    memset(&o, 0, sizeof o);
    o.sink = sink;
    o.ctx = ctx;
    int dfd = open(s->dir, O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    if (dfd < 0) { snprintf(err, el, "%s: %s", s->dir, strerror(errno)); return -1; }
    if (rtset_put(&o, RTSET_MAGIC, RTSET_MAGIC_LEN) || rtset_put_u32(&o, (uint32_t)s->n)) goto sink_failed;
    for (int i = 0; i < s->n; i++) {
        struct rtset_member *m = &s->m[i];
        int fd = openat(dfd, m->name, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
        struct stat st;
        if (fd < 0 || fstat(fd, &st) != 0) {
            snprintf(err, el, "%s/%s: %s", s->dir, m->name, strerror(errno));
            if (fd >= 0) close(fd);
            close(dfd);
            return -1;
        }
        if (!S_ISREG(st.st_mode) || st.st_dev != m->dev || st.st_ino != m->ino || (uint64_t)st.st_size != m->size) {
            snprintf(err, el, "%s/%s changed between the scan and the encoding", s->dir, m->name);
            close(fd);
            close(dfd);
            return -1;
        }
        size_t len = strlen(m->name);
        if (rtset_put_u32(&o, (uint32_t)len) || rtset_put(&o, m->name, len) || rtset_put_u64(&o, m->size)) {
            close(fd);
            goto sink_failed;
        }
        uint64_t left = m->size;
        int first = 1;
        m->elf = 0;
        while (left) {
            size_t want = left < sizeof rbuf ? (size_t)left : sizeof rbuf;
            ssize_t r = read(fd, rbuf, want);
            if (r < 0 && errno == EINTR) continue;
            if (r <= 0) {
                snprintf(err, el, "%s/%s: %s", s->dir, m->name, r < 0 ? strerror(errno) : "shrank while encoding");
                close(fd);
                close(dfd);
                return -1;
            }
            if (first) {
                m->elf = r >= 4 && !memcmp(rbuf, "\x7f" "ELF", 4);
                first = 0;
            }
            if (rtset_put(&o, rbuf, (size_t)r)) { close(fd); goto sink_failed; }
            left -= (uint64_t)r;
        }
        ssize_t more = read(fd, rbuf, 1);
        close(fd);
        if (more != 0) {
            snprintf(err, el, "%s/%s: %s", s->dir, m->name, more < 0 ? strerror(errno) : "grew while encoding");
            close(dfd);
            return -1;
        }
    }
    close(dfd);
    if (rtset_flush(&o)) goto sink_failed_closed;
    if (o.written != s->total) {
        snprintf(err, el, "emitted %llu bytes where the scan computed %llu", (unsigned long long)o.written,
                 (unsigned long long)s->total);
        return -1;
    }
    return 0;
sink_failed:
    close(dfd);
sink_failed_closed:
    snprintf(err, el, "the sink refused the encoding after %llu bytes: %s", (unsigned long long)o.written,
             o.err < 0 ? strerror(-o.err) : "error");
    return -1;
}

/* fork + execve, returning only once the child IS the new program.
 *
 * Before execve completes, /proc/<pid>/maps is the PARENT's image - a forked copy of the init binary - so a maps
 * check that started early would report /init as an unadmitted executable mapping, or, worse, a check written to
 * tolerate that would tolerate anything. A CLOEXEC pipe closes exactly when execve succeeds, and carries errno if
 * it does not. */
static pid_t __attribute__((unused)) rtset_spawn(char *const argv[], char *const envp[], int *err_out) {
    int p[2];
    if (pipe2(p, O_CLOEXEC) != 0) { *err_out = errno; return -1; }
    pid_t pid = fork();
    if (pid < 0) { *err_out = errno; close(p[0]); close(p[1]); return -1; }
    if (pid == 0) {
        close(p[0]);
        execve(argv[0], argv, envp);
        int e = errno;
        ssize_t w = write(p[1], &e, sizeof e);
        (void)w;
        _exit(127);
    }
    close(p[1]);
    int e = 0;
    ssize_t r;
    do { r = read(p[0], &e, sizeof e); } while (r < 0 && errno == EINTR);
    close(p[0]);
    if (r > 0) {
        waitpid(pid, NULL, 0);
        *err_out = e;
        return -1;
    }
    return pid;
}

/* One reading of the maps: 1 covered, 0 not every ELF member mapped yet, -1 a violation (err says which).
 * `outside` collects non-executable file mappings outside the set, which are reported and not refused. */
static int rtset_check_maps(struct rtset *s, pid_t pid, char *outside, size_t osz, char *err, size_t el) {
    char path[64];
    snprintf(path, sizeof path, "/proc/%d/maps", (int)pid);
    FILE *f = fopen(path, "re");
    if (!f) { snprintf(err, el, "%s: %s", path, strerror(errno)); return -1; }
    for (int i = 0; i < s->n; i++) s->m[i].mapped = 0;
    outside[0] = 0;
    size_t dl = strlen(s->dir);
    static char line[4096 + 512];
    while (fgets(line, sizeof line, f)) {
        char perms[8] = {0};
        unsigned long long off, ino;
        unsigned maj, min;
        int pos = 0;
        if (sscanf(line, "%*[0-9a-f]-%*[0-9a-f] %7s %llx %x:%x %llu %n", perms, &off, &maj, &min, &ino, &pos) < 5 || !pos)
            continue;
        char *p = line + pos;
        p[strcspn(p, "\n")] = 0;
        if (p[0] != '/') continue;  /* anonymous (the JIT's own code), [heap], [stack], [vdso], [vvar] */
        int member = -1;
        if (!strncmp(p, s->dir, dl) && p[dl] == '/') {
            for (int i = 0; i < s->n; i++)
                if (!strcmp(p + dl + 1, s->m[i].name)) { member = i; break; }
        }
        if (member >= 0) {
            struct rtset_member *m = &s->m[member];
            if (ino != (unsigned long long)m->ino || makedev(maj, min) != m->dev) {
                snprintf(err, el, "%s is mapped, but it is not the file object that was admitted (inode %llu, "
                         "admitted %llu): it was replaced after admission", p, ino, (unsigned long long)m->ino);
                fclose(f);
                return -1;
            }
            m->mapped = 1;
            continue;
        }
        if (perms[2] == 'x') {
            snprintf(err, el, "%s is mapped EXECUTABLE and is not a member of the admitted runtime set", p);
            fclose(f);
            return -1;
        }
        if (!strstr(outside, p) && strlen(outside) + strlen(p) + 2 < osz) {
            if (outside[0]) strcat(outside, ",");
            strcat(outside, p);
        }
    }
    fclose(f);
    for (int i = 0; i < s->n; i++)
        if (s->m[i].elf && !s->m[i].mapped) return 0;
    return 1;
}

/* Poll until the loaded process is covered (1) or not (-1). A timeout is a refusal: a check that never saw every
 * admitted ELF member mapped has not seen a complete load, and cannot say what that load contained. */
static int __attribute__((unused)) rtset_wait_coverage(struct rtset *s, pid_t pid, int timeout_ms, char *outside, size_t osz, char *err,
                               size_t el, int *polls) {
    struct timespec tick = {0, 10 * 1000 * 1000};
    *polls = 0;
    for (int waited = 0;; waited += 10) {
        (*polls)++;
        int r = rtset_check_maps(s, pid, outside, osz, err, el);
        if (r != 0) return r;
        if (waited >= timeout_ms) {
            int k = snprintf(err, el, "not every admitted ELF member was mapped within %d ms, so no complete load "
                             "was seen; unmapped:", timeout_ms);
            for (int i = 0; i < s->n && k > 0 && (size_t)k < el; i++)
                if (s->m[i].elf && !s->m[i].mapped) k += snprintf(err + k, el - k, " %s", s->m[i].name);
            return -1;
        }
        nanosleep(&tick, NULL);
    }
}

static int rtset_elf_members(const struct rtset *s) {
    int k = 0;
    for (int i = 0; i < s->n; i++) k += s->m[i].elf;
    return k;
}

#endif /* ENCLAVE_RTSET_H */
