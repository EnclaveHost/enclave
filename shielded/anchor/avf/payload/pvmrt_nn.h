/* pvmrt_nn.h -- the verified in-VM engine as the app runtime sees it (PVM-CPU.md, "The app runtime", milestone 3).
 * The C mirror of runtime/pvm-rt/src/nn.rs NnOps: engine_local.cpp fills it over its loaded, self-tested model and hands
 * it to the payload, which passes it to pvmrt_run_app; the component reaches the model only through wasi:nn. The layout is
 * checked on both sides (the asserts below; pvm-rt tests/nn.rs). Every function is required.
 *   tokenize  llama_tokenize, add_special off, parse_special on: the id count, -needed when cap is too small, INT32_MIN
 *             on failure
 *   piece     one token's bytes (special tokens as text): the byte count, or -needed when cap is too small
 *   reset     clear the sequence (KV): 0
 *   decode    append n ids to the sequence and write the LAST position's n_vocab logits: 0, non-zero on failure (the
 *             sequence is then in an unknown state; the runtime refuses further use of that context) */
#ifndef PVMRT_NN_H
#define PVMRT_NN_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
typedef struct {
    void *engine;
    int32_t n_vocab, n_ctx;
    int32_t (*tokenize)(void *engine, const uint8_t *text, int32_t len, int32_t *out, int32_t cap);
    int32_t (*piece)(void *engine, int32_t id, uint8_t *buf, int32_t cap);
    int32_t (*reset)(void *engine);
    int32_t (*decode)(void *engine, const int32_t *ids, int32_t n, float *logits);
} pvmrt_nn_ops;
#ifdef __cplusplus
}
static_assert(sizeof(pvmrt_nn_ops) == 48 && offsetof(pvmrt_nn_ops, tokenize) == 16 && offsetof(pvmrt_nn_ops, decode) == 40, "pvmrt_nn_ops is nn.rs NnOps");
#else
_Static_assert(sizeof(pvmrt_nn_ops) == 48 && offsetof(pvmrt_nn_ops, tokenize) == 16 && offsetof(pvmrt_nn_ops, decode) == 40, "pvmrt_nn_ops is nn.rs NnOps");
#endif
/* engine_local.cpp: set before engine_local_main; the engine then calls host(ops, arg) after its self-test instead of
 * serving the chat port, and returns host's result */
typedef int (*pvmrt_nn_host_fn)(const pvmrt_nn_ops *ops, void *arg);
#endif
