/* anchor-pins: the phone anchor's measured pins load fail-closed (shielded/anchor/avf/payload/anchor_pins.c).
 * Runs from test/anchor-pins.test.mjs against temp directories. */
#include "anchor_pins.h"
#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/stat.h>

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
    /* the mode is exact bytes: an embedded NUL, padding, a second newline or a longer file are all refused */
    { char mp0[600]; snprintf(mp0, sizeof mp0, "%s/anchor.mode", dir); FILE *f = fopen(mp0, "wb"); assert(f); fwrite("dev\0junk", 1, 8, f); fclose(f); }
    assert(!anchor_pins_load(dir, &p) && strstr(p.err, "neither"));
    put(dir, "anchor.mode", "dev\n\n");   assert(!anchor_pins_load(dir, &p) && strstr(p.err, "neither"));
    put(dir, "anchor.mode", " dev");     assert(!anchor_pins_load(dir, &p) && strstr(p.err, "neither"));
    put(dir, "anchor.mode", "devx");     assert(!anchor_pins_load(dir, &p) && strstr(p.err, "neither"));
    put(dir, "anchor.mode", "protected                                  "); assert(!anchor_pins_load(dir, &p) && strstr(p.err, "too long"));
    put(dir, "anchor.mode", "dev");      assert(anchor_pins_load(dir, &p) && p.mode == ANCHOR_MODE_DEV);      /* no newline: fine */
    put(dir, "anchor.mode", "protected\n"); assert(!anchor_pins_load(dir, &p) && strstr(p.err, "protected build without pins"));
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
    /* the ORDER that matters: the descriptor that will be parsed is checked after the last write, against
     * the pin and against the digest a grant froze; a same-size replacement under the same name is refused */
    {
        put(dir, "anchor.mode", "protected"); put(dir, "model.sha256", "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad\n");
        assert(anchor_pins_load(dir, &p));
        put(dir, "model.gguf", "abc");
        int fd = open(mp, O_RDONLY); assert(fd >= 0);
        uint8_t frozen[32]; assert(anchor_pins_model_fd_check(&p, fd, NULL, frozen, err, sizeof err) && frozen[0] == 0xba);
        close(fd);
        put(dir, "model.gguf", "abd");                                   /* same size, one byte changed, same name */
        fd = open(mp, O_RDONLY); assert(fd >= 0);
        assert(!anchor_pins_model_fd_check(&p, fd, frozen, d, err, sizeof err) && strstr(err, "differs from the measured pin"));
        close(fd);
        put(dir, "anchor.mode", "dev"); put(dir, "model.sha256", NULL); assert(anchor_pins_load(dir, &p) && !p.has_model);
        fd = open(mp, O_RDONLY); assert(fd >= 0);
        assert(!anchor_pins_model_fd_check(&p, fd, frozen, d, err, sizeof err) && strstr(err, "differs from the one the seed was granted for"));
        assert(anchor_pins_model_fd_check(&p, fd, NULL, d, err, sizeof err) && d[0] != 0xba);   /* dev before a grant: hashed, not judged */
        close(fd);
        put(dir, "model.gguf", "");
        fd = open(mp, O_RDONLY); assert(fd >= 0);
        assert(!anchor_pins_model_fd_check(&p, fd, NULL, d, err, sizeof err) && strstr(err, "unreadable or empty"));
        close(fd);
        /* a read ERROR is not an end of file: a directory descriptor (EISDIR) is refused, never hashed short */
        fd = open(dir, O_RDONLY); assert(fd >= 0);
        assert(!anchor_pins_model_fd_check(&p, fd, NULL, d, err, sizeof err) && strstr(err, "unreadable or empty"));
        close(fd);
        put(dir, "anchor.mode", "protected"); put(dir, "model.sha256", HEX64); assert(anchor_pins_load(dir, &p) && p.has_model);
        assert(!anchor_pins_model_matches(&p, dir, d, err, sizeof err) && strstr(err, "unreadable"));   /* path hasher: fread error */
    }
    /* a pin that exists but cannot be read is an error, not "absent" (skipped as root, who reads anything) */
    if (geteuid() != 0) {
        char lp[600]; snprintf(lp, sizeof lp, "%s/ledger.pk", dir);
        put(dir, "anchor.mode", "dev"); put(dir, "ledger.pk", HEX64); assert(chmod(lp, 0) == 0);
        assert(!anchor_pins_load(dir, &p) && strstr(p.err, "ledger.pk present but malformed or unreadable") && p.mode == ANCHOR_MODE_INVALID);
        assert(chmod(lp, 0600) == 0);
        assert(anchor_pins_load(dir, &p) && p.has_ledger);
    }
    /* SHA-256 vectors */
    uint8_t h[32]; anchor_sha256((const uint8_t *)"", 0, h); assert(h[0] == 0xe3 && h[31] == 0x55);
    char cmd[700]; snprintf(cmd, sizeof cmd, "rm -rf %s", dir); (void)!system(cmd);
    printf("anchor-pins: ok\n");
    return 0;
}
