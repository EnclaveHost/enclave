#include "llama-model.h"
#include "ggml-backend.h"
#include "../../wasm/llama-shim/enclave_llama.h"
#include <cassert>
#include <cstring>
#include <cstdio>
#include <sys/stat.h>
#include <vector>
int main(int argc,char **argv) {
    assert(argc==2);
    ell_init();
    auto *m=static_cast<llama_model *>(ell_load_model(argv[1],0));
    assert(m);
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
    printf("loader: tensors=%zu source_bytes=%llu actual_blocks_freed=%llu\n",count,
       (unsigned long long)read,(unsigned long long)(before.st_blocks-after.st_blocks)*512);
    ell_free_model(m);
}
