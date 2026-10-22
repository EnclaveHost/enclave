/* encvol-probe.c - TEST ONLY (never in an image), for m3/test-domexec-encvol.sh: what domexec gives each workload in a
 * domain with (or without) the monitor's encrypted-volume staging. Its role is its argv[0]: containing "front", the
 * front; anything else, the runtime (domexec runs it as /plat/secretrun in a secret domain). Writes "uid=", "groups="
 * and "umask=" to /probe-out/<role>.enc. Built static. */
#define _GNU_SOURCE
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(int argc, char **argv) {
    (void)argc;
    const char *role = strstr(argv[0], "front") ? "front" : "runtime";
    char path[64];
    snprintf(path, sizeof path, "/probe-out/%s.enc", role);
    FILE *out = fopen(path, "w");
    if (!out) return 1;
    gid_t g[64];
    int n = getgroups(64, g);
    fprintf(out, "uid=%u\ngroups=", (unsigned)getuid());
    for (int i = 0; i < n; i++) fprintf(out, "%s%u", i ? "," : "", (unsigned)g[i]);
    mode_t m = umask(0);
    umask(m);
    fprintf(out, "\numask=%03o\n", (unsigned)m);
    fclose(out);
    chmod(path, 0644);   /* the report itself: readable by the test outside the namespace whatever the umask was */
    sleep(3);   /* domexec ends the domain when either workload exits */
    return 0;
}
