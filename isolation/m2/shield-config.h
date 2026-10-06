/* Shield settings the deployment's app config may carry (dominit reads them from ENCLAVE_CONFIG before it starts the
 * app). Only top-level keys of the config object count: the scanner skips every string, escapes included, so text
 * inside a value (a system prompt quoting a key, say) never matches, and a key only counts when a ':' follows it.
 * The config is the deployment's own (owner-signed, CID-pinned); an unreadable value falls back to the default. */
#ifndef SHIELD_CONFIG_H
#define SHIELD_CONFIG_H
#include <string.h>

#define SHIELD_BUSY_DEFAULT (-2)   /* `true`: the engine's own default (half its refill threads) */

/* "shieldPadBusyMint": mint one-time pads into the pad spill while requests run, not only while idle.
 *   absent / false / unreadable -> -1 or 0: idle-only (the caller sets 0)
 *   true                        -> SHIELD_BUSY_DEFAULT
 *   0..64                       -> that many minting threads (larger numbers clamp to 64) */
static int shield_busy_mint(const char *json) {
    static const char key[] = "\"shieldPadBusyMint\"";
    if (!json) return -1;
    int depth = 0;
    for (const char *p = json; *p; p++) {
        if (*p == '"') {
            const char *s = p++;
            while (*p && *p != '"') { if (*p == '\\' && p[1]) p++; p++; }
            if (!*p) return -1;                       /* unterminated string */
            if (depth != 1 || (size_t)(p - s + 1) != sizeof key - 1 || memcmp(s, key, sizeof key - 1) != 0) continue;
            const char *v = p + 1;
            while (*v == ' ' || *v == '\t' || *v == '\n' || *v == '\r') v++;
            if (*v != ':') continue;                  /* the key's text as a VALUE, not a key */
            v++;
            while (*v == ' ' || *v == '\t' || *v == '\n' || *v == '\r') v++;
            if (strncmp(v, "true", 4) == 0) return SHIELD_BUSY_DEFAULT;
            if (strncmp(v, "false", 5) == 0) return 0;
            if (*v >= '0' && *v <= '9') {
                long n = 0;
                while (*v >= '0' && *v <= '9') { if (n <= 64) n = n * 10 + (*v - '0'); v++; }
                return n > 64 ? 64 : (int)n;
            }
            return -1;
        }
        if (*p == '{' || *p == '[') depth++;
        else if (*p == '}' || *p == ']') depth--;
    }
    return -1;
}
#endif
