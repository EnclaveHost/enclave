#include "anchor_auth.h"
#include <string.h>
int anchor_auth_token(const char *line) {
    if (!line) return ANCHOR_AUTH_TOKEN_MALFORMED;
    int found = 0, mode = ANCHOR_AUTH_TOKEN_WHOLE_FILE;
    const char *p = line;
    while (*p) {
        while (*p == ' ') p++;
        const char *tok = p; while (*p && *p != ' ') p++;
        const size_t n = (size_t)(p - tok);
        if (n >= 5 && !memcmp(tok, "auth=", 5)) {
            if (found) return ANCHOR_AUTH_TOKEN_MALFORMED;                       /* one token, once */
            found = 1;
            if (n == 5 + 7 && !memcmp(tok + 5, "catalog", 7)) mode = ANCHOR_AUTH_TOKEN_CATALOG;
            else if (n == 5 + 10 && !memcmp(tok + 5, "whole-file", 10)) mode = ANCHOR_AUTH_TOKEN_WHOLE_FILE;
            else return ANCHOR_AUTH_TOKEN_MALFORMED;                              /* unknown, empty, or glued to something */
        }
    }
    return mode;
}
int anchor_cache_token(const char *line) {
    if (!line) return ANCHOR_CACHE_TOKEN_MALFORMED;
    int found = 0; const char *p = line;
    while (*p) {
        while (*p == ' ') p++;
        const char *tok = p; while (*p && *p != ' ') p++;
        const size_t n = (size_t)(p - tok);
        if (n >= 6 && !memcmp(tok, "cache=", 6)) {
            if (found) return ANCHOR_CACHE_TOKEN_MALFORMED;                       /* one token, once */
            found = 1;
            if (!(n == 6 + 4 && !memcmp(tok + 6, "only", 4))) return ANCHOR_CACHE_TOKEN_MALFORMED;   /* exactly "only" */
        }
    }
    return found ? ANCHOR_CACHE_TOKEN_ONLY : ANCHOR_CACHE_TOKEN_ABSENT;
}
