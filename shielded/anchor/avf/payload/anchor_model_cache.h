/* The retained-model decision of the model stage (anchor_payload.c model_file), pure so a host fixture can prove that a
 * cache-only miss changes NOTHING in the store. Reuse iff <dir>/model.gguf opens O_RDONLY|O_NOFOLLOW|O_NONBLOCK as a regular
 * file whose fstat size is exactly `bytes` AND <dir>/model.gguf.sha256 is a regular file holding EXACTLY `tag` (64 lowercase hex)
 * optionally followed by one '\n' and nothing else. The tag is a transfer hint only: the payload's catalog/whole-file admission
 * still judges the bytes it reuses. Every read here is bounded and never blocks (no FIFO, no link is followed). */
#ifndef ANCHOR_MODEL_CACHE_H
#define ANCHOR_MODEL_CACHE_H
#include <stddef.h>
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif
enum { ANCHOR_MODEL_REUSE = 0, ANCHOR_MODEL_MISS_ABSENT = 1, ANCHOR_MODEL_MISS_SIZE = 2, ANCHOR_MODEL_MISS_NO_TAG = 3, ANCHOR_MODEL_MISS_TAG = 4,
       ANCHOR_MODEL_MISS_NOT_REGULAR = 5, ANCHOR_MODEL_MISS_UNREADABLE = 6, ANCHOR_MODEL_MISS_ARGS = 7 };
/* Read-only verdict (the model is opened O_RDONLY|O_NOFOLLOW|O_NONBLOCK and fstat-checked, then closed; the tag is read through
 * a held, fstat-checked regular descriptor, at most 80 bytes). `why` gets a static sentence. */
int anchor_model_retained(const char *dir, uint64_t bytes, const char *tag, const char **why);
/* The model stage's file decision with an explicit cache-only rule:
 *   REUSE              -> returns the very descriptor the verdict was taken on (regular, exact size, read-only), *existing = 1
 *   miss, !cache_only  -> today's behaviour: the tag is unlinked, the model file is created/truncated and sized, *existing = 0
 *   miss,  cache_only  -> returns -2 and TOUCHES NOTHING (no unlink, no O_TRUNC, no create)
 * -1 = the truncate/open of the default path failed (errno set). `verdict` receives the ANCHOR_MODEL_* value in every case;
 * a reuse whose open fails is MISS_UNREADABLE, never REUSE. */
int anchor_model_open(const char *dir, uint64_t bytes, const char *tag, int cache_only, int *existing, int *verdict);
/* The purge decision of a REJECTED model (whole-file parse/pin/grant failure after reception): today it unlinks <dir>/model.gguf
 * and its tag so a lying stream cannot be answered 'K' later. Under cache_only NOTHING is removed (the retained file was not
 * received in this run; the refusal is reported and the store stays as it was). Returns the number of entries unlinked. */
int anchor_model_purge(const char *dir, int cache_only);
#ifdef __cplusplus
}
#endif
#endif
