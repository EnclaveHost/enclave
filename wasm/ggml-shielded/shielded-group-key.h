#pragma once
#include <string>
#include <string_view>
#include <utility>

/* q/k/v come from one attn_norm and gate/up from one ffn_norm, so they share an
 * activation -- and therefore share one exponent, one outlier set and, at run
 * time, ONE PAD and ONE EXCHANGE. That is not a bandwidth optimisation: masking
 * the same x three times under three pads would hand the adversary three
 * encryptions of one value for no benefit.
 *
 * qwen35's gated-deltanet layers feed FOUR linears from one norm output:
 * attn_qkv, attn_gate, ssm_alpha and ssm_beta all read the same tensor
 * (shielded-calib reports it from the graph). Without the last three rows the
 * backend exchanged attn_qkv and attn_gate as two groups, i.e. one plaintext
 * under two pads and one exchange per layer more than needed. A name that
 * matches here but whose model has no attn_qkv simply finds no calibration and
 * stays in the enclave. */
static inline std::string sh_group_key(std::string_view name) {
    static constexpr std::pair<std::string_view, std::string_view> members[] = {
        { "attn_k",    "attn_q" },   { "attn_v",    "attn_q" },
        { "ffn_up",    "ffn_gate" },
        { "attn_gate", "attn_qkv" }, { "ssm_alpha", "attn_qkv" }, { "ssm_beta", "attn_qkv" },
        { "ssm_ba",    "attn_qkv" },   /* qwen3next: the same norm output */
    };
    for (const auto &m : members) {
        const size_t p = name.find(m.first);
        if (p != std::string_view::npos) {
            // Borrow the input only during this call. The returned key owns
            // its bytes, with room for a longer alias before anything is copied.
            std::string out;
            out.reserve(name.size() - m.first.size() + m.second.size());
            out.append(name.substr(0, p));
            out.append(m.second);
            out.append(name.substr(p + m.first.size()));
            return out;
        }
    }
    return std::string(name);
}
