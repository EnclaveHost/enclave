/* modelvol-probe.c - TEST ONLY (never in an image), for m3/test-domexec-modelvol.sh: what domexec hands each workload in
 * a domain with (or without) the monitor's model-volume binds. Its role is its argv[0]: containing "front", the front;
 * anything else, the runtime (domexec runs it as /plat/secretrun in a secret domain). Writes its argv one per line to
 * /probe-out/<role>.argv, its environment to /probe-out/<role>.env, and, for the runtime, where each staged graph in
 * /tmp/nn-graph points to /probe-out/runtime.stage. Built static. */
#define _GNU_SOURCE
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

extern char **environ;

static FILE *report(const char *role, const char *what, char *path, size_t len) {
    snprintf(path, len, "/probe-out/%s.%s", role, what);
    return fopen(path, "w");
}

int main(int argc, char **argv) {
    const char *role = strstr(argv[0], "front") ? "front" : "runtime";
    char path[96];
    FILE *out = report(role, "argv", path, sizeof path);
    if (!out) return 1;
    for (int i = 0; i < argc; i++) fprintf(out, "%s\n", argv[i]);
    fclose(out);
    chmod(path, 0644);
    if (!(out = report(role, "env", path, sizeof path))) return 1;
    for (char **e = environ; *e; e++) fprintf(out, "%s\n", *e);
    fclose(out);
    chmod(path, 0644);
    if (!strcmp(role, "runtime") && (out = report(role, "stage", path, sizeof path))) {
        DIR *d = opendir("/tmp/nn-graph");
        struct dirent *v, *f;
        while (d && (v = readdir(d))) {
            if (v->d_name[0] == '.') continue;
            char vd[300];
            snprintf(vd, sizeof vd, "/tmp/nn-graph/%s", v->d_name);
            DIR *g = opendir(vd);
            while (g && (f = readdir(g))) {
                if (f->d_name[0] == '.') continue;
                char l[600], t[600] = "";
                snprintf(l, sizeof l, "%s/%s", vd, f->d_name);
                ssize_t n = readlink(l, t, sizeof t - 1);
                if (n > 0) t[n] = 0;
                fprintf(out, "%s -> %s\n", l, t);
            }
            if (g) closedir(g);
        }
        if (d) closedir(d);
        fclose(out);
        chmod(path, 0644);
    }
    sleep(3);   /* domexec ends the domain when either workload exits */
    return 0;
}
