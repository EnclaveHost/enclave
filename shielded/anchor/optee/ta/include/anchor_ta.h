/* anchor_ta.h -- UUID and command surface of the anchor spike TA. */
#ifndef ANCHOR_TA_H
#define ANCHOR_TA_H

#define TA_ANCHOR_UUID \
    { 0x6e3f9c52, 0x8d41, 0x4c07, \
        { 0x9a, 0xb2, 0x5e, 0xd0, 0x1a, 0x84, 0x7c, 0x33 } }

/* SETUP: p0 memref-in weights blob
 *          [u32 n_nodes][n x (u32 K, u32 N)][w_fixed bytes, (N,K) each]
 *        p1 value-out  a = core footprint in KiB, b = heap high-water 0 (unused)
 * Creates the core, registers the weights, draws the Freivalds secrets. */
#define TA_ANCHOR_CMD_SETUP  0

/* PAD: stage one pad (r from the ChaCha20 bank, u = r.W). No params. */
#define TA_ANCHOR_CMD_PAD    1

/* MASK: p0 value-in a = x seed, b = iteration index
 *       p1 memref-out the three residue planes (3*K bytes, ciphertext)
 * The plaintext activation is generated INSIDE the TA from (seed, index) --
 * a deterministic test fixture -- so no plaintext transits normal world. */
#define TA_ANCHOR_CMD_MASK   2

/* FINISH: p0 memref-in the worker's reply (ciphertext)
 *         p1 value-in a = ywidth (3 or 4)
 *         p2 value-out a = verified (1/0), b = exact vs TA-local int64 (1/0)
 * Unmask + integer Freivalds + bit-equality against the TA's own product. */
#define TA_ANCHOR_CMD_FINISH 3

/* NOP: the world-switch + parameter-marshal baseline. */
#define TA_ANCHOR_CMD_NOP    4

/* STATS: p0 value-out a = pads issued, b = verify failures. */
#define TA_ANCHOR_CMD_STATS  5

#endif
