/* Standalone v3 files. Included by shielded-pads.c to reuse its vetted crypto
 * and exact-I/O helpers without changing the integrated v2 path. */
#include "shielded-pads-v3.h"
#include "shielded-pad-sparse-table.h"

enum { V3_HEADER = 256, V3_DEALER = 96, V3_KEY = 128, V3_AUTH = 176 };
#define V3_MAX_CELL_BYTES (UINT64_C(64) << 20)
static const uint8_t v3_magic[8] = {'E','N','C','L','P','A','D','3'};

typedef struct {
    uint32_t n;
    sh_pads_group *groups;
    sh_pads_span *spans;
    uint64_t *offsets, *cell0;
    sh_pads_sparse_extent extent;
    uint8_t *metadata;
    size_t metadata_bytes, cell_cap;
    uint8_t manifest[32], seed_id[16], key[32];
} v3_file;

struct sh_pads_v3_writer {
    v3_file f;
    int fd, dirfd, failed;
    char name[201], temporary[240];
    uint8_t *claimed, *plain, *box;
    uint64_t completed;
};

struct sh_pads_v3_reader { v3_file f; int fd; };

static void v3_file_clear(v3_file *f) {
    pads_wipe(f->key, sizeof f->key);
    free(f->groups); free(f->spans); free(f->offsets); free(f->cell0);
    free(f->metadata);
    memset(f, 0, sizeof *f);
}

static int v3_file_init(v3_file *f, const sh_pads_v3_policy *p) {
    if (!p || !p->manifest || !p->max_file_bytes || p->max_file_bytes > INT64_MAX ||
        !p->max_cell_bytes || p->max_cell_bytes > V3_MAX_CELL_BYTES ||
        p->reserved_lo >= p->reserved_hi || p->reserved_hi > SH_PADS_INDEX_LIMIT)
        return SH_ERR_RANGE;
    int rc = sh_pads_manifest_digest(p->manifest, f->manifest);
    if (rc != SH_OK) return rc;
    f->n = p->manifest->group_count;
    f->metadata_bytes = (V3_HEADER + (size_t)f->n * SH_PADS_SPARSE_GROUP_BYTES + 4095) & ~(size_t)4095;
    if (f->metadata_bytes > p->max_file_bytes) return SH_ERR_RANGE;
    f->groups = (sh_pads_group *)calloc(f->n, sizeof *f->groups);
    f->spans = (sh_pads_span *)calloc(f->n, sizeof *f->spans);
    f->offsets = (uint64_t *)calloc(f->n, sizeof *f->offsets);
    f->cell0 = (uint64_t *)calloc(f->n, sizeof *f->cell0);
    f->metadata = (uint8_t *)calloc(f->metadata_bytes, 1);
    if (!f->groups || !f->spans || !f->offsets || !f->cell0 || !f->metadata) return SH_ERR_NOMEM;
    for (uint32_t i = 0; i < f->n; i++) f->groups[i] = p->manifest->groups[i].identity;
    memcpy(f->seed_id, p->seed_id, 16);
    return SH_OK;
}

static int v3_cell_layout(v3_file *f, const sh_pads_v3_policy *p) {
    uint64_t cells = 0;
    for (uint32_t i = 0; i < f->n; i++) {
        f->cell0[i] = cells;
        if (f->spans[i].count > SH_PADS_WRITER_MAX_CELLS - cells) return SH_ERR_RANGE;
        cells += f->spans[i].count;
        if (f->spans[i].count) {
            const uint64_t bytes = cell_bytes(f->groups[i].u_len);
            if (bytes > p->max_cell_bytes) return SH_ERR_RANGE;
            if (bytes > f->cell_cap) f->cell_cap = (size_t)bytes;
        }
    }
    return cells == f->extent.cells && cells && f->cell_cap ? SH_OK : SH_ERR_RANGE;
}

/* Hash canonical header, complete descriptors and zero alignment padding.
 * The wrapped key and encrypted hash are excluded to avoid a circular hash;
 * the ephemeral public key, manifest, seed and exact extents are included. */
static int v3_metadata_hash(const v3_file *f, uint8_t digest[64]) {
    uint8_t *copy = (uint8_t *)malloc(f->metadata_bytes);
    if (!copy) return SH_ERR_NOMEM;
    memcpy(copy, f->metadata, f->metadata_bytes);
    memset(copy + V3_KEY, 0, V3_HEADER - V3_KEY);
    crypto_hash(digest, copy, f->metadata_bytes);
    free(copy);
    return SH_OK;
}

static int v3_pread_all(int fd, void *buffer, size_t length, uint64_t offset) {
    uint8_t *p = (uint8_t *)buffer;
    while (length) {
        const ssize_t n = pread(fd, p, length, (off_t)offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return SH_ERR_IO;
        p += n; length -= (size_t)n; offset += (uint64_t)n;
    }
    return SH_OK;
}

static int v3_writer_fail(sh_pads_v3_writer *w, int rc) {
    int expected = SH_OK;
    __atomic_compare_exchange_n(&w->failed, &expected, rc, false, __ATOMIC_RELEASE, __ATOMIC_RELAXED);
    return rc;
}

void sh_pads_v3_writer_abort(sh_pads_v3_writer *w) {
    if (!w) return;
    if (w->fd >= 0) close(w->fd);
    if (w->dirfd >= 0) {
        if (w->temporary[0]) unlinkat(w->dirfd, w->temporary, 0);
        close(w->dirfd);
    }
    if (w->plain) pads_wipe(w->plain, w->f.cell_cap);
    free(w->claimed); free(w->plain); free(w->box);
    v3_file_clear(&w->f);
    free(w);
}

sh_pads_v3_writer *sh_pads_v3_writer_open(int directory_fd, const char *name,
        const sh_pads_v3_policy *policy, const sh_pads_span *spans,
        const uint8_t consumer_pk[32], int *err) {
    if (!err) return NULL;
    *err = SH_ERR_RANGE;
    if (!name || !spans || !consumer_pk || directory_fd < 0) return NULL;
    const size_t name_len = strnlen(name, 201);
    if (!name_len || name_len > 200 || strchr(name, '/') || !strcmp(name, ".") || !strcmp(name, "..")) return NULL;
    sh_pads_v3_writer *w = (sh_pads_v3_writer *)calloc(1, sizeof *w);
    if (!w) { *err = SH_ERR_NOMEM; return NULL; }
    w->fd = w->dirfd = -1;
    uint8_t esk[32] = {0}, shared[32] = {0};
    int rc = v3_file_init(&w->f, policy);
    if (rc != SH_OK) goto fail;
    v3_file *f = &w->f;
    memcpy(f->spans, spans, f->n * sizeof *spans);
    rc = sh_pads_sparse_table_encode(policy->manifest, f->spans,
            policy->reserved_lo, policy->reserved_hi, policy->max_file_bytes,
            f->metadata + V3_HEADER, f->n * SH_PADS_SPARSE_GROUP_BYTES,
            f->offsets, f->n, &f->extent);
    if (rc != SH_OK || (rc = v3_cell_layout(f, policy)) != SH_OK) goto fail;
    w->claimed = (uint8_t *)calloc((size_t)((f->extent.cells + 7) / 8), 1);
    w->plain = (uint8_t *)malloc(f->cell_cap);
    w->box = (uint8_t *)malloc(f->cell_cap);
    if (!w->claimed || !w->plain || !w->box) { rc = SH_ERR_NOMEM; goto fail; }
    w->dirfd = fcntl(directory_fd, F_DUPFD_CLOEXEC, 0);
    struct stat st;
    if (w->dirfd < 0 || fstat(w->dirfd, &st) || !S_ISDIR(st.st_mode)) { rc = SH_ERR_IO; goto fail; }
    memcpy(w->name, name, name_len + 1);
    if (fstatat(w->dirfd, name, &st, AT_SYMLINK_NOFOLLOW) == 0 || errno != ENOENT) { rc = SH_ERR_IO; goto fail; }
    uint8_t *h = f->metadata;
    memcpy(h, v3_magic, 8); put_u32(h + 8, 3); put_u32(h + 12, f->n);
    memcpy(h + 16, f->manifest, 32); memcpy(h + 48, f->seed_id, 16);
    put_u64(h + 64, f->extent.file_bytes); put_u64(h + 72, f->extent.data_off);
    put_u64(h + 80, f->extent.file_bytes - f->extent.data_off);
    randombytes(f->key, 32);
    crypto_box_keypair(h + V3_DEALER, esk);
    rc = box_shared_checked(shared, consumer_pk, esk);
    if (rc != SH_OK) goto fail;
    uint8_t kn[24], hn[12], digest[64];
    key_nonce(kn, f->seed_id); hdr_nonce(hn);
    rc = secretbox_seal(h + V3_KEY, f->key, 32, kn, shared);
    if (rc != SH_OK) goto fail;
    pads_wipe(esk, sizeof esk); pads_wipe(shared, sizeof shared);
    rc = v3_metadata_hash(f, digest);
    if (rc != SH_OK || (rc = aead_seal(f->key, hn, digest, 64, h + V3_AUTH)) != SH_OK) goto fail;
    /* Temporary and final names resolve against the same retained directory. */
    for (unsigned attempt = 0; attempt < 8; attempt++) {
        uint8_t nonce[16]; char suffix[33]; randombytes(nonce, sizeof nonce);
        sh_pads_bin2hex(nonce, sizeof nonce, suffix);
        snprintf(w->temporary, sizeof w->temporary, "%s.tmp.%s", name, suffix);
        w->fd = openat(w->dirfd, w->temporary, O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
        if (w->fd >= 0) break;
        w->temporary[0] = 0; /* never unlink a collision belonging to someone else */
        if (errno != EEXIST) break;
    }
    if (w->fd < 0) { rc = SH_ERR_IO; goto fail; }
    rc = writer_pwrite_all(w->fd, h, f->metadata_bytes, 0);
    if (rc != SH_OK || ftruncate(w->fd, (off_t)f->extent.file_bytes)) { rc = SH_ERR_IO; goto fail; }
    *err = SH_OK;
    return w;
fail:
    pads_wipe(esk, sizeof esk); pads_wipe(shared, sizeof shared);
    *err = rc;
    sh_pads_v3_writer_abort(w);
    return NULL;
}

size_t sh_pads_v3_writer_scratch_bytes(const sh_pads_v3_writer *w) { return w ? w->f.cell_cap : 0; }

int sh_pads_v3_writer_cell(sh_pads_v3_writer *w, uint32_t group,
        uint64_t index, const int32_t *u, size_t u_count) {
    return w ? sh_pads_v3_writer_cell_with(w, group, index, u, u_count,
                    w->plain, w->box, w->f.cell_cap) : SH_ERR_RANGE;
}

int sh_pads_v3_writer_cell_with(sh_pads_v3_writer *w, uint32_t group,
        uint64_t index, const int32_t *u, size_t u_count,
        uint8_t *plain, uint8_t *box, size_t scratch_bytes) {
    if (!w) return SH_ERR_RANGE;
    v3_file *f = &w->f;
    const int failed = __atomic_load_n(&w->failed, __ATOMIC_ACQUIRE);
    if (failed != SH_OK) return failed;
    if (!u || !plain || !box || group >= f->n || scratch_bytes < f->cell_cap ||
        u_count != f->groups[group].u_len || index < f->spans[group].index0 ||
        index - f->spans[group].index0 >= f->spans[group].count)
        return v3_writer_fail(w, SH_ERR_RANGE);
    const uint64_t relative = index - f->spans[group].index0;
    const uint64_t ordinal = f->cell0[group] + relative;
    const uint8_t bit = (uint8_t)(1u << (ordinal % 8));
    if (__atomic_fetch_or(&w->claimed[ordinal / 8], bit, __ATOMIC_ACQ_REL) & bit)
        return v3_writer_fail(w, SH_ERR_RANGE);
    for (size_t j = 0; j < u_count; j++) {
        const int64_t v = (int64_t)u[j] + SH_HALF_M;
        if (v < 0 || v >= SH_M_MOD) return v3_writer_fail(w, SH_ERR_RANGE);
        plain[3*j] = (uint8_t)v; plain[3*j+1] = (uint8_t)(v >> 8); plain[3*j+2] = (uint8_t)(v >> 16);
    }
    uint8_t nonce[12]; cell_nonce(nonce, index, group);
    int rc = aead_seal(f->key, nonce, plain, 3 * u_count, box);
    if (rc != SH_OK) return v3_writer_fail(w, rc);
    const size_t bytes = (size_t)cell_bytes(u_count);
    rc = writer_pwrite_all(w->fd, box, bytes, f->offsets[group] + relative * bytes);
    if (rc != SH_OK) return v3_writer_fail(w, rc);
    __atomic_add_fetch(&w->completed, 1, __ATOMIC_RELEASE);
    return SH_OK;
}

int sh_pads_v3_writer_finish(sh_pads_v3_writer *w, bool *published) {
    if (!w) return SH_ERR_RANGE;
    if (!published) { sh_pads_v3_writer_abort(w); return SH_ERR_RANGE; }
    *published = false;
    int rc = __atomic_load_n(&w->failed, __ATOMIC_ACQUIRE);
    if (rc == SH_OK && __atomic_load_n(&w->completed, __ATOMIC_ACQUIRE) != w->f.extent.cells) rc = SH_ERR_RANGE;
    if (rc == SH_OK && fsync(w->fd)) rc = SH_ERR_IO;
    if (close(w->fd) && rc == SH_OK) rc = SH_ERR_IO;
    w->fd = -1;
    if (rc == SH_OK) {
        if (linkat(w->dirfd, w->temporary, w->dirfd, w->name, 0)) rc = SH_ERR_IO;
        else *published = true;
    }
    if (unlinkat(w->dirfd, w->temporary, 0)) { if (rc == SH_OK) rc = SH_ERR_IO; }
    else w->temporary[0] = 0;
    if (*published && fsync(w->dirfd) && rc == SH_OK) rc = SH_ERR_IO;
    sh_pads_v3_writer_abort(w);
    return rc;
}

void sh_pads_v3_reader_close(sh_pads_v3_reader *r) {
    if (!r) return;
    if (r->fd >= 0) close(r->fd);
    v3_file_clear(&r->f);
    free(r);
}

sh_pads_v3_reader *sh_pads_v3_reader_open(int fd, const sh_pads_v3_policy *policy,
        const uint8_t consumer_sk[32], int *err) {
    if (!err) return NULL;
    *err = SH_ERR_RANGE;
    if (fd < 0 || !consumer_sk) return NULL;
    sh_pads_v3_reader *r = (sh_pads_v3_reader *)calloc(1, sizeof *r);
    if (!r) { *err = SH_ERR_NOMEM; return NULL; }
    r->fd = -1;
    uint8_t shared[32] = {0}, claimed_hash[64] = {0}, expected_hash[64];
    int rc = v3_file_init(&r->f, policy);
    if (rc != SH_OK) goto fail;
    v3_file *f = &r->f;
    r->fd = fcntl(fd, F_DUPFD_CLOEXEC, 0);
    struct stat st;
    if (r->fd < 0 || fstat(r->fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 ||
        (uint64_t)st.st_size < f->metadata_bytes || (uint64_t)st.st_size > policy->max_file_bytes) {
        rc = SH_ERR_IO; goto fail;
    }
    rc = v3_pread_all(r->fd, f->metadata, f->metadata_bytes, 0);
    if (rc != SH_OK) goto fail;
    const uint8_t *h = f->metadata;
    const uint64_t file_bytes = sh_pads_table_le(h + 64, 8);
    if (memcmp(h, v3_magic, 8) || sh_pads_table_le(h + 8, 4) != 3 ||
        sh_pads_table_le(h + 12, 4) != f->n || memcmp(h + 16, f->manifest, 32) ||
        memcmp(h + 48, f->seed_id, 16) || sh_pads_table_le(h + 88, 8) != 0 ||
        file_bytes != (uint64_t)st.st_size || sh_pads_table_le(h + 72, 8) != f->metadata_bytes ||
        file_bytes - f->metadata_bytes != sh_pads_table_le(h + 80, 8)) {
        rc = SH_ERR_VERIFY; goto fail;
    }
    for (size_t i = V3_HEADER + f->n * SH_PADS_SPARSE_GROUP_BYTES; i < f->metadata_bytes; i++)
        if (h[i]) { rc = SH_ERR_VERIFY; goto fail; }
    rc = box_shared_checked(shared, h + V3_DEALER, consumer_sk);
    if (rc != SH_OK) goto fail;
    uint8_t kn[24], hn[12]; key_nonce(kn, f->seed_id); hdr_nonce(hn);
    rc = secretbox_open(f->key, h + V3_KEY, 32, kn, shared);
    pads_wipe(shared, sizeof shared);
    if (rc != SH_OK) goto fail;
    rc = aead_open(f->key, hn, h + V3_AUTH, 64, claimed_hash);
    if (rc != SH_OK || (rc = v3_metadata_hash(f, expected_hash)) != SH_OK) goto fail;
    uint8_t different = 0;
    for (unsigned i = 0; i < 64; i++) different |= claimed_hash[i] ^ expected_hash[i];
    if (different) { rc = SH_ERR_VERIFY; goto fail; }
    rc = sh_pads_sparse_table_decode(policy->manifest,
            h + V3_HEADER, f->n * SH_PADS_SPARSE_GROUP_BYTES,
            policy->reserved_lo, policy->reserved_hi, policy->max_file_bytes,
            f->spans, f->offsets, f->n, &f->extent);
    if (rc != SH_OK) goto fail;
    if (f->extent.data_off != f->metadata_bytes || f->extent.file_bytes != file_bytes) { rc = SH_ERR_VERIFY; goto fail; }
    rc = v3_cell_layout(f, policy);
    if (rc != SH_OK) goto fail;
    if (fstat(r->fd, &st) || !S_ISREG(st.st_mode) || st.st_size < 0 || (uint64_t)st.st_size != file_bytes) { rc = SH_ERR_IO; goto fail; }
    pads_wipe(claimed_hash, sizeof claimed_hash);
    *err = SH_OK;
    return r;
fail:
    pads_wipe(shared, sizeof shared); pads_wipe(claimed_hash, sizeof claimed_hash);
    *err = rc;
    sh_pads_v3_reader_close(r);
    return NULL;
}

int sh_pads_v3_reader_span(const sh_pads_v3_reader *r, uint32_t group, sh_pads_span *span) {
    if (!r || !span || group >= r->f.n) return SH_ERR_RANGE;
    *span = r->f.spans[group];
    return SH_OK;
}

int sh_pads_v3_reader_cell(const sh_pads_v3_reader *r, uint32_t group,
        uint64_t index, int32_t *u, size_t u_count) {
    if (!r || !u || group >= r->f.n) return SH_ERR_RANGE;
    const v3_file *f = &r->f;
    if (u_count != f->groups[group].u_len || index < f->spans[group].index0 ||
        index - f->spans[group].index0 >= f->spans[group].count) return SH_ERR_RANGE;
    const size_t bytes = (size_t)cell_bytes(u_count), plain_bytes = 3 * u_count;
    uint8_t *box = (uint8_t *)malloc(bytes), *plain = (uint8_t *)malloc(plain_bytes);
    if (!box || !plain) { free(box); free(plain); return SH_ERR_NOMEM; }
    const uint64_t offset = f->offsets[group] + (index - f->spans[group].index0) * bytes;
    int rc = v3_pread_all(r->fd, box, bytes, offset);
    if (rc != SH_OK) goto done;
    struct stat st;
    if (fstat(r->fd, &st) || st.st_size < 0 || (uint64_t)st.st_size != f->extent.file_bytes) { rc = SH_ERR_IO; goto done; }
    uint8_t nonce[12]; cell_nonce(nonce, index, group);
    rc = aead_open(f->key, nonce, box, plain_bytes, plain);
    if (rc != SH_OK) goto done;
    /* Refuse every invalid field element before committing any caller output. */
    for (size_t j = 0; j < u_count; j++)
        if (sh_pads_table_le(plain + 3*j, 3) >= (uint64_t)SH_M_MOD) { rc = SH_ERR_VERIFY; goto done; }
    for (size_t j = 0; j < u_count; j++)
        u[j] = (int32_t)((int64_t)sh_pads_table_le(plain + 3*j, 3) - SH_HALF_M);
done:
    pads_wipe(plain, plain_bytes);
    free(plain); free(box);
    return rc;
}
