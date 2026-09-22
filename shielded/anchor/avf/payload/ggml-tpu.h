/* ggml-tpu.h -- the Shielded-TPU backend's C surface (ggml-tpu.cpp, TPU.md). Bound by name from the engine, like the shielded module. */
#ifndef GGML_TPU_H
#define GGML_TPU_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    uint64_t exchanges, rows, bytes_out, bytes_in;
    uint64_t mask_us, link_us, unmask_us;            /* per-exchange wall time: build the masked rows | write + the worker + read | subtract the pads */
    uint64_t pads_minted_inline, mint_inline_us;     /* pads the bank did not have: minted inside a decode step */
    uint64_t mint_bank_us, pads_redrawn;
    uint64_t outlier_entries, saturated;
    uint64_t sat_clipped, sat_max_excess, sat_hi, sat_lo;   /* which digit railed: lo has only 1.25x headroom by DIGIT_OUT_DIV, hi has 2.5x */            /* of `saturated`: how many were GENUINE clips (exact value past the rail), and by how much */
    uint64_t ver_n, ver_bad, ver_max;                /* backend-vs-reference: elements compared, disagreements, worst |diff| in LSB */
    double   ver_sq;                                 /* sum of squared differences, for an RMS */
    uint64_t rail_m32768, rail_m32767, rail_p32767;  /* which rail values the backend ACTUALLY returns */
    uint64_t sat_repaired;                           /* 1 when the build actually substitutes the exact value (kRepairClips) */
    double   sat_max_err_lsb;                        /* the worst error a clip put into y, in output LSBs */             /* entries kept in the VM (beyond their lane) | replies on the int16 rail */
    uint64_t bank_min;                               /* pads left in the emptiest group */
    uint64_t pads_refilled;                          /* pads the background minters added */
    uint64_t spin_us;                                /* of link_us, time spent spinning on the reply instead of sleeping for it */
    uint64_t rx_calls;                               /* read()s to collect the replies: >1 per exchange means the reply is arriving in chunks */
    uint64_t window_mint_us;                         /* pad minting done inside the link window, off the critical path */
    uint64_t corr_us, wait_us;                       /* of link_us: the out-of-lane correction run while the request is in flight, and what was left of the window */
} ggml_backend_tpu_stats_t;
struct ggml_backend_reg;
struct ggml_backend_reg *ggml_backend_tpu_reg(void);
int    ggml_backend_tpu_open_bundle(const char *path);         /* 0 = ok */
double ggml_backend_tpu_warm_bundle(int threads, int *locked); /* page the bundle in and try to mlock it; returns seconds */
void   ggml_backend_tpu_set_link(int fd, int rows_max);        /* the worker connection; rows_max = the compiled signatures' row count */
int    ggml_backend_tpu_claims(const char *tensor_name);       /* 1 when the bundle covers this weight (the engine keeps those in plain host buffers) */
double ggml_backend_tpu_mint(int positions, int threads);      /* fill every group's bank; returns seconds */
long   ggml_backend_tpu_mint_check(int batch);                 /* batched minter vs the scalar reference over every group: differing values, 0 = exact */
double ggml_backend_tpu_mint_bench(int positions, int threads, int scalar); /* minting alone, pads dropped; returns seconds */
void   ggml_backend_tpu_refill_start(int target, int threads); /* keep every bank at `target` pads from background threads */
void   ggml_backend_tpu_refill_stop(void);
void   ggml_backend_tpu_window_mint(int target, int chunk);
void   ggml_backend_tpu_link_buf(uint64_t *before, uint64_t *after);  /* the vsock credit window, before and after widening */
void   ggml_backend_tpu_ping_bench(int reps);   /* reply-size sweep through the real link, TPU excluded */  /* mint inside the link window: bank target, pads per batch (0 = off) */
void   ggml_backend_tpu_get_stats(ggml_backend_tpu_stats_t *out, int reset);
int    ggml_backend_tpu_reference_worker(int fd);              /* the exact integer worker, for host tests: what the TPU is required to compute */
#ifdef __cplusplus
}
#endif
#endif
