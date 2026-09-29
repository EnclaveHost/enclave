#include "llama-model.h"
#include "ggml-backend.h"
#include "../../wasm/llama-shim/enclave_llama.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <sys/stat.h>
#include <vector>
#include <array>
#include <openssl/sha.h>
int main(int argc,char **argv) {
    assert(argc==2);
    ell_init();
    auto *m=static_cast<llama_model *>(ell_load_model(argv[1],0));
    assert(m);
    std::vector<std::pair<ggml_tensor *, std::array<unsigned char, SHA256_DIGEST_LENGTH>>> cpu;
    ggml_backend_buffer_t cpu_buffer=nullptr;
    for (auto &kv:llama_internal_get_tensor_map(m)) {
        auto *t=kv.second;
        if (!strcmp(ggml_backend_buffer_name(t->buffer),"Shielded_weight_source")) continue;
        if (!cpu_buffer) cpu_buffer=t->buffer;
        assert(t->buffer==cpu_buffer); // Preserve the original CPU buffer layout.
        std::array<unsigned char,SHA256_DIGEST_LENGTH> hash{};
        SHA256((const unsigned char *)t->data,ggml_nbytes(t),hash.data());
        cpu.emplace_back(t,hash);
    }
    assert(!cpu.empty());
    uint64_t read=0; size_t count=0;
    struct stat before{},after{}; assert(!stat(argv[1],&before));
    for (auto &kv:llama_internal_get_tensor_map(m)) {
        auto *t=kv.second;
        if (strcmp(ggml_backend_buffer_name(t->buffer),"Shielded_weight_source")) continue;
        std::vector<unsigned char> data(ggml_nbytes(t));
        // Goes through authenticated get_tensor; real source pages are retired.
        ggml_backend_tensor_get(t,data.data(),0,data.size());
        read+=data.size(); count++;
    }
    assert(!stat(argv[1],&after));
    assert(count && before.st_blocks>after.st_blocks);
    for (const auto &entry:cpu) {
        std::array<unsigned char,SHA256_DIGEST_LENGTH> hash{};
        SHA256((const unsigned char *)entry.first->data,ggml_nbytes(entry.first),hash.data());
        assert(hash==entry.second);
    }
    printf("loader: tensors=%zu source_bytes=%llu actual_blocks_freed=%llu\n",count,
       (unsigned long long)read,(unsigned long long)(before.st_blocks-after.st_blocks)*512);
    ell_free_model(m);
}
