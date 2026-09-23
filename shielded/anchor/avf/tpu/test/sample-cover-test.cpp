// sample-cover-test.cpp -- the verification and self-check samplers cover what they claim, on the REAL E2B geometry
// (tpu/test/e2b-geometry.txt: 140 exchange groups read from the shipped bundle), and the old global-counter sampler
// they replace fails the same checks (REPORT 18.38-18.40: a deterministic sampler over a periodic schedule samples a
// fixed phase unless it is stratified by the finest unit it means to cover).
//
// Checks, for the sampler in payload/tpu_sample.h driven exactly as ggml-tpu.cpp drives it (one visit per group per
// pass, the group order of a pass, rows varying per pass):
//   1. every (group, rows) cell is self-checked on its first visit, and every cell past the period is checked
//      periodically (ceil(visits/period) times, counting the first);
//   2. self-checks land on all four kinds;
//   3. after n_out visits, every output of every projection has been verified exactly once;
//   4. two VMs (different randomness) verify different outputs on the same visit (the order is not public);
//   5. init refuses a zero width; widths of 1 work; rows past the cell table clamp instead of overflowing.
// The mutant (exchanges % 16 / exchanges % n_out, what shipped before) must fail 1, 2 and 3.
#include "tpu_sample.h"
#include <cstdio>
#include <fstream>
#include <map>
#include <random>
#include <sstream>
#include <string>

struct G { int layer, kind; std::vector<uint32_t> outs; };
static int fails = 0;
static void check(const char *what, bool ok) { printf("%s %s\n", ok ? "ok  " : "FAIL", what); if (!ok) fails++; }

struct Result { bool first_all, periodic_all, all_kinds, outputs_once; size_t cells, kinds_hit; double out_frac, ever_frac; };

// mutant=true reproduces the shipped global-counter sampler
static Result simulate(const std::vector<G> &gs, uint64_t passes, bool mutant, uint64_t seed) {
    std::mt19937_64 rng(seed);
    std::vector<tpu_sampler> smp(gs.size());
    for (size_t i = 0; i < gs.size(); i++) if (!tpu_sampler_init(smp[i], gs[i].outs, [&] { return rng(); })) { check("init", false); return {}; }
    std::map<std::pair<size_t, uint32_t>, std::pair<uint64_t, uint64_t>> cell;   // (group, rows) -> visits, checks
    std::map<std::pair<size_t, uint32_t>, bool> first_checked;
    std::vector<std::vector<std::vector<uint32_t>>> hits(gs.size());
    for (size_t i = 0; i < gs.size(); i++) { hits[i].resize(gs[i].outs.size()); for (size_t p = 0; p < gs[i].outs.size(); p++) hits[i][p].assign(gs[i].outs[p], 0); }
    bool kind_hit[4] = {};
    std::mt19937_64 rows_rng(seed ^ 0x9e37);
    uint64_t exchanges = 0;
    for (uint64_t t = 0; t < passes; t++) {
        const uint32_t rows = t < 3 ? 5 : 1 + (uint32_t)(rows_rng() % 5);   // prefill passes at 5 rows, then 1..5
        for (size_t i = 0; i < gs.size(); i++) {
            tpu_sampler &s = smp[i];
            const bool chk = mutant ? (exchanges % 16) == 0 : tpu_sample_selfcheck(s, rows, 16);
            auto &c = cell[{i, rows}];
            if (c.first == 0) first_checked[{i, rows}] = chk;
            c.first++; if (chk) { c.second++; kind_hit[gs[i].kind & 3] = true; }
            for (size_t p = 0; p < gs[i].outs.size(); p++) {
                const uint32_t n = gs[i].outs[p];
                const uint32_t jv = mutant ? (uint32_t)(exchanges % n) : tpu_sample_jv(s, p, n);
                if (s.visits < n) hits[i][p][jv]++;          // only the first n visits: each output exactly once
            }
            tpu_sample_advance(s, rows); exchanges++;
        }
    }
    Result r{true, true, true, true, cell.size(), 0, 0, 0};
    for (auto &kv : first_checked) if (!kv.second) r.first_all = false;
    for (auto &kv : cell) if (kv.second.second < (kv.second.first + 15) / 16) r.periodic_all = false;   // ceil: v=0 counts
    for (bool k : kind_hit) { if (!k) r.all_kinds = false; else r.kinds_hit++; }
    uint64_t covered = 0, total = 0, ever = 0;
    for (size_t i = 0; i < gs.size(); i++) for (size_t p = 0; p < hits[i].size(); p++) {
        const uint32_t n = gs[i].outs[p]; const bool complete = passes >= n;
        for (uint32_t j = 0; j < n; j++) { if (complete) { total++; covered += hits[i][p][j] == 1; ever += hits[i][p][j] > 0; if (hits[i][p][j] != 1) r.outputs_once = false; } }
    }
    r.out_frac = total ? (double)covered / (double)total : 0; r.ever_frac = total ? (double)ever / (double)total : 0;
    return r;
}

int main(int argc, char **argv) {
    const char *path = argc > 1 ? argv[1] : "tpu/test/e2b-geometry.txt";
    std::ifstream f(path); std::string line; std::vector<G> gs;
    while (std::getline(f, line)) { if (line.empty() || line[0] == '#') continue; std::istringstream is(line); G g; is >> g.layer >> g.kind; uint32_t n; while (is >> n) g.outs.push_back(n); gs.push_back(g); }
    check("geometry has the 140 exchange groups of a pass", gs.size() == 140);
    if (gs.size() != 140) return 1;
    uint32_t maxw = 0; for (auto &g : gs) for (uint32_t n : g.outs) if (n > maxw) maxw = n;

    const Result good = simulate(gs, maxw, false, 1);          // maxw passes: every projection completes its walk
    printf("     stratified: %zu (group,rows) cells, kinds self-checked %zu/4, outputs verified exactly once %.4f\n", good.cells, good.kinds_hit, good.out_frac);
    check("every (group, rows) cell self-checked on its first visit", good.first_all);
    check("every cell checked periodically (>= ceil(visits/16))", good.periodic_all);
    check("self-checks land on all four kinds", good.all_kinds);
    check("every output of every projection verified exactly once per n_out visits", good.outputs_once);

    const Result bad = simulate(gs, maxw, true, 1);
    printf("     global-counter mutant: kinds self-checked %zu/4, outputs verified exactly once %.4f, ever verified %.4f\n", bad.kinds_hit, bad.out_frac, bad.ever_frac);
    check("mutant fails first-visit coverage", !bad.first_all);
    check("mutant fails all-kinds (it only ever checks kind 0)", !bad.all_kinds && bad.kinds_hit == 1);
    check("mutant fails output coverage (one residue mod 4)", !bad.outputs_once && bad.ever_frac < 0.26);

    // 4. the order is the VM's secret: two VMs disagree on which output they verify on most visits
    {
        std::mt19937_64 a(11), b(12); tpu_sampler sa, sb; std::vector<uint32_t> w{2048, 256, 256};
        tpu_sampler_init(sa, w, [&] { return a(); }); tpu_sampler_init(sb, w, [&] { return b(); });
        int same = 0; for (int v = 0; v < 256; v++) { same += tpu_sample_jv(sa, 0, 2048) == tpu_sample_jv(sb, 0, 2048); tpu_sample_advance(sa, 1); tpu_sample_advance(sb, 1); }
        check("two VMs' verification orders differ (<= 4 of 256 visits coincide)", same <= 4);
        check("stride is coprime to the width", tpu_gcd(sa.stride[0], 2048) == 1 && tpu_gcd(sa.stride[1], 256) == 1);
    }
    // 5. edges
    { tpu_sampler s; std::vector<uint32_t> z{0}; check("zero width refused", !tpu_sampler_init(s, z, [] { return (uint64_t)7; }) && !s.ready); }
    { tpu_sampler s; std::vector<uint32_t> one{1}; check("width 1 works", tpu_sampler_init(s, one, [] { return (uint64_t)7; }) && tpu_sample_jv(s, 0, 1) == 0); }
    { tpu_sampler s; std::vector<uint32_t> w{8}; tpu_sampler_init(s, w, [] { return (uint64_t)3; });
      tpu_sample_advance(s, 99); check("rows past the table clamp", s.row_visits[kSampleRowsCells - 1] == 1 && s.visits == 1); }
    // a constant randomness source still yields a coprime stride or a refusal, never a stride sharing a factor
    { tpu_sampler s; std::vector<uint32_t> w{6144}; const bool ok = tpu_sampler_init(s, w, [] { return (uint64_t)2047; });
      check("degenerate randomness: coprime stride or refusal", ok ? tpu_gcd(s.stride[0], 6144) == 1 : !s.ready); }
    printf(fails ? "%d failed\n" : "PASS sample-cover\n", fails);
    return fails ? 1 : 0;
}
