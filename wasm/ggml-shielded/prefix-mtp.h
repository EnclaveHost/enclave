#pragma once

#include "prefix-kv.h"
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <cmath>
#include <limits>

/* ENPMTP01 is a compound PUBLIC-prefix artifact. Its entire byte stream is
 * signed by the existing v2 sidecar (model + calibration + text + count).
 * Open only an authenticated private snapshot. The 64-byte LE header holds:
 * magic[8], header_size:u32, embd:u32, tokens:u64, target_size:u64,
 * head_size:u64, pending_size:u64, reserved_zero[16]. Payloads are target
 * sequence FILE bytes, zero padding to 8, head sequence FILE bytes, zero
 * padding to 8, and embd IEEE float32 values in LE order. No trailing bytes.
 * Memory-state envelopes are NOT sequence files and are refused here. */
struct sh_prefix_mtp_view {
    // BORROWED views: load_snapshot may consume their headers. Never free
    // these separately; free only the original authenticated snapshot.
    sh_prefix_kv_snapshot target{}, head{};
    const uint8_t *pending = nullptr;
    size_t n_embd = 0;
};
static inline uint32_t sh_pmtp_u32(const uint8_t *p) {
    return uint32_t(p[0]) | uint32_t(p[1]) << 8 | uint32_t(p[2]) << 16 | uint32_t(p[3]) << 24;
}
static inline uint64_t sh_pmtp_u64(const uint8_t *p) {
    return uint64_t(sh_pmtp_u32(p)) | uint64_t(sh_pmtp_u32(p + 4)) << 32;
}
static inline void sh_pmtp_put32(uint8_t *p, uint32_t v) {
    for (int i = 0; i < 4; i++) p[i] = uint8_t(v >> (8 * i));
}
static inline void sh_pmtp_put64(uint8_t *p, uint64_t v) {
    for (int i = 0; i < 8; i++) p[i] = uint8_t(v >> (8 * i));
}
static inline int sh_prefix_mtp_open(sh_prefix_kv_snapshot *snapshot, int32_t expected_embd,
        uint32_t sequence_magic, uint32_t sequence_version, int32_t vocab_size,
        sh_prefix_mtp_view *out, char *err, size_t err_cap) {
    if (out) *out = {};
    auto refuse = [&](const char *why) { std::snprintf(err, err_cap, "MTP prefix: %s", why); return -1; };
    if (!snapshot || !snapshot->bytes || snapshot->size < 64 || !out || expected_embd <= 0)
        return refuse("missing or short container");
    uint8_t *p = snapshot->bytes;
    if (std::memcmp(p, "ENPMTP01", 8) || sh_pmtp_u32(p + 8) != 64)
        return refuse("container magic/version/header size mismatch");
    const uint32_t embd = sh_pmtp_u32(p + 12);
    const uint64_t tokens = sh_pmtp_u64(p + 16), target_size = sh_pmtp_u64(p + 24),
                   head_size = sh_pmtp_u64(p + 32), pending_size = sh_pmtp_u64(p + 40);
    if (embd != uint32_t(expected_embd) || pending_size != uint64_t(embd) * 4)
        return refuse("pending row dimension mismatch");
    if (!tokens || tokens != snapshot->n_tokens) return refuse("signed token count mismatch");
    for (size_t i = 48; i < 64; i++) if (p[i]) return refuse("nonzero reserved header");
    sh_prefix_mtp_view view;
    size_t offset = 64;
    auto sequence = [&](uint64_t n, sh_prefix_kv_snapshot &part) {
        if (!n || n > snapshot->size - offset) return false;
        part = {p + offset, size_t(n), tokens}; offset += size_t(n);
        const size_t pad = (8 - offset % 8) % 8;
        if (pad > snapshot->size - offset) return false;
        for (size_t i = 0; i < pad; i++) if (p[offset + i]) return false;
        offset += pad; return true;
    };
    if (!sequence(target_size, view.target) || !sequence(head_size, view.head))
        return refuse("sequence length or padding invalid");
    if (pending_size != snapshot->size - offset) return refuse("pending length or trailing bytes invalid");
    view.pending = p + offset; view.n_embd = embd;
    for (size_t i = 0; i < embd; i++)
        if ((sh_pmtp_u32(view.pending + i * 4) & 0x7f800000u) == 0x7f800000u)
            return refuse("nonfinite pending row");
    const uint8_t *body = nullptr; size_t body_size = 0;
    if (sh_prefix_kv_snapshot_state(&view.target, sequence_magic, sequence_version, vocab_size,
                                   &body, &body_size, err, err_cap) ||
        sh_prefix_kv_snapshot_state(&view.head, sequence_magic, sequence_version, vocab_size,
                                   &body, &body_size, err, err_cap)) return -1;
    // Both snapshots describe the exact same committed prefix tokens.
    if (std::memcmp(view.target.bytes + 12, view.head.bytes + 12, size_t(tokens) * 4))
        return refuse("target and head token vectors differ");
    *out = view; return 0;
}
static inline int sh_prefix_mtp_pending(const sh_prefix_mtp_view *view, float *out, size_t n) {
    static_assert(sizeof(float) == 4 && std::numeric_limits<float>::is_iec559, "IEEE float32 required");
    if (!view || !view->pending || !out || n != view->n_embd) return -1;
    // Validate before writing, including callers that modified a borrowed view.
    for (size_t i = 0; i < n; i++)
        if ((sh_pmtp_u32(view->pending + i * 4) & 0x7f800000u) == 0x7f800000u) return -1;
    for (size_t i = 0; i < n; i++) {
        const uint32_t bits = sh_pmtp_u32(view->pending + i * 4);
        std::memcpy(out + i, &bits, 4);
    }
    return 0;
}

/* Trusted publisher: write a compound file, then sh_prefix_kv_sign_v2 it.
 * Inputs must be snapshots of the same public prefix after head observe.
 * This writes no signature and makes no claim about durable publication. */
static inline int sh_prefix_mtp_write(const char *path, const sh_prefix_kv_snapshot *target,
        const sh_prefix_kv_snapshot *head, const float *pending, size_t n_embd,
        char *err, size_t err_cap) {
    auto refuse = [&](const char *why) { std::snprintf(err, err_cap, "MTP prefix: %s", why); return -1; };
    if (!path || !target || !head || !target->bytes || !head->bytes || !target->size || !head->size ||
        !target->n_tokens || target->n_tokens != head->n_tokens || !pending || !n_embd || n_embd > INT32_MAX)
        return refuse("invalid publisher inputs");
    for (size_t i = 0; i < n_embd; i++) if (!std::isfinite(pending[i])) return refuse("nonfinite pending row");
    // Bound arithmetic before calculating offsets or opening the output.
    const uint64_t cap = uint64_t(INT64_MAX);
    if (target->size > cap - 71) return refuse("target too large");
    const uint64_t first_end = (64 + uint64_t(target->size) + 7) & ~uint64_t(7);
    if (head->size > cap - first_end - 7) return refuse("head too large");
    const uint64_t second_end = (first_end + uint64_t(head->size) + 7) & ~uint64_t(7);
    if (uint64_t(n_embd) * 4 > cap - second_end) return refuse("container too large");
    uint8_t header[64] = {}; std::memcpy(header, "ENPMTP01", 8);
    sh_pmtp_put32(header + 8, 64); sh_pmtp_put32(header + 12, uint32_t(n_embd));
    sh_pmtp_put64(header + 16, target->n_tokens); sh_pmtp_put64(header + 24, target->size);
    sh_pmtp_put64(header + 32, head->size); sh_pmtp_put64(header + 40, uint64_t(n_embd) * 4);
    FILE *f = std::fopen(path, "wb"); if (!f) return refuse("cannot create compound file");
    const uint8_t zero[8] = {};
    auto write = [&](const void *p, size_t n) { return std::fwrite(p, 1, n, f) == n; };
    bool ok = write(header, sizeof header) && write(target->bytes, target->size) &&
        write(zero, size_t(first_end - 64 - target->size)) && write(head->bytes, head->size) &&
        write(zero, size_t(second_end - first_end - head->size));
    for (size_t i = 0; ok && i < n_embd; i++) {
        uint32_t bits; uint8_t le[4]; std::memcpy(&bits, pending + i, 4); sh_pmtp_put32(le, bits); ok = write(le, 4);
    }
    if (std::fflush(f) != 0) ok = false;
    if (std::fclose(f) != 0) ok = false;
    return ok ? 0 : refuse("cannot write complete compound file");
}
