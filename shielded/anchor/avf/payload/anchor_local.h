/* anchor_local.h -- the owner's LOCAL line: run the whole model inside this VM (engine_local.cpp, LOCAL.md).
 *   LOCAL model_bytes=<1..2^40> threads=<1..16> ctx=<512..32768> [tpu_bundle_bytes=<1..2^40> bank=<0..4096> refill=<0..16>] [draft_bytes=<1..2^34> draft_max=<1..4>] [links=<2..4>]
 * Strict: exactly these keys in this order, canonical decimal, single spaces, nothing after. The optional tail turns on
 * Shielded-TPU decode (ggml-tpu.cpp, TPU.md): the lane bundle's size (it arrives on the bundle port) and how many pad
 * positions to mint before READY. The draft tail adds a drafter model (it arrives on the draft port; unauthenticated on
 * purpose: the target verifies every proposal) and how many tokens it proposes per step. The links tail asks
 * for extra worker connections used ONLY by the link-scaling benchmark (run_local): they carry benchmark
 * bytes, never masked rows, and are closed before decode starts, so pads, verification, ordering and
 * lifetimes are untouched by them. Pure. */
#ifndef ANCHOR_LOCAL_H
#define ANCHOR_LOCAL_H
#include <stdint.h>
#include <string.h>
typedef struct { uint64_t model_bytes; int threads, ctx; uint64_t tpu_bundle_bytes; int bank, refill; uint64_t draft_bytes; int draft_max; int links; } anchor_local_plan;
static inline int anchor_local_u64(const char **p, const char *key, uint64_t lo, uint64_t hi, uint64_t *out) {
    const size_t k = strlen(key); if (strncmp(*p, key, k)) return 0;
    const char *s = *p + k; uint64_t v = 0; int digits = 0;
    if (*s == '0' && s[1] >= '0' && s[1] <= '9') return 0;
    while (*s >= '0' && *s <= '9') { if (v > (hi / 10)) return 0; v = v * 10 + (uint64_t)(*s - '0'); s++; if (++digits > 13) return 0; }
    if (!digits || v < lo || v > hi) return 0;
    *out = v; *p = s; return 1;
}
static inline int anchor_local_parse(const char *line, anchor_local_plan *plan) {
    if (!line || strncmp(line, "LOCAL ", 6)) return 0;
    const char *p = line + 6; uint64_t b = 0, t = 0, c = 0;
    if (!anchor_local_u64(&p, "model_bytes=", 1, (uint64_t)1 << 40, &b) || *p++ != ' ') return 0;
    if (!anchor_local_u64(&p, "threads=", 1, 16, &t) || *p++ != ' ') return 0;
    if (!anchor_local_u64(&p, "ctx=", 512, 32768, &c)) return 0;
    uint64_t tb = 0, bank = 0;
    uint64_t db = 0, dm = 0, rf = 0;
    if (*p == ' ' && !strncmp(p + 1, "tpu_bundle_bytes=", 17)) { p++; if (!anchor_local_u64(&p, "tpu_bundle_bytes=", 1, (uint64_t)1 << 40, &tb) || *p++ != ' ' || !anchor_local_u64(&p, "bank=", 0, 4096, &bank) || *p++ != ' ' || !anchor_local_u64(&p, "refill=", 0, 16, &rf)) return 0; }
    /* the draft tail is now key-conditional, so the links tail can follow it or stand alone */
    if (*p == ' ' && !strncmp(p + 1, "draft_bytes=", 12)) { p++; if (!anchor_local_u64(&p, "draft_bytes=", 1, (uint64_t)1 << 34, &db) || *p++ != ' ' || !anchor_local_u64(&p, "draft_max=", 1, 4, &dm)) return 0; }
    uint64_t lk = 0;
    if (*p == ' ' && !strncmp(p + 1, "links=", 6)) { p++; if (!anchor_local_u64(&p, "links=", 2, 4, &lk)) return 0; }
    if (*p != 0) return 0;
    plan->model_bytes = b; plan->threads = (int)t; plan->ctx = (int)c; plan->tpu_bundle_bytes = tb; plan->bank = (int)bank; plan->refill = (int)rf; plan->draft_bytes = db; plan->draft_max = (int)dm; plan->links = (int)lk; return 1;
}
#endif
