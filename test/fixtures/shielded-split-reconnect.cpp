#include "../../wasm/ggml-shielded/ggml-shielded.cpp"
#include "ggml-cpu.h"
#include <cassert>
int main(int argc, char **argv) {
    assert(argc == 3);
    cpu_set_t allowed, main_cpu, other_cpu;
    assert(!sched_getaffinity(0, sizeof allowed, &allowed));
    std::vector<int> cpus;
    for (int i = 0; i < CPU_SETSIZE; i++) if (CPU_ISSET(i, &allowed)) cpus.push_back(i);
    assert(cpus.size() >= 2);
    CPU_ZERO(&main_cpu); CPU_SET(cpus[0], &main_cpu);
    CPU_ZERO(&other_cpu); CPU_SET(cpus[1], &other_cpu);
    setenv("SHIELDED_CPU_MAIN", std::to_string(cpus[0]).c_str(), 1);
    setenv("SHIELDED_CPU_HELPER", std::to_string(cpus[1]).c_str(), 1);
    setenv("SHIELDED_CPU_REST", std::to_string(cpus[1]).c_str(), 1);
    auto check_placement = [&] {
        cpu_set_t current;
        assert(!sched_getaffinity(0, sizeof current, &current));
        assert(CPU_EQUAL(&current, &main_cpu));
    };
    uint64_t counters[24] = {99};
    assert(ggml_backend_shielded_profile_snapshot(nullptr, 24) == -1);
    assert(ggml_backend_shielded_profile_snapshot(counters, 23) == -1 && counters[0] == 99);
    assert(ggml_backend_shielded_profile_snapshot(counters, 24) == 1 && counters[0] == 1 && counters[1] == 0);
    std::string workers = std::string("127.0.0.1|") + argv[1] + "|0|16777216\n127.0.0.1|" + argv[2] + "|0|16777216";
    setenv("SHIELDED_WORKERS", workers.c_str(), 1);
    setenv("SHIELDED_SPLIT_COLS", "1", 1);
    setenv("SHIELDED_MIN_MACS", "1", 1);
    setenv("SHIELDED_REFILL_THREADS", "2", 1);
    setenv("SHIELDED_POOL_DEPTH", "4", 1);
    sh_pool &p = sh_pool_get(); sh_pool_init(p); assert(!p.invalid && p.cards.size() == 2);
    for (auto *s : p.cards) {
        s->configured = s->calib_loaded = true; s->calib_version = 2;
        s->calib["blk.0.ffn_gate.weight"] = {8, {}};
    }
    auto *ctx = ggml_init({4u << 20, nullptr, false}); assert(ctx);
    auto *w = ggml_new_tensor_2d(ctx, GGML_TYPE_Q8_0, 128, 128);
    auto *x = ggml_new_tensor_2d(ctx, GGML_TYPE_F32, 128, 1);
    ggml_set_name(w, "blk.0.ffn_gate.weight");
    std::vector<float> raw(128*128);
    for (size_t i = 0; i < raw.size(); i++) raw[i] = (int(i % 11) - 5) / 64.0f;
    ggml_quantize_chunk(GGML_TYPE_Q8_0, raw.data(), w->data, 0, 128, 128, nullptr);
    for (int i = 0; i < 128; i++) ((float *)x->data)[i] = (i % 7 - 3) / 32.0f;
    p.pending[ggml_get_name(w)] = *w; sh_plan(p);
    assert(p.cards[0]->weights.at(ggml_get_name(w)).part_cards.size() == 2);
    auto *y = ggml_mul_mat(ctx, w, x);
    auto *g = ggml_new_graph_custom(ctx, 8, false); ggml_graph_add_node(g, y);
    assert(sh_card_compute(*p.cards[0], g) == GGML_STATUS_SUCCESS);
    check_placement();
    std::vector<float> first((float *)y->data, (float *)y->data + 128);
    // The worker fixture closes after the first product. This graph must notice
    // the FIN and upload/reconnect before use instead of staying on CPU.
    usleep(100000);
    // Model an async caller arriving from the background mask between sweeps.
    assert(!sched_setaffinity(0, sizeof other_cpu, &other_cpu));
    assert(sh_card_compute(*p.cards[0], g) == GGML_STATUS_SUCCESS);
    check_placement();
    assert(!memcmp(first.data(), y->data, 128*sizeof(float)));
    // The fixture drops the next product mid-exchange; retry must use fresh pads.
    assert(!sched_setaffinity(0, sizeof other_cpu, &other_cpu));
    assert(sh_card_compute(*p.cards[0], g) == GGML_STATUS_SUCCESS);
    check_placement();
    assert(!memcmp(first.data(), y->data, 128*sizeof(float)));
    assert(p.cards[0]->local_nodes == 0 && p.cards[1]->local_nodes == 0);
    assert(ggml_backend_shielded_profile_snapshot(counters, 24) == 1);
    assert(counters[1] == 2 && counters[3] > 0 && counters[4] == 0);
    std::atomic<bool> holding{false}, release{false};
    std::thread busy([&] { std::lock_guard<std::mutex> lock(p.mu); holding = true; while (!release) std::this_thread::yield(); });
    while (!holding) std::this_thread::yield();
    counters[0] = 99;
    assert(ggml_backend_shielded_profile_snapshot(counters, 24) == 0 && counters[0] == 99);
    release = true; busy.join();
    puts("split reconnect: idle close and mid-product close recovered with identical verified output");
    // Process-scoped backend threads are intentionally kept until process exit.
    fflush(stdout); _Exit(0);
}
