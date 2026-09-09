#include <atomic>
#include <cassert>
#include <condition_variable>
#include <mutex>
#include <vector>
struct ggml_threadpool { int pauses = 0, resumes = 0; bool paused = false; };
#include "anchor_idle_pool.h"
static anchor_idle_pool::hook_fn installed;
static void *installed_ctx;
static void set_hook(anchor_idle_pool::hook_fn fn, void *ctx) { installed=fn; installed_ctx=ctx; }
static void pause_pool(ggml_threadpool *p) { ++p->pauses; p->paused=true; }
static void resume_pool(ggml_threadpool *p) { ++p->resumes; p->paused=false; }
int main() {
    anchor_idle_order mode;
    assert(anchor_idle_order_parse(nullptr,0,1,mode) && mode==anchor_idle_order::none);
    for (const char *bad : {"", "0", "1", "off-on ", "OFF-ON", "off-off", "on-on"})
        assert(!anchor_idle_order_parse(bad,2,0,mode));
    assert(!anchor_idle_order_parse("off-on",1,0,mode));
    assert(!anchor_idle_order_parse("off-on",2,1,mode));
    for (const char *order : {"off-on","on-off"}) for (bool separate_batch : {false,true}) {
        assert(anchor_idle_order_parse(order,2,0,mode));
        ggml_threadpool target,batch;
        {
            anchor_idle_pool p;
            p.target=&target; p.batch=separate_batch ? &batch : &target;
            p.pause=pause_pool; p.resume=resume_pool; p.set=set_hook; p.armed=false;
            set_hook(anchor_idle_pool::park,&p);
            // Registration and prompt observation invoke the real callback but cannot pause.
            for (int i=0;i<12;++i) installed(installed_ctx);
            assert(p.calls==0 && target.pauses==0);
            std::mutex mu; std::condition_variable cv; bool entered=false,release=false;
            std::atomic<bool> foreign_refused{false};
            std::thread head([&] {
                // Model an independent draft caller entering while its target owner is active.
                installed(installed_ctx);
                foreign_refused=!p.select(true);
                std::unique_lock<std::mutex> lk(mu); entered=true; cv.notify_all();
                cv.wait(lk,[&]{return release;});
                for (int i=0;i<100;++i) installed(installed_ctx);
            });
            { std::unique_lock<std::mutex> lk(mu); cv.wait(lk,[&]{return entered;}); }
            assert(foreign_refused && !p.armed && p.calls==0);
            for (uint64_t trial=1;trial<=2;++trial) {
                bool on=anchor_idle_trial_enabled(mode,trial);
                assert(p.select(on));
                if (!on) assert(!target.paused && !batch.paused);
                auto before=p.calls;
                for (int i=0;i<7;++i) installed(installed_ctx);
                assert(p.calls-before==(on?7u:0u));
                if (on) assert(target.paused && (!separate_batch || batch.paused));
            }
            { std::lock_guard<std::mutex> lk(mu); release=true; cv.notify_all(); }
            head.join();
            assert(p.calls==7 && target.pauses==7 && batch.pauses==(separate_batch?7:0));
            assert(p.select(false) && !target.paused && !batch.paused);
        }
        assert(installed==nullptr && installed_ctx==nullptr);
    }
    // Missing resume capability refuses paired selection, instead of silently keeping a parked pool.
    anchor_idle_pool missing; ggml_threadpool target; missing.target=&target; missing.pause=pause_pool;
    assert(!missing.select(false) && target.resumes==0);
}
