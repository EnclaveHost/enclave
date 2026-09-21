#ifndef EE_POLL_H
#define EE_POLL_H
#ifdef __cplusplus
extern "C" {
#endif
struct pollfd { int fd; short events, revents; };
#define POLLIN 1
#define POLLOUT 4
#define POLLERR 8
#define POLLHUP 16
#define POLLNVAL 32
int poll(struct pollfd *fds, unsigned long n, int timeout);
#ifdef __cplusplus
}
#endif
#endif
