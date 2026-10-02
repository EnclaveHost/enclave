#include "../../wasm/ggml-shielded/shielded-group-key.h"
#include <cassert>

int main() {
    const std::pair<const char *, const char *> cases[] = {
        {"", ""}, {"token_embd.weight", "token_embd.weight"},
        {"attn_output", "attn_output"}, {"attn_q", "attn_q"},
        {"attn_k", "attn_q"}, {"attn_v", "attn_q"},
        {"ffn_up", "ffn_gate"}, {"ffn_gate", "ffn_gate"},
        {"attn_gate", "attn_qkv"}, {"ssm_alpha", "attn_qkv"},
        {"ssm_beta", "attn_qkv"}, {"ssm_ba", "attn_qkv"},
        // Preserve ordered, first-occurrence substring replacement, including
        // names outside the usual model naming convention.
        {"attn_k_attn_k", "attn_q_attn_k"},
        {"ffn_up_attn_k", "ffn_up_attn_q"},
        {"ssm_ba_ssm_beta", "ssm_ba_attn_qkv"},
        {"prefix_attn_gate_suffix", "prefix_attn_qkv_suffix"},
        {"ssm_bar", "attn_qkvr"}, {"ATTN_K", "ATTN_K"},
    };
    for (const auto &c : cases) {
        assert(sh_group_key(c.first) == c.second);
        for (size_t length : {size_t(0), size_t(15), size_t(16), size_t(127), size_t(512), size_t(4096)}) {
            const std::string prefix = "blk." + std::string(length, '3') + ".";
            std::string name = prefix + c.first + ".weight";
            const std::string expected = prefix + c.second + ".weight";
            const std::string key = sh_group_key(name);
            assert(key == expected);
            name.assign(name.size(), 'x'); // Returned keys must retain owned bytes.
            assert(key == expected);
        }
    }
    const std::string bounded = "!ffn_up?attn_k";
    assert(sh_group_key(std::string_view(bounded).substr(1, 6)) == "ffn_gate");
    const std::string nul("x\0ffn_up", 8), expected("x\0ffn_gate", 10);
    assert(sh_group_key(nul) == expected);
}
