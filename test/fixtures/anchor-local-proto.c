/* host fixture for engine_local_proto.h: the GEN grammar, accepted and refused lines; --wire parses argv lines */
#include <stdio.h>
#include <string.h>
#include "engine_local_proto.h"
#include "anchor_local.h"
static int checks = 0, failed = 0;
static void expect(int ok, const char *what) { checks++; if (!ok) { failed++; fprintf(stderr, "FAIL %s\n", what); } }
int main(int argc, char **argv) {
    engine_local_request r;
    if (argc > 1 && !strcmp(argv[1], "--wire")) {
        for (int i = 2; i < argc; i++) { if (engine_local_parse_gen(argv[i], &r)) printf("GEN %d %d %zu\n", r.max_new, r.temperature_milli, r.hex_len); else printf("REFUSED\n"); }
        return 0;
    }
    expect(engine_local_parse_gen("GEN 256 700 68656c6c6f", &r) && r.max_new == 256 && r.temperature_milli == 700 && r.hex_len == 10 && !strcmp(r.hex, "68656c6c6f"), "plain request");
    expect(engine_local_parse_gen("GEN 1 0 AB", &r) && r.max_new == 1 && r.temperature_milli == 0, "bounds low, upper-case hex");
    expect(engine_local_parse_gen("GEN 8192 2000 00", &r), "bounds high");
    const char *bad[] = { "GEN 0 700 6869", "GEN 8193 700 6869", "GEN 256 2001 6869", "GEN 256 -1 6869", "GEN 0256 700 6869", "GEN 256 0700 6869", "GEN 256 700 686",
                          "GEN 256 700 ", "GEN 256 700", "GEN 256  700 6869", "GEN 256 700 6869 ", "GEN 256 700 68zz", "gen 256 700 6869", "GEN256 700 6869", "GEN 256 700 6869\n",
                          "GEN +5 700 6869", "GEN 99999999999 700 6869", "RESET", "", "GEN 1e2 700 6869" };
    for (size_t i = 0; i < sizeof bad / sizeof *bad; i++) expect(!engine_local_parse_gen(bad[i], &r), bad[i]);
    expect(!engine_local_parse_gen(NULL, &r), "null line");
    anchor_local_plan lp;
    expect(anchor_local_parse("LOCAL model_bytes=3360161216 threads=6 ctx=4096", &lp) && lp.model_bytes == 3360161216ull && lp.threads == 6 && lp.ctx == 4096, "LOCAL plan");
    expect(anchor_local_parse("LOCAL model_bytes=1 threads=1 ctx=512", &lp) && anchor_local_parse("LOCAL model_bytes=1099511627776 threads=16 ctx=32768", &lp), "LOCAL bounds");
    const char *lbad[] = { "LOCAL", "LOCAL ", "LOCAL model_bytes=0 threads=6 ctx=4096", "LOCAL model_bytes=5 threads=0 ctx=4096", "LOCAL model_bytes=5 threads=17 ctx=4096", "LOCAL model_bytes=5 threads=6 ctx=511",
                           "LOCAL model_bytes=5 threads=6 ctx=32769", "LOCAL threads=6 model_bytes=5 ctx=4096", "LOCAL model_bytes=5 threads=6 ctx=4096 ", "LOCAL model_bytes=5  threads=6 ctx=4096", "LOCAL model_bytes=05 threads=6 ctx=4096",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 env=00", "LOCAL model_bytes=1099511627777 threads=6 ctx=4096", "LOCAL model_bytes=99999999999999999999 threads=6 ctx=4096", "LOCALmodel_bytes=5 threads=6 ctx=4096" };
    for (size_t i = 0; i < sizeof lbad / sizeof *lbad; i++) expect(!anchor_local_parse(lbad[i], &lp), lbad[i]);
    if (argc > 1 && !strcmp(argv[1], "--local")) { for (int i = 2; i < argc; i++) { if (anchor_local_parse(argv[i], &lp)) printf("LOCAL %llu %d %d\n", (unsigned long long)lp.model_bytes, lp.threads, lp.ctx); else printf("REFUSED\n"); } return 0; }
    printf("{\"status\":\"%s\",\"executed_checks\":%d}\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
