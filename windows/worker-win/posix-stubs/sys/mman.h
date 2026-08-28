/* posix-stubs/sys/mman.h -- enough of mmap for worker.cu to COMPILE, and to
 * fail cleanly at run time.
 *
 * The --shm ring is the ivshmem backing store shared with a QEMU CVM. Hyper-V
 * has no ivshmem, so there is nothing for this path to map. Rather than carve
 * the code out of worker.cu with an #ifdef, mmap() here always fails with
 * ENOSYS; worker.cu's existing check then prints
 *
 *     --shm <path>: Function not implemented
 *
 * and exits 2. Passing --shm on Windows is a configuration error and this
 * reports it as one. The TCP and AF_HYPERV listeners are unaffected.
 */
#ifndef SHIELDED_STUB_SYS_MMAN_H
#define SHIELDED_STUB_SYS_MMAN_H
#include <errno.h>
#include <stddef.h>

#define PROT_READ   0x1
#define PROT_WRITE  0x2
#define MAP_SHARED  0x01
#define MAP_FAILED  ((void *)-1)

static __inline void *mmap(void *addr, size_t len, int prot, int flags, int fd, long long off) {
    (void)addr; (void)len; (void)prot; (void)flags; (void)fd; (void)off;
    _set_errno(ENOSYS);
    return MAP_FAILED;
}
static __inline int munmap(void *addr, size_t len) {
    (void)addr; (void)len;
    _set_errno(ENOSYS);
    return -1;
}
#endif
