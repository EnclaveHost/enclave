/* The buffered phase trace must survive normal process exit.
 *
 * The first version kept records in a function-local static vector and
 * registered atexit(flush) from a different static initialiser. Exit handlers
 * and static destructors run in reverse order, the vector was constructed
 * second, and so it was destroyed before the flush read it: heap-use-after-free
 * on every normal exit. This mirrors the shipped structure and must run clean
 * under ASan on a NORMAL exit path, not on abort.
 */
#include <cstdio>
#include <cstdint>
#include <cstdlib>
#include <mutex>
#include <vector>

struct rec { int card; double t; uint64_t graphs; };
struct state { std::vector<rec> v; std::mutex mu; uint64_t dropped = 0; };
static state *st_get() {
    static state *st = [] { auto *p = new state(); p->v.reserve(64); return p; }();
    return st;   /* leaked on purpose: valid through exit handlers */
}
static void push(int card, double t, uint64_t g) {
    state *st = st_get();
    std::lock_guard<std::mutex> lk(st->mu);
    if (st->v.size() < st->v.capacity()) st->v.push_back({card, t, g});
    else st->dropped++;
}
static void flush() {
    state *st = st_get();
    std::lock_guard<std::mutex> lk(st->mu);
    uint64_t n = 0;
    for (const auto &r : st->v) n += r.graphs;      /* touches every record at exit */
    printf("  flushed %zu records, dropped %llu, checksum %llu\n",
           st->v.size(), (unsigned long long)st->dropped, (unsigned long long)n);
}
static bool enabled() {
    static const bool on = [] { st_get(); atexit(flush); return true; }();
    return on;
}

int main() {
    if (enabled()) {
        for (int i = 0; i < 100; i++) push(i & 1, i * 0.5, (uint64_t)i);   /* 64 fit, 36 drop */
    }
    printf("  main done; flush runs after this on normal exit\n");
    return 0;                     /* NORMAL exit: the path that was broken */
}
