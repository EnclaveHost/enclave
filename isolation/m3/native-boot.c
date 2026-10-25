/* Production native boot helper. The production dominit runs this once, as a
 * root child, after its guest proc, sysfs, devtmpfs, /run and cgroup mounts and
 * before the monitor, in PID 1's mount namespace. It:
 *   1. opens exactly the three measured optical media (/dev/sr0..2), marks each
 *      read-only and tells them apart only by their build-pinned container
 *      sizes (a fixed 64 KiB header followed by the original raw payload);
 *   2. maps each payload, past its header, as a read-only dm-linear device with
 *      the measured /dmsetup, then checks the resulting dm tables;
 *   3. opens native-root and native-models over those linear devices with the
 *      measured /veritysetup and the build-pinned roots and salts, then checks
 *      the resulting dm tables;
 *   4. mounts both read-only (dm-verity authenticates every block as it is read;
 *      nothing here reads the whole device, and no header or ISO metadata is
 *      parsed);
 *   5. creates /dev/input, binds the verified nsinit onto /plat/native-desktop,
 *      loads the verified nft_ct.ko and seals /plat read-only.
 * There are no arguments, flags or environment-selected paths. Only fixed stage
 * names and errno values are printed. Any failure returns nonzero and dominit
 * powers the guest off; nothing is undone because nothing continues. */
#define _GNU_SOURCE
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <linux/dm-ioctl.h>
#include <linux/magic.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/statvfs.h>
#include <sys/syscall.h>
#include <sys/sysmacros.h>
#include <sys/utsname.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>
#include "native-boot-profile.h"

#define KERNEL_RELEASE "6.6.87.2-enclave-kvm-box"
#define VERITY_BLOCK ((uint64_t)4096)
#define SCSI_CDROM_MAJOR 11u
#define MEDIA_READY_MS 30000
#define TOOL_TIMEOUT_MS 10000
#define DMSETUP "/dmsetup"
#define VERITYSETUP "/veritysetup"
#define NSINIT_REL "usr/local/libexec/kvm-box/nsinit"
#define NFT_CT_REL "usr/local/libexec/kvm-box/nft_ct.ko"
/* each medium is a fixed header followed by the raw payload; the linear maps
 * skip the header, so verity offsets stay relative to the payload */
#define CONTAINER_HEADER_BYTES ((uint64_t)65536)
#define HEADER_SECTORS 128u
#define MAX_PAYLOAD_BYTES ((uint64_t)128 << 30)
#ifndef STATX_ATTR_MOUNT_ROOT
#define STATX_ATTR_MOUNT_ROOT 0x00002000
#endif

_Static_assert(IMAGE_BYTES && HASH_BYTES && MODEL_IMAGE_BYTES && MODEL_BYTES, "profile sizes must be nonzero");
_Static_assert(IMAGE_BYTES != HASH_BYTES && IMAGE_BYTES != MODEL_IMAGE_BYTES && HASH_BYTES != MODEL_IMAGE_BYTES,
               "media are told apart by size, so the three sizes must differ");
_Static_assert(CONTAINER_HEADER_BYTES == (uint64_t)HEADER_SECTORS * 512, "header must be whole sectors");
_Static_assert((uint64_t)IMAGE_BYTES <= MAX_PAYLOAD_BYTES && (uint64_t)HASH_BYTES <= MAX_PAYLOAD_BYTES &&
               (uint64_t)MODEL_IMAGE_BYTES <= MAX_PAYLOAD_BYTES,
               "payloads are bounded, so header plus payload cannot overflow");
_Static_assert((uint64_t)IMAGE_BYTES % 512 == 0 && (uint64_t)HASH_BYTES % 512 == 0 &&
               (uint64_t)MODEL_IMAGE_BYTES % 512 == 0, "linear maps cover whole sectors");

enum { ROLE_ROOT, ROLE_HASH, ROLE_MODEL, ROLES };
/* one set for the optical media, a separate one for the linear maps over them */
struct media { int fd[ROLES]; dev_t dev[ROLES]; };
struct profile {
    uint64_t root_blocks, model_blocks, model_hash_start, model_hash_offset;
    uint64_t payload[ROLES], container[ROLES];
};

static char *const linear_name[ROLES] = {"native-root-data", "native-root-hashes", "native-model-data"};

static int fail(const char *stage, int err) {
    dprintf(2, "NATIVE_BOOT_FAIL stage=%s errno=%d\n", stage, err);
    return -1;
}

static void stage(const char *s) { dprintf(2, "NATIVE_BOOT stage=%s\n", s); }

static char *fdpath(char *buf, size_t n, int fd) {
    snprintf(buf, n, "/proc/self/fd/%d", fd);
    return buf;
}

static int64_t mono_ms(void) {
    struct timespec t;
    if (clock_gettime(CLOCK_MONOTONIC, &t)) return -1;
    return (int64_t)t.tv_sec * 1000 + t.tv_nsec / 1000000;
}

static void pause_ms(long ms) {
    struct timespec t = {0, ms * 1000000L};
    while (nanosleep(&t, &t) && errno == EINTR) {}
}

/* Strict decimal: digits only, no sign, no leading zero, no overflow. */
static int parse_u64(const char *s, uint64_t *out) {
    uint64_t v = 0;
    if (!s[0] || strlen(s) > 20 || (s[0] == '0' && s[1])) return -1;
    for (; *s; s++) {
        if (*s < '0' || *s > '9') return -1;
        if (__builtin_mul_overflow(v, 10, &v) || __builtin_add_overflow(v, (uint64_t)(*s - '0'), &v)) return -1;
    }
    *out = v;
    return 0;
}

/* Lowercase only: the kernel prints root and salt that way in the dm table. */
static int is_hex(const char *s, size_t min, size_t max) {
    size_t n = strlen(s);
    if (n < min || n > max || n % 2) return 0;
    for (; *s; s++)
        if (!((*s >= '0' && *s <= '9') || (*s >= 'a' && *s <= 'f'))) return 0;
    return 1;
}

static int digits(const char *s) {
    if (!*s) return 0;
    for (; *s; s++)
        if (*s < '0' || *s > '9') return 0;
    return 1;
}

static int check_profile(struct profile *p) {
    uint64_t bytes;
    if (parse_u64(DATA_BLOCKS, &p->root_blocks) || !p->root_blocks ||
        __builtin_mul_overflow(p->root_blocks, VERITY_BLOCK, &bytes) || bytes != IMAGE_BYTES)
        return fail("profile-root", EINVAL);
    if (parse_u64(MODEL_BLOCKS, &p->model_blocks) || !p->model_blocks ||
        __builtin_mul_overflow(p->model_blocks, VERITY_BLOCK, &bytes) || bytes != MODEL_BYTES)
        return fail("profile-model", EINVAL);
    /* the hash tree follows the data in the same payload and lies inside it */
    if (parse_u64(MODEL_HASH_START, &p->model_hash_start) || p->model_hash_start < p->model_blocks ||
        __builtin_mul_overflow(p->model_hash_start, VERITY_BLOCK, &p->model_hash_offset) ||
        p->model_hash_offset >= MODEL_IMAGE_BYTES)
        return fail("profile-model-hash", EINVAL);
    if (!is_hex(VERITY_ROOT, 64, 64) || !is_hex(MODEL_ROOT, 64, 64) ||
        !is_hex(VERITY_SALT, 2, 512) || !is_hex(MODEL_SALT, 2, 512))
        return fail("profile-hex", EINVAL);
    p->payload[ROLE_ROOT] = IMAGE_BYTES;
    p->payload[ROLE_HASH] = HASH_BYTES;
    p->payload[ROLE_MODEL] = MODEL_IMAGE_BYTES;
    for (int i = 0; i < ROLES; i++)
        if (p->payload[i] > MAX_PAYLOAD_BYTES || p->payload[i] % 512 ||
            __builtin_add_overflow(p->payload[i], CONTAINER_HEADER_BYTES, &p->container[i]))
            return fail("profile-container", EOVERFLOW);
    return 0;
}

/* Keeps descriptors 0-2 occupied so no device descriptor can land on them. */
static int std_fds(void) {
    for (int fd = 0; fd < 3; fd++) {
        if (fcntl(fd, F_GETFD) >= 0) continue;
        if (errno != EBADF || open("/dev/null", O_RDWR | O_NOFOLLOW) != fd) return -1;
    }
    return 0;
}

static ssize_t read_small(const char *path, char *buf, size_t n) {
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return -1;
    ssize_t r = read(fd, buf, n - 1);
    int e = errno;
    close(fd);
    errno = e;
    if (r >= 0) buf[r] = 0;
    return r;
}

static int safe_dir(int fd) {
    struct stat st;
    if (fstat(fd, &st)) return -1;
    if (!S_ISDIR(st.st_mode)) { errno = ENOTDIR; return -1; }
    if (st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH))) { errno = EPERM; return -1; }
    return 0;
}

/* Opens an absolute directory one component at a time without following
 * symlinks; every directory on the way, "/" included, must be root-owned and
 * not group or other writable. With create, a missing component is made 0755. */
static int open_dir_path(const char *path, int create) {
    char buf[256], *save = NULL;
    if (path[0] != '/' || strlen(path) >= sizeof buf) { errno = EINVAL; return -1; }
    strcpy(buf, path);
    int fd = open("/", O_PATH | O_DIRECTORY | O_CLOEXEC);
    if (fd < 0) return -1;
    if (safe_dir(fd)) goto bad;
    for (char *c = strtok_r(buf, "/", &save); c; c = strtok_r(NULL, "/", &save)) {
        if (!strcmp(c, ".") || !strcmp(c, "..")) { errno = EINVAL; goto bad; }
        int next = openat(fd, c, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0 && errno == ENOENT && create) {
            if (mkdirat(fd, c, 0755) && errno != EEXIST) goto bad;
            next = openat(fd, c, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
        }
        if (next < 0) goto bad;
        close(fd);
        fd = next;
        if (safe_dir(fd)) goto bad;
    }
    return fd;
bad: {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
}

/* Opens the regular file rel below dir without following symlinks and without
 * leaving dir's filesystem (the verified root). */
static int open_below(int dir, const char *rel, int flags) {
    char buf[256], *save = NULL;
    struct stat top, st;
    if (strlen(rel) >= sizeof buf) { errno = ENAMETOOLONG; return -1; }
    strcpy(buf, rel);
    if (fstat(dir, &top)) return -1;
    int fd = fcntl(dir, F_DUPFD_CLOEXEC, 3);
    if (fd < 0) return -1;
    char *c = strtok_r(buf, "/", &save);
    if (!c) { errno = EINVAL; goto bad; }
    while (c) {
        char *n = strtok_r(NULL, "/", &save);
        if (!strcmp(c, ".") || !strcmp(c, "..")) { errno = EINVAL; goto bad; }
        int next = openat(fd, c, (n ? O_PATH | O_DIRECTORY : flags) | O_NOFOLLOW | O_CLOEXEC);
        if (next < 0) goto bad;
        close(fd);
        fd = next;
        if (fstat(fd, &st)) goto bad;
        if (st.st_dev != top.st_dev) { errno = EXDEV; goto bad; }
        if (!n && !S_ISREG(st.st_mode)) { errno = EINVAL; goto bad; }
        c = n;
    }
    return fd;
bad: {
        int e = errno;
        close(fd);
        errno = e;
        return -1;
    }
}

static int is_mount_root(int fd) {
    struct statx sx;
    if (statx(fd, "", AT_EMPTY_PATH | AT_SYMLINK_NOFOLLOW, STATX_BASIC_STATS, &sx)) return -1;
    if (!(sx.stx_attributes_mask & STATX_ATTR_MOUNT_ROOT)) { errno = ENOSYS; return -1; }
    return (sx.stx_attributes & STATX_ATTR_MOUNT_ROOT) != 0;
}

static int mount_flags(int fd, unsigned long set, unsigned long clear) {
    struct statvfs v;
    if (fstatvfs(fd, &v)) return -1;
    if ((v.f_flag & set) != set || (v.f_flag & clear)) { errno = EPERM; return -1; }
    return 0;
}

/* Storage: only sr0..sr2 may exist. Unattached loop devices and ram disks are
 * standard kernel devices and are ignored; anything else (sd, vd, nvme, hd,
 * partitions, dm, md, other sr) is fatal at once, never waited out. */
static int scan_block(unsigned *present) {
    DIR *d = opendir("/sys/class/block");
    if (!d) return fail("block-scan", errno);
    int r = 0;
    *present = 0;
    for (;;) {
        errno = 0;
        struct dirent *e = readdir(d);
        if (!e) { if (errno) r = fail("block-scan", errno); break; }
        const char *n = e->d_name;
        if (!strcmp(n, ".") || !strcmp(n, "..")) continue;
        if (!strncmp(n, "ram", 3) && digits(n + 3)) continue;
        if (!strncmp(n, "loop", 4) && digits(n + 4)) {
            char path[320], size[32];
            if (snprintf(path, sizeof path, "/sys/class/block/%s/size", n) >= (int)sizeof path ||
                read_small(path, size, sizeof size) < 0 || strcmp(size, "0\n")) {
                r = fail("block-loop-attached", EBUSY);
                break;
            }
            continue;
        }
        if (!strcmp(n, "sr0")) *present |= 1u;
        else if (!strcmp(n, "sr1")) *present |= 2u;
        else if (!strcmp(n, "sr2")) *present |= 4u;
        else { r = fail("block-unexpected", ENODEV); break; }
    }
    closedir(d);
    return r;
}

/* 0 opened, 1 not ready yet (ENOENT or ENOMEDIUM only), -1 fatal. The sr
 * driver reports a medium writable (BLKROGET 0) even when the host attached it
 * read-only, so the block layer flag is set here and must then read back. */
static int open_medium(int i, const struct profile *p, struct media *m) {
    char path[16], sys[48], want[32], got[32];
    struct stat st;
    uint64_t size = 0;
    int ro = 0, one = 1, r, role;
    snprintf(path, sizeof path, "/dev/sr%d", i);
    snprintf(sys, sizeof sys, "/sys/class/block/sr%d/dev", i);
    int fd = open(path, O_RDONLY | O_NONBLOCK | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return errno == ENOENT || errno == ENOMEDIUM ? 1 : fail("media-open", errno);
    if (fstat(fd, &st)) { r = fail("media-stat", errno); goto out; }
    if (!S_ISBLK(st.st_mode) || major(st.st_rdev) != SCSI_CDROM_MAJOR) { r = fail("media-type", ENODEV); goto out; }
    snprintf(want, sizeof want, "%u:%u\n", major(st.st_rdev), minor(st.st_rdev));
    if (read_small(sys, got, sizeof got) < 0) { r = fail("media-sysfs", errno); goto out; }
    if (strcmp(got, want)) { r = fail("media-sysfs", ENODEV); goto out; }
    if (ioctl(fd, BLKROSET, &one)) { r = fail("media-readonly-set", errno); goto out; }
    if (ioctl(fd, BLKROGET, &ro)) { r = errno == ENOMEDIUM ? 1 : fail("media-readonly", errno); goto out; }
    if (ro != 1) { r = fail("media-readonly", EPERM); goto out; }
    if (ioctl(fd, BLKGETSIZE64, &size)) { r = errno == ENOMEDIUM ? 1 : fail("media-size", errno); goto out; }
    role = size == p->container[ROLE_ROOT] ? ROLE_ROOT : size == p->container[ROLE_HASH] ? ROLE_HASH :
           size == p->container[ROLE_MODEL] ? ROLE_MODEL : -1;
    if (role < 0) { r = fail("media-size-unknown", EINVAL); goto out; }
    if (m->fd[role] >= 0) { r = fail("media-size-duplicate", EEXIST); goto out; }
    m->fd[role] = fd;
    m->dev[role] = st.st_rdev;
    return 0;
out:
    close(fd);
    return r;
}

/* Opened descriptors are held until setup is complete. */
static int acquire_media(const struct profile *p, struct media *m) {
    unsigned opened = 0, present = 0;
    int64_t start = mono_ms();
    if (start < 0) return fail("clock", errno);
    for (;;) {
        if (scan_block(&present)) return -1;
        for (int i = 0; i < 3; i++) {
            if ((opened & (1u << i)) || !(present & (1u << i))) continue;
            int r = open_medium(i, p, m);
            if (r < 0) return -1;
            if (r == 0) opened |= 1u << i;
        }
        if (opened == 7u) break;
        int64_t now = mono_ms();
        if (now < 0) return fail("clock", errno);
        if (now - start >= MEDIA_READY_MS) return fail("media-timeout", ETIMEDOUT);
        pause_ms(100);
    }
    if (scan_block(&present)) return -1;
    if (present != 7u || m->fd[ROLE_ROOT] < 0 || m->fd[ROLE_HASH] < 0 || m->fd[ROLE_MODEL] < 0)
        return fail("media-count", ENODEV);
    return 0;
}

/* Runs the measured tool with a fixed environment and /dev/null for all of
 * stdin, stdout and stderr. Only the descriptors in keep survive its exec. */
static int run_tool(char *const argv[], const int keep[], int nkeep) {
    static char *const envp[] = {"PATH=/", "LC_ALL=C", NULL};
    struct stat st;
    int status = 0, e;
    int null = open("/dev/null", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (null < 0 || fstat(null, &st)) return fail("tool-null", errno);
    if (!S_ISCHR(st.st_mode) || st.st_rdev != makedev(1, 3)) return fail("tool-null", ENODEV);
    if (lstat(argv[0], &st)) return fail("tool-binary", errno);
    if (!S_ISREG(st.st_mode) || st.st_uid != 0 || (st.st_mode & (S_IWGRP | S_IWOTH))) return fail("tool-binary", EPERM);
    int64_t start = mono_ms();
    if (start < 0) return fail("clock", errno);
    pid_t pid = fork();
    if (pid < 0) return fail("tool-fork", errno);
    if (pid == 0) {
        sigset_t none;
        sigemptyset(&none);
        if (sigprocmask(SIG_SETMASK, &none, NULL) || dup2(null, 0) != 0 || dup2(null, 1) != 1 || dup2(null, 2) != 2)
            _exit(126);
        for (int i = 0; i < nkeep; i++)
            if (fcntl(keep[i], F_SETFD, 0)) _exit(126);
        execve(argv[0], argv, envp);
        _exit(127);
    }
    close(null);
    for (;;) {
        pid_t w = waitpid(pid, &status, WNOHANG);
        if (w == pid) break;
        if (w < 0 && errno != EINTR) {
            e = errno;
        } else {
            int64_t now = mono_ms();
            if (now >= 0 && now - start < TOOL_TIMEOUT_MS) { pause_ms(10); continue; }
            e = ETIMEDOUT;
        }
        kill(pid, SIGKILL);
        while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
        return fail("tool-timeout", e);
    }
    if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) return fail("tool-status", ECANCELED);
    return 0;
}

static union { struct dm_ioctl io; char raw[16384]; } dmbuf;

static int dm_call(int ctl, unsigned long cmd, const char *name, unsigned flags) {
    memset(&dmbuf, 0, sizeof dmbuf);
    dmbuf.io.version[0] = DM_VERSION_MAJOR;
    dmbuf.io.data_size = sizeof dmbuf;
    dmbuf.io.data_start = sizeof dmbuf.io;
    dmbuf.io.flags = flags;
    snprintf(dmbuf.io.name, sizeof dmbuf.io.name, "%s", name);
    return ioctl(ctl, cmd, &dmbuf.io);
}

/* No reuse: neither the node nor the kernel's device of that name may exist. */
static int dm_absent(int ctl, const char *name) {
    char node[64];
    struct stat st;
    snprintf(node, sizeof node, "/dev/mapper/%s", name);
    if (lstat(node, &st) == 0) return fail("dm-exists", EEXIST);
    if (errno != ENOENT) return fail("dm-node", errno);
    if (dm_call(ctl, DM_DEV_STATUS, name, 0) == 0) return fail("dm-exists", EEXIST);
    if (errno != ENXIO) return fail("dm-status", errno);
    return 0;
}

/* The live table must be exactly one active, read-only target of the given
 * type covering bytes with exactly the given params and no inactive table;
 * the node must be that device, read-only and of that size. Returns the node
 * held open. */
static int dm_check(int ctl, const char *name, const char *type, const char *want, uint64_t bytes, dev_t *out,
                    int *outfd) {
    const unsigned want_flags = DM_ACTIVE_PRESENT_FLAG | DM_READONLY_FLAG;
    const unsigned mask = want_flags | DM_INACTIVE_PRESENT_FLAG | DM_SUSPEND_FLAG | DM_BUFFER_FULL_FLAG;
    char node[64];
    struct stat st;
    uint64_t size = 0;
    int ro = 0;
    if (dm_call(ctl, DM_TABLE_STATUS, name, DM_STATUS_TABLE_FLAG)) return fail("dm-table", errno);
    struct dm_ioctl *io = &dmbuf.io;
    if ((io->flags & mask) != want_flags) return fail("dm-flags", EINVAL);
    if (io->target_count != 1 || io->data_start < sizeof *io ||
        (size_t)io->data_start + sizeof(struct dm_target_spec) >= sizeof dmbuf)
        return fail("dm-targets", EINVAL);
    const struct dm_target_spec *t = (const void *)(dmbuf.raw + io->data_start);
    const char *params = (const char *)(t + 1);
    if (!memchr(params, 0, sizeof dmbuf - io->data_start - sizeof *t)) return fail("dm-params", EINVAL);
    if (t->sector_start != 0 || t->length != bytes / 512 || strncmp(t->target_type, type, sizeof t->target_type) ||
        strcmp(params, want))
        return fail("dm-table-mismatch", EINVAL);
    dev_t dev = (dev_t)io->dev;
    snprintf(node, sizeof node, "/dev/mapper/%s", name);
    if (lstat(node, &st)) return fail("dm-node", errno);
    if (S_ISLNK(st.st_mode)) {
        /* The pinned libdevmapper publishes /dev/dm-N rather than a second block node.
         * Accept only that exact kernel-derived link, then open its fixed
         * target with O_NOFOLLOW and check the device number again. */
        char link[64], expected[64];
        ssize_t n = readlink(node, link, sizeof link);
        int len = snprintf(expected, sizeof expected, "/dev/dm-%u", minor(dev));
        if (n != len || memcmp(link, expected, (size_t)len)) return fail("dm-link", ENODEV);
        snprintf(node, sizeof node, "/dev/dm-%u", minor(dev));
        if (lstat(node, &st)) return fail("dm-node", errno);
    }
    if (!S_ISBLK(st.st_mode) || st.st_rdev != dev) return fail("dm-node", ENODEV);
    int fd = open(node, O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &st)) return fail("dm-open", errno);
    if (st.st_rdev != dev) return fail("dm-open", ENODEV);
    if (ioctl(fd, BLKROGET, &ro) || ioctl(fd, BLKGETSIZE64, &size)) return fail("dm-geometry", errno);
    if (ro != 1 || size != bytes) return fail("dm-geometry", EINVAL);
    *out = dev;
    *outfd = fd;
    return 0;
}

/* Maps the raw payload of one held optical container, which starts right after
 * its fixed header, as a read-only linear device. The table is built only from
 * the pinned payload size and the medium's device number. */
static int map_payload(int ctl, int role, dev_t under, uint64_t bytes, struct media *lin) {
    char table[96], want[48];
    int n = snprintf(table, sizeof table, "0 %" PRIu64 " linear %u:%u %u", bytes / 512, major(under), minor(under),
                     HEADER_SECTORS);
    if (n < 0 || (size_t)n >= sizeof table) return fail("linear-table", ENAMETOOLONG);
    /* No udev daemon exists in this measured initrd. Request the node directly
     * instead of relying on an asynchronous userspace rule. */
    char *const argv[] = {DMSETUP, "--noudevrules", "--noudevsync", "create", linear_name[role],
                         "--addnodeoncreate", "--readonly", "--table", table, NULL};
    if (run_tool(argv, NULL, 0)) return -1;
    char *const nodes[] = {DMSETUP, "--noudevrules", "--noudevsync", "mknodes", linear_name[role], NULL};
    if (run_tool(nodes, NULL, 0)) return -1;
    n = snprintf(want, sizeof want, "%u:%u %u", major(under), minor(under), HEADER_SECTORS);
    if (n < 0 || (size_t)n >= sizeof want) return fail("linear-params", ENAMETOOLONG);
    return dm_check(ctl, linear_name[role], "linear", want, bytes, &lin->dev[role], &lin->fd[role]);
}

/* The live table must be exactly one read-only verity target over the linear
 * maps with the pinned geometry, root and salt, and the node must be it. */
static int dm_verify(int ctl, const char *name, dev_t data, dev_t hash, const char *blocks,
                     const char *hash_start, const char *root, const char *salt, uint64_t bytes, dev_t *out) {
    char want[1024];
    int fd;
    int n = snprintf(want, sizeof want, "1 %u:%u %u:%u 4096 4096 %s %s sha256 %s %s", major(data), minor(data),
                     major(hash), minor(hash), blocks, hash_start, root, salt);
    if (n < 0 || (size_t)n >= sizeof want) return fail("dm-params", ENAMETOOLONG);
    if (dm_check(ctl, name, "verity", want, bytes, out, &fd)) return -1;
    close(fd);
    return 0;
}

/* Mounts the verified device src on parent/leaf (a fresh, safe, not yet
 * mounted directory) and returns an O_PATH descriptor of the new mount root
 * once it is shown to be that device with the wanted flags. */
static int mount_verity(const char *src, dev_t dev, const char *parent, const char *leaf, const char *type,
                        unsigned long magic, unsigned long flags, const char *opts, unsigned long want) {
    char p[32];
    struct stat st;
    struct statfs sf;
    int dir = open_dir_path(parent, 1);
    if (dir < 0) return fail("mount-parent", errno);
    int fd = openat(dir, leaf, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 && errno == ENOENT && mkdirat(dir, leaf, 0755) == 0)
        fd = openat(dir, leaf, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || safe_dir(fd)) return fail("mount-target", errno);
    int busy = is_mount_root(fd);
    if (busy) return fail("mount-target-busy", busy < 0 ? errno : EBUSY);
    if (mount(src, fdpath(p, sizeof p, fd), type, flags, opts)) return fail("mount", errno);
    close(fd);
    fd = openat(dir, leaf, O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    close(dir);
    if (fd < 0 || fstat(fd, &st) || fstatfs(fd, &sf)) return fail("mount-check", errno);
    if (st.st_dev != dev || (unsigned long)sf.f_type != magic || is_mount_root(fd) != 1 || mount_flags(fd, want, 0))
        return fail("mount-check", EINVAL);
    return fd;
}

static int run(void) {
    struct profile p;
    struct media m = {{-1, -1, -1}, {0, 0, 0}}, lin = {{-1, -1, -1}, {0, 0, 0}};
    struct stat st, sst;
    char a[32], b[32], offset[48];
    dev_t rootdev, modeldev;
    int fd;

    stage("profile");
    if (check_profile(&p)) return -1;

    stage("media");
    if (acquire_media(&p, &m)) return -1;

    stage("dm-absent");
    int ctl = open("/dev/mapper/control", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
    if (ctl < 0 || fstat(ctl, &st)) return fail("dm-control", errno);
    if (!S_ISCHR(st.st_mode)) return fail("dm-control", ENODEV);
    for (int i = 0; i < ROLES; i++)
        if (dm_absent(ctl, linear_name[i])) return -1;
    if (dm_absent(ctl, "native-root") || dm_absent(ctl, "native-models")) return -1;

    stage("linear");
    for (int i = 0; i < ROLES; i++)
        if (map_payload(ctl, i, m.dev[i], p.payload[i], &lin)) return -1;

    stage("root-verity");
    {
        char *const argv[] = {VERITYSETUP, "open", "--no-superblock", "--format=1", "--hash=sha256",
                              "--hash-offset=0", "--data-block-size=4096", "--hash-block-size=4096",
                              "--data-blocks=" DATA_BLOCKS, "--salt=" VERITY_SALT,
                              fdpath(a, sizeof a, lin.fd[ROLE_ROOT]), "native-root",
                              fdpath(b, sizeof b, lin.fd[ROLE_HASH]), VERITY_ROOT, NULL};
        const int keep[] = {lin.fd[ROLE_ROOT], lin.fd[ROLE_HASH]};
        if (run_tool(argv, keep, 2)) return -1;
    }
    if (dm_verify(ctl, "native-root", lin.dev[ROLE_ROOT], lin.dev[ROLE_HASH], DATA_BLOCKS, "0", VERITY_ROOT,
                  VERITY_SALT, IMAGE_BYTES, &rootdev))
        return -1;

    stage("root-mount");
    int rootdir = mount_verity("/dev/mapper/native-root", rootdev, "/plat/native-desktop", "rootfs", "squashfs",
                               SQUASHFS_MAGIC, MS_RDONLY | MS_NOSUID | MS_NODEV, NULL,
                               ST_RDONLY | ST_NOSUID | ST_NODEV);
    if (rootdir < 0) return -1;

    stage("model-verity");
    {
        int n = snprintf(offset, sizeof offset, "--hash-offset=%" PRIu64, p.model_hash_offset);
        if (n < 0 || (size_t)n >= sizeof offset) return fail("model-offset", EOVERFLOW);
        fdpath(a, sizeof a, lin.fd[ROLE_MODEL]);
        char *const argv[] = {VERITYSETUP, "open", "--no-superblock", "--format=1", "--hash=sha256", offset,
                              "--data-block-size=4096", "--hash-block-size=4096",
                              "--data-blocks=" MODEL_BLOCKS, "--salt=" MODEL_SALT,
                              a, "native-models", a, MODEL_ROOT, NULL};
        const int keep[] = {lin.fd[ROLE_MODEL]};
        if (run_tool(argv, keep, 1)) return -1;
    }
    if (dm_verify(ctl, "native-models", lin.dev[ROLE_MODEL], lin.dev[ROLE_MODEL], MODEL_BLOCKS, MODEL_HASH_START,
                  MODEL_ROOT, MODEL_SALT, MODEL_BYTES, &modeldev))
        return -1;

    stage("model-mount");
    fd = mount_verity("/dev/mapper/native-models", modeldev, "/", "native-models", "ext4", EXT4_SUPER_MAGIC,
                      MS_RDONLY | MS_NOSUID | MS_NODEV | MS_NOEXEC, "noload",
                      ST_RDONLY | ST_NOSUID | ST_NODEV | ST_NOEXEC);
    if (fd < 0) return -1;
    close(fd);

    stage("dev-input");
    fd = open_dir_path("/dev/input", 1);
    if (fd < 0 || fstat(fd, &st)) return fail("dev-input", errno);
    if (st.st_gid != 0 || (st.st_mode & 07777) != 0755) return fail("dev-input", EPERM);
    close(fd);

    stage("nsinit");
    int src = open_below(rootdir, NSINIT_REL, O_PATH);
    if (src < 0 || fstat(src, &sst)) return fail("nsinit-source", errno);
    int desk = open_dir_path("/plat/native-desktop", 0);
    if (desk < 0) return fail("nsinit-dir", errno);
    int ph = openat(desk, "nsinit", O_RDONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0555);
    if (ph < 0 || fstat(ph, &st)) return fail("nsinit-placeholder", errno);
    if (!S_ISREG(st.st_mode) || st.st_uid != 0 || (st.st_mode & 07777) != 0555) return fail("nsinit-placeholder", EPERM);
    if (mount(fdpath(a, sizeof a, src), fdpath(b, sizeof b, ph), NULL, MS_BIND, NULL)) return fail("nsinit-bind", errno);
    close(ph);
    fd = openat(desk, "nsinit", O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0) return fail("nsinit-bind", errno);
    if (mount(NULL, fdpath(b, sizeof b, fd), NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL))
        return fail("nsinit-remount", errno);
    if (fstat(fd, &st) || mount_flags(fd, ST_RDONLY | ST_NOSUID | ST_NODEV, ST_NOEXEC)) return fail("nsinit-check", errno);
    if (st.st_dev != sst.st_dev || st.st_ino != sst.st_ino || is_mount_root(fd) != 1) return fail("nsinit-check", EINVAL);
    close(fd);
    close(desk);
    close(src);

    /* EEXIST is refused too: a module already present was not loaded from here */
    stage("nft-ct");
    fd = open_below(rootdir, NFT_CT_REL, O_RDONLY);
    if (fd < 0) return fail("nft-ct-open", errno);
    if (syscall(SYS_finit_module, fd, "", 0)) return fail("nft-ct-load", errno);
    close(fd);
    close(rootdir);

    stage("seal");
    int slash = open_dir_path("/", 0), plat = open_dir_path("/plat", 0);
    if (slash < 0 || plat < 0) return fail("seal-open", errno);
    fdpath(a, sizeof a, plat);
    if (mount(a, a, NULL, MS_BIND | MS_REC, NULL)) return fail("seal-bind", errno);
    close(plat);
    plat = openat(slash, "plat", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (plat < 0) return fail("seal-open", errno);
    if (mount(NULL, fdpath(a, sizeof a, plat), NULL, MS_REMOUNT | MS_BIND | MS_RDONLY | MS_NOSUID | MS_NODEV, NULL))
        return fail("seal-remount", errno);
    if (is_mount_root(plat) != 1 || mount_flags(plat, ST_RDONLY | ST_NOSUID | ST_NODEV, 0)) return fail("seal-check", EINVAL);
    /* the copies under the sealed /plat keep their own read-only flags */
    fd = openat(plat, "native-desktop/rootfs", O_PATH | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &st)) return fail("seal-rootfs", errno);
    if (st.st_dev != rootdev || mount_flags(fd, ST_RDONLY | ST_NOSUID | ST_NODEV, 0)) return fail("seal-rootfs", EINVAL);
    close(fd);
    fd = openat(plat, "native-desktop/nsinit", O_PATH | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 || fstat(fd, &st)) return fail("seal-nsinit", errno);
    if (st.st_dev != sst.st_dev || st.st_ino != sst.st_ino || mount_flags(fd, ST_RDONLY | ST_NOSUID | ST_NODEV, ST_NOEXEC))
        return fail("seal-nsinit", EINVAL);
    close(fd);
    close(plat);
    close(slash);

    /* setup is complete; the linear and optical descriptors are no longer needed */
    for (int i = 0; i < ROLES; i++) {
        close(lin.fd[i]);
        close(m.fd[i]);
    }
    close(ctl);
    stage("ready");
    return 0;
}

int main(int argc, char **argv) {
    struct utsname u;
    (void)argv;
    umask(022);
    signal(SIGCHLD, SIG_DFL);
    if (std_fds()) return 70;
    if (argc != 1 || getuid() != 0 || geteuid() != 0 || uname(&u) || strcmp(u.release, KERNEL_RELEASE)) {
        fail("contract", EPERM);
        return 64;
    }
    return run() == 0 ? 0 : 1;
}
