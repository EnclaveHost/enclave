/* mverity.h - bring up a READ-ONLY dm-verity device over a model volume, with no libdevmapper, no cryptsetup and no
 * kernel headers (the per-app guest's init is linked against musl, which ships none). ONE implementation, shared by:
 *   - metal/guest/mverity.c, the metal guest's helper (its original home: this is that code, moved here unchanged in
 *     behaviour);
 *   - isolation/m2/dominit.c, the per-app SNP guest's PID 1, which mounts the deployment's model volumes against the
 *     roots pinned in its own measured runtime (rt/model-volumes.table);
 *   - the m3 partition image (as the mverity binary), for the Windows Shield partition's monitor.
 *
 * The device-mapper ioctl ABI is restated below rather than included. test-mverity-abi.sh checks every size, offset
 * and ioctl number against <linux/dm-ioctl.h>. Data and hash share ONE device (metal/volumes.mjs appends the hash
 * tree), so the verity table names the disk twice and the tree starts at hash_start_block. */
#ifndef ENCLAVE_MVERITY_H
#define ENCLAVE_MVERITY_H

#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define MV_DM_VERSION_MAJOR 4
#define MV_DM_NAME_LEN 128
#define MV_DM_UUID_LEN 129
#define MV_DM_MAX_TYPE_NAME 16
#define MV_DM_READONLY_FLAG (1u << 0)

struct mv_dm_ioctl {
    uint32_t version[3];
    uint32_t data_size;
    uint32_t data_start;
    uint32_t target_count;
    int32_t open_count;
    uint32_t flags;
    uint32_t event_nr;
    uint32_t padding;
    uint64_t dev;
    char name[MV_DM_NAME_LEN];
    char uuid[MV_DM_UUID_LEN];
    char data[7];
};
struct mv_dm_target_spec {
    uint64_t sector_start;
    uint64_t length;
    int32_t status;
    uint32_t next;
    char target_type[MV_DM_MAX_TYPE_NAME];
};
_Static_assert(sizeof(struct mv_dm_ioctl) == 312, "struct dm_ioctl is 312 bytes");
_Static_assert(sizeof(struct mv_dm_target_spec) == 40, "struct dm_target_spec is 40 bytes");

#define MV_DM_IOCTL 0xfd
#define MV_DM_DEV_CREATE  _IOWR(MV_DM_IOCTL, 3, struct mv_dm_ioctl)
#define MV_DM_DEV_SUSPEND _IOWR(MV_DM_IOCTL, 6, struct mv_dm_ioctl)
#define MV_DM_TABLE_LOAD  _IOWR(MV_DM_IOCTL, 9, struct mv_dm_ioctl)

#define MV_BUFSZ 16384

static void mv_init(char *buf, struct mv_dm_ioctl *dmi, const char *name) {
    memset(buf, 0, MV_BUFSZ);
    dmi->version[0] = MV_DM_VERSION_MAJOR;
    dmi->data_size = sizeof(struct mv_dm_ioctl);
    dmi->data_start = sizeof(struct mv_dm_ioctl);
    snprintf(dmi->name, sizeof(dmi->name), "%s", name);
}

/* dm_ioctl.dev carries the kernel's packed dev_t (new_encode_dev) */
static unsigned mv_dev_major(unsigned long long d) { return (unsigned)((d & 0xfff00) >> 8); }
static unsigned mv_dev_minor(unsigned long long d) { return (unsigned)((d & 0xff) | ((d >> 12) & 0xfff00)); }

/* Create <name> as a read-only verity target over <dev> and write its block node's path to node[len].
 * -> NULL, or a static string naming the step that failed (errno says why). */
static const char *mverity_setup(const char *name, const char *dev, unsigned long long data_bs, unsigned long long hash_bs,
                                 unsigned long long data_blocks, unsigned long long hash_start, const char *alg,
                                 const char *root, const char *salt, char *node, size_t len) {
    static char buf[MV_BUFSZ];
    if (!data_bs || data_bs % 512 || !hash_bs || !data_blocks) { errno = EINVAL; return "bad geometry"; }
    /* the backing disk, as major:minor: no name resolution inside the kernel */
    struct stat st;
    if (stat(dev, &st) || !S_ISBLK(st.st_mode)) { if (!errno) errno = ENOTBLK; return "the backing device is not a block device"; }
    char devspec[64];
    snprintf(devspec, sizeof devspec, "%u:%u", major(st.st_rdev), minor(st.st_rdev));
    int fd = open("/dev/mapper/control", O_RDWR | O_CLOEXEC);
    if (fd < 0) return "open /dev/mapper/control (is dm-mod loaded?)";
    struct mv_dm_ioctl *dmi = (struct mv_dm_ioctl *)buf;

    /* 1. create the mapped device */
    mv_init(buf, dmi, name);
    if (ioctl(fd, MV_DM_DEV_CREATE, dmi)) { close(fd); return "DM_DEV_CREATE"; }
    unsigned long long created = dmi->dev;

    /* 2. load the single verity target:
     *    <version> <data_dev> <hash_dev> <data_bs> <hash_bs> <data_blocks> <hash_start_block> <alg> <root> <salt> */
    mv_init(buf, dmi, name);
    dmi->flags = MV_DM_READONLY_FLAG;
    dmi->target_count = 1;
    struct mv_dm_target_spec *spec = (struct mv_dm_target_spec *)(buf + sizeof(struct mv_dm_ioctl));
    spec->sector_start = 0;
    spec->length = data_blocks * (data_bs / 512);
    snprintf(spec->target_type, sizeof spec->target_type, "verity");
    char *params = (char *)(spec + 1);
    size_t room = MV_BUFSZ - (size_t)(params - buf);
    int n = snprintf(params, room, "1 %s %s %llu %llu %llu %llu %s %s %s", devspec, devspec, data_bs, hash_bs, data_blocks,
                     hash_start, alg, root, salt);
    if (n < 0 || (size_t)n >= room) { close(fd); errno = E2BIG; return "verity table params too long"; }
    size_t used = (size_t)(params - buf) + (size_t)n + 1;
    used = (used + 7) & ~(size_t)7;   /* 8-byte align the entry */
    spec->next = (uint32_t)(used - sizeof(struct mv_dm_ioctl));
    dmi->data_size = (uint32_t)used;
    if (ioctl(fd, MV_DM_TABLE_LOAD, dmi)) { close(fd); return "DM_TABLE_LOAD (verity)"; }

    /* 3. resume it (a suspend ioctl with no SUSPEND flag = resume) */
    mv_init(buf, dmi, name);
    dmi->flags = MV_DM_READONLY_FLAG;
    if (ioctl(fd, MV_DM_DEV_SUSPEND, dmi)) { close(fd); return "DM_DEV_SUSPEND (resume)"; }
    close(fd);

    /* 4. our own node: devtmpfs gives /dev/dm-N, and callers want the name they chose */
    snprintf(node, len, "/dev/mapper/%s", name);
    mkdir("/dev/mapper", 0755);
    unlink(node);
    if (mknod(node, S_IFBLK | 0600, makedev(mv_dev_major(created), mv_dev_minor(created)))) {
        snprintf(node, len, "/dev/dm-%u", mv_dev_minor(created));   /* fall back to the devtmpfs node */
        if (access(node, F_OK)) return "mknod /dev/mapper";
    }
    return NULL;
}

#endif
