#define _GNU_SOURCE
#include <stdio.h>
#include <unistd.h>
#include <string.h>
#include "app-seccomp.h"
int main(int argc, char **argv) {
    if (argc < 2) return 2;
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { perror("nnp"); return 2; }
    if (app_seccomp_install() != 0) { perror("seccomp"); return 2; }
    execv(argv[1], argv + 1);
    perror("exec"); return 127;
}
