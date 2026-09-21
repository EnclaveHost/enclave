#ifndef EE_SYS_UIO_H
#define EE_SYS_UIO_H
#include <stddef.h>
#include "socket.h"
#ifdef __cplusplus
extern "C" {
#endif
struct iovec { void *iov_base; size_t iov_len; };
#define IOV_MAX 1024
ssize_t writev(int fd, const struct iovec *iov, int cnt); ssize_t readv(int fd, const struct iovec *iov, int cnt);
#ifdef __cplusplus
}
#endif
#endif
