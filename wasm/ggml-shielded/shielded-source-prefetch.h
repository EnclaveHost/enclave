#pragma once

#ifndef SH_SOURCE_PREFETCH_RESIZE
#define SH_SOURCE_PREFETCH_RESIZE(v, n) (v).resize(n)
#endif

// One raw source copy ahead of registration. The reader owns its descriptor
// copy; the model still owns the source buffer until the planner returns.
// No authentication happens here: sh_register verifies the returned private
// bytes before encoding. At most 128 MiB extra is retained, and only one
// source reader is active. Destruction joins before model cleanup can proceed.
struct sh_prefetched_source {
    ggml_tensor descriptor = {};
    std::vector<uint8_t> bytes;
    int status = 0; // 0: allocation unavailable, 1: read complete, -1: read failed
};

class sh_source_prefetch {
    std::unique_ptr<sh_prefetched_source> job;
    std::thread worker;
public:
    static constexpr size_t cap = 128u << 20;
    ~sh_source_prefetch() { if (worker.joinable()) worker.join(); }
    void start(const ggml_tensor *w) {
        if (!w || !sh_is_weight_source(w) || job || worker.joinable()) return;
        const auto &source = *static_cast<sh_weight_source *>(w->buffer->context);
        if (!sh_source_descriptor_matches(source, w) || !source.size || source.size > cap) return;
        try {
            job.reset(new sh_prefetched_source);
            job->descriptor = *w;
            const size_t bytes = source.size;
            auto *j = job.get();
            worker = std::thread([j, bytes] {
                try { SH_SOURCE_PREFETCH_RESIZE(j->bytes, bytes); }
                catch (...) { return; } // registration can allocate serially later
                j->status = sh_source_read_for_registration(&j->descriptor, j->bytes.data(), bytes) ? 1 : -1;
            });
        } catch (...) { job.reset(); } // failed thread creation leaves serial reading available
    }
    std::unique_ptr<sh_prefetched_source> take(const ggml_tensor *w) {
        if (worker.joinable()) worker.join();
        auto result = std::move(job);
        if (!result) return nullptr;
        const auto &a = result->descriptor;
        if (a.buffer != w->buffer || a.data != w->data || a.type != w->type ||
            strcmp(a.name, w->name) || memcmp(a.ne, w->ne, sizeof a.ne) ||
            memcmp(a.nb, w->nb, sizeof a.nb)) return nullptr;
        return result;
    }
};
