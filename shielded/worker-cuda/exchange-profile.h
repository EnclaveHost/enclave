#ifndef SHIELDED_WORKER_EXCHANGE_PROFILE_H
#define SHIELDED_WORKER_EXCHANGE_PROFILE_H

#include <array>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <vector>
#include <cstdio>
#include <time.h>

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
    struct Row { uint64_t id, at, end, req, reply; double gpu_us, upload_us, cpu_us; std::array<double,COUNT> phase; };
    std::vector<Row> rows;
    std::array<double,COUNT> current{};
    double start_cpu=0, gpu_us=0, upload_us=0;
    uint64_t request_at=0, request_bytes=0;
    static double cpu() { timespec t{}; clock_gettime(CLOCK_THREAD_CPUTIME_ID,&t); return double(t.tv_sec)*1e6+double(t.tv_nsec)/1e3; }
    static uint64_t ns() { return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now().time_since_epoch()).count(); }
    WorkerExchangeProfile() { rows.reserve(8192); }
    void request(uint64_t bytes) { current={}; request_at=ns(); request_bytes=bytes; start_cpu=cpu(); }
    void finish(uint64_t id, uint64_t reply) {
        if (rows.size()<8192) rows.push_back(Row{id,request_at,ns(),request_bytes,reply,gpu_us,upload_us,cpu()-start_cpu,current});
    }
    void dump() {
        for (const auto &r:rows) {
            fprintf(stderr,"WORKER_SP %llu %llu %llu %llu %llu %.3f %.3f %.3f",(unsigned long long)r.id,(unsigned long long)r.at,(unsigned long long)r.end,(unsigned long long)r.req,(unsigned long long)r.reply,r.gpu_us,r.upload_us,r.cpu_us);
            for(double x:r.phase) fprintf(stderr," %.3f",x);
            fputc('\n',stderr);
        }
        fprintf(stderr,"WORKER_SP_COUNT recorded=%zu cap=8192\n",rows.size());
    }

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
        current[phase] = us;
        if (us > s.max_us) s.max_us = us;
        last = now;
        return true;
    }
private:
    Time last{};
    bool started = false;
};

#endif
