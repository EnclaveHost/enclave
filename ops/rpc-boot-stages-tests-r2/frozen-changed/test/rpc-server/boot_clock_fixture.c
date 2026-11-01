/* Inert test-only FD3 exec/SCM_RIGHTS probe. Never included in guest media. */
#define _GNU_SOURCE
#include <stdlib.h>
#include <sys/socket.h>
#include "rpc-boot-clock.h"

int main(int argc, char **argv) {
    if (argc != 2) return 64;
    if (!strcmp(argv[1], "verify")) {
        unsigned char b[40];
        struct stat st;
        if (fstat(3, &st) || st.st_size != 40 || fcntl(3, F_GET_SEALS) != 15 ||
            pread(3, b, sizeof b, 0) != sizeof b || pwrite(3, "x", 1, 0) != -1 ||
            ftruncate(3, 0) != -1 || ftruncate(3, 41) != -1) return 65;
        union { struct cmsghdr align; char b[CMSG_SPACE(sizeof(int))]; } control = {0};
        struct iovec iov = {b, sizeof b};
        struct msghdr msg = {.msg_iov = &iov, .msg_iovlen = 1, .msg_control = control.b, .msg_controllen = sizeof control.b};
        struct cmsghdr *c = CMSG_FIRSTHDR(&msg);
        c->cmsg_level = SOL_SOCKET; c->cmsg_type = SCM_RIGHTS; c->cmsg_len = CMSG_LEN(sizeof(int));
        int clockfd = 3;
        memcpy(CMSG_DATA(c), &clockfd, sizeof clockfd);
        return sendmsg(4, &msg, 0) == 40 ? 0 : 66;
    }
    char *end = NULL;
    errno = 0;
    unsigned long long origin = strtoull(argv[1], &end, 10);
    if (errno || !*argv[1] || *end) return 67;
    int socket = fcntl(3, F_DUPFD_CLOEXEC, 20);
    if (socket < 0) return 68;
    int clock = rpc_clock_create(origin);
    if (clock < 0) return 69;
    if (fcntl(clock, F_GETFD) != FD_CLOEXEC || dup2(clock, 3) != 3 || dup2(socket, 4) != 4 ||
        fcntl(3, F_SETFD, 0) || fcntl(4, F_SETFD, 0)) return 70;
    close(socket);
    char *args[] = {argv[0], "verify", NULL};
    char *env[] = {NULL};
    execve("/proc/self/exe", args, env);
    return 71;
}
