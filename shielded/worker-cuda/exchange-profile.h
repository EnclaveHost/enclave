#ifndef SHIELDED_WORKER_EXCHANGE_PROFILE_H
#define SHIELDED_WORKER_EXCHANGE_PROFILE_H

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>

/* Owned by ONE connection thread, never shared between connections. These
 * are host elapsed intervals, not CUDA kernel or device-active durations.
 * Only phases that reach their end marker contribute a sample. */
struct WorkerExchangeProfile {
    using Clock = std::chrono::steady_clock;
    using Time = Clock::time_point;
    enum Phase : size_t { LOCK_WAIT, STAGING, GRAPH_LOOKUP, LAUNCH_CALL,
                          STREAM_SYNC, HOST_PACK, TCP_REPLY, COUNT };
    struct Sample { uint64_t count = 0; double total_us = 0, max_us = 0; };
    std::array<Sample, COUNT> samples{};
    uint64_t invalid_intervals = 0;

    static const char *name(size_t phase) {
        static const char *const names[] = {"lock_wait", "staging", "graph_lookup_capture",
            "graph_launch_call", "stream_sync", "host_pack", "tcp_reply_write"};
        return phase < COUNT ? names[phase] : "invalid";
    }
    void begin(Time now = Clock::now()) { last = now; started = true; }
    bool mark(Phase phase, Time now = Clock::now()) {
        if (!started || phase >= COUNT || now < last) {
            ++invalid_intervals;
            started = false;
            return false;
        }
        const double us = std::chrono::duration<double, std::micro>(now-last).count();
        auto &s = samples[phase];
        ++s.count;
        s.total_us += us;
        if (us > s.max_us) s.max_us = us;
        last = now;
        return true;
    }
private:
    Time last{};
    bool started = false;
};

#endif
