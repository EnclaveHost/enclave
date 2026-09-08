#pragma once

#include <set>
#include <sstream>
#include <string>

/* Opt-in placement for a calibration shared by the APK and dealer. Keep every
 * member of a calibrated activation group in ordinary q8 rows, allowing local
 * weights to use CPU_REPACK. These aliases must agree with sh_group_key().
 * This chooses storage layout only; supports_op still enforces calibration,
 * masking and verification before any operation can leave the trusted VM. */
static inline bool anchor_placement_pattern(const std::string &calibration,
                                          const char *local_sites,
                                          std::string &pattern,
                                          size_t &pinned_count,
                                          std::string &error) {
    pattern.clear(); pinned_count = 0; error.clear();
    std::set<std::string> local, pins;
    std::istringstream local_stream(local_sites ? local_sites : "");
    for (std::string name; std::getline(local_stream, name, ',');) local.insert(name);
    std::istringstream lines(calibration);
    std::string line;
    if (!std::getline(lines, line) || (line != "# shielded-calib 2" && line != "# shielded-calib 1")) {
        error = "missing supported calibration version"; return false;
    }
    while (std::getline(lines, line)) {
        std::istringstream fields(line);
        std::string tag, name;
        if (!(fields >> tag) || tag[0] == '#') continue;
        int af = 0, outliers = 0;
        if (tag != "site" || !(fields >> name >> af >> outliers) || outliers < 0 || name.size() > 127 ||
            name.size() < 8 || name.compare(name.size() - 7, 7, ".weight") != 0) {
            error = "malformed calibration site"; return false;
        }
        for (unsigned char c : name) {
            if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '.' || c == '_')) {
                error = "noncanonical calibration name"; return false;
            }
        }
        std::set<std::string> members{name};
        const size_t component = name.rfind('.', name.size() - 8);
        const size_t begin = component == std::string::npos ? 0 : component + 1;
        const std::string family = name.substr(begin, name.size() - 7 - begin);
        const auto add = [&](const char *member) {
            members.insert(name.substr(0, begin) + member + ".weight");
        };
        if (family == "attn_q") { add("attn_k"); add("attn_v"); }
        else if (family == "ffn_gate") add("ffn_up");
        else if (family == "attn_qkv") {
            add("attn_gate"); add("ssm_alpha"); add("ssm_beta"); add("ssm_ba");
        }
        if (!local.count(name)) {
            for (const auto &member : members) if (!local.count(member)) pins.insert(member);
        }
    }
    if (pins.empty()) { error = "no offloadable calibration sites"; return false; }
    pattern = "^(";
    for (const auto &name : pins) {
        if (pinned_count++) pattern += '|';
        for (char c : name) { if (c == '.') pattern += '\\'; pattern += c; }
    }
    pattern += ")$";
    return true;
}
