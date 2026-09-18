/* engine_local_proto.h -- the local engine's chat grammar (engine_local.cpp), pure so a host fixture runs it.
 *   GEN <max_new_tokens 1..8192> <temperature_milli 0..2000> <hex utf-8 message, 2..ENGINE_LOCAL_MAX_MSG*2 chars>
 * Canonical decimal only (no sign, no leading zero, no spaces beyond the single separators), lower- or upper-case
 * hex, nothing after it. The app's LocalChat.request() builds exactly this line (test/anchor-local-proto.test.mjs). */
#ifndef ENGINE_LOCAL_PROTO_H
#define ENGINE_LOCAL_PROTO_H
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#define ENGINE_LOCAL_MAX_MSG  (256u * 1024u)                 /* bytes of message text per turn */
#define ENGINE_LOCAL_MAX_LINE (ENGINE_LOCAL_MAX_MSG * 2u + 64u)
typedef struct { int max_new, temperature_milli; const char *hex; size_t hex_len; } engine_local_request;
static inline int engine_local_decimal(const char **p, long lo, long hi, int *out) {
    const char *s = *p; long v = 0; int digits = 0;
    if (*s == '0' && s[1] >= '0' && s[1] <= '9') return 0;   /* no leading zero */
    while (*s >= '0' && *s <= '9') { v = v * 10 + (*s - '0'); if (v > 1000000) return 0; s++; digits++; }
    if (!digits || v < lo || v > hi) return 0;
    *out = (int)v; *p = s; return 1;
}
static inline int engine_local_is_hex(char c) { return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F'); }
static inline int engine_local_parse_gen(const char *line, engine_local_request *rq) {
    if (!line || strncmp(line, "GEN ", 4)) return 0;
    const char *p = line + 4;
    if (!engine_local_decimal(&p, 1, 8192, &rq->max_new) || *p++ != ' ') return 0;
    if (!engine_local_decimal(&p, 0, 2000, &rq->temperature_milli) || *p++ != ' ') return 0;
    size_t n = 0; while (engine_local_is_hex(p[n])) n++;
    if (p[n] != 0 || n < 2 || (n & 1) || n > (size_t)ENGINE_LOCAL_MAX_MSG * 2u) return 0;
    rq->hex = p; rq->hex_len = n; return 1;
}
#ifdef __cplusplus
#include <string>
static inline int engine_local_nibble(char c) { return c <= '9' ? c - '0' : (c | 0x20) - 'a' + 10; }
static inline bool engine_local_unhex(const char *hex, std::string &out) {
    out.clear(); size_t n = 0; while (engine_local_is_hex(hex[n])) n++;
    if (hex[n] != 0 || (n & 1)) return false;
    out.reserve(n / 2);
    for (size_t i = 0; i < n; i += 2) out.push_back((char)((engine_local_nibble(hex[i]) << 4) | engine_local_nibble(hex[i + 1])));
    return true;
}
static inline std::string engine_local_hex(const uint8_t *p, size_t n) {
    static const char d[] = "0123456789abcdef"; std::string o; o.resize(n * 2);
    for (size_t i = 0; i < n; i++) { o[2 * i] = d[p[i] >> 4]; o[2 * i + 1] = d[p[i] & 15]; }
    return o;
}
#endif
#endif
