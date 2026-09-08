#include "prefix-mtp.h"
#include "shielded-pads.h"
extern "C" {
#include "tweetnacl.h"
}
#include <cassert>
#include <vector>
#include <string>
#include <fcntl.h>
#include <unistd.h>

int main(int argc, char **argv) {
    assert(argc == 2);
    const uint32_t magic = 0x71736767, version = 2;
    uint8_t target_bytes[23] = {}, head_bytes[25] = {};
    for (uint8_t *p : {target_bytes, head_bytes}) {
        sh_pmtp_put32(p, magic); sh_pmtp_put32(p + 4, version); sh_pmtp_put32(p + 8, 2);
        sh_pmtp_put32(p + 12, 7); sh_pmtp_put32(p + 16, 11); p[20] = 123;
    }
    sh_prefix_kv_snapshot target{target_bytes, sizeof target_bytes, 2}, head{head_bytes, sizeof head_bytes, 2};
    float pending[] = {1.5f, -2.25f, 0.f, 0.125f}; char err[256];
    const std::string path = std::string(argv[1]) + "/prefix.mtp";
    assert(sh_prefix_mtp_write(path.c_str(), &target, &head, pending, 4, err, sizeof err) == 0);
    uint8_t pk[32], sk[64], model[32] = {1}, calib[32] = {2}; crypto_sign_keypair(pk, sk);
    assert(sh_prefix_kv_sign_v2(path.c_str(), model, calib, "prefix", 6, 2, sk, err, sizeof err) == 0);
    int fd = open(path.c_str(), O_RDONLY); assert(fd >= 0);
    sh_prefix_kv_snapshot snap{};
    assert(sh_prefix_kv_snapshot_read_v2(path.c_str(), fd, pk, model, calib, "prefix", 6, 1000, 2, &snap, err, sizeof err) == 0);
    close(fd);
    sh_prefix_mtp_view view;
    assert(sh_prefix_mtp_open(&snap, 4, magic, version, 12, &view, err, sizeof err) == 0);
    assert(view.target.size == sizeof target_bytes && view.head.size == sizeof head_bytes);
    assert(!memcmp(view.target.bytes, target_bytes, sizeof target_bytes));
    assert(!memcmp(view.head.bytes, head_bytes, sizeof head_bytes));
    float got[4] = {};
    assert(sh_prefix_mtp_pending(&view, got, 4) == 0 && !memcmp(got, pending, sizeof got));
    assert(sh_prefix_mtp_pending(&view, got, 3) != 0);
    const std::vector<uint8_t> good(snap.bytes, snap.bytes + snap.size);
    const size_t head_at = size_t(view.head.bytes - snap.bytes), pending_at = size_t(view.pending - snap.bytes);
    // Each segment is inside the SAME signature, including target, head and pending state.
    for (size_t at : {size_t(0), size_t(64 + 20), head_at + 20, pending_at}) {
        fd = open(path.c_str(), O_WRONLY); assert(fd >= 0);
        const uint8_t changed = good[at] ^ 1; assert(pwrite(fd, &changed, 1, at) == 1); close(fd);
        fd = open(path.c_str(), O_RDONLY); assert(fd >= 0); sh_prefix_kv_snapshot refused{};
        assert(sh_prefix_kv_snapshot_read_v2(path.c_str(), fd, pk, model, calib, "prefix", 6, 1000, 2, &refused, err, sizeof err) != 0);
        assert(!refused.bytes); close(fd);
        fd = open(path.c_str(), O_WRONLY); assert(fd >= 0); assert(pwrite(fd, &good[at], 1, at) == 1); close(fd);
    }
    // Even authenticated publisher mistakes must fail bounds/format checks.
    for (int mode = 0; mode < 15; mode++) {
        memcpy(snap.bytes, good.data(), good.size()); snap.size = good.size(); snap.n_tokens = 2;
        switch (mode) {
        case 0: snap.size = 63; break;
        case 1: snap.bytes[0] ^= 1; break;
        case 2: sh_pmtp_put32(snap.bytes + 8, 63); break;
        case 3: sh_pmtp_put32(snap.bytes + 12, 5); break;
        case 4: sh_pmtp_put64(snap.bytes + 16, 3); break;
        case 5: sh_pmtp_put64(snap.bytes + 24, UINT64_MAX); break;
        case 6: sh_pmtp_put64(snap.bytes + 32, UINT64_MAX); break;
        case 7: sh_pmtp_put64(snap.bytes + 40, UINT64_MAX); break;
        case 8: snap.bytes[48] = 1; break;
        case 9: snap.bytes[64 + sizeof target_bytes] = 1; break;
        case 10: snap.bytes[head_at + sizeof head_bytes] = 1; break;
        case 11: sh_pmtp_put32(snap.bytes + pending_at, 0x7fc00000); break;
        case 12: sh_pmtp_put32(snap.bytes + head_at + 12, 8); break;
        case 13: sh_pmtp_put32(snap.bytes + head_at + 8, 1); break;
        case 14: snap.size--; break;
        }
        assert(sh_prefix_mtp_open(&snap, 4, magic, version, 12, &view, err, sizeof err) != 0);
        assert(!view.target.bytes && !view.head.bytes && !view.pending);
    }
    memcpy(snap.bytes, good.data(), good.size()); snap.size = good.size();
    fd = open(path.c_str(), O_WRONLY | O_TRUNC); assert(fd >= 0); close(fd);
    assert(sh_prefix_mtp_open(&snap, 4, magic, version, 12, &view, err, sizeof err) == 0);
    assert(sh_prefix_mtp_pending(&view, got, 4) == 0 && !memcmp(got, pending, sizeof got));
    sh_prefix_kv_snapshot_free(&snap); // Never free the borrowed target/head views.
    target.n_tokens = 3;
    assert(sh_prefix_mtp_write(path.c_str(), &target, &head, pending, 4, err, sizeof err) != 0);
    target.n_tokens = 2; pending[0] = std::numeric_limits<float>::infinity();
    assert(sh_prefix_mtp_write(path.c_str(), &target, &head, pending, 4, err, sizeof err) != 0);
    unlink(path.c_str()); unlink((path + ".sig").c_str());
    puts("prefix-mtp: whole-container binding, private views and malformed lengths PASS");
}
