// gwcheck -- run ONE compiled graph on the NPU with deterministic int8 inputs and dump the int16 output,
// so a host reference can say whether the compiled graph computes what it was built to compute.
// Compiling is not correctness: this exists because "the compiler accepted it" has been wrong here before.
//   gwcheck <dispatch_dir> <model.tflite> <out_prefix> <seed> [timed_runs] [perf_mode] [gap_us]
//     perf_mode: -1 leave the runtime default, else a Google Tensor PerformanceMode (0 ExtremePowerSaver,
//                1 PowerSaver, 2 Balanced -- the documented default, 3 HighPerformance, 4 Sustained, 5 Burst)
//     gap_us:    idle time between timed Runs (negative = spin that long instead of sleeping). The real exchange is always Run, gap, Run, and a Run after a
//                3 ms gap measured 30-50 % slower than back to back, so back-to-back timing alone hides it.
// writes <out_prefix>.in<k> (int8, one per input, in signature order) and <out_prefix>.out (int16).
#include <cerrno>
#include <chrono>
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>
#include "litert/cc/litert_compiled_model.h"
#include "litert/cc/litert_environment.h"
#include "litert/cc/litert_environment_options.h"
#include "litert/cc/litert_model.h"
#include "litert/cc/litert_tensor_buffer.h"
#include "litert/cc/litert_options.h"
#include "litert/cc/options/litert_google_tensor_options.h"
#include <thread>
#include <sys/syscall.h>
#include <unistd.h>
#include <cstring>
// sched_setattr is not in bionic's headers; the struct is the kernel's (include/uapi/linux/sched/types.h)
struct gw_sched_attr { uint32_t size, sched_policy; uint64_t sched_flags; int32_t sched_nice; uint32_t sched_priority;
                       uint64_t sched_runtime, sched_deadline, sched_period; uint32_t sched_util_min, sched_util_max; };
// Raise this thread's uclamp.min WITHOUT changing its policy or priority. A floor on utilisation makes
// the governor pick a high frequency whenever the thread runs, including right after it wakes -- so if
// the idle-gap penalty is frequency ramp-down it disappears, and if it is deep-idle exit it does not.
static int set_uclamp_min(int v) {
  gw_sched_attr a; memset(&a, 0, sizeof a); a.size = sizeof a;
  a.sched_flags = 0x08 /*KEEP_POLICY*/ | 0x10 /*KEEP_PARAMS*/ | 0x20 /*UTIL_CLAMP_MIN*/;
  a.sched_util_min = (uint32_t)v;
  return (int)syscall(SYS_sched_setattr, 0, &a, 0);
}

static uint32_t lcg(uint32_t& s) { s = s * 1664525u + 1013904223u; return s; }
static bool dump(const std::string& p, const void* d, size_t n) {
  FILE* f = fopen(p.c_str(), "wb"); if (!f) return false;
  bool ok = fwrite(d, 1, n, f) == n; return fclose(f) == 0 && ok;
}

int main(int argc, char** argv) {
  if (argc < 5) { fprintf(stderr, "usage: gwcheck <dispatch_dir> <model.tflite> <out_prefix> <seed>\n"); return 2; }
  const std::string dispatch = argv[1], path = argv[2], pre = argv[3];
  uint32_t seed = (uint32_t)strtoul(argv[4], nullptr, 10);
  std::vector<litert::EnvironmentOptions::Option> opts;
  opts.push_back({litert::EnvironmentOptions::Tag::kDispatchLibraryDir, dispatch.c_str()});
  auto env = litert::Environment::Create(litert::EnvironmentOptions(opts));
  if (!env) { fprintf(stderr, "FAIL environment: %s\n", env.Error().Message().c_str()); return 3; }
  const int perf = argc > 6 ? atoi(argv[6]) : -1;
  auto copts = litert::Options::Create();
  if (!copts) { fprintf(stderr, "FAIL options\n"); return 14; }
  copts->SetHardwareAccelerators(litert::HwAccelerators::kNpu);
  if (perf >= 0) {
    auto gt = copts->GetGoogleTensorOptions();
    if (!gt) { fprintf(stderr, "FAIL google tensor options\n"); return 15; }
    gt->SetPerformanceMode(static_cast<litert::google_tensor::GoogleTensorOptions::PerformanceMode>(perf));
  }
  auto cm = litert::CompiledModel::Create(*env, path, *copts);
  if (!cm) { fprintf(stderr, "FAIL compile/load: %s\n", cm.Error().Message().c_str()); return 4; }
  auto in = cm->CreateInputBuffers(size_t(0)); auto out = cm->CreateOutputBuffers(size_t(0));
  if (!in || !out || out->size() != 1) { fprintf(stderr, "FAIL buffers\n"); return 5; }
  for (size_t i = 0; i < in->size(); i++) {
    auto z = (*in)[i].PackedSize(); if (!z) { fprintf(stderr, "FAIL input size\n"); return 6; }
    std::vector<int8_t> v(*z);
    for (auto& x : v) x = (int8_t)((int)(lcg(seed) >> 25) - 64);       // uniform in [-64, 63]
    if (auto r = (*in)[i].Write<int8_t>(litert::Span<const int8_t>(v.data(), v.size())); !r) {
      fprintf(stderr, "FAIL input write\n"); return 7; }
    if (!dump(pre + ".in" + std::to_string(i), v.data(), v.size())) { fprintf(stderr, "FAIL dump in\n"); return 8; }
  }
  if (auto r = cm->Run(size_t(0), *in, *out); !r) { fprintf(stderr, "FAIL run: %s\n", r.Error().Message().c_str()); return 9; }
  auto oz = (*out)[0].PackedSize(); if (!oz) { fprintf(stderr, "FAIL output size\n"); return 10; }
  std::vector<int16_t> y(*oz / 2);
  if (auto r = (*out)[0].Read<int16_t>(litert::Span<int16_t>(y.data(), y.size())); !r) {
    fprintf(stderr, "FAIL output read\n"); return 11; }
  if (!dump(pre + ".out", y.data(), y.size() * 2)) { fprintf(stderr, "FAIL dump out\n"); return 12; }
  long nz = 0; for (auto v : y) nz += v != 0;
  printf("\nOK inputs=%zu out_elems=%zu nonzero=%ld\n", in->size(), y.size(), nz);
  // optional 5th arg: time N back-to-back Runs on the same resident model (min and median, ms)
  if (argc > 5) {
    const int N = atoi(argv[5]); std::vector<double> t;
    const int ucl = argc > 8 ? atoi(argv[8]) : -1;
    if (ucl >= 0) { int r = set_uclamp_min(ucl);
      if (r != 0) { fprintf(stderr, "FAIL uclamp.min=%d not granted (errno %d)\n", ucl, errno); return 16; } }
    const int gap_us = argc > 7 ? atoi(argv[7]) : 0;
    for (int i = -5; i < N; i++) {
      // gap_us > 0: SLEEP through the gap (the calling thread and its core go idle, as the worker's do
      // while it blocks on the next request). gap_us < 0: SPIN for |gap_us| (same wall time, core kept
      // busy). If the Run after a spun gap is as fast as back to back, the penalty is the HOST idling.
      if (gap_us > 0) std::this_thread::sleep_for(std::chrono::microseconds(gap_us));
      else if (gap_us < 0) { auto e = std::chrono::steady_clock::now() + std::chrono::microseconds(-gap_us);
                             while (std::chrono::steady_clock::now() < e) { } }
      auto a = std::chrono::steady_clock::now();
      if (auto r = cm->Run(size_t(0), *in, *out); !r) { fprintf(stderr, "FAIL timed run\n"); return 13; }
      double ms = std::chrono::duration<double, std::milli>(std::chrono::steady_clock::now() - a).count();
      if (i >= 0) t.push_back(ms);
    }
    std::sort(t.begin(), t.end());
    printf("TIME n=%d perf=%d gap_us=%d uclamp_min=%d min=%.3f median=%.3f ms\n", N, perf, gap_us, ucl, t.front(), t[t.size() / 2]);
  }
  return 0;
}
