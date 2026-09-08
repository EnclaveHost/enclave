#ifndef SHIELDED_PADS_V3_H
#define SHIELDED_PADS_V3_H

#include "shielded-pad-manifest.h"

#ifdef __cplusplus
extern "C" {
#endif

/* Standalone sparse file API. No engine, dealer loop, relay or receipt path
 * currently calls it. The caller MUST already have admitted this immutable
 * complete manifest and seed binding and authenticated the reserved window.
 * Passing a struct/digest is not authorization or proof of asset provenance.
 * An ephemeral sender can wrap its own key to a public recipient key: a valid
 * box does not establish dealer identity or the mathematical correctness of u.
 * All open-call inputs are stable private snapshots; outputs do not alias them.
 * Neither reading a cell nor authenticating metadata authorizes mask reuse.
 */
typedef struct {
    const sh_pads_manifest *manifest;
    uint8_t seed_id[16];
    uint64_t reserved_lo, reserved_hi;
    uint64_t max_file_bytes, max_cell_bytes; /* mandatory trusted policy caps */
} sh_pads_v3_policy;

typedef struct sh_pads_v3_writer sh_pads_v3_writer;
typedef struct sh_pads_v3_reader sh_pads_v3_reader;

/* directory_fd names an already opened TRUSTED writer directory, with no
 * concurrent removal/replacement of this writer's temporary entries. It must
 * support hard links and directory fsync, like the v2 dealer store.
 * name is one new component;
 * the writer duplicates the directory fd and never follows a final symlink.
 * spans has exactly policy->manifest->group_count entries. All canonical
 * groups appear, including zero spans; an all-empty shipment is refused.
 * Fresh encryption key per file does not permit reusing a mask domain.
 */
sh_pads_v3_writer *sh_pads_v3_writer_open(int directory_fd, const char *name,
        const sh_pads_v3_policy *policy, const sh_pads_span *spans,
        const uint8_t consumer_pk[32], int *err);
size_t sh_pads_v3_writer_scratch_bytes(const sh_pads_v3_writer *writer);
/* cell uses shared scratch and must be serialized. The last plaintext stays
 * in that private scratch until finish/abort wipes it. cell_with permits parallel
 * distinct cells using disjoint caller scratch, each >= scratch_bytes. Atomic
 * nonce claims reject repeats. u_count must equal this group's output extent.
 * The caller owns and must clear the private scratch passed to cell_with.
 * Every cell failure poisons the writer; no changed plaintext is re-encrypted
 * under a previously claimed nonce. Inputs and scratch must not overlap.
 */
int sh_pads_v3_writer_cell(sh_pads_v3_writer *writer, uint32_t canonical_group,
        uint64_t index, const int32_t *u, size_t u_count);
int sh_pads_v3_writer_cell_with(sh_pads_v3_writer *writer, uint32_t canonical_group,
        uint64_t index, const int32_t *u, size_t u_count,
        uint8_t *plain, uint8_t *box, size_t scratch_bytes);
/* No cell call may remain in flight. Both calls consume the writer.
 * finish requires all declared cells, file fsync/close, no-replace publication
 * and directory fsync. published is set to whether the final name was linked:
 * an I/O failure AFTER that point requires reconciliation, never blind remint.
 * abort attempts to remove only its temporary file and always clears memory;
 * filesystem failure can leave a temporary entry requiring reconciliation.
 */
int sh_pads_v3_writer_finish(sh_pads_v3_writer *writer, bool *published);
void sh_pads_v3_writer_abort(sh_pads_v3_writer *writer);

/* Duplicate and retain this already opened regular-file fd. Opening admits
 * authenticated metadata and exact canonical layout, not the integrity of
 * every unread ciphertext or the correctness of its r.W. The trusted importer
 * still verifies each cell's r.W and respects its own irreversible cursors.
 */
sh_pads_v3_reader *sh_pads_v3_reader_open(int fd, const sh_pads_v3_policy *policy,
        const uint8_t consumer_sk[32], int *err);
/* Independent calls can run concurrently. Close must wait for them. Missing or
 * invalid cells fail without changing u. Successful repeat reads are allowed;
 * the consumer's signed-window/cursor protocol separately forbids mask reuse.
 */
int sh_pads_v3_reader_cell(const sh_pads_v3_reader *reader,
        uint32_t canonical_group, uint64_t index, int32_t *u, size_t u_count);
int sh_pads_v3_reader_span(const sh_pads_v3_reader *reader,
        uint32_t canonical_group, sh_pads_span *span);
void sh_pads_v3_reader_close(sh_pads_v3_reader *reader);

#ifdef __cplusplus
}
#endif
#endif
