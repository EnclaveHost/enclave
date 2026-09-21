/* posix/unistd.h -- enclave: no files, no processes; sockets are call-outs (ee-rt.c). */
#ifndef EE_UNISTD_H
#define EE_UNISTD_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifndef _SSIZE_T_DEFINED
typedef ptrdiff_t ssize_t;
#define _SSIZE_T_DEFINED 1
#endif
int close(int fd); ssize_t read(int fd, void *b, size_t n); ssize_t write(int fd, const void *b, size_t n);
ssize_t pread(int fd, void *b, size_t n, long long off); ssize_t pwrite(int fd, const void *b, size_t n, long long off);
int unlink(const char *p); int access(const char *p, int m); int ftruncate(int fd, long long n); int fsync(int fd); int fdatasync(int fd);
long long lseek(int fd, long long off, int whence); int isatty(int fd); int dup(int fd); int pipe(int fds[2]); long sysconf(int name); int getpid(void);
int usleep(unsigned int us); unsigned int sleep(unsigned int s);
#define _SC_PAGESIZE 30
#define _SC_NPROCESSORS_ONLN 84
#define F_OK 0
#define R_OK 4
#define STDIN_FILENO 0
#define STDOUT_FILENO 1
#define STDERR_FILENO 2
#ifdef __cplusplus
}
#endif
#endif
