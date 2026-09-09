#include "anchor_prepare.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>
uint64_t anchor_prepare_mono_ms(void) { struct timespec ts; clock_gettime(CLOCK_MONOTONIC, &ts); return (uint64_t)ts.tv_sec * 1000u + (uint64_t)ts.tv_nsec / 1000000u; }
int anchor_artifact_profile_parse(const char *line, int *on) {
    if (!line || !on || strncmp(line, "ARTIFACT_PROFILE ", 17) != 0) return 0;
    if ((line[17] != '0' && line[17] != '1') || line[18] != 0) return 0;   /* exactly one of the two digits, nothing after it */
    *on = line[17] - '0'; return 1;
}
int anchor_artifact_profile_effective(int explicit_setting, const char *env_value) {
    if (explicit_setting == 0 || explicit_setting == 1) return explicit_setting;
    return env_value != NULL && strcmp(env_value, "1") == 0;
}
int anchor_prepare_parse(const char *line, int *seconds) {
    if (!line || !seconds || strncmp(line, "PREPARE", 7) != 0) return 0;
    const char *p = line + 7;
    if (*p == 0) { *seconds = 300; return 1; }
    if (*p != ' ') return 0;
    p++;
    if (*p < '1' || *p > '9') return 0;                              /* canonical: no leading zero, no sign, at least one digit */
    int v = 0; const char *q = p;
    while (*q >= '0' && *q <= '9') { v = v * 10 + (*q - '0'); if (v > 600) return 0; q++; }
    if (*q != 0 || q - p > 3) return 0;                              /* nothing after the number */
    if (v < 1 || v > 600) return 0;
    *seconds = v; return 1;
}
int anchor_prepare_wait_stop(int fd, uint64_t deadline_ms) {
    char line[65]; size_t n = 0;
    if (fd < 0) return ANCHOR_PREPARE_ERROR;                         /* poll() would silently ignore a negative descriptor and wait out the deadline */
    for (;;) {
        const uint64_t now = anchor_prepare_mono_ms();
        if (now >= deadline_ms) return ANCHOR_PREPARE_DEADLINE;
        const uint64_t left = deadline_ms - now;
        struct pollfd pf = { fd, POLLIN, 0 };
        const int pr = poll(&pf, 1, left > 1000 ? 1000 : (int)left);
        if (pr < 0) { if (errno == EINTR) continue; return ANCHOR_PREPARE_ERROR; }
        if (pr == 0) continue;
        if (pf.revents & (POLLERR | POLLNVAL)) return ANCHOR_PREPARE_ERROR;
        char buf[64]; ssize_t r = read(fd, buf, sizeof buf);          /* only what is available now: poll said readable */
        if (r < 0) { if (errno == EINTR || errno == EAGAIN) continue; return ANCHOR_PREPARE_ERROR; }
        if (r == 0) return ANCHOR_PREPARE_EOF;
        for (ssize_t i = 0; i < r; i++) {
            const char c = buf[i];
            if (c == '\n') { line[n] = 0; if (!strcmp(line, "STOP")) return ANCHOR_PREPARE_STOP; n = 0; continue; }   /* other complete lines: ignored */
            if (n >= sizeof line - 1) return ANCHOR_PREPARE_OVERLONG;
            line[n++] = c;
        }
    }
}
