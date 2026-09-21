/* posix/sys/stat.h -- shadows the UCRT one: stat() answers for the host's files, everything else fails. */
#ifndef EE_SYS_STAT_H
#define EE_SYS_STAT_H
#include <time.h>
#ifdef __cplusplus
extern "C" {
#endif
struct stat { unsigned long st_dev, st_ino; unsigned int st_mode, st_nlink, st_uid, st_gid; long long st_size; time_t st_atime, st_mtime, st_ctime; };
#define S_IFMT 0170000
#define S_IFREG 0100000
#define S_IFDIR 0040000
#define S_IFLNK 0120000
#define S_ISREG(m) (((m) & S_IFMT) == S_IFREG)
#define S_ISDIR(m) (((m) & S_IFMT) == S_IFDIR)
#define S_ISLNK(m) (((m) & S_IFMT) == S_IFLNK)
#define S_IRUSR 0400
#define S_IWUSR 0200
#define S_IXUSR 0100
#define S_IRWXU 0700
int fstat(int fd, struct stat *st); int stat(const char *p, struct stat *st); int lstat(const char *p, struct stat *st); int mkdir(const char *p, unsigned int m);
#ifdef __cplusplus
}
#endif
#endif
