/* MASKBENCH comparator: the EXISTING 3-byte cell import (pread + Poly1305 + ChaCha20 + unpack, sh_pads_reader_cell, exactly
 * what decode imports) timed on the PUBLIC shipment the build packaged as an APK asset, copied by this code into a fresh
 * directory of its own under the encrypted store. Speed probe only: no session seed, no live pads directory, no pad FV check,
 * nothing used for inference. Pure C, host-fixtured. */
#ifndef ANCHOR_MASKBENCH_H
#define ANCHOR_MASKBENCH_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef int64_t (*anchor_maskbench_clock_fn)(void);          /* monotonic microseconds */
typedef void (*anchor_maskbench_line_fn)(const char *);      /* one output line */
/* Copies the public shipment at `asset` (a regular file, <= 64 MiB) into mkdtemp("<store>/.maskbench-XXXXXX") under its
 * canonical name with checked writes + fsync (no link, no rename), opens it with the production reader, verifies EVERY
 * element of every cell against the public pattern (untimed) so the timed path cannot be a failure path, then times
 * sh_pads_reader_cell per group for ~1.5 s each under a 10 s whole bound (a case must span >= 1 s), printing one
 * CELL_IMPORT line per case, and removes exactly the file and directory it created (reader closed first).
 * Returns 0 = PASS with three CELL_IMPORT lines; 2 = refused/failed (a "CELL_IMPORT FAIL …" line says why). */
int anchor_maskbench_import(const char *store, const char *asset, anchor_maskbench_clock_fn clock_us, anchor_maskbench_line_fn line);
#ifdef __cplusplus
}
#endif
#endif
