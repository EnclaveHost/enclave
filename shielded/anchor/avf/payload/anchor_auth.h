/* The " auth=<mode>" token on the owner's MODEL and ENGINE control lines: strict. Exactly "whole-file" (the default
 * when absent) or "catalog"; anything else, a duplicate, or a value glued to other characters ("auth=catalogue",
 * "auth=catalog,") is MALFORMED and the line is refused: an unknown mode never silently becomes the full scan. */
#ifndef ANCHOR_AUTH_H
#define ANCHOR_AUTH_H
#ifdef __cplusplus
extern "C" {
#endif
enum { ANCHOR_AUTH_TOKEN_WHOLE_FILE = 1, ANCHOR_AUTH_TOKEN_CATALOG = 2, ANCHOR_AUTH_TOKEN_MALFORMED = 0 };
/* Scans `line` (space-separated tokens; the first token may be the verb) for "auth=". No token -> WHOLE_FILE. */
int anchor_auth_token(const char *line);
/* The " cache=only" token on the MODEL line: ABSENT = today's stage (a miss receives the model), ONLY = a miss receives nothing
 * and the store is left untouched, MALFORMED = any other value, a duplicate, or a value glued to other characters. */
enum { ANCHOR_CACHE_TOKEN_MALFORMED = 0, ANCHOR_CACHE_TOKEN_ABSENT = 1, ANCHOR_CACHE_TOKEN_ONLY = 2 };
int anchor_cache_token(const char *line);
#ifdef __cplusplus
}
#endif
#endif
