#include "anchor_placement.h"
#include <cassert>
#include <fstream>
#include <iostream>
#include <iterator>
#include <regex>

int main(int argc, char **argv) {
    assert(argc == 3);
    std::ifstream file(argv[1]);
    std::string input((std::istreambuf_iterator<char>(file)), {}), pattern, error;
    size_t count;
    assert(anchor_placement_pattern(input, "token_embd.weight", pattern, count, error));
    std::regex re(pattern);
    const auto pinned = [&](const std::string &name) { return std::regex_match(name, re); };
    const bool ffn_only = std::string(argv[2]) == "gpu-ffn";
    for (int layer = 0; layer < 24; ++layer) {
        const std::string prefix = "blk." + std::to_string(layer) + ".";
        assert(pinned(prefix + "ffn_gate.weight"));
        assert(pinned(prefix + "ffn_up.weight"));
        for (const char *site : {"ffn_down", "ssm_out", "attn_output", "attn_norm", "ffn_norm"})
            assert(!pinned(prefix + site + ".weight"));
        const bool full_attn = layer % 4 == 3;
        for (const char *site : {"attn_q", "attn_k", "attn_v"})
            assert(pinned(prefix + site + ".weight") == (!ffn_only && full_attn));
        for (const char *site : {"attn_qkv", "attn_gate", "ssm_alpha", "ssm_beta", "ssm_ba"})
            assert(pinned(prefix + site + ".weight") == (!ffn_only && !full_attn));
    }
    for (const char *name : {"token_embd.weight", "blk.24.ffn_gate.weight", "xblk.0.ffn_gate.weight",
                             "blkX0Xffn_gateXweight", "blk.0.ffn_gate.weight.extra"}) assert(!pinned(name));
    assert(count == (ffn_only ? 48 : 156));
    assert(anchor_placement_pattern("# shielded-calib 2\nsite blk.0.attn_q.weight 8 0\n", "blk.0.attn_k.weight", pattern, count, error));
    std::regex partial(pattern);
    assert(std::regex_match("blk.0.attn_v.weight", partial));
    assert(!std::regex_match("blk.0.attn_k.weight", partial));
    for (const char *bad : {"", "# shielded-calib 3\n", "# shielded-calib 2\nsite evil.*.weight 8 0\n",
                            "# shielded-calib 2\nsite blk.0.ffn_gate.weight 8 -1\n"}) {
        assert(!anchor_placement_pattern(bad, nullptr, pattern, count, error));
        assert(pattern.empty());
    }
    std::cout << "anchor-placement: ok\n";
}
