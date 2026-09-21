#ifndef EE_SYS_MMAN_H
#define EE_SYS_MMAN_H
#include <stddef.h>
#ifdef __cplusplus
extern "C" {
#endif
#define PROT_READ 1
#define PROT_NONE 0
#define PROT_WRITE 2
#define MAP_ANONYMOUS 0x20
#define MAP_ANON MAP_ANONYMOUS
#define MAP_NORESERVE 0x4000
#define MAP_POPULATE 0x8000
#define MAP_SHARED 1
#define MAP_PRIVATE 2
#define MAP_FAILED ((void *)-1)
#define MADV_WILLNEED 3
#define MADV_RANDOM 1
#define MADV_DONTNEED 4
#define POSIX_MADV_WILLNEED 3
#define POSIX_MADV_RANDOM 1
void *mmap(void *a, size_t n, int prot, int flags, int fd, long long off); int munmap(void *a, size_t n);
int madvise(void *a, size_t n, int adv); int posix_madvise(void *a, size_t n, int adv);
int mlock(const void *a, size_t n); int munlock(const void *a, size_t n); int mprotect(void *a, size_t n, int p);
#ifdef __cplusplus
}
#endif
#endif
