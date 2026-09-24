/* anchor-app: the APP line grammar (shielded/anchor/avf/payload/anchor_app.h), strict both ways. Run from test/anchor-app.test.mjs. */
#include "anchor_app.h"
#include <assert.h>
#include <stdio.h>
#include <string.h>
static const char *H = "faaf2071f9cd6982beb9f089f1990b86f43449a7c1db7dcd13a7e1b9f1f27505";
int main(void) {
    anchor_app_plan p; char l[20000]; int n = 0;
#define OK(...)  do { snprintf(l, sizeof l, __VA_ARGS__); assert(anchor_app_parse(l, &p)); n++; } while (0)
#define BAD(...) do { snprintf(l, sizeof l, __VA_ARGS__); assert(!anchor_app_parse(l, &p)); n++; } while (0)
    OK("APP bytes=82693 sha256=%s", H); assert(p.bytes == 82693 && p.sha256[0] == 0xfa && p.sha256[31] == 0x05 && p.args_len == 0);
    OK("APP bytes=1 sha256=%s args=61006200", H); assert(p.args_len == 4 && p.args[0] == 'a' && p.args[1] == 0 && p.args[2] == 'b');
    OK("APP bytes=1073741824 sha256=%s", H);                                  /* the 1 GiB cap itself */
    BAD("APP bytes=1073741825 sha256=%s", H);                                 /* past the cap */
    BAD("APP bytes=0 sha256=%s", H); BAD("APP bytes=01 sha256=%s", H);        /* zero, leading zero */
    BAD("APP bytes= sha256=%s", H); BAD("APP bytes=12345678901 sha256=%s", H);
    BAD("APP bytes=5 sha256=%.63s", H);                                        /* short digest */
    BAD("APP bytes=5 sha256=FAAF2071f9cd6982beb9f089f1990b86f43449a7c1db7dcd13a7e1b9f1f27505");   /* upper-case */
    BAD("APP bytes=5 sha256=%s ", H); BAD("APP bytes=5 sha256=%s x", H);      /* trailing bytes */
    BAD("APP bytes=5 sha256=%s args=", H); BAD("APP bytes=5 sha256=%s args=616", H); BAD("APP bytes=5 sha256=%s args=zz", H);
    BAD("APP  bytes=5 sha256=%s", H); BAD("APP sha256=%s bytes=5", H); BAD("LOCAL bytes=5 sha256=%s", H); BAD("%s", "");
    { char big[20000]; int k = snprintf(big, sizeof big, "APP bytes=5 sha256=%s args=", H); for (int i = 0; i < 8193; i++) k += snprintf(big + k, sizeof big - k, "61");
      assert(!anchor_app_parse(big, &p)); n++; }                                /* 8193 decoded bytes: over the bound */
    assert(!anchor_app_parse(NULL, &p) && !anchor_app_parse("APP bytes=5", NULL)); n += 2;
    /* graph=: the model's name for wasi:nn, after args when both are given */
    OK("APP bytes=5 sha256=%s graph=gemma-4-e2b-it-q4_0", H); assert(!strcmp(p.graph, "gemma-4-e2b-it-q4_0") && p.args_len == 0);
    OK("APP bytes=5 sha256=%s args=6100 graph=m", H); assert(!strcmp(p.graph, "m") && p.args_len == 2);
    OK("APP bytes=5 sha256=%s", H); assert(p.graph[0] == 0);                  /* absent = no model */
    { char g[80]; memset(g, 'm', 64); g[64] = 0; OK("APP bytes=5 sha256=%s graph=%s", H, g); assert(strlen(p.graph) == 64);
      g[64] = 'm'; g[65] = 0; BAD("APP bytes=5 sha256=%s graph=%s", H, g); }   /* 64 is the bound */
    BAD("APP bytes=5 sha256=%s graph=", H); BAD("APP bytes=5 sha256=%s graph=Gemma", H); BAD("APP bytes=5 sha256=%s graph=-m", H);
    BAD("APP bytes=5 sha256=%s graph=a/b", H); BAD("APP bytes=5 sha256=%s graph=m ", H); BAD("APP bytes=5 sha256=%s graph=m args=6100", H);
    BAD("APP bytes=5 sha256=%s graph=m graph=n", H);
    /* serve=http: last, never with args */
    OK("APP bytes=5 sha256=%s serve=http", H); assert(p.http == 1 && p.graph[0] == 0);
    OK("APP bytes=5 sha256=%s graph=m serve=http", H); assert(p.http == 1 && !strcmp(p.graph, "m"));
    OK("APP bytes=5 sha256=%s graph=m", H); assert(p.http == 0);
    BAD("APP bytes=5 sha256=%s args=6100 serve=http", H); BAD("APP bytes=5 sha256=%s serve=http graph=m", H);
    BAD("APP bytes=5 sha256=%s serve=cli", H); BAD("APP bytes=5 sha256=%s serve=http ", H); BAD("APP bytes=5 sha256=%s serve=httpx", H);
    /* serve=https: TLS in the VM */
    OK("APP bytes=5 sha256=%s serve=https", H); assert(p.http == 2);
    OK("APP bytes=5 sha256=%s graph=m serve=https", H); assert(p.http == 2 && !strcmp(p.graph, "m"));
    BAD("APP bytes=5 sha256=%s args=6100 serve=https", H); BAD("APP bytes=5 sha256=%s serve=httpss", H); BAD("APP bytes=5 sha256=%s serve=https ", H);
    printf("{\"status\":\"PASS\",\"executed_checks\":%d}\n", n);
    return 0;
}
