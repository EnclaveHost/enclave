/* anchor_app.h -- the owner's APP line: run a portable WebAssembly component in this VM (PVM-CPU.md, "The app runtime").
 *   APP bytes=<1..2^30> sha256=<64 lowercase hex>[ args=<even-length lowercase hex, 1..8192 bytes decoded>][ graph=<name>][ serve=http|https]
 * Strict: exactly these keys in this order, canonical decimal, single spaces, nothing after. `graph` (1..64 of [a-z0-9._-],
 * starting with a letter or digit: runtime/pvm-rt nn.rs valid_graph_name) is the name the component loads the VM's verified
 * model by through wasi:nn; it comes with a LOCAL line (the model and its engine) and never without one. `serve=http` says
 * the component is a wasi:http/proxy app, served on APP_HTTP_PORT until the owner's STOP (args are then refused: an HTTP
 * app takes its input from requests); `serve=https` is the same over TLS 1.3 terminating in the VM with its attested
 * transport key (plan->http == 2). The component itself arrives on
 * APP_PORT (anchor_public_file.h framing) and is refused unless its bytes hash to `sha256`; the runtime hashes the bytes it
 * is about to compile once more (runtime/pvm-rt), so the compiled bytes are the checked bytes. `sha256` is the app's
 * identity (its AppID), which the pVM binds into its attestation (report_data[32:64]) so a verifier sees exactly which app
 * runs. `args`, decoded, is the argument list, NUL-separated (an empty args key is not allowed; omit it for none). Pure. */
#ifndef ANCHOR_APP_H
#define ANCHOR_APP_H
#include <stdint.h>
#include <string.h>

typedef struct { uint64_t bytes; uint8_t sha256[32]; char args[8193]; size_t args_len; char graph[65]; int http; /* 0 cli, 1 http, 2 https */ } anchor_app_plan;

static inline int anchor_app_hex(char c) { return c >= '0' && c <= '9' ? c - '0' : c >= 'a' && c <= 'f' ? c - 'a' + 10 : -1; }

static inline int anchor_app_parse(const char *line, anchor_app_plan *plan) {
    if (!line || !plan || strncmp(line, "APP bytes=", 10)) return 0;
    const char *p = line + 10; uint64_t v = 0; int digits = 0;
    if (*p == '0') return 0;                                            /* canonical: no leading zero, no zero size */
    while (*p >= '0' && *p <= '9') { if (++digits > 10) return 0; v = v * 10 + (uint64_t)(*p - '0'); p++; }
    if (!digits || v == 0 || v > ((uint64_t)1 << 30)) return 0;
    if (strncmp(p, " sha256=", 8)) return 0;
    p += 8;
    uint8_t h[32];
    for (int i = 0; i < 32; i++) { const int a = anchor_app_hex(p[2 * i]), b = anchor_app_hex(p[2 * i + 1]); if (a < 0 || b < 0) return 0; h[i] = (uint8_t)(a << 4 | b); }
    p += 64;
    size_t n = 0; char args[8193];
    if (!strncmp(p, " args=", 6)) {
        p += 6;
        const char *s = p; while (anchor_app_hex(*p) >= 0) p++;
        const size_t hl = (size_t)(p - s);
        if (hl == 0 || (hl & 1) || hl / 2 > 8192) return 0;
        for (size_t i = 0; i < hl / 2; i++) args[i] = (char)(anchor_app_hex(s[2 * i]) << 4 | anchor_app_hex(s[2 * i + 1]));
        n = hl / 2;
    }
    char graph[65] = "";
    if (!strncmp(p, " graph=", 7)) {
        p += 7;
        size_t g = 0;
        if (!((*p >= 'a' && *p <= 'z') || (*p >= '0' && *p <= '9'))) return 0;
        while ((p[g] >= 'a' && p[g] <= 'z') || (p[g] >= '0' && p[g] <= '9') || p[g] == '.' || p[g] == '_' || p[g] == '-') { if (++g > 64) return 0; }
        memcpy(graph, p, g); graph[g] = 0; p += g;
    }
    int http = 0;
    if (!strncmp(p, " serve=https", 12)) { if (n) return 0; http = 2; p += 12; }
    else if (!strncmp(p, " serve=http", 11)) { if (n) return 0; http = 1; p += 11; }
    if (*p != 0) return 0;
    plan->http = http;
    plan->bytes = v; memcpy(plan->sha256, h, 32); memcpy(plan->args, args, n); plan->args[n] = 0; plan->args_len = n;
    memcpy(plan->graph, graph, sizeof graph);
    return 1;
}
#endif
