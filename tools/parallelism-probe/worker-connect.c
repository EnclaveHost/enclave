#include <pthread.h>
#include <stdio.h>
#include <string.h>
#include <errno.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <unistd.h>

/* HIGH-4 regression test: main connect() FIRST (caching the instance_network
   handle), then a worker connect(). Before global_network became thread-local
   the worker trapped `unknown handle index`. */
static int try_connect(const char *who) {
    int fd = socket(AF_INET, SOCK_STREAM, 0);
    if (fd < 0) { printf("%s: socket failed\n", who); return -1; }
    struct sockaddr_in a; memset(&a, 0, sizeof a);
    a.sin_family = AF_INET; a.sin_port = htons(9); a.sin_addr.s_addr = htonl(0x7f000001);
    int rc = connect(fd, (struct sockaddr *)&a, sizeof a);
    printf("%s: connect rc=%d errno=%d (a refusal is fine; a TRAP is the bug)\n", who, rc, rc < 0 ? errno : 0);
    fflush(stdout);
    close(fd);
    return 0;
}
static void *worker(void *arg) { (void)arg; try_connect("worker"); return (void *)1; }

int main(void) {
    try_connect("main");
    pthread_t t; void *r = NULL;
    if (pthread_create(&t, NULL, worker, NULL) != 0) { puts("spawn failed"); return 1; }
    pthread_join(t, &r);
    printf("main: worker completed=%ld\n", (long)r);
    return 0;
}
