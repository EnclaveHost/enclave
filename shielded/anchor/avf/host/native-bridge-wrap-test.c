/* Force a partial send, refill across the end of the circular buffer, and
 * drain both contiguous spans. Real socket I/O with only send size limited. */
#define _GNU_SOURCE
#include <assert.h>
#include <sys/socket.h>
#include <unistd.h>
static ssize_t limited_send(int fd, const void *buf, size_t n, int flags);
#define send limited_send
#include "native-bridge.c"
#undef send
#include <stdio.h>

static ssize_t limited_send(int fd, const void *buf, size_t n, int flags) {
    return send(fd, buf, n < 7 ? n : 7, flags);
}

int main(void) {
    int source[2], sink[2];
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, source) == 0);
    assert(socketpair(AF_UNIX, SOCK_STREAM, 0, sink) == 0);
    uint8_t guarded[19]; memset(guarded, 0xA5, sizeof guarded);
    bridge_dir d = {.buf = guarded + 1, .cap = 17};
    anchor_bridge_stats stats = {0}; uint64_t delivered = 0;
    uint8_t input[21], output[21];
    for (size_t i = 0; i < sizeof input; ++i) input[i] = (uint8_t)(i * 37 + 9);
    assert(write(source[0], input, sizeof input) == sizeof input);
    assert(pump_read(source[1], &d, POLLIN, &stats) == 0);
    assert(d.head == 0 && d.used == 17);
    assert(pump_write(sink[0], &d, POLLOUT, &stats, &delivered) == 0);
    assert(d.head == 7 && d.used == 10 && delivered == 7);
    assert(pump_read(source[1], &d, POLLIN, &stats) == 0);
    assert(d.head == 7 && d.used == 14);  /* four new bytes wrapped to offset 0 */
    assert(pump_write(sink[0], &d, POLLOUT, &stats, &delivered) == 0);
    assert(d.head == 14 && d.used == 7 && delivered == 14);
    assert(pump_write(sink[0], &d, POLLOUT, &stats, &delivered) == 0);
    assert(d.head == 0 && d.used == 4 && delivered == 17); /* stop at the buffer end */
    assert(pump_write(sink[0], &d, POLLOUT, &stats, &delivered) == 0);
    assert(d.head == 0 && d.used == 0 && delivered == sizeof input);
    assert(shutdown(sink[0], SHUT_WR) == 0);
    size_t got = 0;
    while (got < sizeof output) {
        const ssize_t n = read(sink[1], output + got, sizeof output - got);
        assert(n > 0); got += (size_t)n;
    }
    assert(memcmp(input, output, sizeof input) == 0);
    uint8_t byte; assert(read(sink[1], &byte, 1) == 0);
    assert(guarded[0] == 0xA5 && guarded[18] == 0xA5);
    assert(stats.reads == 2 && stats.writes == 4 && stats.max_chunk == 17);
    for (int i = 0; i < 2; ++i) { close(source[i]); close(sink[i]); }
    puts("native-bridge: partial send, wrapped refill and two-span drain exact PASS");
    return 0;
}
