/* rtset: the host side of guest/rtset.h - the SAME code the plane runs, built for the host.
 *
 *   rtset encode <dir>                              the runtime-set encoding on stdout; sha256 it for
 *                                                   ENCLAVE_RUNTIME_SHA256
 *   rtset list <dir>                                the members, one per line: name size elf
 *   rtset cover <dir> <timeout_ms> [--swap NAME] -- <argv...>
 *                                                   start argv the way planeinit starts the runtime, then run the
 *                                                   maps check the plane runs; exit 0 only when covered
 *
 * --swap is a TEST knob, for test-rtset.sh only: after the set is encoded it renames a byte-identical copy over
 * NAME, so the process maps the same path and the same bytes through a DIFFERENT file object - which the maps
 * check must refuse, since a rename after admission is exactly how an unadmitted file would reach the loader.
 */
#define _GNU_SOURCE
#include "guest/rtset.h"

#include <limits.h>

/* The encoding goes to stdout, and every piece the header hands a sink must fit one sysfs write in the guest. The
 * guest's sink cannot check that without losing bytes, so this one does, loudly. */
static int stdout_sink(void *ctx, const void *buf, size_t n) {
    (void)ctx;
    if (n == 0 || n > RTSET_CHUNK) {
        fprintf(stderr, "rtset: the encoder handed the sink %zu bytes; the guest's sysfs sink takes at most %d\n", n,
                RTSET_CHUNK);
        abort();
    }
    const char *b = buf;
    while (n) {
        ssize_t w = write(1, b, n);
        if (w < 0 && errno == EINTR) continue;
        if (w <= 0) return -errno;
        b += w;
        n -= (size_t)w;
    }
    return 0;
}

static int null_sink(void *ctx, const void *buf, size_t n) {
    (void)ctx;
    (void)buf;
    return n > RTSET_CHUNK ? -EINVAL : 0;
}

static int load(struct rtset *s, const char *arg, rtset_sink sink, char *err, size_t el) {
    /* the maps name files by their resolved path, so the set must too */
    char real[PATH_MAX];
    if (!realpath(arg, real)) { snprintf(err, el, "%s: %s", arg, strerror(errno)); return -1; }
    if (rtset_scan(s, real, err, el)) return -1;
    return rtset_encode(s, sink, NULL, err, el);
}

static int swap_member(const struct rtset *s, const char *name) {
    char from[PATH_MAX + 8], to[PATH_MAX + 8], cmd[3 * PATH_MAX];
    snprintf(to, sizeof to, "%s/%s", s->dir, name);
    snprintf(from, sizeof from, "%s/.swap-%s", s->dir, name);
    snprintf(cmd, sizeof cmd, "cp -p '%s' '%s'", to, from);
    if (system(cmd) != 0) return -1;
    return rename(from, to);
}

int main(int argc, char **argv) {
    static struct rtset s;
    static char err[8192];
    if (argc == 3 && !strcmp(argv[1], "encode")) {
        if (load(&s, argv[2], stdout_sink, err, sizeof err)) { fprintf(stderr, "rtset: REFUSED: %s\n", err); return 1; }
        return 0;
    }
    if (argc == 3 && !strcmp(argv[1], "list")) {
        if (load(&s, argv[2], null_sink, err, sizeof err)) { fprintf(stderr, "rtset: REFUSED: %s\n", err); return 1; }
        for (int i = 0; i < s.n; i++) printf("%s %llu %d\n", s.m[i].name, (unsigned long long)s.m[i].size, s.m[i].elf);
        printf("total %llu members %d elf %d\n", (unsigned long long)s.total, s.n, rtset_elf_members(&s));
        return 0;
    }
    if (argc >= 5 && !strcmp(argv[1], "cover")) {
        int timeout = atoi(argv[3]), i = 4;
        const char *swap = NULL;
        if (!strcmp(argv[i], "--swap") && i + 1 < argc) { swap = argv[i + 1]; i += 2; }
        if (i >= argc || strcmp(argv[i], "--") || i + 1 >= argc) goto usage;
        if (load(&s, argv[2], null_sink, err, sizeof err)) { printf("COVER refused: %s\n", err); return 1; }
        if (swap && swap_member(&s, swap)) { printf("COVER harness: could not swap %s\n", swap); return 2; }
        /* the environment planeinit gives the runtime, with the set's own directory as PATH */
        char pathenv[PATH_MAX + 8];
        snprintf(pathenv, sizeof pathenv, "PATH=%s", s.dir);
        char *envp[] = {"HOME=/tmp", pathenv, NULL};
        int e = 0;
        pid_t pid = rtset_spawn(argv + i + 1, envp, &e);
        if (pid < 0) { printf("COVER harness: %s did not start: %s\n", argv[i + 1], strerror(e)); return 2; }
        char outside[2048];
        int polls = 0;
        int r = rtset_wait_coverage(&s, pid, timeout, outside, sizeof outside, err, sizeof err, &polls);
        if (r == 1)
            printf("COVER ok elf_members_mapped=%d/%d members=%d polls=%d outside_data=%s\n", rtset_elf_members(&s),
                   rtset_elf_members(&s), s.n, polls, outside[0] ? outside : "none");
        else
            printf("COVER refused: %s\n", err);
        kill(pid, SIGKILL);
        waitpid(pid, NULL, 0);
        return r == 1 ? 0 : 1;
    }
usage:
    fprintf(stderr, "usage: rtset encode|list <dir>\n       rtset cover <dir> <timeout_ms> [--swap NAME] -- argv...\n");
    return 2;
}
