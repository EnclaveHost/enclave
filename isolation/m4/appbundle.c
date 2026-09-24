/* appbundle: the host side of guest/appbundle.h - the SAME framing, hash and sealed hand-off the plane runs.
 *
 *   appbundle extract <bundle>          the component, cut and manifest-checked, on stdout
 *   appbundle sha256 <file>             the plane's own SHA-256 of a file, for comparison with sha256sum
 *   appbundle serve <bundle> <port> <timeout_ms> -- <argv...>
 *        start argv exactly as planeinit starts the runtime - the sealed component at fd 3, argv naming
 *        /proc/self/fd/3 - GET / on 127.0.0.1:<port>, print the first body line, then try to WRITE and TRUNCATE
 *        the component through /proc/<pid>/fd/3, which the seals must refuse
 */
#define _GNU_SOURCE
#include "guest/rtset.h"
#include "guest/appbundle.h"

#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>

static int load(struct appbundle *b, const char *path, char *err, size_t el) {
    return appbundle_read(b, path, err, el) || appbundle_frame(b, err, el) ? -1 : 0;
}

static int get_root(int port, char *body, size_t bl) {
    int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0);
    struct sockaddr_in a = {.sin_family = AF_INET, .sin_port = htons((uint16_t)port)};
    a.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    if (s < 0 || connect(s, (struct sockaddr *)&a, sizeof a) != 0) { if (s >= 0) close(s); return -1; }
    const char *req = "GET / HTTP/1.0\r\nHost: localhost\r\n\r\n";
    if (write(s, req, strlen(req)) != (ssize_t)strlen(req)) { close(s); return -1; }
    static char resp[65536];
    size_t got = 0;
    ssize_t r;
    while (got < sizeof resp - 1 && (r = read(s, resp + got, sizeof resp - 1 - got)) > 0) got += (size_t)r;
    close(s);
    resp[got] = 0;
    char *b = strstr(resp, "\r\n\r\n");
    if (!b) return -1;
    b += 4;
    b[strcspn(b, "\r\n")] = 0;
    snprintf(body, bl, "%s", b);
    return 0;
}

int main(int argc, char **argv) {
    static struct appbundle b;
    static char err[4096];
    if (argc == 3 && !strcmp(argv[1], "extract")) {
        if (load(&b, argv[2], err, sizeof err)) { fprintf(stderr, "appbundle: REFUSED: %s\n", err); return 1; }
        return fwrite(b.buf + b.art_off, 1, b.art_len, stdout) == b.art_len ? 0 : 1;
    }
    if (argc == 3 && !strcmp(argv[1], "sha256")) {
        FILE *f = fopen(argv[2], "rb");
        if (!f) { perror(argv[2]); return 1; }
        struct ab_sha256 s;
        static unsigned char buf[1 << 16];
        size_t n;
        char hex[65];
        ab_sha256_init(&s);
        while ((n = fread(buf, 1, sizeof buf, f)) > 0) ab_sha256_update(&s, buf, n);
        fclose(f);
        ab_sha256_hex(&s, hex);
        printf("%s\n", hex);
        return 0;
    }
    if (argc >= 7 && !strcmp(argv[1], "serve") && !strcmp(argv[5], "--")) {
        int port = atoi(argv[3]), timeout = atoi(argv[4]);
        if (load(&b, argv[2], err, sizeof err)) { printf("SERVE refused: %s\n", err); return 1; }
        int fd = appbundle_memfd(&b, err, sizeof err);
        if (fd < 0) { printf("SERVE refused: %s\n", err); return 1; }
        char *envp[] = {"HOME=/tmp", NULL};
        int e = 0;
        pid_t pid = rtset_spawn(argv + 6, envp, fd, &e);
        if (pid < 0) { printf("SERVE harness: did not start: %s\n", strerror(e)); return 2; }
        char body[1024] = "";
        int ok = -1;
        struct timespec tick = {0, 50 * 1000 * 1000};
        for (int waited = 0; waited < timeout && (ok = get_root(port, body, sizeof body)) != 0; waited += 50)
            nanosleep(&tick, NULL);
        printf("COMPONENT sha256=%s bytes=%zu\n", b.art_hex, b.art_len);
        printf("BODY %s\n", ok == 0 ? body : "(no response)");
        char path[64];
        snprintf(path, sizeof path, "/proc/%d/fd/3", (int)pid);
        int w = open(path, O_RDWR | O_CLOEXEC);
        const char *wr = "open failed", *tr = "open failed";
        char wbuf[64], tbuf[64];
        if (w >= 0) {
            snprintf(wbuf, sizeof wbuf, "%s", write(w, "X", 1) == 1 ? "WROTE" : strerror(errno));
            snprintf(tbuf, sizeof tbuf, "%s", ftruncate(w, 0) == 0 ? "TRUNCATED" : strerror(errno));
            wr = wbuf;
            tr = tbuf;
            close(w);
        }
        printf("SEAL write=%s truncate=%s\n", wr, tr);
        kill(pid, SIGKILL);
        waitpid(pid, NULL, 0);
        return ok == 0 ? 0 : 1;
    }
    fprintf(stderr, "usage: appbundle extract|sha256 <file>\n"
                    "       appbundle serve <bundle> <port> <timeout_ms> -- argv...\n");
    return 2;
}
