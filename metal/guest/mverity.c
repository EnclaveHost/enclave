// mverity — bring up a dm-verity device inside the metal guest.
//
//   mverity <mapname> <backing-dev> <data-bs> <hash-bs> <data-blocks>
//           <hash-start-block> <alg> <root-hex> <salt-hex>
//
// prints the created block device path on stdout.
//
// The guest is an initramfs built from a slim base image: no cryptsetup, no
// libdevmapper, no udev. So this talks the device-mapper ioctl interface
// directly — create the device, load a one-target `verity` table, resume it,
// and mknod the node ourselves (devtmpfs only gives us /dev/dm-N, and we want a
// name we chose). Same reason netup.c and minsmod.c exist: a static ~20 KB
// binary beats dragging a package tree into a MEASURED image.
//
// Data and hash live in ONE file (the hash tree is appended after the
// filesystem), so both table devices are the same disk and the hash tree starts
// at hash-start-block. The table is loaded READ-ONLY: a model volume is
// immutable by construction, and dm-verity cannot back writes anyway.
#include <errno.h>
#include <fcntl.h>
#include <linux/dm-ioctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/sysmacros.h>
#include <unistd.h>

#define BUFSZ 16384

static char buf[BUFSZ];

static void dmi_init(struct dm_ioctl *dmi, const char *name)
{
	memset(buf, 0, BUFSZ);
	dmi->version[0] = DM_VERSION_MAJOR;
	dmi->version[1] = 0;
	dmi->version[2] = 0;
	dmi->data_size = sizeof(struct dm_ioctl);
	dmi->data_start = sizeof(struct dm_ioctl);
	snprintf(dmi->name, sizeof(dmi->name), "%s", name);
}

static int fail(const char *what)
{
	fprintf(stderr, "mverity: %s: %s\n", what, strerror(errno));
	return 1;
}

/* dm_ioctl.dev carries the kernel's packed dev_t (new_encode_dev) */
static unsigned dev_major(unsigned long long d) { return (unsigned)((d & 0xfff00) >> 8); }
static unsigned dev_minor(unsigned long long d) { return (unsigned)((d & 0xff) | ((d >> 12) & 0xfff00)); }

int main(int argc, char **argv)
{
	if (argc != 10) {
		fprintf(stderr, "usage: mverity <mapname> <dev> <data-bs> <hash-bs> <data-blocks> "
				"<hash-start-block> <alg> <root-hex> <salt-hex>\n");
		return 2;
	}
	const char *name = argv[1], *dev = argv[2];
	unsigned long long data_bs = strtoull(argv[3], NULL, 10);
	unsigned long long hash_bs = strtoull(argv[4], NULL, 10);
	unsigned long long data_blocks = strtoull(argv[5], NULL, 10);
	unsigned long long hash_start = strtoull(argv[6], NULL, 10);
	const char *alg = argv[7], *root = argv[8], *salt = argv[9];

	if (!data_bs || data_bs % 512 || !hash_bs || !data_blocks) {
		fprintf(stderr, "mverity: bad geometry\n");
		return 2;
	}

	/* the backing disk, as major:minor — no name resolution inside the kernel */
	struct stat st;
	if (stat(dev, &st) || !S_ISBLK(st.st_mode)) {
		fprintf(stderr, "mverity: %s is not a block device\n", dev);
		return 1;
	}
	char devspec[64];
	snprintf(devspec, sizeof(devspec), "%u:%u", major(st.st_rdev), minor(st.st_rdev));

	int fd = open("/dev/mapper/control", O_RDWR);
	if (fd < 0)
		return fail("open /dev/mapper/control (is dm-mod loaded?)");

	struct dm_ioctl *dmi = (struct dm_ioctl *)buf;

	/* 1. create the mapped device */
	dmi_init(dmi, name);
	if (ioctl(fd, DM_DEV_CREATE, dmi))
		return fail("DM_DEV_CREATE");
	unsigned long long created = dmi->dev;

	/* 2. load the single verity target
	 *    <version> <data_dev> <hash_dev> <data_bs> <hash_bs> <data_blocks>
	 *    <hash_start_block> <alg> <root_digest> <salt>
	 */
	dmi_init(dmi, name);
	dmi->flags = DM_READONLY_FLAG;
	dmi->target_count = 1;
	struct dm_target_spec *spec = (struct dm_target_spec *)(buf + sizeof(struct dm_ioctl));
	spec->sector_start = 0;
	spec->length = data_blocks * (data_bs / 512);
	spec->status = 0;
	snprintf(spec->target_type, sizeof(spec->target_type), "verity");
	char *params = (char *)(spec + 1);
	size_t room = BUFSZ - (params - buf);
	int n = snprintf(params, room, "1 %s %s %llu %llu %llu %llu %s %s %s",
			 devspec, devspec, data_bs, hash_bs, data_blocks, hash_start, alg, root, salt);
	if (n < 0 || (size_t)n >= room) {
		fprintf(stderr, "mverity: table params too long\n");
		return 1;
	}
	size_t used = (params - buf) + n + 1;
	used = (used + 7) & ~(size_t)7;                 /* 8-byte align the entry */
	spec->next = (unsigned)(used - sizeof(struct dm_ioctl));
	dmi->data_size = used;
	if (ioctl(fd, DM_TABLE_LOAD, dmi))
		return fail("DM_TABLE_LOAD (verity)");

	/* 3. resume it (a suspend ioctl with no SUSPEND flag = resume) */
	dmi_init(dmi, name);
	dmi->flags = DM_READONLY_FLAG;
	if (ioctl(fd, DM_DEV_SUSPEND, dmi))
		return fail("DM_DEV_SUSPEND (resume)");
	close(fd);

	/* 4. our own node: devtmpfs gives us /dev/dm-N, but callers want the name */
	char node[128];
	snprintf(node, sizeof(node), "/dev/mapper/%s", name);
	mkdir("/dev/mapper", 0755);
	unlink(node);
	if (mknod(node, S_IFBLK | 0600, makedev(dev_major(created), dev_minor(created)))) {
		/* fall back to the devtmpfs node rather than failing the mount */
		snprintf(node, sizeof(node), "/dev/dm-%u", dev_minor(created));
		if (access(node, F_OK))
			return fail("mknod /dev/mapper");
	}
	printf("%s\n", node);
	return 0;
}
