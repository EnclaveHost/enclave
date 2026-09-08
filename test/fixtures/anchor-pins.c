/* anchor-pins: the phone anchor's measured pins load fail-closed (shielded/anchor/avf/payload/anchor_pins.c).
 * Runs from test/anchor-pins.test.mjs against temp directories. */
#include "anchor_pins.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

static void put(const char *dir, const char *name, const char *content) {
    char p[600]; snprintf(p, sizeof p, "%s/%s", dir, name);
    if (!content) { unlink(p); return; }
    FILE *f = fopen(p, "wb"); assert(f); fputs(content, f); fclose(f);
}
static const char *HEX64 = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

int main(void) {
    char dir[] = "/tmp/anchor-pins-XXXXXX"; assert(mkdtemp(dir));
    anchor_pins p;
    /* no mode file: not a default, an error */
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "anchor.mode missing") && p.mode == ANCHOR_MODE_INVALID);
    put(dir, "anchor.mode", "release\n");
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "neither"));
    /* dev without pins is fine and says so */
    put(dir, "anchor.mode", "dev\n");
    assert(anchor_pins_load(dir, &p) && p.mode == ANCHOR_MODE_DEV && !p.has_ledger && !p.has_model && !p.has_prefix);
    /* dev with a corrupt pin is NOT fine: a present pin must be right */
    put(dir, "ledger.pk", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde\n");    /* 63 hex */
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "ledger.pk present but malformed") && p.mode == ANCHOR_MODE_INVALID);
    put(dir, "ledger.pk", "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef\n");   /* uppercase */
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "ledger.pk present but malformed"));
    put(dir, "ledger.pk", HEX64);
    assert(anchor_pins_load(dir, &p) && p.has_ledger && p.ledger_pk[0] == 0x01 && p.ledger_pk[31] == 0xef);
    /* protected needs all three */
    put(dir, "anchor.mode", "protected");
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "protected build without pins: model prefix"));
    put(dir, "model.sha256", HEX64); put(dir, "prefix.pk", "\n");
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "prefix.pk present but malformed"));
    put(dir, "prefix.pk", HEX64);
    assert(anchor_pins_load(dir, &p) && p.mode == ANCHOR_MODE_PROTECTED && p.has_ledger && p.has_model && p.has_prefix);
    /* the model check: the actual file against the pin, computed here, never taken from a claim */
    put(dir, "model.gguf", "abc");
    put(dir, "model.sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
    assert(anchor_pins_load(dir, &p));
    char err[160]; uint8_t d[32]; char mp[600]; snprintf(mp, sizeof mp, "%s/model.gguf", dir);
    assert(anchor_pins_model_matches(&p, mp, d, err, sizeof err) && d[0] == 0xba && d[31] == 0xad);
    put(dir, "model.gguf", "abd");                                   /* changed model, same name */
    assert(!anchor_pins_model_matches(&p, mp, d, err, sizeof err) && strstr(err, "differs"));
    put(dir, "model.gguf", NULL);                                    /* absent */
    assert(!anchor_pins_model_matches(&p, mp, d, err, sizeof err) && strstr(err, "unreadable"));
    put(dir, "anchor.mode", "dev"); put(dir, "model.sha256", NULL);  /* dev without a model pin: no claim of a match */
    assert(anchor_pins_load(dir, &p) && !p.has_model);
    put(dir, "model.gguf", "abc");
    assert(!anchor_pins_model_matches(&p, mp, d, err, sizeof err) && strstr(err, "no model pin"));
    /* SHA-256 vectors */
    uint8_t h[32]; anchor_sha256((const uint8_t *)"", 0, h); assert(h[0] == 0xe3 && h[31] == 0x55);
    char cmd[700]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); (void)!system(cmd);
    printf("anchor-pins: ok\n");
    return 0;
}
