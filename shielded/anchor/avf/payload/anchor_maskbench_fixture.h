/* The MASKBENCH public fixture: geometry, keys and element pattern shared by the host mint tool (production writer, host
 * only), the pVM comparator (production reader) and the host fixture. Everything here is public by construction. */
#ifndef ANCHOR_MASKBENCH_FIXTURE_H
#define ANCHOR_MASKBENCH_FIXTURE_H
#include <stdint.h>
#include <string.h>
#include <stdio.h>
#include "shielded-pads.h"
#include "shielded-field.h"
#define MB_GROUPS 3
#define MB_INDICES 4
#define MB_FILE_NAME "4d41534b42454e43482d5055424c4943-0-4.pads"      /* <seed_id hex>-<index0>-<count>.pads */
static const int64_t mb_widths[MB_GROUPS] = { 5120, 34816, 248320 };
static const uint8_t mb_seed_id[16] = { 'M','A','S','K','B','E','N','C','H','-','P','U','B','L','I','C' };
static const uint8_t mb_model_digest[32] = { 0x4d,0x41,0x53,0x4b,0x42,0x45,0x4e,0x43,0x48,0x2d,0x50,0x55,0x42,0x4c,0x49,0x43,0x2d,0x4d,0x4f,0x44,0x45,0x4c,0x2d,0x44,0x49,0x47,0x45,0x53,0x54,0x2d,0x30,0x31 };
static const uint8_t mb_consumer_sk[32] = { 0x70,0x75,0x62,0x6c,0x69,0x63,0x2d,0x6d,0x61,0x73,0x6b,0x62,0x65,0x6e,0x63,0x68,0x2d,0x63,0x6f,0x6e,0x73,0x75,0x6d,0x65,0x72,0x2d,0x6b,0x65,0x79,0x2d,0x30,0x31 };
/* balanced values in (-M/2, M/2], different per element, index and group */
static inline int32_t mb_value(uint64_t j, uint64_t index, uint32_t group) {
    const uint64_t v = (j * 7919u + index * 104729u + (uint64_t)group * 15485863u) % (uint64_t)SH_M_MOD;
    return (int32_t)((int64_t)v - SH_HALF_M);
}
static inline void mb_groups(sh_pads_group *groups) {
    memset(groups, 0, MB_GROUPS * sizeof *groups);
    for (uint32_t g = 0; g < MB_GROUPS; g++) { groups[g].group = g; groups[g].K = 5120; groups[g].u_len = (uint64_t)mb_widths[g]; snprintf(groups[g].name, sizeof groups[g].name, "maskbench.g%u.weight", g); }
}
#endif
