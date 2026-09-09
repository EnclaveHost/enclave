/* PUBLIC encoded-weight artifacts beneath the pVM's held directory (shielded/anchor/avf/CATALOG.md and
 * encoded-artifact-delivery-design.md). A file is named "<64 lowercase hex>.i8": its own content digest, as an
 * authenticated EWCAT001 entry lists it. The catalog is the authority; a file's presence, name or size is never
 * more than an availability hint, and every consumer block-verifies what it reads. Everything here is scoped to a
 * directory descriptor (openat/O_NOFOLLOW): no host-supplied path is ever used, no raw tensor name is ever a file
 * name, and a malformed or unauthenticated catalog can neither admit nor delete anything. */
#ifndef ANCHOR_ARTIFACTS_H
#define ANCHOR_ARTIFACTS_H
#include "anchor_encoded_catalog.h"
#include <stddef.h>
#include <stdint.h>
#include <sys/types.h>
#ifdef __cplusplus
extern "C" {
#endif
#define ANCHOR_ARTIFACT_NAME_LEN 67                     /* 64 hex + ".i8" */
void anchor_artifact_name(const uint8_t sha256[32], char out[ANCHOR_ARTIFACT_NAME_LEN + 1]);
/* The entry whose encoded digest equals `sha256`; NULL when the catalog is not authenticated or lists no such digest. */
const anchor_encoded_entry *anchor_artifact_entry(const anchor_encoded_catalog *cat, const uint8_t sha256[32]);
/* Admission of an offered name: the entry the name spells, only when the catalog is authenticated and the announced
 * size equals the entry's bytes. NULL otherwise, with `*why` a static explanation. Called before any byte is taken. */
const anchor_encoded_entry *anchor_artifact_admit(const anchor_encoded_catalog *cat, const char *name, uint64_t bytes, const char **why);
/* 1 = a regular file of exactly `bytes` sits under `name`; 0 = nothing under that name; -1 = something else (another
 * size, a link, a directory, a FIFO or device, unreadable): a new offer replaces it. Opens never follow links and
 * never block (O_NOFOLLOW|O_NONBLOCK, then fstat). Availability only: nothing here is verified. */
int anchor_artifact_have(int dirfd, const char *name, uint64_t bytes);
/* read(2) semantics: > 0 bytes delivered, 0 = the stream ended, < 0 = error with errno (EINTR/EAGAIN are retried). */
typedef ssize_t (*anchor_artifact_reader)(void *ctx, void *buf, size_t n);
typedef enum {
    ANCHOR_ARTIFACT_OK = 0, ANCHOR_ARTIFACT_E_ARGS = 1, ANCHOR_ARTIFACT_E_OPEN = 2, ANCHOR_ARTIFACT_E_READ = 3,
    ANCHOR_ARTIFACT_E_SHORT = 4, ANCHOR_ARTIFACT_E_WRITE = 5, ANCHOR_ARTIFACT_E_BLOCK = 6, ANCHOR_ARTIFACT_E_PUBLISH = 7
} anchor_artifact_rc;
typedef struct { uint64_t got; uint64_t bad_block; int err_no; } anchor_artifact_receipt;
/* Optional, non-overlapping wall-clock breakdown. Read includes waiting for the sender;
 * writes count write_all batches, not individual write(2) calls. Body total begins
 * after temporary-file creation/allocation and includes final publication/cleanup.
 * These timings never establish CPU utilization. A nonzero clock_errors invalidates
 * the timing data. Existing callers incur no additional clock reads. */
typedef struct {
    uint64_t read_ns, write_ns, hash_ns, file_sync_ns, publish_ns, body_total_ns;
    uint64_t read_calls, write_batches, read_bytes, clock_errors;
} anchor_artifact_profile;
/* Receives exactly e->bytes through `rd` into ".<name>.tmp" beneath dirfd. `name` must spell e->encoded_sha256 (E_ARGS
 * before anything is created or unlinked otherwise). Every 1 MiB block is hashed with `h` and
 * compared with the catalog's digest the moment it completes; the first mismatch ends the reception (E_BLOCK,
 * r->bad_block). Only a file whose every block matched is fsynced, renamed over `name`, and the directory fsynced
 * (OK). On every other outcome the temp file is gone and a file ALREADY published under `name` is untouched (a
 * failed re-offer never costs the earlier verified copy). Bounds: EAGAIN from the reader is a timeout (E_READ,
 * err_no EAGAIN: the caller's socket timeout is the per-read bound), EINTR is retried a bounded number of times,
 * and max_ms > 0 bounds the WHOLE reception on the monotonic clock (E_READ, err_no ETIMEDOUT). `r` may be NULL. */
int anchor_artifact_receive(int dirfd, const char *name, const anchor_encoded_entry *e, const anchor_hash_ops *h,
                            anchor_artifact_reader rd, void *ctx, unsigned max_ms, anchor_artifact_receipt *r);
/* Same admission, verification and publication semantics; profile==NULL disables
 * additional timing. The profile is zeroed on entry, including rejected arguments. */
int anchor_artifact_receive_profiled(int dirfd, const char *name, const anchor_encoded_entry *e, const anchor_hash_ops *h,
                            anchor_artifact_reader rd, void *ctx, unsigned max_ms, anchor_artifact_receipt *r,
                            anchor_artifact_profile *profile);
/* Bounded, directory-scoped sweep after a VERIFIED admission: unlinks ".<artifact>.tmp" leftovers, artifact names the
 * catalog does not list, and catalog-named entries that are not a regular file of the listed size. Touches no other
 * name (the model, pads and prefix assets never live here anyway). Returns the number removed; -1 when the catalog
 * is not authenticated (nothing touched) or the directory cannot be listed. */
int anchor_artifact_sweep(int dirfd, const anchor_encoded_catalog *cat);
enum { ANCHOR_ARTIFACT_PRESENT = 0, ANCHOR_ARTIFACT_ABSENT = 1, ANCHOR_ARTIFACT_INVALID = 2 };
/* The use-time open for the engine's hook: read-only, O_NOFOLLOW, a regular file of exactly `bytes`. Returns the
 * descriptor with *state PRESENT; -1 with *state ABSENT (nothing under the name) or INVALID (a link, a directory,
 * another size, unreadable) and *err_no the errno that decided it (0 for a size/type mismatch). */
int anchor_artifact_open(int dirfd, const uint8_t sha256[32], uint64_t bytes, int *state, int *err_no);
/* The same, waiting up to wait_ms (polling every poll_ms, each sleep capped to the time remaining, monotonic clock)
 * for a delivery still in flight: ABSENT becomes a bounded wait; INVALID and PRESENT return at once. wait_ms 0 = a
 * single attempt. */
int anchor_artifact_open_wait(int dirfd, const uint8_t sha256[32], uint64_t bytes, unsigned wait_ms, unsigned poll_ms, int *state, int *err_no);
#ifdef __cplusplus
}
#endif
#endif
