#include "ggml-backend.h"
#include "ggml-cpu.h"
#include "ggml.h"
#include <atomic>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <dirent.h>
#include <sched.h>
#include <thread>
#include <unistd.h>
#include <vector>
static int threads() {
  int n = 0;
  DIR *d = opendir("/proc/self/task");
  assert(d);
  while (auto *e = readdir(d))
    if (e->d_name[0] >= '0' && e->d_name[0] <= '9')
      n++;
  closedir(d);
  return n;
}
struct Test {
  ggml_context *c;
  ggml_cgraph *g;
  ggml_tensor *out;
  std::vector<unsigned char> expected;
  Test(int id) {
    c = ggml_init({4 << 20, nullptr, false});
    auto *a = ggml_new_tensor_2d(c, GGML_TYPE_F32, 256, 64);
    auto *b = ggml_new_tensor_2d(c, GGML_TYPE_F32, 256, 2);
    for (int i = 0; i < 256 * 64; i++)
      ((float *)a->data)[i] = sinf((i + id) * .01f);
    for (int i = 0; i < 512; i++)
      ((float *)b->data)[i] = cosf((i + id * 7) * .02f);
    out = ggml_mul_mat(c, a, b);
    g = ggml_new_graph(c);
    ggml_build_forward_expand(g, out);
    expected.resize(ggml_nbytes(out));
  }
  ~Test() { ggml_free(c); }
};
int main() {
  cpu_set_t initial_affinity;
  assert(!sched_getaffinity(0, sizeof initial_affinity, &initial_affinity));
  setenv("ENCLAVE_GGML_SHARED_CPU_POOL", "1", 1);
  auto ref = ggml_backend_cpu_init();
  ggml_backend_cpu_set_n_threads(ref, 1);
  std::vector<Test *> cases;
  for (int i = 0; i < 8; i++) {
    auto *t = new Test(i);
    assert(ggml_backend_graph_compute(ref, t->g) == 0);
    cpu_set_t after_reference;
    assert(!sched_getaffinity(0, sizeof after_reference, &after_reference));
    assert(CPU_EQUAL(&initial_affinity, &after_reference));
    memcpy(t->expected.data(), t->out->data, t->expected.size());
    cases.push_back(t);
  }
  ggml_backend_free(ref);
  const int base = threads();
  std::atomic<int> ready{0};
  std::atomic<bool> go{false};
  std::vector<std::thread> clients;
  for (auto *t : cases)
    clients.emplace_back([&ready, &go, t] {
      auto b = ggml_backend_cpu_init();
      ggml_backend_cpu_set_n_threads(b, 6);
      auto plan = ggml_backend_graph_plan_create(b, t->g);
      assert(plan);
      ready++;
      while (!go.load())
        std::this_thread::yield();
      cpu_set_t caller_before;
      assert(!sched_getaffinity(0, sizeof caller_before, &caller_before));
      for (int j = 0; j < 200; j++) {
        assert((j % 2 ? ggml_backend_graph_plan_compute(b, plan)
                      : ggml_backend_graph_compute(b, t->g)) ==
               GGML_STATUS_SUCCESS);
        assert(!memcmp(t->expected.data(), t->out->data, t->expected.size()));
        cpu_set_t caller_after;
        assert(!sched_getaffinity(0, sizeof caller_after, &caller_after));
        assert(CPU_EQUAL(&caller_before, &caller_after));
      }
      ggml_backend_graph_plan_free(b, plan);
      ggml_backend_free(b);
    });
  while (ready.load() != 8)
    std::this_thread::yield();
  int peak = threads();
  assert(peak <= base + 8 + 5);
  go = true;
  for (auto &t : clients)
    t.join();
  fprintf(stderr, "base=%d peak=%d remaining=%d\n", base, peak, threads());
  for (auto end = std::chrono::steady_clock::now() + std::chrono::seconds(1);
       threads() > base + 5 && std::chrono::steady_clock::now() < end;)
    std::this_thread::yield();
  assert(threads() <= base + 5); // Simulate the GPU placement sweep moving idle
                                 // compute workers away.
  std::vector<int> cpus;
  const char *cs = getenv("SHIELDED_CPU_COMPUTE");
  while (*cs) {
    char *end;
    cpus.push_back(strtol(cs, &end, 10));
    cs = *end ? end + 1 : end;
  }
  assert(cpus.size() >= 6);
  std::vector<int> tids;
  DIR *d = opendir("/proc/self/task");
  assert(d);
  while (auto *e = readdir(d)) {
    int tid = atoi(e->d_name);
    if (tid > 0 && tid != getpid())
      tids.push_back(tid);
  }
  closedir(d);
  assert(tids.size() == 5);
  cpu_set_t wrong;
  CPU_ZERO(&wrong);
  CPU_SET(cpus[0], &wrong);
  for (int tid : tids)
    assert(!sched_setaffinity(tid, sizeof wrong, &wrong));
  auto again = ggml_backend_cpu_init();
  ggml_backend_cpu_set_n_threads(again, 6);
  assert(ggml_backend_graph_compute(again, cases[0]->g) == 0);
  assert(!memcmp(cases[0]->expected.data(), cases[0]->out->data,
                 cases[0]->expected.size()));
  ggml_backend_free(again);
  for (int tid : tids) {
    cpu_set_t actual;
    assert(!sched_getaffinity(tid, sizeof actual, &actual));
    assert(CPU_COUNT(&actual) == 1 && !CPU_ISSET(cpus[0], &actual));
    bool found = false;
    for (int i = 1; i < 6; i++)
      found |= CPU_ISSET(cpus[i], &actual);
    assert(found);
  }
  // A caller-owned pool must remain usable after its first backend is freed.
  auto params = ggml_threadpool_params_default(2);
  auto external = ggml_threadpool_new(&params);
  for (int i = 0; i < 2; i++) {
    auto b = ggml_backend_cpu_init();
    ggml_backend_cpu_set_n_threads(b, 2);
    ggml_backend_cpu_set_threadpool(b, external);
    assert(ggml_backend_graph_compute(b, cases[i]->g) == 0);
    assert(!memcmp(cases[i]->expected.data(), cases[i]->out->data,
                   cases[i]->expected.size()));
    ggml_backend_free(b);
  }
  ggml_threadpool_free(external);
  for (auto end = std::chrono::steady_clock::now() + std::chrono::seconds(1);
       threads() > base + 5 && std::chrono::steady_clock::now() < end;)
    std::this_thread::yield();
  assert(threads() == base + 5);
  for (auto *t : cases)
    delete t;
  printf("SHARED_POOL_CONCURRENCY_PASS callers=8 peak_threads=%d "
         "persistent_workers=%d bit_identical=1 affinity_repaired=1 "
         "external_pool_preserved=1 caller_affinity_preserved=1\n",
         peak, threads() - base);
}
