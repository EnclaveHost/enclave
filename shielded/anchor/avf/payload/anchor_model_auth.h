/* Versioned model-authentication capability between the payload and libengine.so (CATALOG.md,
 * encoded-artifact-delivery-design.md s.4). The payload fills it; the engine takes it through
 * engine_set_model_auth_v1 (0 = taken). A payload in catalog mode REFUSES an engine that lacks the symbol or
 * returns non-zero: an engine that cannot say how the model was authenticated must not run it. Mode 1 keeps
 * the older engine_set_model_table call; this struct is only used for mode 2. Pointers borrowed here stay
 * valid for the life of the process: the payload's catalog admission is immutable and never freed. */
#ifndef ANCHOR_MODEL_AUTH_H
#define ANCHOR_MODEL_AUTH_H
#include "anchor_gguf.h"
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
#define ANCHOR_MODEL_AUTH_VERSION 1u
#define ANCHOR_MODEL_AUTH_WHOLE_FILE 1u          /* whole-file SHA-256 scan at the stage: table.has_whole == 1 */
#define ANCHOR_MODEL_AUTH_CATALOG_V1 2u          /* AGCAT001 admission: private header + measured catalog; table.has_whole == 0 */
struct anchor_encoded_catalog_s;                 /* anchor_encoded_catalog (opaque here: the engine's hook only borrows entries) */
/* The engine's artifact reads (mode 2 with an encoded catalog): open the artifact named by its encoded-content digest
 * beneath the payload's held directory, waiting up to wait_ms for a delivery in flight. Returns a read-only descriptor
 * (caller closes) with *state 0 = PRESENT, or -1 with *state 1 = ABSENT (nothing delivered within wait_ms) or
 * 2 = INVALID (present but not a regular file of `bytes`). The engine never sees a path. */
typedef int (*anchor_artifact_open_fn)(void *ctx, const uint8_t sha256[32], uint64_t bytes, unsigned wait_ms, int *state);
/* The engine names the artifact the backend reported as FAILING a verified read (at registration or at a later block
 * read), so the payload can remove THAT file (a public, re-deliverable artifact; never the model) and the next cycle
 * re-delivers it instead of answering 'H' forever. Never a guess from ordering. */
typedef void (*anchor_artifact_suspect_fn)(void *ctx, const uint8_t sha256[32]);
typedef struct {
    uint32_t size;                               /* sizeof(anchor_model_auth_v1): a mismatch is refused */
    uint32_t version;                            /* ANCHOR_MODEL_AUTH_VERSION */
    uint32_t mode;                               /* ANCHOR_MODEL_AUTH_* */
    uint32_t reserved;
    const anchor_gguf_table *table;              /* the authenticated tensor table (mode 2: from the catalog, has_whole 0) */
    const anchor_hash_ops *hops;
    uint8_t model_identity[32];                  /* mode 1: the whole-file digest; mode 2: the catalog's authenticated model identity */
    uint8_t source_catalog_sha256[32];           /* mode 2: the measured AGCAT001 identity; zero in mode 1 */
    uint8_t encoded_catalog_sha256[32];          /* zero unless `encoded` is set */
    const void *encoded;                         /* const anchor_encoded_catalog *: NULL = no encoded artifacts this session */
    anchor_artifact_open_fn artifact_open;       /* required iff encoded */
    anchor_artifact_suspect_fn artifact_suspect; /* optional */
    void *ctx;
} anchor_model_auth_v1;
/* The engine's admission of the struct, pure so a host fixture can exercise it: 0 = usable; otherwise the reason. */
enum { ANCHOR_MODEL_AUTH_OK = 0, ANCHOR_MODEL_AUTH_E_NULL = 1, ANCHOR_MODEL_AUTH_E_SIZE = 2, ANCHOR_MODEL_AUTH_E_VERSION = 3, ANCHOR_MODEL_AUTH_E_MODE = 4,
       ANCHOR_MODEL_AUTH_E_TABLE = 5, ANCHOR_MODEL_AUTH_E_WHOLE = 6, ANCHOR_MODEL_AUTH_E_ENCODED = 7 };
static inline int anchor_model_auth_check(const anchor_model_auth_v1 *a) {
    if (!a) return ANCHOR_MODEL_AUTH_E_NULL;
    if (a->size != sizeof(anchor_model_auth_v1)) return ANCHOR_MODEL_AUTH_E_SIZE;
    if (a->version != ANCHOR_MODEL_AUTH_VERSION) return ANCHOR_MODEL_AUTH_E_VERSION;
    if (a->mode != ANCHOR_MODEL_AUTH_WHOLE_FILE && a->mode != ANCHOR_MODEL_AUTH_CATALOG_V1) return ANCHOR_MODEL_AUTH_E_MODE;
    if (!a->table || !a->hops || !a->hops->init || !a->hops->update || !a->hops->final || !a->table->t || !a->table->n) return ANCHOR_MODEL_AUTH_E_TABLE;
    if (a->mode == ANCHOR_MODEL_AUTH_CATALOG_V1 && a->table->has_whole) return ANCHOR_MODEL_AUTH_E_WHOLE;      /* a catalog table never claims a whole-file scan */
    if (a->mode == ANCHOR_MODEL_AUTH_WHOLE_FILE && !a->table->has_whole) return ANCHOR_MODEL_AUTH_E_WHOLE;     /* and a whole-file mode must carry one */
    if (a->encoded && !a->artifact_open) return ANCHOR_MODEL_AUTH_E_ENCODED;                                   /* artifacts need a way to be opened */
    return ANCHOR_MODEL_AUTH_OK;
}
#ifdef __cplusplus
}
#endif
#endif
