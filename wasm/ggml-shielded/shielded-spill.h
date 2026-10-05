/* shielded-spill.h -- the disk tier behind the pad rings (SHIELDED_PAD_SPILL).
 *
 * A pad is one-time: a mask row r and u = r.W, consumed by exactly one
 * exchange. The ring keeps SHIELDED_POOL_DEPTH of them per group in private
 * RAM and the refill threads mint more as it drains -- at the refill rate,
 * which is what a long prompt waits on, since a prompt takes one pad per group
 * per token. The spill is a much larger store the same threads fill while the
 * link is idle, on a disk the HOST attaches, so a prompt that arrives later
 * imports its pads (a read and an AEAD open) instead of minting them (a pass
 * over the group's weights per batch).
 *
 * The host owns the disk and is not trusted, so nothing on it is usable to it:
 *   - u is sealed (ChaCha20-Poly1305) under a key drawn at attach time that
 *     never leaves this process. r is never written at all: it is regenerated
 *     from a second in-memory key and the write id, by the same sampler the
 *     link's own mask bank uses.
 *   - every write gets a fresh write id, which is its nonce, and the write id a
 *     slot is expected to hold lives only in memory. A replayed, stale or
 *     moved ciphertext does not open.
 *   - the caller takes a pad off the store BEFORE reading it (rule 1, as in the
 *     ring), so no slot is imported twice.
 *   - nothing survives the process: after a restart the keys are gone and the
 *     disk holds noise.
 * The host can still refuse, withhold or corrupt the disk. Any failure turns
 * the spill off for the link, which then mints exactly as it did without one.
 *
 * The device is handed over by the guest's init as an open descriptor,
 * SHIELDED_PAD_SPILL=fd:N, read-write, used with O_DIRECT so the store never
 * occupies the guest's page cache. Links share it by partition
 * (SHIELDED_PAD_SPILL_PARTS, default 2: one per card). */
#ifndef SHIELDED_SPILL_H
#define SHIELDED_SPILL_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct sh_spill sh_spill;

/* The mask sampler: n values in [0, M) from ChaCha20 under `key`, starting at
 * block `counter`. NULL selects the scalar form; the AVX-512 one
 * (SHIELDED_MASK_CHACHA16) produces the identical values. */
typedef void (*sh_spill_stream_fn)(const uint32_t *key, uint64_t counter, int32_t *dst, size_t n);

/* Write ids are below this: the mask stream for id w starts at block w << 24. */
#define SH_SPILL_WID_LIMIT (UINT64_C(1) << 40)

/* Claim a partition of the process's spill device for one link and cut it into
 * `n` per-group regions with the same slot count. `fingerprint` names the
 * registration the layout is for (see sh_spill_fits). NULL with why[0] == 0:
 * no device configured, which is not an error. NULL with why set: configured
 * but unusable. */
sh_spill *sh_spill_attach(const int64_t *K, const int64_t *u_len, size_t n, uint64_t fingerprint,
                          sh_spill_stream_fn stream, char *why, size_t why_cap);
/* Release the partition and forget the keys. */
void      sh_spill_detach(sh_spill *s);
/* Whether this layout was cut for the same registration. */
bool      sh_spill_fits(const sh_spill *s, size_t n, uint64_t fingerprint);
uint32_t  sh_spill_slots(const sh_spill *s);          /* per group */
int       sh_spill_part(const sh_spill *s);
uint64_t  sh_spill_bytes(const sh_spill *s);          /* the partition's size */
uint64_t  sh_spill_row_bytes(const sh_spill *s);      /* one slot of every group */
/* An I/O buffer for sh_spill_write/sh_spill_read, aligned for O_DIRECT; free()
 * it. One per thread: the calls use it as scratch. NULL when out of memory. */
uint8_t  *sh_spill_io_alloc(const sh_spill *s);

/* The K mask values of the pad with write id `wid` (< SH_SPILL_WID_LIMIT). */
void sh_spill_mask(const sh_spill *s, uint64_t wid, int32_t *r, int64_t K);

/* Seal and write b pads of group g to slots slot0, slot0+1, ... (modulo the
 * slot count): u is b rows of the group's u_len balanced values, wid[i] the
 * write id of row i. SH_ERR_RANGE when a value is outside (-M/2, M/2],
 * SH_ERR_IO when the device refuses. */
int sh_spill_write(const sh_spill *s, size_t g, uint32_t slot0, int b,
                   const uint64_t *wid, const int32_t *u, uint8_t *io);
/* Read and open b pads of group g from slot0, ... that were written with
 * wid[0..b): u rows (balanced) into u_out, mask rows into r_out (K each).
 * SH_ERR_VERIFY when any slot does not open as exactly that write. */
int sh_spill_read(const sh_spill *s, size_t g, uint32_t slot0, int b,
                  const uint64_t *wid, int32_t *r_out, int32_t *u_out, uint8_t *io);

/* A link's spill, as shielded-tee.c runs it: whether one is attached or was
 * turned off, slots per group, rows = the fewest ready pads in any group (the
 * prompt tokens it can serve whole), pads written, imported by refills,
 * imported on the request path, failures. */
typedef struct {
    bool     attached, off;
    uint64_t slots, rows, written, imported, onpath, failed;
} sh_link_spill;
struct sh_link;
void sh_link_spill_stats(struct sh_link *l, sh_link_spill *out);

#ifdef __cplusplus
}
#endif

#endif
