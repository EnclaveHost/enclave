/* posix/sys/socket.h -- the enclave's socket API: a call-out to the host per operation (ee-rt.c).
 * Addresses are names: getaddrinfo returns a sockaddr_ee carrying the host string and port, the
 * host resolves and connects. */
#ifndef EE_SYS_SOCKET_H
#define EE_SYS_SOCKET_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#ifndef _SSIZE_T_DEFINED
typedef ptrdiff_t ssize_t;
#define _SSIZE_T_DEFINED 1
#endif
typedef int socklen_t;
typedef unsigned short sa_family_t;
struct sockaddr { sa_family_t sa_family; char sa_data[14]; };
struct sockaddr_storage { sa_family_t ss_family; char pad[254]; };
struct sockaddr_ee { sa_family_t sa_family; int port; char host[256]; };
#define AF_UNSPEC 0
#define AF_UNIX 1
#define AF_INET 2
#define AF_INET6 10
#define AF_VSOCK 40
#define PF_INET AF_INET
#define SOCK_STREAM 1
#define SOCK_DGRAM 2
#define SOL_SOCKET 1
#define SO_RCVBUF 8
#define SO_SNDBUF 7
#define SO_RCVLOWAT 18
#define SO_REUSEADDR 2
#define SO_KEEPALIVE 9
#define SO_ERROR 4
#define SO_RCVTIMEO 20
#define SO_SNDTIMEO 21
#define MSG_DONTWAIT 0x40
#define MSG_NOSIGNAL 0x4000
#define MSG_WAITALL 0x100
#define SHUT_RDWR 2
#define IPPROTO_TCP 6
int socket(int af, int type, int proto); int connect(int fd, const struct sockaddr *addr, socklen_t len);
ssize_t send(int fd, const void *b, size_t n, int flags); ssize_t recv(int fd, void *b, size_t n, int flags);
int setsockopt(int fd, int level, int name, const void *v, socklen_t l); int getsockopt(int fd, int level, int name, void *v, socklen_t *l);
int getsockname(int fd, struct sockaddr *a, socklen_t *l); int shutdown(int fd, int how); int sock_close(int fd);
#ifdef __cplusplus
}
#endif
#endif
