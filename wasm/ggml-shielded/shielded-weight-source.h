#pragma once

// Public raw weights behind an authenticated read interface. Keeping is_host
// false is essential: ggml otherwise bypasses get_tensor and memcpy's data.
#include <atomic>
#include <sys/mman.h>

struct sh_weight_source {
    ggml_tensor descriptor;
    ggml_shielded_weight_reader reader;
    void *reader_ctx;
    ggml_shielded_weight_verifier verifier;
    void *verifier_ctx;
    void *guard = MAP_FAILED;
    size_t size = 0;
    std::atomic<bool> failed{false};
    ~sh_weight_source() { if (guard != MAP_FAILED) munmap(guard, size); }
};
static ggml_backend_buffer_type_t sh_source_buft();
static bool sh_is_weight_source(const ggml_tensor *t) {
    return t && t->buffer && t->buffer->buft == sh_source_buft();
}
static bool sh_source_descriptor_matches(const sh_weight_source &s, const ggml_tensor *t) {
    return t && t->type == s.descriptor.type && !strcmp(t->name, s.descriptor.name) &&
           !memcmp(t->ne, s.descriptor.ne, sizeof t->ne) &&
           !memcmp(t->nb, s.descriptor.nb, sizeof t->nb) && t->data == s.guard;
}
// Direct registration already owns its private destination and verifies it
// immediately afterward. Do not allocate/hash a second temporary copy there.
static bool sh_source_read_for_registration(const ggml_tensor *t, void *dst, size_t n) {
    auto &s = *static_cast<sh_weight_source *>(t->buffer->context);
    if (s.failed.load() || !sh_source_descriptor_matches(s, t) || n != s.size) return false;
    try {
        if (s.reader(s.reader_ctx, s.descriptor.name, (uint32_t)s.descriptor.type,
                     s.descriptor.ne, dst, n) == SH_OK) return true;
    } catch (...) { }
    s.failed.store(true);
    return false;
}
static void sh_source_free(ggml_backend_buffer_t b) { delete static_cast<sh_weight_source *>(b->context); }
static void *sh_source_base(ggml_backend_buffer_t b) { return static_cast<sh_weight_source *>(b->context)->guard; }
static ggml_status sh_source_init(ggml_backend_buffer_t b, ggml_tensor *t) {
    return sh_source_descriptor_matches(*static_cast<sh_weight_source *>(b->context), t) ? GGML_STATUS_SUCCESS : GGML_STATUS_FAILED;
}
static void sh_source_write(ggml_backend_buffer_t, ggml_tensor *, const void *, size_t, size_t) {
    GGML_ABORT("authenticated weight sources are immutable");
}
static void sh_source_memset(ggml_backend_buffer_t, ggml_tensor *, uint8_t, size_t, size_t) {
    GGML_ABORT("authenticated weight sources are immutable");
}
static void sh_source_clear(ggml_backend_buffer_t, uint8_t) {
    GGML_ABORT("authenticated weight sources are immutable");
}
static void sh_source_get(ggml_backend_buffer_t b, const ggml_tensor *t, void *dst, size_t off, size_t n) {
    auto &s = *static_cast<sh_weight_source *>(b->context);
    const ggml_tensor *root = t;
    // ggml collapses view_src to the owning tensor. A malformed chain must not
    // turn this into an unbounded walk or manufacture a different source.
    for (int i = 0; root && root->view_src && i < GGML_MAX_DIMS; i++) root = root->view_src;
    const uintptr_t base = (uintptr_t)s.guard, addr = (uintptr_t)t->data;
    bool ok = !s.failed.load() && root && !root->view_src && sh_source_descriptor_matches(s, root) &&
              addr >= base && addr - base <= s.size;
    const size_t start = ok ? (size_t)(addr - base) : 0;
    ok = ok && off <= s.size - start && n <= s.size - start - off;
    std::vector<uint8_t> bytes;
    if (ok) {
        try {
            bytes.resize(s.size);
            ok = s.reader(s.reader_ctx, s.descriptor.name, (uint32_t)s.descriptor.type,
                          s.descriptor.ne, bytes.data(), bytes.size()) == SH_OK &&
                 s.verifier(s.verifier_ctx, s.descriptor.name, (uint32_t)s.descriptor.type,
                            s.descriptor.ne, bytes.data(), bytes.size()) == SH_OK;
        } catch (...) { ok = false; }
    }
    if (!ok) {
        s.failed.store(true);
        GGML_ABORT("%s: authenticated weight source read failed", s.descriptor.name);
    }
    memcpy(dst, bytes.data() + start + off, n);
}
static const char *sh_source_name(ggml_backend_buffer_type_t) { return "Shielded_weight_source"; }
static ggml_backend_buffer_t sh_source_no_alloc(ggml_backend_buffer_type_t, size_t) { return nullptr; }
static size_t sh_source_alignment(ggml_backend_buffer_type_t) { return 64; }
static bool sh_source_not_host(ggml_backend_buffer_type_t) { return false; }
static ggml_backend_buffer_type_t sh_source_buft() {
    static ggml_backend_buffer_type type = [] {
        ggml_backend_buffer_type t = {};
        t.iface.get_name = sh_source_name; t.iface.alloc_buffer = sh_source_no_alloc;
        t.iface.get_alignment = sh_source_alignment; t.iface.is_host = sh_source_not_host;
        return t;
    }();
    return &type;
}

ggml_backend_buffer_t ggml_backend_shielded_weight_source(ggml_tensor *t, ggml_shielded_weight_reader reader, void *ctx) {
    if (!t || !reader || !g_weight_verifier || t->data || t->view_src ||
        (t->buffer && ggml_backend_buffer_get_size(t->buffer)) || !ggml_is_contiguous(t) || !t->name[0]) return nullptr;
    size_t elems = 1;
    for (int i = 0; i < GGML_MAX_DIMS; i++) {
        if (t->ne[i] <= 0 || (uint64_t)t->ne[i] > SIZE_MAX / elems) return nullptr;
        elems *= (size_t)t->ne[i];
    }
    const size_t block = ggml_blck_size(t->type), unit = ggml_type_size(t->type);
    if (!block || t->ne[0] % block || elems / block > SIZE_MAX / unit) return nullptr;
    const size_t size = elems / block * unit;
    if (!size || size > PTRDIFF_MAX || size != ggml_nbytes(t)) return nullptr;
    std::unique_ptr<sh_weight_source> s(new (std::nothrow) sh_weight_source);
    if (!s) return nullptr;
    s->descriptor = *t; s->reader = reader; s->reader_ctx = ctx;
    s->verifier = g_weight_verifier; s->verifier_ctx = g_weight_verifier_ctx; s->size = size;
    s->guard = mmap(nullptr, size, PROT_NONE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (s->guard == MAP_FAILED) return nullptr;
    ggml_backend_buffer_i iface = {};
    iface.free_buffer = sh_source_free; iface.get_base = sh_source_base; iface.init_tensor = sh_source_init;
    iface.get_tensor = sh_source_get; iface.set_tensor = sh_source_write;
    iface.memset_tensor = sh_source_memset; iface.clear = sh_source_clear;
    auto *b = ggml_backend_buffer_init(sh_source_buft(), iface, s.get(), size);
    if (!b) return nullptr;
    s.release();
    auto *old = t->buffer; t->buffer = nullptr;
    if (ggml_backend_tensor_alloc(b, t, sh_source_base(b)) != GGML_STATUS_SUCCESS) {
        t->buffer = old; t->data = nullptr; ggml_backend_buffer_free(b); return nullptr;
    }
    ggml_backend_buffer_set_usage(b, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
    return b;
}
