#define _POSIX_C_SOURCE 200809L   /* fseeko/ftello for the header on glibc; the NDK declares them by default */
/* Host fixture for anchor_stderr_export.h: exports FILE at CAP bytes to stdout, one record per line, exactly
 * as the VM engine would over its control channel; the collector must reconstruct it byte-exactly. */
#include <stdio.h>
#include <stdlib.h>
#include "../../shielded/anchor/avf/payload/anchor_stderr_export.h"
static void emit(void *ctx, const char *line) { (void)ctx; puts(line); }
static int parse_tests(void) {
    int f = 7; uint64_t v = 0; int ok = 1;
    ok &= anchor_stderr_flag_parse(NULL, &f) && f == 0; ok &= anchor_stderr_flag_parse("0", &f) && f == 0; ok &= anchor_stderr_flag_parse("1", &f) && f == 1;
    ok &= !anchor_stderr_flag_parse("", &f) && !anchor_stderr_flag_parse("01", &f) && !anchor_stderr_flag_parse("true", &f) && !anchor_stderr_flag_parse("1 ", &f) && !anchor_stderr_flag_parse("2", &f);
    ok &= anchor_stderr_cap_parse("65536", 65536, 67108864, &v) && v == 65536; ok &= anchor_stderr_cap_parse("67108864", 65536, 67108864, &v) && v == 67108864;
    ok &= !anchor_stderr_cap_parse("65535", 65536, 67108864, &v) && !anchor_stderr_cap_parse("67108865", 65536, 67108864, &v);
    ok &= !anchor_stderr_cap_parse("0065536", 65536, 67108864, &v) && !anchor_stderr_cap_parse("+65536", 65536, 67108864, &v) && !anchor_stderr_cap_parse("65536k", 65536, 67108864, &v);
    ok &= !anchor_stderr_cap_parse("", 65536, 67108864, &v) && !anchor_stderr_cap_parse(NULL, 65536, 67108864, &v) && !anchor_stderr_cap_parse("9999999999999", 65536, 67108864, &v);
    puts(ok ? "parse tests: PASS" : "parse tests: FAIL"); return ok ? 0 : 1;
}
int main(int argc, char **argv) {
    if (argc == 2 && !strcmp(argv[1], "--parse-test")) return parse_tests();
    if (argc < 3) { fprintf(stderr, "usage: %s FILE CAP | --parse-test\n", argv[0]); return 2; }
    return anchor_stderr_export(argv[1], strtoull(argv[2], NULL, 10), emit, NULL) == 0 ? 0 : 1;
}
