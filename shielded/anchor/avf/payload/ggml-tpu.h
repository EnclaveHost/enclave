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
    uint64_t outlier_entries, saturated;             /* entries kept in the VM (beyond their lane) | replies on the int16 rail */
    uint64_t bank_min;                               /* pads left in the emptiest group */
} ggml_backend_tpu_stats_t;
struct ggml_backend_reg;
struct ggml_backend_reg *ggml_backend_tpu_reg(void);
int    ggml_backend_tpu_open_bundle(const char *path);         /* 0 = ok */
void   ggml_backend_tpu_set_link(int fd, int rows_max);        /* the worker connection; rows_max = the compiled signatures' row count */
int    ggml_backend_tpu_claims(const char *tensor_name);       /* 1 when the bundle covers this weight (the engine keeps those in plain host buffers) */
double ggml_backend_tpu_mint(int positions, int threads);      /* fill every group's bank; returns seconds */
void   ggml_backend_tpu_get_stats(ggml_backend_tpu_stats_t *out, int reset);
int    ggml_backend_tpu_reference_worker(int fd);              /* the exact integer worker, for host tests: what the TPU is required to compute */
#ifdef __cplusplus
}
#endif
#endif
