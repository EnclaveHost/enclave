/*
 * vsock-sink -- the host side of a --debug none protected VM's only mouth.
 *
 * A non-debuggable pVM has no console and no log: the guest's memory is
 * unmapped from the host and nothing leaks out but what the payload chooses
 * to send. This sink listens on a vsock port on the host (VMADDR_CID_ANY),
 * accepts the guest's connection and copies whatever it writes to stdout.
 * Run it from an adb shell on the phone BEFORE `vm run-app --debug none`.
 *
 *   vsock-sink <port> [--once]        # --once: exit when the first peer closes
 */
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <sys/socket.h>
#include <linux/vm_sockets.h>

int main(int argc, char **argv) {
    int port = argc > 1 ? atoi(argv[1]) : 7777;
    int once = argc > 2 && !strcmp(argv[2], "--once");
    int s = socket(AF_VSOCK, SOCK_STREAM, 0);
    if (s < 0) { fprintf(stderr, "sink: socket(AF_VSOCK): %s\n", strerror(errno)); return 1; }
    struct sockaddr_vm sa = { .svm_family = AF_VSOCK, .svm_port = (unsigned)port, .svm_cid = VMADDR_CID_ANY };
    if (bind(s, (struct sockaddr *)&sa, sizeof sa) != 0) { fprintf(stderr, "sink: bind port %d: %s\n", port, strerror(errno)); return 1; }
    if (listen(s, 4) != 0) { fprintf(stderr, "sink: listen: %s\n", strerror(errno)); return 1; }
    fprintf(stderr, "sink: listening on vsock port %d\n", port);
    for (;;) {
        struct sockaddr_vm peer; socklen_t pl = sizeof peer;
        int c = accept(s, (struct sockaddr *)&peer, &pl);
        if (c < 0) { fprintf(stderr, "sink: accept: %s\n", strerror(errno)); return 1; }
        fprintf(stderr, "sink: peer cid=%u port=%u\n", peer.svm_cid, peer.svm_port);
        char buf[4096]; ssize_t n;
        while ((n = read(c, buf, sizeof buf)) > 0) { fwrite(buf, 1, (size_t)n, stdout); fflush(stdout); }
        close(c);
        fprintf(stderr, "sink: peer closed\n");
        if (once) break;
    }
    return 0;
}
