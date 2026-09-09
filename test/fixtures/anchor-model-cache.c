/* anchor-model-cache: the model stage's retained-model decision (shielded/anchor/avf/payload/anchor_model_cache.[ch]) and the
 * MODEL-line cache token (anchor_auth.[ch]). The contract this guards: under cache=only a miss, a refusal, or a purge decision
 * leaves the model file and its tag byte-for-byte and metadata-identical (size, inode, mtime, ctime), a hit returns the very
 * fstat-verified descriptor, and the default (token absent) path still truncates and purges exactly as before. */
#define _GNU_SOURCE
#include "anchor_model_cache.h"
#include "anchor_auth.h"
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <time.h>
#include <errno.h>
static int checks = 0;
static uint64_t ms(void) { struct timespec t; clock_gettime(CLOCK_MONOTONIC, &t); return (uint64_t)t.tv_sec * 1000u + (uint64_t)t.tv_nsec / 1000000u; }
#define CHECK(c, what) do { const int _ok = (c) ? 1 : 0; checks++; fprintf(stderr, "check %d %s: %s\n", checks, _ok ? "ok" : "FAIL", what); if (!_ok) exit(1); } while (0)
/* a snapshot of the store: the COMPLETE model content (bounded 2000 bytes: every fixture model is <= 1000 B, the default-path resize
 * makes 2000 B), its size/inode/mtime/ctime, and the tag's content/size/inode/mtime/ctime; read without ever blocking (FIFO fixtures) */
typedef struct { struct stat model, tag; unsigned char content[2000]; size_t content_len; char tagtext[80]; size_t tag_len; int have_model, have_tag; } snap;
static void take(const char *d, snap *s) {
    char p[600], t[600]; snprintf(p, sizeof p, "%s/model.gguf", d); snprintf(t, sizeof t, "%s/model.gguf.sha256", d); memset(s, 0, sizeof *s);
    s->have_model = lstat(p, &s->model) == 0; s->have_tag = lstat(t, &s->tag) == 0;
    if (s->have_model && S_ISREG(s->model.st_mode)) { int fd = open(p, O_RDONLY | O_NONBLOCK | O_NOFOLLOW); if (fd >= 0) { ssize_t n; while ((n = read(fd, s->content + s->content_len, sizeof s->content - s->content_len)) > 0) s->content_len += (size_t)n; close(fd); } }
    if (s->have_tag && S_ISREG(s->tag.st_mode)) { int tf = open(t, O_RDONLY | O_NONBLOCK | O_NOFOLLOW); if (tf >= 0) { ssize_t n; while ((n = read(tf, s->tagtext + s->tag_len, sizeof s->tagtext - 1 - s->tag_len)) > 0) s->tag_len += (size_t)n; s->tagtext[s->tag_len] = 0; close(tf); } }
}
static int same_stat(const struct stat *a, const struct stat *b) {
    return a->st_size == b->st_size && a->st_ino == b->st_ino && a->st_mode == b->st_mode && a->st_mtim.tv_sec == b->st_mtim.tv_sec && a->st_mtim.tv_nsec == b->st_mtim.tv_nsec
        && a->st_ctim.tv_sec == b->st_ctim.tv_sec && a->st_ctim.tv_nsec == b->st_ctim.tv_nsec;
}
static int same(const snap *a, const snap *b) {
    return a->have_model == b->have_model && (!a->have_model || (same_stat(&a->model, &b->model) && a->content_len == b->content_len && a->content_len == (size_t)a->model.st_size && !memcmp(a->content, b->content, a->content_len)))
        && a->have_tag == b->have_tag && (!a->have_tag || (same_stat(&a->tag, &b->tag) && a->tag_len == b->tag_len && !memcmp(a->tagtext, b->tagtext, a->tag_len)));
}
static void put(const char *d, const char *name, const void *b, size_t n) { char p[600]; snprintf(p, sizeof p, "%s/%s", d, name); int fd = open(p, O_WRONLY | O_CREAT | O_TRUNC, 0600); CHECK(fd >= 0 && (n == 0 || write(fd, b, n) == (ssize_t)n), "fixture write"); close(fd); }
int main(void) {
    char d[300]; const char *td = getenv("TMPDIR") ? getenv("TMPDIR") : "/tmp"; CHECK(strlen(td) < 200 && snprintf(d, sizeof d, "%s/anchor-model-cache-XXXXXX", td) < (int)sizeof d, "TMPDIR fits"); CHECK(mkdtemp(d) != NULL, "workdir");
    const char *TAG = "c54f8b67069c70085b98440de696b44da8250250ac69a961b41133def876e262", *OTHER = "0000000000000000000000000000000000000000000000000000000000000001";
    unsigned char model[1000]; for (int i = 0; i < 1000; i++) model[i] = (unsigned char)(i * 31 + 7);
    const char *why; int existing = -1, verdict = -1; snap a, b;
    /* the cache token parser: a sibling of the auth token */
    CHECK(anchor_cache_token("MODEL 1 abc") == ANCHOR_CACHE_TOKEN_ABSENT, "no token = absent (today's path)");
    CHECK(anchor_cache_token("MODEL 1 abc cache=only") == ANCHOR_CACHE_TOKEN_ONLY, "cache=only");
    CHECK(anchor_cache_token("MODEL 1 abc auth=catalog cache=only") == ANCHOR_CACHE_TOKEN_ONLY, "with auth token");
    const char *bad[] = { "MODEL 1 cache=", "MODEL 1 cache=Only", "MODEL 1 cache=only,", "MODEL 1 cache=only cache=only", "MODEL 1 cache=onlyx", "MODEL 1 cache=no", "MODEL 1 cache= only", NULL };
    for (int i = 0; bad[i]; i++) CHECK(anchor_cache_token(bad[i]) == ANCHOR_CACHE_TOKEN_MALFORMED, bad[i]);
    CHECK(anchor_cache_token("MODEL 1 xcache=only") == ANCHOR_CACHE_TOKEN_ABSENT && anchor_cache_token(NULL) == ANCHOR_CACHE_TOKEN_MALFORMED, "near-miss is not the token; NULL malformed");
    /* absent model */
    CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_ABSENT, why);
    take(d, &a); CHECK(anchor_model_open(d, 1000, TAG, 1, &existing, &verdict) == -2 && existing == 0 && verdict == ANCHOR_MODEL_MISS_ABSENT, "cache-only on an empty store: refused"); take(d, &b);
    CHECK(access(d, F_OK) == 0 && !b.have_model && !b.have_tag, "cache-only created nothing");
    /* retained: exact size + matching tag */
    put(d, "model.gguf", model, sizeof model); put(d, "model.gguf.sha256", TAG, 64); { char nl[66]; snprintf(nl, sizeof nl, "%s\n", TAG); put(d, "model.gguf.sha256", nl, 65); }
    CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_REUSE, why);
    take(d, &a); { int fd = anchor_model_open(d, 1000, TAG, 1, &existing, &verdict); CHECK(fd >= 0 && existing == 1 && verdict == ANCHOR_MODEL_REUSE, "cache-only hit returns the retained file"); unsigned char h[8]; struct stat fs; CHECK(fstat(fd, &fs) == 0 && S_ISREG(fs.st_mode) && fs.st_size == 1000, "the returned descriptor is the fstat-verified regular file of exact size"); CHECK(read(fd, h, 8) == 8 && !memcmp(h, model, 8), "read-only view of the same bytes"); CHECK(write(fd, "x", 1) < 0, "the reused descriptor is read-only"); close(fd); }
    take(d, &b); CHECK(same(&a, &b), "a hit changes nothing");
    /* size differs: cache-only refuses and nothing changes; default path truncates (today's behaviour) */
    CHECK(anchor_model_retained(d, 1001, TAG, &why) == ANCHOR_MODEL_MISS_SIZE, why);
    take(d, &a); usleep(20000); CHECK(anchor_model_open(d, 1001, TAG, 1, &existing, &verdict) == -2 && existing == 0 && verdict == ANCHOR_MODEL_MISS_SIZE, "cache-only size miss: refused"); take(d, &b);
    CHECK(same(&a, &b), "cache-only size miss: model bytes, size, inode, mtime, ctime and tag all unchanged");
    /* tag differs */
    CHECK(anchor_model_retained(d, 1000, OTHER, &why) == ANCHOR_MODEL_MISS_TAG, why);
    take(d, &a); CHECK(anchor_model_open(d, 1000, OTHER, 1, &existing, &verdict) == -2 && verdict == ANCHOR_MODEL_MISS_TAG, "cache-only tag miss: refused"); take(d, &b); CHECK(same(&a, &b), "cache-only tag miss: everything unchanged");
    /* no tag */
    { char t[600]; snprintf(t, sizeof t, "%s/model.gguf.sha256", d); CHECK(unlink(t) == 0, "drop tag"); }
    CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_NO_TAG, why);
    take(d, &a); CHECK(anchor_model_open(d, 1000, TAG, 1, &existing, &verdict) == -2 && verdict == ANCHOR_MODEL_MISS_NO_TAG, "cache-only no-tag miss: refused"); take(d, &b); CHECK(same(&a, &b), "cache-only no-tag miss: model unchanged");
    /* a tag with trailing junk is NOT a tag (exact 64 hex + optional newline); a FIFO under the tag name never blocks */
    { char t[600]; snprintf(t, sizeof t, "%s/model.gguf.sha256", d); char junk[80]; snprintf(junk, sizeof junk, "%s\nx", TAG); put(d, "model.gguf.sha256", junk, strlen(junk));
      CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_NO_TAG, "tag with trailing junk is no tag");
      CHECK(unlink(t) == 0 && mkfifo(t, 0600) == 0, "fifo tag fixture"); { uint64_t t0 = ms(); CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_NO_TAG && ms() - t0 < 1000, "a FIFO under the tag name: no tag, no blocking"); }
      take(d, &a); CHECK(anchor_model_open(d, 1000, TAG, 1, &existing, &verdict) == -2 && verdict == ANCHOR_MODEL_MISS_NO_TAG, "cache-only with a FIFO tag: refused, untouched"); take(d, &b); CHECK(same(&a, &b) && b.have_tag, "the FIFO is still there (nothing unlinked)");
      CHECK(unlink(t) == 0, "fifo removed"); }
    /* a symlink under the model name is never followed for reuse */
    { char p[600], q[600]; snprintf(p, sizeof p, "%s/model.gguf", d); snprintf(q, sizeof q, "%s/real.gguf", d); CHECK(rename(p, q) == 0 && symlink("real.gguf", p) == 0, "symlink fixture"); { char nl[66]; snprintf(nl, sizeof nl, "%s\n", TAG); put(d, "model.gguf.sha256", nl, 65); }
      CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_UNREADABLE, why);
      CHECK(anchor_model_open(d, 1000, TAG, 1, &existing, &verdict) == -2 && verdict == ANCHOR_MODEL_MISS_UNREADABLE, "cache-only: a symlink is unreadable, refused, untouched");
      CHECK(unlink(p) == 0 && rename(q, p) == 0, "symlink fixture removed"); }
    /* arguments: over-long store path or a non-hex tag are refused before any path is built */
    { char longdir[600]; memset(longdir, 'a', 500); longdir[500] = 0; CHECK(anchor_model_retained(longdir, 1000, TAG, &why) == ANCHOR_MODEL_MISS_ARGS, "over-long dir refused before paths");
      CHECK(anchor_model_retained(d, 1000, "not-hex", &why) == ANCHOR_MODEL_MISS_NO_TAG && anchor_model_retained(d, 1000, NULL, &why) == ANCHOR_MODEL_MISS_NO_TAG, "non-hex / NULL tag = no tag");
      CHECK(anchor_model_open(longdir, 1000, TAG, 1, &existing, &verdict) == -2 && verdict == ANCHOR_MODEL_MISS_ARGS, "cache-only with bad args: refused");
      CHECK(anchor_model_open(longdir, 1000, TAG, 0, &existing, &verdict) == -1 && errno == EINVAL, "default path with bad args: -1/EINVAL, nothing built"); }
    /* the purge decision: a rejected model is removed today, but NEVER under cache-only (bytes, tag and metadata unchanged) */
    put(d, "model.gguf", model, sizeof model); { char nl[66]; snprintf(nl, sizeof nl, "%s\n", TAG); put(d, "model.gguf.sha256", nl, 65); }
    take(d, &a); usleep(20000); CHECK(anchor_model_purge(d, 1) == 0, "cache-only purge removes nothing"); take(d, &b); CHECK(same(&a, &b) && b.have_tag && b.content_len == 1000, "cache-only purge: model and tag byte/metadata-identical");
    CHECK(anchor_model_purge(d, 0) == 2, "default purge removes the model and its tag (today's behaviour)"); take(d, &b); CHECK(!b.have_model && !b.have_tag, "default purge: both gone");
    { char longdir[600]; memset(longdir, 'a', 500); longdir[500] = 0; CHECK(anchor_model_purge(longdir, 0) == 0 && anchor_model_purge(NULL, 0) == 0, "purge with bad args does nothing"); }
    put(d, "model.gguf", model, sizeof model); { char nl[66]; snprintf(nl, sizeof nl, "%s\n", TAG); put(d, "model.gguf.sha256", nl, 65); }
    /* a directory under the model name */
    { char p[600]; snprintf(p, sizeof p, "%s/model.gguf", d); CHECK(unlink(p) == 0 && mkdir(p, 0700) == 0, "dir fixture"); CHECK(anchor_model_retained(d, 1000, TAG, &why) == ANCHOR_MODEL_MISS_NOT_REGULAR, why); CHECK(anchor_model_open(d, 1000, TAG, 1, &existing, &verdict) == -2, "cache-only: a directory is a miss, untouched"); CHECK(rmdir(p) == 0, "dir removed"); }
    /* the default (not cache-only) path is today's: a miss unlinks the tag and truncates/sizes the file */
    put(d, "model.gguf", model, sizeof model); { char nl[66]; snprintf(nl, sizeof nl, "%s\n", TAG); put(d, "model.gguf.sha256", nl, 65); }
    { int fd = anchor_model_open(d, 2000, TAG, 0, &existing, &verdict); struct stat st; CHECK(fd >= 0 && existing == 0 && verdict == ANCHOR_MODEL_MISS_SIZE && fstat(fd, &st) == 0 && st.st_size == 2000, "default path: miss = truncate + size to the offer (unchanged behaviour)"); close(fd); take(d, &b); CHECK(!b.have_tag, "default path: the stale tag is gone"); }
    { int fd = anchor_model_open(d, 2000, TAG, 0, &existing, &verdict); CHECK(fd >= 0 && existing == 0 && verdict == ANCHOR_MODEL_MISS_NO_TAG, "default path: no tag = re-receive"); close(fd); }
    { char p[600]; snprintf(p, sizeof p, "%s/model.gguf", d); unlink(p); snprintf(p, sizeof p, "%s/model.gguf.sha256", d); unlink(p); rmdir(d); }
    printf("{\"status\":\"PASS\",\"executed_checks\":%d}\n", checks); return 0;
}
