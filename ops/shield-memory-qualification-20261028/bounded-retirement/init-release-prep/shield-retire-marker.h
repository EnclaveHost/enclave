/* shield-retire-marker.h - the measured opt-in for bounded retirement of consumed private originals.
 * The marker is release content in the measured initramfs (/rt), never host or tenant input. Read by init as root,
 * before the app's privilege drop and seccomp filter, and only when original-source reclaim is on (dominit.c spawn()).
 * The runtime side is ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB in shield-original-source.hpp (plain decimal, 64..65536). */
#ifndef SHIELD_RETIRE_MARKER_H
#define SHIELD_RETIRE_MARKER_H
#include <errno.h>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

#define SHIELD_RETIRE_MARKER "/rt/shield-source-retire-budget-1024.enabled"
#define SHIELD_RETIRE_ENV "ENCLAVE_SHIELD_SOURCE_RETIRE_BUDGET_MIB=1024"

/* -> 0 absent (ENOENT only: today's deferred flush), 1 a regular file of exactly "1\n", -1 anything else (no app).
 * No symlink, FIFO, device or directory is followed or waited on; a short or long file is malformed. */
static int shield_retire_marker_at(const char *path) {
    int fd = open(path, O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_NOCTTY | O_CLOEXEC);
    if (fd < 0) return errno == ENOENT ? 0 : -1;
    struct stat st;
    char b[3];
    ssize_t n = -1;
    if (fstat(fd, &st) == 0 && S_ISREG(st.st_mode) && st.st_size == 2) n = read(fd, b, sizeof b);
    close(fd);
    return n == 2 && b[0] == '1' && b[1] == '\n' ? 1 : -1;
}
#endif
