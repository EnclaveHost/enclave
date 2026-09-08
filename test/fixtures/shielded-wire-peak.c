/* Real socket framing with an injected monotonic clock: exact header/body
 * attribution without sleeping or relying on the host scheduler. */
#define clock_gettime test_clock_gettime
#include "../../wasm/ggml-shielded/shielded-wire.c"
#undef clock_gettime
#include <assert.h>
#include <math.h>
#include <signal.h>

static const int64_t *ticks;
static size_t tick_count, tick_pos;
int test_clock_gettime(clockid_t id, struct timespec *ts) {
    assert(id == CLOCK_MONOTONIC && tick_pos < tick_count);
    int64_t ms = ticks[tick_pos++];
    ts->tv_sec = ms / 1000; ts->tv_nsec = (ms % 1000) * 1000000;
    return 0;
}
static void clock_set(const int64_t *values, size_t n) { ticks = values; tick_count = n; tick_pos = 0; }
static void exchange(sh_pipe *p, int peer, const uint8_t *payload, size_t n, size_t split, uint8_t cmd, uint8_t status) {
    assert(split <= n);
    uint8_t answer[15] = {0}; answer[0] = status; put_u64(answer + 1, 6);
    memcpy(answer + 9, "answer", 6);
    assert(write(peer, answer, sizeof answer) == sizeof answer);
    sh_frame f = {cmd, payload, split, payload + split, n - split}; sh_reply r;
    int rc = sh_pipe_exchange(p, &f, 1, &r);
    assert(rc == (status ? SH_ERR_VIOLATION : SH_OK));
    if (!status) assert(r.len == 6 && !memcmp(r.data, "answer", 6));
    uint8_t wire[128]; assert(n + 9 <= sizeof wire);
    assert(read_all(peer, wire, n + 9) == SH_OK);
    assert(wire[0] == cmd && get_u64(wire + 1) == n && !memcmp(wire + 9, payload, n));
    assert(tick_pos == tick_count);
}
int main(void) {
    signal(SIGPIPE, SIG_IGN); unsetenv("SHIELDED_SPIN_US"); setenv("SHIELDED_PROFILE", "1", 1);
    int pair[2]; assert(socketpair(AF_UNIX, SOCK_STREAM, 0, pair) == 0);
    sh_pipe *p = calloc(1, sizeof *p); assert(p); p->fd = pair[0];
    uint8_t request[40] = {0}; // 2 nodes, 2 rows, K=4 ->16 metadata+24 plane bytes
    put_u32(request, 2); put_u32(request + 4, 2); put_u32(request + 8, 17); put_u32(request + 12, 29);
    const int64_t header_stall[] = {1000,1002,1005,7505,7510};
    clock_set(header_stall, 5); exchange(p, pair[1], request, sizeof request, 7, SH_CMD_FIELD_GEMM24, 0);
    sh_wire_timing first; sh_pipe_wire_timing(p, &first);
    assert(first.calls == 1 && first.max_ms == 6510 && first.over_100ms == 1 && first.over_1s == 1);
    assert(first.peak.call == 1 && first.peak.cmd == SH_CMD_FIELD_GEMM24 && first.peak.metadata_valid);
    assert(first.peak.nodes == 2 && first.peak.rows == 2 && first.peak.K == 4 && first.peak.first_node == 17);
    assert(first.peak.request_bytes == 49 && first.peak.reply_bytes == 15 && !first.peak.first_node_name[0]);
    assert(first.peak.write_ms == 2 && first.peak.work_ms == 3 && first.peak.header_ms == 6500 && first.peak.body_ms == 5);
    const int64_t fast[] = {8000,8001,8002,8005,8010};
    clock_set(fast, 5); exchange(p, pair[1], request, sizeof request, sizeof request, SH_CMD_FIELD_GEMM, 0);
    sh_wire_timing second; sh_pipe_wire_timing(p, &second);
    assert(second.calls == 2 && second.request_bytes == 98 && second.reply_bytes == 30);
    assert(second.max_ms == first.max_ms && !memcmp(&second.peak, &first.peak, sizeof first.peak));
    const int64_t body_stall[] = {9000,9001,9002,9003,16000};
    put_u32(request + 8, 29);
    clock_set(body_stall, 5); exchange(p, pair[1], request, sizeof request, 0, SH_CMD_FIELD_GEMM, 0);
    sh_wire_timing third; sh_pipe_wire_timing(p, &third);
    assert(third.calls == 3 && third.max_ms == 7000 && third.peak.call == 3 && third.peak.first_node == 29);
    assert(third.peak.header_ms == 1 && third.peak.body_ms == 6997 && third.over_1s == 2);
    assert(third.peak.cmd == SH_CMD_FIELD_GEMM && third.peak.K == 4);
    assert(third.write_ms == 4 && third.work_ms == 5 && third.header_ms == 6504 && third.body_ms == 7007);
    // Disabled profiling and non-GEMM commands must not read the clock or
    // overwrite previous evidence. Failed responses are not successful calls.
    setenv("SHIELDED_PROFILE", "0", 1); clock_set(NULL, 0);
    exchange(p, pair[1], request, sizeof request, 16, SH_CMD_FIELD_GEMM24, 0);
    setenv("SHIELDED_PROFILE", "1", 1); clock_set(NULL, 0);
    exchange(p, pair[1], request, sizeof request, 16, SH_CMD_SET_TENSOR, 0);
    clock_set(body_stall, 5); exchange(p, pair[1], request, sizeof request, 16, SH_CMD_FIELD_GEMM24, 1);
    sh_wire_timing unchanged; sh_pipe_wire_timing(p, &unchanged);
    assert(!memcmp(&unchanged, &third, sizeof third));
    // A raw pipe can transport malformed request metadata. Its profiling must
    // stay bounded, flag metadata invalid, and never invent a known node.
    const int64_t later[] = {20000,20001,20002,28000,28001};
    for (int mode = 0; mode < 3; mode++) {
        memset(&p->timing, 0, sizeof p->timing);
        put_u32(request, mode == 1 ? UINT32_MAX : 2); put_u32(request + 4, mode == 2 ? 0 : 2);
        clock_set(later, 5); exchange(p, pair[1], request, mode == 0 ? 5 : sizeof request, 3, SH_CMD_FIELD_GEMM24, 0);
        sh_pipe_wire_timing(p, &unchanged);
        assert(unchanged.peak.call == 1 && !unchanged.peak.metadata_valid && !unchanged.peak.first_node_name[0]);
    }
    sh_pipe_wire_timing(NULL, &unchanged); assert(!unchanged.calls && !unchanged.peak.call);
    sh_pipe_wire_timing(p, NULL); close(pair[1]); sh_pipe_close(p);
    puts("shielded-wire-peak: PASS");
}
