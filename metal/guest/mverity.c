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
//
// The device-mapper work itself is isolation/m2/mverity.h, shared with the
// per-app guest's init (which mounts model volumes the same way) and the
// Windows partition image: one implementation of the table, three users.
#include <stdlib.h>
#include "../../isolation/m2/mverity.h"

int main(int argc, char **argv)
{
	if (argc != 10) {
		fprintf(stderr, "usage: mverity <mapname> <dev> <data-bs> <hash-bs> <data-blocks> "
				"<hash-start-block> <alg> <root-hex> <salt-hex>\n");
		return 2;
	}
	unsigned long long data_bs = strtoull(argv[3], NULL, 10);
	unsigned long long hash_bs = strtoull(argv[4], NULL, 10);
	unsigned long long data_blocks = strtoull(argv[5], NULL, 10);
	unsigned long long hash_start = strtoull(argv[6], NULL, 10);
	if (!data_bs || data_bs % 512 || !hash_bs || !data_blocks) {
		fprintf(stderr, "mverity: bad geometry\n");
		return 2;
	}
	char node[128];
	const char *why = mverity_setup(argv[1], argv[2], data_bs, hash_bs, data_blocks, hash_start, argv[7], argv[8],
					argv[9], node, sizeof node);
	if (why) {
		fprintf(stderr, "mverity: %s: %s\n", why, strerror(errno));
		return 1;
	}
	printf("%s\n", node);
	return 0;
}
