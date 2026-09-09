#ifndef ANCHOR_BENCH_RECORDS_H
#define ANCHOR_BENCH_RECORDS_H
/* BENCH v1 record formatting for the in-session repeat trials (BENCH.md). Pure C++ (no llama/ggml/android), so the host
 * fixture formats byte-exact records with the SAME code the engine emits and runs the repeat parser on them. Every
 * function returns one complete line including the `BENCH v1 ` prefix and no newline. The engine's outf() holds a
 * 4096-byte line and truncates silently, so anchor_bench_fits() is the guard: a record that does not fit is REFUSED as
 * a terminal failure, never emitted truncated. Counters (FROZEN rev-3 flat schema): ONE object
 * {"offloaded_nodes","local_nodes","macs","gmac","verify_fail","pads_used","pads_missed"} or the JSON literal null when
 * either counter source is unavailable - never zeroes. */
#include <cstdint>
#include <cstdio>
#include <string>

#define ANCHOR_BENCH_LINE_MAX 4000u   /* outf: 4096 - '\n' - NUL, with margin */

static inline std::string anchor_bench_escape(const std::string &in) {
    std::string o; o.reserve(in.size() + 8); char hex[8];
    for (unsigned char c : in) {
        switch (c) {
        case '"': o += "\\\""; break; case '\\': o += "\\\\"; break; case '\n': o += "\\n"; break; case '\r': o += "\\r"; break; case '\t': o += "\\t"; break;
        default: if (c < 0x20) { snprintf(hex, sizeof hex, "\\u%04x", c); o += hex; } else o += (char)c;
        }
    }
    return o;
}
struct anchor_bench_counters { bool have_stats, have_pads; uint64_t offloaded, local, macs, verify_fail, pads_used, pads_missed; };
static inline std::string anchor_bench_counters_json(const anchor_bench_counters &c) {
    if (!c.have_stats || !c.have_pads) return "null";
    char b[320];
    snprintf(b, sizeof b, "{\"offloaded_nodes\":%llu,\"local_nodes\":%llu,\"macs\":%llu,\"gmac\":%.3f,\"verify_fail\":%llu,\"pads_used\":%llu,\"pads_missed\":%llu}",
             (unsigned long long)c.offloaded, (unsigned long long)c.local, (unsigned long long)c.macs, c.macs / 1e9, (unsigned long long)c.verify_fail, (unsigned long long)c.pads_used, (unsigned long long)c.pads_missed);
    return b;
}
struct anchor_bench_session {
    uint64_t trials; std::string model_sha256, calib_digest; size_t target_bytes, head_bytes, pending_bytes; double snapshot_ms; long prompt_observe_us;
    int n_past, first_token, prompt_tokens; double prefill_ms; int mtp_requested_k, mtp_k_effective; std::string mtp_fallback; bool have_stats, have_pads;
    int n_predict, draft_ahead, threads, threads_batch, head_threads; std::string cpu_poll, arm_tuned, stream_min_bytes;
};
static inline std::string anchor_bench_session_json(const anchor_bench_session &s) {
    char b[1024];
    snprintf(b, sizeof b, "BENCH v1 {\"record\":\"session\",\"trials\":%llu,\"model_sha256\":\"%s\",\"calib_digest\":\"%s\",\"snapshot_bytes\":{\"target\":%zu,\"head\":%zu,\"pending\":%zu},\"snapshot_ms\":%.3f,\"prompt_observe_us\":%ld,"
             "\"n_past\":%d,\"first_token\":%d,\"prompt_tokens\":%d,\"prefill_ms\":%.3f,\"mtp_requested_k\":%d,\"mtp_fallback\":\"%s\",\"counters_available\":{\"stats\":%s,\"pads\":%s},",
             (unsigned long long)s.trials, anchor_bench_escape(s.model_sha256).c_str(), anchor_bench_escape(s.calib_digest).c_str(), s.target_bytes, s.head_bytes, s.pending_bytes, s.snapshot_ms, s.prompt_observe_us,
             s.n_past, s.first_token, s.prompt_tokens, s.prefill_ms, s.mtp_requested_k, anchor_bench_escape(s.mtp_fallback).c_str(), s.have_stats ? "true" : "false", s.have_pads ? "true" : "false");
    std::string r = b;
    snprintf(b, sizeof b, "\"settings\":{\"n_predict\":%d,\"mtp_k\":%d,\"draft_ahead\":%d,\"threads\":%d,\"threads_batch\":%d,\"head_threads\":%d,\"cpu_poll\":\"%s\",\"arm_tuned\":\"%s\",\"stream_min_bytes\":\"%s\"},\"not_restored\":\"pads,seed,spent indices,receipts,verification state\"}",
             s.n_predict, s.mtp_k_effective, s.draft_ahead, s.threads, s.threads_batch, s.head_threads, anchor_bench_escape(s.cpu_poll).c_str(), anchor_bench_escape(s.arm_tuned).c_str(), anchor_bench_escape(s.stream_min_bytes).c_str());
    return r + b;
}
static inline std::string anchor_bench_begin_json(uint64_t trial, long restore_us, const std::string &counters) {
    char b[128]; snprintf(b, sizeof b, "BENCH v1 {\"record\":\"begin\",\"trial\":%llu,\"restore_us\":%ld,\"counters_before\":", (unsigned long long)trial, restore_us);
    return std::string(b) + counters + "}";
}
struct anchor_bench_result {
    uint64_t trial; std::string status, mtp_fallback; int generated; long decode_us; long steady_us; int steady_tokens;
    int rounds, drafted, accepted, emitted; std::string text_sha256, completion; std::string counters_after;
};
static inline std::string anchor_bench_result_json(const anchor_bench_result &r) {
    char b[512];
    snprintf(b, sizeof b, "BENCH v1 {\"record\":\"result\",\"trial\":%llu,\"status\":\"%s\",\"mtp_fallback\":\"%s\",\"generated\":%d,\"decode_us\":%ld,\"decode_tokens\":%d,\"steady_us\":%ld,\"steady_tokens\":%d,"
             "\"mtp\":{\"rounds\":%d,\"drafted\":%d,\"accepted\":%d,\"emitted\":%d},\"text_sha256\":\"%s\",\"completion\":\"",
             (unsigned long long)r.trial, anchor_bench_escape(r.status).c_str(), anchor_bench_escape(r.mtp_fallback).c_str(), r.generated, r.decode_us, r.generated, r.steady_us, r.steady_tokens,
             r.rounds, r.drafted, r.accepted, r.emitted, anchor_bench_escape(r.text_sha256).c_str());
    return std::string(b) + anchor_bench_escape(r.completion) + "\",\"counters_after\":" + r.counters_after + "}";
}
static inline std::string anchor_bench_end_json(uint64_t trials, uint64_t completed, const char *reason, bool identical_text, bool identical_mtp, uint64_t generated_total, bool any_failed) {
    char b[320];
    snprintf(b, sizeof b, "BENCH v1 {\"record\":\"end\",\"trials\":%llu,\"completed\":%llu,\"reason\":\"%s\",\"identical_text\":%s,\"identical_mtp\":%s,\"generated_total\":%llu,\"any_failed\":%s}",
             (unsigned long long)trials, (unsigned long long)completed, anchor_bench_escape(reason).c_str(), identical_text ? "true" : "false", identical_mtp ? "true" : "false", (unsigned long long)generated_total, any_failed ? "true" : "false");
    return b;
}
static inline bool anchor_bench_fits(const std::string &line) { return line.size() <= ANCHOR_BENCH_LINE_MAX; }
#endif
