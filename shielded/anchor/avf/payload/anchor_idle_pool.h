#ifndef ANCHOR_IDLE_POOL_H
#define ANCHOR_IDLE_POOL_H
#include <cstdint>
#include <cstring>
#include <thread>

struct ggml_threadpool;
enum class anchor_idle_order { none, off_on, on_off };
inline bool anchor_idle_order_parse(const char *text, uint64_t trials, int full_park, anchor_idle_order &order) {
    order = anchor_idle_order::none;
    if (!text) return true;
    if (trials != 2 || full_park) return false;
    if (!strcmp(text, "off-on")) order = anchor_idle_order::off_on;
    else if (!strcmp(text, "on-off")) order = anchor_idle_order::on_off;
    else return false;
    return true;
}
inline bool anchor_idle_trial_enabled(anchor_idle_order order, uint64_t trial) {
    return (order == anchor_idle_order::off_on && trial == 2) ||
           (order == anchor_idle_order::on_off && trial == 1);
}

struct anchor_idle_pool {
    using pause_fn = void (*)(ggml_threadpool *);
    using hook_fn = void (*)(void *);
    using set_fn = void (*)(hook_fn, void *);
    pause_fn pause = nullptr, resume = nullptr;
    set_fn set = nullptr;
    ggml_threadpool *target = nullptr, *batch = nullptr;
    const std::thread::id owner = std::this_thread::get_id();
    bool armed = true;
    uint64_t calls = 0;
    static void park(void *v) {
        auto &p = *static_cast<anchor_idle_pool *>(v);
        // The owner has completed its previous CPU split. Draft-ahead uses
        // another pool and cannot establish that fact about the target.
        // Only the owner accesses armed/calls, so no shared flag race occurs.
        if (std::this_thread::get_id() != p.owner || !p.armed) return;
        p.pause(p.target);
        if (p.batch && p.batch != p.target) p.pause(p.batch);
        ++p.calls;
        // ggml_graph_compute_kickoff resumes the next CPU graph.
    }
    bool select(bool enabled) {
        if (std::this_thread::get_id() != owner || !pause || !resume || !target) return false;
        armed = enabled;
        if (!enabled) {
            resume(target);
            if (batch && batch != target) resume(batch);
        }
        return true;
    }
    ~anchor_idle_pool() { if (set) set(nullptr, nullptr); }
};
#endif
