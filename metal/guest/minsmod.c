/* minsmod — a 30-line static `insmod`. The slim container base image the guest
 * root is built from ships no kmod, so we load the handful of virtio + coco
 * modules ourselves via finit_module(2). Modules are shipped uncompressed in the
 * initramfs, so no in-kernel decompression is needed.
 *
 *   minsmod <path.ko> [params]
 */
#define _GNU_SOURCE
#include <fcntl.h>
#include <stdio.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  if (argc < 2) { fprintf(stderr, "usage: minsmod <file.ko> [params]\n"); return 2; }
  int fd = open(argv[1], O_RDONLY | O_CLOEXEC);
  if (fd < 0) { perror("open"); return 1; }
  const char *params = argc > 2 ? argv[2] : "";
  if (syscall(SYS_finit_module, fd, params, 0) != 0) { perror("finit_module"); return 1; }
  return 0;
}
