/* HOST-ONLY: mints the MASKBENCH public shipment with the production writer (never runs in the pVM, where the writer's
 * close was refused by the encrypted store). Packaged into the APK as assets/maskbench.pads by the build.
 * cc -DANCHOR_MASKBENCH_MINT_MAIN … anchor_maskbench_mint.c shielded-pads.c shielded-field.c tweetnacl.c poly1305-donna.c -lm -o maskbench-mint */
#define _GNU_SOURCE
#include "anchor_maskbench_fixture.h"
#include "third_party/tweetnacl.h"
#include <stdlib.h>
#include <stdio.h>
/* Returns 0 on success (file at `path`, refused if it already exists), nonzero with a message otherwise. */
int anchor_maskbench_mint(const char *path, char *why, size_t whycap) {
    if (!path || !*path) { snprintf(why, whycap, "no path"); return 2; }
    uint8_t pk[32]; crypto_scalarmult_base(pk, mb_consumer_sk);
    sh_pads_group groups[MB_GROUPS]; mb_groups(groups);
    int32_t *u = (int32_t *)malloc((size_t)mb_widths[MB_GROUPS - 1] * sizeof *u); if (!u) { snprintf(why, whycap, "out of memory"); return 2; }
    int err = 0; sh_pads_writer *w = sh_pads_writer_open(path, mb_model_digest, mb_seed_id, groups, MB_GROUPS, 0, MB_INDICES, pk, &err);
    if (!w) { free(u); snprintf(why, whycap, "writer open (%d)", err); return 2; }
    for (uint64_t index = 0; index < MB_INDICES; index++) for (uint32_t g = 0; g < MB_GROUPS; g++) {
        for (uint64_t j = 0; j < (uint64_t)mb_widths[g]; j++) u[j] = mb_value(j, index, g);
        const int rc = sh_pads_writer_cell(w, index, g, u);
        if (rc != 0) { free(u); (void)sh_pads_writer_close(w); snprintf(why, whycap, "writer cell %llu/%u (%d)", (unsigned long long)index, g, rc); return 2; }
    }
    free(u);
    const int rc = sh_pads_writer_close(w);
    if (rc != 0) { snprintf(why, whycap, "writer close (%d)", rc); return 2; }
    why[0] = 0; return 0;
}
#ifdef ANCHOR_MASKBENCH_MINT_MAIN
int main(int argc, char **argv) {
    if (argc != 2) { fprintf(stderr, "usage: maskbench-mint <output.pads>\n"); return 2; }
    char why[256]; const int rc = anchor_maskbench_mint(argv[1], why, sizeof why);
    if (rc) fprintf(stderr, "maskbench-mint: %s\n", why); else printf("minted %s (%d groups x %d indices)\n", argv[1], MB_GROUPS, MB_INDICES);
    return rc;
}
#endif
