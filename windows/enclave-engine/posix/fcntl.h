/* posix/fcntl.h -- open() flags; open always fails inside the enclave (files are host memory, see ee-rt.c fopen). */
#ifndef EE_FCNTL_H
#define EE_FCNTL_H
#ifdef __cplusplus
extern "C" {
#endif
#define O_RDONLY 0
#define O_WRONLY 1
#define O_RDWR 2
#define O_CREAT 0x40
#define O_EXCL 0x80
#define O_TRUNC 0x200
#define O_APPEND 0x400
#define O_NONBLOCK 0x800
#define O_DIRECTORY 0x10000
#define O_NOFOLLOW 0x20000
#define O_CLOEXEC 0x80000
#define O_DIRECT 0x4000
#define F_GETFL 3
#define F_SETFL 4
#define POSIX_FADV_SEQUENTIAL 2
#define POSIX_FADV_WILLNEED 3
#define POSIX_FADV_DONTNEED 4
#define F_GETFD 1
#define F_SETFD 2
#define FD_CLOEXEC 1
#define F_DUPFD_CLOEXEC 1030
#define AT_FDCWD (-100)
#define AT_SYMLINK_NOFOLLOW 0x100
int mkstemp(char *tmpl);
int open(const char *p, int flags, ...); int fcntl(int fd, int cmd, ...); int posix_fadvise(int fd, long long o, long long l, int a);
#ifdef __cplusplus
}
#endif
#endif
