// Inject a decode error after a successful real-model prefill. No runtime
// switch or failure hook is added to the shipped diagnostic runner.
#include "llama.h"
#include <cstdlib>
#include <dlfcn.h>
extern "C" int32_t llama_decode(llama_context *ctx, llama_batch batch) {
    static int calls = 0;
    const char *at = std::getenv("TEST_DECODE_FAIL_CALL");
    if (++calls == (at ? std::atoi(at) : 0)) return -1;
    auto real = reinterpret_cast<int32_t (*)(llama_context *, llama_batch)>(dlsym(RTLD_NEXT, "llama_decode"));
    return real ? real(ctx, batch) : -1;
}
