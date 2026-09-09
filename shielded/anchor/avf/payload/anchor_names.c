#include "anchor_names.h"
#include <string.h>

/* canonical unsigned decimal: digits only, no leading zero unless the number is 0, fits uint64 */
static int dec_u64(const char *s, size_t n, uint64_t *out) {
    if (n == 0 || n > 20) return 0;
    if (n > 1 && s[0] == '0') return 0;
    uint64_t v = 0;
    for (size_t i = 0; i < n; i++) {
        if (s[i] < '0' || s[i] > '9') return 0;
        const unsigned d = (unsigned)(s[i] - '0');
        if (v > (UINT64_MAX - d) / 10) return 0;
        v = v * 10 + d;
    }
    *out = v; return 1;
}

anchor_name_class anchor_name_classify(const char *name, char seed_hex_out[33], uint64_t *index0, uint64_t *count) {
    if (seed_hex_out) seed_hex_out[0] = 0;
    if (index0) *index0 = 0;
    if (count) *count = 0;
    if (!name) return ANCHOR_NAME_REFUSED;
    if (!strcmp(name, "prefix.kv") || !strcmp(name, "prefix.kv.sig") || !strcmp(name, "prefix.txt")) return ANCHOR_NAME_PREFIX;
    const size_t n = strlen(name);
    if (n == 64 + 3 && !strcmp(name + 64, ".i8")) {           /* "<64 lowercase hex>.i8": the artifact's own content digest */
        for (int i = 0; i < 64; i++) { const char c = name[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return ANCHOR_NAME_REFUSED; }
        return ANCHOR_NAME_ARTIFACT;
    }
    if (n < 32 + 1 + 1 + 1 + 1 + 5 || n > 127) return ANCHOR_NAME_REFUSED;
    for (int i = 0; i < 32; i++) { const char c = name[i]; if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f'))) return ANCHOR_NAME_REFUSED; }
    if (name[32] != '-') return ANCHOR_NAME_REFUSED;
    if (strcmp(name + n - 5, ".pads")) return ANCHOR_NAME_REFUSED;
    const char *a = name + 33, *dash = memchr(a, '-', (size_t)(name + n - 5 - a));
    if (!dash) return ANCHOR_NAME_REFUSED;
    uint64_t i0 = 0, cnt = 0;
    if (!dec_u64(a, (size_t)(dash - a), &i0)) return ANCHOR_NAME_REFUSED;
    if (!dec_u64(dash + 1, (size_t)(name + n - 5 - (dash + 1)), &cnt)) return ANCHOR_NAME_REFUSED;
    if (cnt == 0 || i0 > UINT64_MAX - cnt) return ANCHOR_NAME_REFUSED;
    if (seed_hex_out) { memcpy(seed_hex_out, name, 32); seed_hex_out[32] = 0; }
    if (index0) *index0 = i0;
    if (count) *count = cnt;
    return ANCHOR_NAME_SHIPMENT;
}
