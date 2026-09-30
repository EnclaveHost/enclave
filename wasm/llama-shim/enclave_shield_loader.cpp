// Optional private-source reclamation for the measured Shield guest. No change
// to the encoded int8 rows, local mask minting, verification, KV or MTP caches.
#include "llama-model.h"
#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "gguf.h"
#include "ggml-shielded.h"
#include "shield-original-source.hpp"
#include <memory>
#include <set>
#include <sys/stat.h>
#include <sys/mman.h>

namespace {
struct loader_state {
    shield_original_source source;
    std::vector<ggml_backend_buffer_t> buffers;
    llama_model *model = nullptr;
    void *private_mapping = MAP_FAILED;
    ~loader_state() {
        for (auto *b : buffers) ggml_backend_buffer_free(b);
        if (private_mapping != MAP_FAILED) munmap(private_mapping, source.file_size);
    }
};
// The Shield backend's model registry is process-lifetime and single-model.
// Keep verifier metadata alive for exactly that lifetime, including load errors.
std::unique_ptr<loader_state> state;
bool attempted = false;
void free_buffers(loader_state &s) {
    for (auto *b : s.buffers) ggml_backend_buffer_free(b);
    s.buffers.clear();
    if (s.private_mapping != MAP_FAILED) {
        munmap(s.private_mapping, s.source.file_size);
        s.private_mapping = MAP_FAILED;
    }
}
int source_fd(const char *name, int mode) {
    if (!strncmp(name, "fd:", 3)) {
        char *end = nullptr; long fd = strtol(name+3, &end, 10);
        if (!end || *end || fd < 3 || fd > 1023 ||
            (fcntl(fd, F_GETFL) & O_ACCMODE) != mode) return -1;
        int copy = fcntl(fd, F_DUPFD_CLOEXEC, 3);
        if (copy >= 0) close(fd);
        return copy;
    }
    return open(name, mode | O_CLOEXEC);
}
}

extern "C" llama_model *ell_shield_load_model(const char *path, llama_model_params params) {
    const char *backing = getenv("ENCLAVE_SHIELD_ORIGINAL_SOURCE");
    if (!backing || !*backing) return llama_model_load_from_file(path, params);
    if (attempted) { fprintf(stderr, "[shield-source] refusing second model load in one backend process\n"); return nullptr; }
    attempted = true;
    auto *reg = ggml_backend_reg_by_name("Shielded");
    auto bind = reg ? (decltype(&ggml_backend_shielded_set_weight_verifier))ggml_backend_reg_get_proc_address(reg, "ggml_backend_shielded_set_weight_verifier") : nullptr;
    auto release = reg ? (decltype(&ggml_backend_shielded_set_source_release))ggml_backend_reg_get_proc_address(reg, "ggml_backend_shielded_set_source_release") : nullptr;
    auto source = reg ? (decltype(&ggml_backend_shielded_weight_source))ggml_backend_reg_get_proc_address(reg, "ggml_backend_shielded_weight_source") : nullptr;
    auto candidate = reg ? (decltype(&ggml_backend_shielded_source_candidate))ggml_backend_reg_get_proc_address(reg, "ggml_backend_shielded_source_candidate") : nullptr;
    if (!bind || !release || !source || !candidate || params.use_extra_bufts) {
        fprintf(stderr, "[shield-source] incompatible loader/backend; refusing unverified fallback\n"); return nullptr;
    }
    state.reset(new loader_state);
    auto &s = *state;
    gguf_context *uf = nullptr;
    ggml_context *metadata = nullptr;
    try {
        // This is the private copy authenticated by /shieldmodel, not /dev/vda.
        const char *private_source = getenv("ENCLAVE_SHIELD_PRIVATE_SOURCE");
        s.source.private_fd = source_fd(private_source ? private_source : path, O_RDWR);
        s.source.backing_fd = source_fd(backing, O_RDONLY);
        struct stat st{};
        struct stat named{};
        struct stat original{};
        if (s.source.private_fd < 0 || s.source.backing_fd < 0 || fstat(s.source.private_fd, &st) ||
            stat(path, &named) || st.st_dev != named.st_dev || st.st_ino != named.st_ino ||
            !S_ISREG(st.st_mode) || st.st_size <= 0) throw std::runtime_error("private/backing file unavailable");
        if (fstat(s.source.backing_fd, &original) ||
            (st.st_dev == original.st_dev && st.st_ino == original.st_ino))
            throw std::runtime_error("backing source aliases the reclaimable private copy");
        s.source.file_size = st.st_size; s.source.page = sysconf(_SC_PAGESIZE);
        uf = gguf_init_from_file(path, {true, &metadata});
        if (!uf || !metadata) throw std::runtime_error("GGUF metadata");
        params.no_alloc = true; params.load_mode = LLAMA_LOAD_MODE_NONE;
        params.n_gpu_layers = 0; // all GPU work still goes through Shield's ACCEL backend
        s.model = llama_model_load_from_file(path, params);
        if (!s.model) throw std::runtime_error("model metadata load");
        // Preserve the original private CPU-weight layout. Only GPU-source
        // interiors are retired; CPU row gathers still address private RAM.
        // This maps the guest's authenticated tmpfs, NEVER the public backing.
        s.private_mapping = mmap(nullptr, s.source.file_size, PROT_READ, MAP_SHARED,
                                 s.source.private_fd, 0);
        if (s.private_mapping == MAP_FAILED) throw std::runtime_error("private CPU mapping");
        auto *cpu_buffer = ggml_backend_cpu_buffer_from_ptr(s.private_mapping, s.source.file_size);
        if (!cpu_buffer) throw std::runtime_error("private CPU buffer");
        ggml_backend_buffer_set_usage(cpu_buffer, GGML_BACKEND_BUFFER_USAGE_WEIGHTS);
        s.buffers.push_back(cpu_buffer);
        // Bind only after metadata parsing, before any graph or registration.
        if (bind(shield_original_source::verify, &s.source)) throw std::runtime_error("verifier admission");
        s.source.defer_retirement = true;
        if (release(shield_original_source::release_consumed, &s.source)) throw std::runtime_error("source retirement admission");
        uint64_t streamed = 0, resident = 0; size_t count = 0;
        std::set<ggml_tensor *> seen;
        for (const auto &kv : llama_internal_get_tensor_map(s.model)) {
            auto *t = kv.second;
            if (!seen.insert(t).second) continue;
            if (t->data || t->view_src) throw std::runtime_error("unexpected allocated/view weight");
            const int64_t id = gguf_find_tensor(uf, kv.first.c_str());
            const auto *md = ggml_get_tensor(metadata, kv.first.c_str());
            if (id < 0 || !md || md->type != t->type || memcmp(md->ne, t->ne, sizeof t->ne) ||
                gguf_get_tensor_size(uf, id) != ggml_nbytes(t)) throw std::runtime_error("tensor metadata mismatch");
            const uint64_t offset = gguf_get_data_offset(uf) + gguf_get_tensor_offset(uf, id);
            const size_t n = ggml_nbytes(t);
            if (offset > s.source.file_size || n > s.source.file_size-offset) throw std::runtime_error("tensor extent");
            ggml_backend_buffer_t b = nullptr;
            s.source.add(t->name, t->type, t->ne, offset, n);
            if (candidate(t)) {
                b = source(t, shield_original_source::read, &s.source);
                if (!b) throw std::runtime_error("source buffer");
                streamed += n; count++;
            } else {
                // Keep embeddings, norms and other CPU weights in their
                // original private pages, with the same shared CPU buffer.
                // No secret-dependent access reaches the backing device.
                b = cpu_buffer;
                t->buffer = nullptr;
                if (ggml_backend_tensor_alloc(b, t, (char *)s.private_mapping + offset) != GGML_STATUS_SUCCESS)
                    throw std::runtime_error("CPU placement");
                resident += n;
            }
            if (b != cpu_buffer) s.buffers.push_back(b);
        }
        gguf_free(uf); uf=nullptr; ggml_free(metadata); metadata=nullptr;
        s.model->hparams.no_alloc = false;
        fprintf(stderr, "[shield-source] originals eligible=%llu bytes tensors=%zu; private CPU weights=%llu bytes; encoded mask weights unchanged\n",
                (unsigned long long)streamed, count, (unsigned long long)resident);
        return s.model;
    } catch (const std::exception &e) {
        fprintf(stderr, "[shield-source] load refused: %s\n", e.what());
        if (uf) gguf_free(uf);
        if (metadata) ggml_free(metadata);
        if (s.model) llama_model_free(s.model);
        s.model=nullptr; free_buffers(s);
        return nullptr;
    }
}
// Also used by the full-model loader fixture, which reads every source without
// allocating the encoded 27B model. Normal inference invokes the same callback
// automatically at the end of each successful backend registration batch.
extern "C" int ell_shield_release_consumed_sources() {
    return state ? shield_original_source::release_consumed(&state->source) : -1;
}
extern "C" void ell_shield_free_model(llama_model *model) {
    llama_model_free(model);
    if (state && state->model == model) {
        state->model=nullptr; free_buffers(*state);
    }
}
