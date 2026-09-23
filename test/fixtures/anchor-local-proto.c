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
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=1842000000 bank=64 refill=2", &lp) && lp.tpu_bundle_bytes == 1842000000ull && lp.bank == 64 && lp.refill == 2, "LOCAL tpu tail");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096", &lp) && lp.tpu_bundle_bytes == 0 && lp.bank == 0, "LOCAL without the tail clears it");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 draft_bytes=170194016 draft_max=4", &lp) && lp.tpu_bundle_bytes == 0 && lp.draft_bytes == 170194016ull && lp.draft_max == 4, "LOCAL draft tail alone");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 draft_bytes=7 draft_max=1", &lp) && lp.tpu_bundle_bytes == 9 && lp.draft_bytes == 7 && lp.draft_max == 1, "LOCAL both tails");
    /* the spin tail: how long the VM polls the worker link before sleeping on it; only with the TPU tail, last */
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=3000", &lp) && lp.tpu_bundle_bytes == 9 && lp.spin == 3000, "LOCAL spin tail");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 links=2 spin=20000", &lp) && lp.links == 2 && lp.spin == 20000, "LOCAL links then spin");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0", &lp) && lp.spin == 0, "LOCAL without spin clears it");
    const char *sbad[] = { "LOCAL model_bytes=5 threads=6 ctx=4096 spin=3000", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=0",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=20001", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=3000 links=2",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=03000", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=3000 " };
    for (size_t i = 0; i < sizeof sbad / sizeof *sbad; i++) expect(!anchor_local_parse(sbad[i], &lp), sbad[i]);
    /* the poll tail: last, 0..100, with or without the TPU tail; absent = -1 (ggml's default kept) */
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 poll=0", &lp) && lp.poll == 0, "LOCAL poll 0 alone");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 spin=10 poll=100", &lp) && lp.spin == 10 && lp.poll == 100, "LOCAL spin then poll");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096", &lp) && lp.poll == -1, "LOCAL without poll keeps the default");
    const char *pbad[] = { "LOCAL model_bytes=5 threads=6 ctx=4096 poll=101", "LOCAL model_bytes=5 threads=6 ctx=4096 poll=", "LOCAL model_bytes=5 threads=6 ctx=4096 poll=05",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 poll=5 spin=10", "LOCAL model_bytes=5 threads=6 ctx=4096 poll=5 " };
    for (size_t i = 0; i < sizeof pbad / sizeof *pbad; i++) expect(!anchor_local_parse(pbad[i], &lp), pbad[i]);
    /* the dthreads tail: last, 1..16; absent = 0 (one pool) */
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 dthreads=2", &lp) && lp.dthreads == 2, "LOCAL dthreads alone");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=0 refill=0 poll=50 dthreads=16", &lp) && lp.poll == 50 && lp.dthreads == 16, "LOCAL poll then dthreads");
    expect(anchor_local_parse("LOCAL model_bytes=5 threads=6 ctx=4096", &lp) && lp.dthreads == 0, "LOCAL without dthreads is one pool");
    const char *dbad[] = { "LOCAL model_bytes=5 threads=6 ctx=4096 dthreads=0", "LOCAL model_bytes=5 threads=6 ctx=4096 dthreads=17", "LOCAL model_bytes=5 threads=6 ctx=4096 dthreads=2 poll=5" };
    for (size_t i = 0; i < sizeof dbad / sizeof *dbad; i++) expect(!anchor_local_parse(dbad[i], &lp), dbad[i]);
    const char *lbad[] = { "LOCAL", "LOCAL ", "LOCAL model_bytes=0 threads=6 ctx=4096", "LOCAL model_bytes=5 threads=0 ctx=4096", "LOCAL model_bytes=5 threads=17 ctx=4096", "LOCAL model_bytes=5 threads=6 ctx=511",
                           "LOCAL model_bytes=5 threads=6 ctx=32769", "LOCAL threads=6 model_bytes=5 ctx=4096", "LOCAL model_bytes=5 threads=6 ctx=4096 ", "LOCAL model_bytes=5  threads=6 ctx=4096", "LOCAL model_bytes=05 threads=6 ctx=4096",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 env=00", "LOCAL model_bytes=1099511627777 threads=6 ctx=4096", "LOCAL model_bytes=99999999999999999999 threads=6 ctx=4096", "LOCALmodel_bytes=5 threads=6 ctx=4096",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9", "LOCAL model_bytes=5 threads=6 ctx=4096 bank=4", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=4097 refill=0", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=4", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=9 bank=4 refill=17", "LOCAL model_bytes=5 threads=6 ctx=4096 tpu_bundle_bytes=0 bank=4 refill=0",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 draft_bytes=7 draft_max=5", "LOCAL model_bytes=5 threads=6 ctx=4096 draft_bytes=7 draft_max=0", "LOCAL model_bytes=5 threads=6 ctx=4096 draft_max=4 draft_bytes=7",
                           "LOCAL model_bytes=5 threads=6 ctx=4096 draft_bytes=7 draft_max=4 tpu_bundle_bytes=9 bank=0" };
    for (size_t i = 0; i < sizeof lbad / sizeof *lbad; i++) expect(!anchor_local_parse(lbad[i], &lp), lbad[i]);
    if (argc > 1 && !strcmp(argv[1], "--local")) { for (int i = 2; i < argc; i++) { if (anchor_local_parse(argv[i], &lp)) printf("LOCAL %llu %d %d %llu %d %llu %d\n", (unsigned long long)lp.model_bytes, lp.threads, lp.ctx, (unsigned long long)lp.tpu_bundle_bytes, lp.bank, (unsigned long long)lp.draft_bytes, lp.draft_max); else printf("REFUSED\n"); } return 0; }
    printf("{\"status\":\"%s\",\"executed_checks\":%d}\n", failed ? "FAIL" : "PASS", checks);
    return failed ? 1 : 0;
}
