/* pins-pvm-cpu-test.c -- the pVM CPU build's pins (payload/anchor_pins.c, ANCHOR_TIER_PVM_CPU): the tier carries NO model, so
 * a protected build is valid with no pin at all, and every pin -- a model digest above all -- is refused by name. Run:
 *   cc -std=c11 -D_GNU_SOURCE -DANCHOR_TIER_PVM_CPU -O1 -Wall -Werror -fsanitize=address,undefined -Ipayload \
 *      cpu/test/pins-pvm-cpu-test.c payload/anchor_pins.c -o pins-pvm-cpu && ./pins-pvm-cpu */
#include "anchor_pins.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static int fails = 0, checks = 0;
static void expect(int ok, const char *what) { checks++; if (!ok) { fails++; printf("FAIL %s\n", what); } else printf("ok   %s\n", what); }
static void put(const char *dir, const char *name, const char *body) {
    char p[512]; snprintf(p, sizeof p, "%s/%s", dir, name); FILE *f = fopen(p, "w"); if (!f) { perror(p); exit(2); } fputs(body, f); fclose(f);
}
static void drop(const char *dir, const char *name) { char p[512]; snprintf(p, sizeof p, "%s/%s", dir, name); unlink(p); }
static const char *HEX = "5bf274a5a82cc4fbb05d7a35d2566dc2074eaef8f64a2741ec812dc65089fc48\n";

int main(void) {
    char dir[] = "/tmp/pins-pvm-cpu-XXXXXX"; if (!mkdtemp(dir)) { perror("mkdtemp"); return 2; }
    anchor_pins p;
    put(dir, "anchor.mode", "protected\n");
    expect(anchor_pins_load(dir, &p) == 1 && p.mode == ANCHOR_MODE_PROTECTED && !p.has_model, "a protected pvm-cpu build with no pin at all is valid");
    put(dir, "model.sha256", HEX);
    expect(anchor_pins_load(dir, &p) == 0 && p.mode == ANCHOR_MODE_INVALID && strstr(p.err, "carries no model"), "a model pin is refused by name");
    printf("     err: %s\n", p.err);
    drop(dir, "model.sha256");
    put(dir, "ledger.pk", HEX);
    expect(anchor_pins_load(dir, &p) == 0 && strstr(p.err, " ledger"), "a pad-ledger pin is refused");
    drop(dir, "ledger.pk");
    put(dir, "anchor.mode", "dev\n");
    put(dir, "model.sha256", HEX);
    expect(anchor_pins_load(dir, &p) == 0 && strstr(p.err, "carries no model"), "a model pin is refused in a dev build too");
    drop(dir, "model.sha256");
    expect(anchor_pins_load(dir, &p) == 1 && p.mode == ANCHOR_MODE_DEV, "a dev pvm-cpu build with no pin is valid");
    drop(dir, "anchor.mode"); rmdir(dir);
    printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails);
    return fails ? 1 : 0;
}
