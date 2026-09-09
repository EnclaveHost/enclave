// Host fixture for anchor_bench_records.h: formats a 3-trial capture exactly as the engine would (same code), checks the
// oversized guard, null counters and escaping, and writes the capture for the repeat parser. Exit 0 = self-checks pass.
#include "anchor_bench_records.h"
#include <cstdio>
#include <cstdlib>
#include <string>
static int fails = 0; static void check(bool ok, const char *w) { if (!ok) { fails++; printf("FAIL %s\n", w); } }
int main(int argc, char **argv) {
    if (argc < 4) { printf("usage: out.log model_sha calib_sha\n"); return 2; }
    FILE *f = fopen(argv[1], "w"); if (!f) return 2;
    anchor_bench_session s; s.trials = 3; s.model_sha256 = argv[2]; s.calib_digest = argv[3]; s.model_authentication = "catalog-v1"; s.source_catalog_sha256 = argv[2]; s.encoded_catalog_sha256 = ""; s.target_bytes = 1048576; s.head_bytes = 65536; s.pending_bytes = 4096;
    s.snapshot_ms = 12.345; s.prompt_observe_us = 2500; s.n_past = 5; s.first_token = 12; s.prompt_tokens = 5; s.prefill_ms = 900.5; s.mtp_requested_k = 15; s.mtp_k_effective = 15; s.mtp_fallback = "";
    s.have_stats = true; s.have_pads = true; s.n_predict = 128; s.draft_ahead = 1; s.threads = 4; s.threads_batch = 4; s.head_threads = 2; s.cpu_poll = "unset"; s.arm_tuned = "unset"; s.stream_min_bytes = "unset";
    std::string line = anchor_bench_session_json(s); check(anchor_bench_fits(line), "session fits"); fprintf(f, "VSOCK %s\n", line.c_str());
    anchor_bench_counters c = {true, true, 1000, 10, 5000000000ull, 0, 200, 0};
    const std::string text = " Paris.\n\"The\" capital of Germany is Berlin.\t\x01" "end";   /* quotes, newline, tab, a control byte (split literal: \x01e would be one escape) */
    const char *sha = "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";   /* placeholder: the parser checks the digest of the escaped-then-decoded text, so the fixture runner supplies the right one */
    for (int t = 1; t <= 3; t++) {
        line = anchor_bench_begin_json(t, t == 1 ? 0 : 3100, anchor_bench_counters_json(c)); check(anchor_bench_fits(line), "begin fits"); fprintf(f, "VSOCK %s\n", line.c_str());
        c.offloaded += 2400; c.macs += 12000000000ull; c.pads_used += 300;
        anchor_bench_result r; r.trial = t; r.status = "budget"; r.mtp_fallback = ""; r.generated = 128; r.decode_us = 5500000; r.steady_us = 5200000; r.steady_tokens = 126; r.rounds = 9; r.drafted = 135; r.accepted = 118; r.emitted = 127;
        r.text_sha256 = argc > 4 ? argv[4] : sha; r.completion = text; r.counters_after = anchor_bench_counters_json(c);
        line = anchor_bench_result_json(r); check(anchor_bench_fits(line), "result fits"); fprintf(f, "VSOCK %s\n", line.c_str());
    }
    line = anchor_bench_end_json(3, 3, "complete", true, true, 384, false); check(anchor_bench_fits(line), "end fits"); fprintf(f, "VSOCK %s\n", line.c_str()); fclose(f);
    /* guards and escaping */
    anchor_bench_result big; big.trial = 1; big.status = "budget"; big.mtp_fallback = ""; big.generated = 2000; big.decode_us = 1; big.steady_us = 0; big.steady_tokens = 0; big.rounds = big.drafted = big.accepted = big.emitted = 0; big.text_sha256 = sha; big.completion = std::string(5000, 'x'); big.counters_after = anchor_bench_counters_json(c);
    check(!anchor_bench_fits(anchor_bench_result_json(big)), "oversized result refused by the guard");
    anchor_bench_counters none = {false, true, 0, 0, 0, 0, 0, 0}; check(anchor_bench_counters_json(none) == "null", "unavailable counters -> null, not zeroes");
    check(anchor_bench_escape("a\"b\\c\nd\x01") == "a\\\"b\\\\c\\nd\\u0001", "escape");
    /* internal snprintf truncation: an oversized metadata string in the session must yield the sentinel, never a cut record */
    anchor_bench_session huge = s; huge.stream_min_bytes = std::string(3000, 'x'); check(!anchor_bench_fits(anchor_bench_session_json(huge)), "oversized session metadata refused");
    anchor_bench_session model_long = s; model_long.model_sha256 = std::string(1500, 'f'); check(!anchor_bench_fits(anchor_bench_session_json(model_long)), "oversized identity refused");
    /* extreme numerics still format within their buffers and fit */
    anchor_bench_counters ext = {true, true, ~0ull, ~0ull, ~0ull, ~0ull, ~0ull, ~0ull}; std::string cj = anchor_bench_counters_json(ext); check(anchor_bench_fits(cj) && cj.find("18446744073709551615") != std::string::npos, "extreme counters");
    anchor_bench_session xs = s; xs.trials = ~0ull; xs.target_bytes = ~(size_t)0; xs.head_bytes = ~(size_t)0; xs.pending_bytes = ~(size_t)0; xs.snapshot_ms = 1e12; xs.prefill_ms = 1e12; xs.prompt_observe_us = 0x7fffffffffffffffL; xs.n_past = 0x7fffffff; xs.first_token = -0x7fffffff; xs.prompt_tokens = 0x7fffffff;
    check(anchor_bench_fits(anchor_bench_session_json(xs)), "extreme (but representable) session numerics fit");
    anchor_bench_session absurd = s; absurd.snapshot_ms = 1e300; absurd.prefill_ms = 1e300;   /* ~600 digits of %.3f would overflow the 1 KiB buffer: REFUSED, never cut */
    check(!anchor_bench_fits(anchor_bench_session_json(absurd)), "absurd doubles are refused by the internal-truncation check");
    anchor_bench_result xr = big; xr.completion = ""; xr.decode_us = 0x7fffffffffffffffL; xr.steady_us = 0x7fffffffffffffffL; xr.generated = 0x7fffffff; xr.steady_tokens = 0x7fffffff; xr.rounds = xr.drafted = xr.accepted = xr.emitted = 0x7fffffff; xr.counters_after = cj;
    check(anchor_bench_fits(anchor_bench_result_json(xr)), "extreme result numerics fit");
    check(anchor_bench_fits(anchor_bench_end_json(~0ull, ~0ull, "incomplete", false, false, ~0ull, true)), "extreme end numerics fit");
    check(!anchor_bench_fits(anchor_bench_end_json(1, 1, std::string(5000, 'r').c_str(), true, true, 1, false)), "oversized end reason refused");
    printf("{\"self_checks\":%s}\n", fails ? "FAIL" : "PASS"); return fails ? 1 : 0;
}
