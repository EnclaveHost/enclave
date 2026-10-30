/* test_retire_marker.c - offline checks of shield-retire-marker.h in a private temp dir. Never touches /rt.
 *   gcc -std=c11 -O1 -g -Wall -Wextra -fsanitize=address,undefined -fno-sanitize-recover=undefined \
 *       -I. test_retire_marker.c -o /tmp/test_retire_marker && /tmp/test_retire_marker
 * expects: "retire marker: all checks passed" */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <unistd.h>
#include "shield-retire-marker.h"

static int fails, checks;
static char dir[] = "/tmp/retire-marker-XXXXXX";
static char made[32][320];
static int nmade;

static const char *at(const char *name) {   /* a ring, so two results can be live at once */
    static char ring[8][320];
    static int next;
    char *p = ring[next++ % 8];
    snprintf(p, sizeof ring[0], "%s/%s", dir, name);
    return p;
}

static void remember(const char *p) {
    if (nmade >= 32) { fprintf(stderr, "too many fixtures\n"); exit(2); }
    snprintf(made[nmade++], sizeof made[0], "%s", p);
}

static const char *put(const char *name, const void *b, size_t n) {
    const char *p = at(name);
    FILE *f = fopen(p, "wb");
    if (!f) { perror(p); exit(2); }
    if (fwrite(b, 1, n, f) != n || fclose(f) != 0) { perror(p); exit(2); }
    remember(p);
    return p;
}

static void expect(const char *what, const char *path, int want) {
    int got = shield_retire_marker_at(path);
    checks++;
    if (got != want) { fprintf(stderr, "FAIL %s: got %d want %d\n", what, got, want); fails++; }
}

int main(void) {
    if (!mkdtemp(dir)) { perror("mkdtemp"); return 2; }
    int probe = dup(0);
    close(probe);

    /* the wiring constants the init and the composer depend on */
    checks += 2;
    if (strcmp(SHIELD_RETIRE_MARKER, "/rt/shield-source-retire-budget-1024.enabled") != 0) { fprintf(stderr, "FAIL marker path\n"); fails++; }
    if (strcmp(SHIELD_RETIRE_ENV, "ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024") != 0) { fprintf(stderr, "FAIL env\n"); fails++; }

    expect("absent", at("absent"), 0);
    expect("exact 1\\n", put("ok", "1\n", 2), 1);
    expect("exact 1\\n again (no state)", at("ok"), 1);
    expect("empty", put("empty", "", 0), -1);
    expect("no newline", put("one", "1", 1), -1);
    expect("two newlines", put("onenn", "1\n\n", 3), -1);
    expect("0\\n", put("zero", "0\n", 2), -1);
    expect("2\\n", put("two", "2\n", 2), -1);
    expect("1\\r", put("cr", "1\r", 2), -1);
    expect("11", put("eleven", "11", 2), -1);
    expect("\\n1", put("swapped", "\n1", 2), -1);
    expect("1\\0", put("nul", "1\0", 2), -1);
    expect("1024\\n", put("value", "1024\n", 5), -1);

    const char *d = at("adir");
    if (mkdir(d, 0700) != 0) { perror(d); return 2; }
    remember(d);
    expect("directory", d, -1);

    char target[4096];
    snprintf(target, sizeof target, "%s", at("ok"));
    const char *l = at("link");
    if (symlink(target, l) != 0) { perror(l); return 2; }
    remember(l);
    expect("symlink to a valid marker", l, -1);
    const char *dl = at("dangling");
    if (symlink(at("nowhere"), dl) != 0) { perror(dl); return 2; }
    remember(dl);
    expect("dangling symlink", dl, -1);

    const char *fifo = at("fifo");
    if (mkfifo(fifo, 0600) != 0) { perror(fifo); return 2; }
    remember(fifo);
    expect("fifo (must not block)", fifo, -1);

    char notdir[4096];
    snprintf(notdir, sizeof notdir, "%s/x", at("ok"));
    expect("parent is a file (ENOTDIR)", notdir, -1);

    char longp[8192];
    memset(longp, 'a', sizeof longp - 1);
    longp[0] = '/';
    longp[sizeof longp - 1] = 0;
    expect("name too long", longp, -1);

    if (geteuid() != 0) {
        const char *u = put("unreadable", "1\n", 2);
        if (chmod(u, 0) != 0) { perror(u); return 2; }
        expect("unreadable (EACCES)", u, -1);
    }

    /* no descriptor leaks across all of the above */
    int after = dup(0);
    close(after);
    checks++;
    if (after != probe) { fprintf(stderr, "FAIL descriptor leak: %d != %d\n", after, probe); fails++; }

    for (int i = nmade - 1; i >= 0; i--)
        if (unlink(made[i]) != 0) rmdir(made[i]);
    rmdir(dir);
    if (fails) { fprintf(stderr, "retire marker: %d of %d checks FAILED\n", fails, checks); return 1; }
    printf("retire marker: all checks passed (%d)\n", checks);
    return 0;
}
