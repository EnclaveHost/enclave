/* Opt-in instruction sampling using per-thread CPU-time timers, no PMU and no
 * stack/memory capture. PC + return PC only. A source sample is statistical,
 * not a count of every executed line. Short-lived threads can be missed between
 * 100ms discovery sweeps; timer overruns and dropped records are reported. */
#ifndef ANCHOR_SOURCE_SAMPLE_H
#define ANCHOR_SOURCE_SAMPLE_H
#include <atomic>
#include <thread>
#include <map>
#include <tuple>
#include <signal.h>
#include <sys/syscall.h>
#include <ucontext.h>
#include <dirent.h>
#include <link.h>
#include <time.h>
namespace anchor_sample {
struct Row { uintptr_t pc, lr; unsigned tid, phase, overrun; std::atomic<unsigned> ready{0}; };
static constexpr unsigned CAP = 262144;
static Row rows[CAP];
static std::atomic<unsigned> count{0}, phase{0};
static std::atomic<bool> stop{false};
static_assert(std::atomic<unsigned>::is_always_lock_free, "signal handler requires lock-free atomics");
static void handler(int, siginfo_t *si, void *v) {
    const int saved_errno = errno;
    const unsigned p = phase.load(std::memory_order_relaxed);
    if (p && si && si->si_code == SI_TIMER) {
        const unsigned n = count.fetch_add(1, std::memory_order_relaxed);
        if (n < CAP) {
            auto *uc = static_cast<ucontext_t *>(v); auto &r = rows[n];
#if defined(__aarch64__)
            r.pc = uc->uc_mcontext.pc; r.lr = uc->uc_mcontext.regs[30];
#elif defined(__x86_64__)
            r.pc = uc->uc_mcontext.gregs[REG_RIP]; r.lr = 0;
#else
#error unsupported source sampling architecture
#endif
            r.tid = (unsigned)si->si_value.sival_int; r.phase = p;
            r.overrun = (unsigned)si->si_overrun;
            r.ready.store(1, std::memory_order_release);
        }
    }
    errno = saved_errno;
}
static int maps(dl_phdr_info *i, size_t, void *) {
    for (unsigned j=0; j<i->dlpi_phnum; ++j) {
        const auto &p=i->dlpi_phdr[j];
        if (p.p_type==PT_LOAD && (p.p_flags&PF_X))
            fprintf(stderr,"CPU_MAP %llx %llx %llx %s\n",(unsigned long long)i->dlpi_addr,
                (unsigned long long)(i->dlpi_addr+p.p_vaddr),
                (unsigned long long)(i->dlpi_addr+p.p_vaddr+p.p_memsz),i->dlpi_name);
    }
    return 0;
}
class Session {
    bool on=false;
    std::thread discover;
public:
    Session() {
        const char *e=getenv("SHIELDED_SOURCE_PROFILE");
        if (!e || strcmp(e,"1")) return;
        struct sigaction old{}, sa{};
        if (sigaction(SIGPROF,nullptr,&old) || old.sa_handler!=SIG_DFL) {
            fprintf(stderr,"CPU_SAMPLE unavailable: SIGPROF already owned\n"); return;
        }
        sa.sa_sigaction=handler; sa.sa_flags=SA_SIGINFO|SA_RESTART; sigemptyset(&sa.sa_mask);
        if (sigaction(SIGPROF,&sa,nullptr)) { fprintf(stderr,"CPU_SAMPLE sigaction errno=%d\n",errno); return; }
        on=true; phase.store(1); stop.store(false);
        discover=std::thread([] {
            std::map<int,timer_t> timers;
            unsigned failures=0, opened=0;
            while (!stop.load()) {
                DIR *d=opendir("/proc/self/task");
                if (d) {
                    while (dirent *de=readdir(d)) {
                        const int tid=atoi(de->d_name);
                        if (tid<=0 || tid==(int)syscall(SYS_gettid) || timers.count(tid)) continue;
                        // Linux per-thread CPU clock. Unsigned complement avoids signed shift UB.
                        const clockid_t clock=(clockid_t)((~(unsigned)tid<<3)|6u);
                        sigevent se{}; se.sigev_notify=SIGEV_THREAD_ID; se.sigev_signo=SIGPROF;
#ifdef __ANDROID__
                        se.sigev_notify_thread_id=tid;
#else
                        se._sigev_un._tid=tid;
#endif
                        se.sigev_value.sival_int=tid; timer_t timer{};
                        if (timer_create(clock,&se,&timer)) { if (!failures++) fprintf(stderr,"CPU_SAMPLE timer_create errno=%d\n",errno); continue; }
                        itimerspec it{}; it.it_value.tv_nsec=it.it_interval.tv_nsec=10000000; // 100Hz CPU time/thread
                        if (timer_settime(timer,0,&it,nullptr)) { ++failures; timer_delete(timer); continue; }
                        timers.emplace(tid,timer); ++opened;
                    }
                    closedir(d);
                } else if (!failures++) fprintf(stderr,"CPU_SAMPLE task_scan errno=%d\n",errno);
                std::this_thread::sleep_for(std::chrono::milliseconds(100));
            }
            for (auto &p:timers) timer_delete(p.second);
            fprintf(stderr,"CPU_SAMPLE timers=%u failures=%u hz_per_thread=100 discovery_ms=100\n",opened,failures);
        });
        fprintf(stderr,"CPU_SAMPLE begin phase=1 setup\n");
    }
    void set(unsigned p) { if (on) { phase.store(p); fprintf(stderr,"CPU_PHASE %u %llu\n",p,(unsigned long long)now()); } }
    static uint64_t now() { timespec t{}; clock_gettime(CLOCK_MONOTONIC,&t); return uint64_t(t.tv_sec)*1000000000+t.tv_nsec; }
    void finish() {
        if (!on) return;
        phase.store(0); stop.store(true); discover.join(); on=false;
        // Keep our inert handler installed until process exit, so a queued
        // timer signal cannot hit SIG_DFL after the diagnostic session ends.
        using Key=std::tuple<unsigned,unsigned,uintptr_t,uintptr_t>;
        std::map<Key,uint64_t> hist;
        const unsigned n=count.load(), cap=std::min(n,CAP); unsigned pending=0; uint64_t overruns=0;
        for (unsigned i=0;i<cap;++i) {
            auto &r=rows[i]; if (!r.ready.load(std::memory_order_acquire)) { ++pending; continue; }
            ++hist[Key(r.phase,r.tid,r.pc,r.lr)]; overruns+=r.overrun;
        }
        dl_iterate_phdr(maps,nullptr);
        for (const auto &p:hist) fprintf(stderr,"CPU_PC %u %u %llx %llx %llu\n",
            std::get<0>(p.first),std::get<1>(p.first),(unsigned long long)std::get<2>(p.first),
            (unsigned long long)std::get<3>(p.first),(unsigned long long)p.second);
        fprintf(stderr,"CPU_SAMPLE end recorded=%u dropped=%u pending=%u overruns=%llu\n",cap,n-cap,pending,(unsigned long long)overruns);
    }
    ~Session() { finish(); }
};
}
#endif
