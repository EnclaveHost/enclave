// tpu_worker_jni.cc -- the UNTRUSTED half of Enclave Shielded on a phone: the app-side TPU worker (enclave repo:
// shielded/anchor/avf/TPU.md; the wire is documented in payload/ggml-tpu.cpp).
//
// It holds the per-block compiled graphs (L<n>.tflite: signatures qkv | o | gu | down, int16 rows in, int16 rows out, public
// int8 weights) and answers the protected VM's exchanges over the vsock descriptor the app's VM API returned:
//   <- u8 0xE7, u8 layer, u8 kind, u8 rows, rows * n_in int16      -> per projection: rows * n_out int16
//   <- u8 0xE8 (digit-split): 2*rows * n_in int8, hi rows then lo  -> per projection: 2*rows * n_out int16
// Everything it ever sees is masked rows. Buffers are created once per signature and reused for every exchange.
#include <jni.h>
#include <android/log.h>
#include <unistd.h>
#include <sys/uio.h>
#include <sys/socket.h>
#include <cerrno>
#include <chrono>
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>
#include "worker_spin.h"
#include "litert/cc/litert_common.h"
#include "litert/cc/litert_compiled_model.h"
#include "litert/cc/litert_environment.h"
#include "litert/cc/litert_environment_options.h"
#include "litert/cc/litert_model.h"
#include "litert/cc/litert_tensor_buffer.h"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, "anchor-tpu", __VA_ARGS__)
namespace {
using Clock = std::chrono::steady_clock;
double us_since(Clock::time_point t) { return std::chrono::duration<double, std::micro>(Clock::now() - t).count(); }
struct Sig { size_t index = 0; bool present = false; std::vector<litert::TensorBuffer> in, out; size_t in_bytes = 0; std::vector<size_t> out_bytes; };
struct Layer { litert::Model model; litert::CompiledModel compiled; Sig sig[4]; Layer(litert::Model m, litert::CompiledModel c) : model(std::move(m)), compiled(std::move(c)) {} };
struct Worker { litert::Environment env; std::vector<Layer> layers; int rows = 5; int spin_us = 0; std::string err; explicit Worker(litert::Environment e) : env(std::move(e)) {} };
const char* kKinds[4] = {"qkv", "o", "gu", "down"};
bool rd_all(int fd, void* p, size_t n) { size_t o = 0; while (o < n) { ssize_t r = read(fd, (char*)p + o, n - o); if (r < 0 && errno == EINTR) continue; if (r <= 0) return false; o += (size_t)r; } return true; }
size_t packed(litert::TensorBuffer& b) { auto z = b.PackedSize(); return z ? *z : 0; }
/* writev that finishes the job: a partial write means advancing into the iovec array, not an error. */
bool wr_all_v(int fd, iovec* v, size_t n) {
  while (n) {
    ssize_t w = writev(fd, v, (int)n);
    if (w < 0) { if (errno == EINTR) continue; return false; }
    if (w == 0) return false;
    while (n && (size_t)w >= v->iov_len) { w -= (ssize_t)v->iov_len; v++; n--; }
    if (n && w) { v->iov_base = (char*)v->iov_base + w; v->iov_len -= (size_t)w; }
  }
  return true;
}
bool wr_all(int fd, const void* p, size_t n) { size_t o = 0; while (o < n) { ssize_t w = write(fd, (const char*)p + o, n - o); if (w < 0 && errno == EINTR) continue; if (w <= 0) return false; o += (size_t)w; } return true; }
}  // namespace

// Per handle, and set on every open (0 included): see worker_spin.h for why it is not a global.
extern "C" JNIEXPORT void JNICALL Java_host_enclave_anchor_avf_TpuWorker_nativeSetSpin(JNIEnv*, jclass, jlong handle, jint us) {
  if (auto* w = (Worker*)(intptr_t)handle) w->spin_us = worker_spin::clamp_us(us);
}

extern "C" JNIEXPORT jlong JNICALL Java_host_enclave_anchor_avf_TpuWorker_nativeOpen(JNIEnv* env, jclass, jstring jdispatch, jstring jdir, jint n_layers, jint rows) {
  const char* d = env->GetStringUTFChars(jdispatch, nullptr); const char* g = env->GetStringUTFChars(jdir, nullptr); std::string dispatch = d, dir = g;
  env->ReleaseStringUTFChars(jdispatch, d); env->ReleaseStringUTFChars(jdir, g);
  auto t0 = Clock::now();
  std::vector<litert::EnvironmentOptions::Option> opts; opts.push_back({litert::EnvironmentOptions::Tag::kDispatchLibraryDir, dispatch.c_str()});
  auto e = litert::Environment::Create(litert::EnvironmentOptions(opts)); if (!e) { LOGI("environment: %s", e.Error().Message().c_str()); return 0; }
  auto* w = new Worker(std::move(*e)); w->rows = rows;
  for (int L = 0; L < n_layers; L++) {
    const std::string path = dir + "/L" + std::to_string(L) + ".tflite";
    auto m = litert::Model::CreateFromFile(w->env, path); if (!m) { LOGI("%s: %s", path.c_str(), m.Error().Message().c_str()); delete w; return 0; }
    auto c = litert::CompiledModel::Create(w->env, path, litert::HwAccelerators::kNpu);   /* the Model above is kept for the signature names only */ if (!c) { LOGI("%s: compile/load: %s", path.c_str(), c.Error().Message().c_str()); delete w; return 0; }
    w->layers.emplace_back(std::move(*m), std::move(*c)); Layer& ly = w->layers.back();
    auto keys = ly.model.GetSignatureKeys(); if (!keys) { delete w; return 0; }
    for (size_t si = 0; si < keys->size(); si++) for (int k = 0; k < 4; k++) if ((*keys)[si] == kKinds[k]) {
      Sig& s = ly.sig[k]; s.index = si; s.present = true;
      auto in = ly.compiled.CreateInputBuffers(si); auto out = ly.compiled.CreateOutputBuffers(si); auto names = ly.model.GetSignatureOutputNames(si);
      if (!in || !out || !names || in->size() != 1) { LOGI("L%d %s: buffers", L, kKinds[k]); delete w; return 0; }
      s.in = std::move(*in); s.in_bytes = packed(s.in[0]);
      // the wire wants y0, y1, y2 (bundle order): place the runtime's outputs by their signature names
      std::vector<litert::TensorBuffer> ordered; ordered.reserve(out->size()); std::vector<int> pos(out->size(), -1);
      for (size_t o = 0; o < names->size(); o++) { const std::string nm((*names)[o]); if (nm.size() >= 2 && nm[0] == 'y') pos[(size_t)atoi(nm.c_str() + 1)] = (int)o; }
      for (size_t o = 0; o < pos.size(); o++) { if (pos[o] < 0) { LOGI("L%d %s: output y%zu missing", L, kKinds[k], o); delete w; return 0; } }
      s.out.reserve(out->size()); s.out_bytes.resize(out->size());
      for (size_t o = 0; o < pos.size(); o++) { s.out.push_back(std::move((*out)[(size_t)pos[o]])); s.out_bytes[o] = packed(s.out[o]); }
      // in_bytes is the packed byte size; zero it as bytes so this works for int8 digit graphs too.
      std::vector<int8_t> zero(s.in_bytes, 0); s.in[0].Write<int8_t>(litert::Span<const int8_t>(zero.data(), zero.size()));
    }
    if (L % 8 == 0 || L == n_layers - 1) LOGI("loaded L%d (%.1f s so far)", L, us_since(t0) / 1e6);
  }
  LOGI("worker ready: %zu layers, %d rows, %.1f s", w->layers.size(), rows, us_since(t0) / 1e6);
  return (jlong)(intptr_t)w;
}

extern "C" JNIEXPORT jstring JNICALL Java_host_enclave_anchor_avf_TpuWorker_nativeServe(JNIEnv* env, jclass, jlong handle, jint fd) {
  auto* w = (Worker*)(intptr_t)handle; if (!w) return env->NewStringUTF("TPU worker: not open");
  uint64_t n = 0, direct = 0, staged = 0; double wait_us = 0, recv_us = 0, write_us = 0, run_us = 0, read_us = 0, send_us = 0; std::string err;
  std::vector<int16_t> rx, tx; std::vector<int8_t> rx8; uint8_t hdr[4];
  for (;;) {
    auto t0 = Clock::now(); worker_spin::poll_for_data(fd, w->spin_us); if (!rd_all(fd, hdr, 4)) break; auto t1 = Clock::now();
    // 0xE7: rows of int16.  0xE8: DIGIT-SPLIT, 2*rows of int8 (hi rows then lo rows) against a graph whose weights
    // the compiler therefore keeps at one byte instead of two. The reply carries both halves; the VM recombines.
const bool ds = hdr[0] == 0xE8;
    if ((hdr[0] != 0xE7 && !ds) || hdr[1] >= w->layers.size() || hdr[2] > 3 || hdr[3] < 1 || hdr[3] > w->rows) { err = "malformed exchange header"; break; }
    Sig& s = w->layers[hdr[1]].sig[hdr[2]]; if (!s.present) { err = "no such signature"; break; }
    const size_t rows = hdr[3], wire_rows = ds ? 2 * rows : rows, max_wire = ds ? 2 * (size_t)w->rows : (size_t)w->rows;
    // int8 input in digit mode, so in_bytes is already the element count; int16 otherwise.
    const size_t n_in = ds ? s.in_bytes / max_wire : s.in_bytes / 2 / (size_t)w->rows;
    auto t2 = Clock::now();
    if (ds) {
      rx8.resize(wire_rows * n_in);
      if (!rd_all(fd, rx8.data(), rx8.size())) { err = "short exchange body"; break; } t2 = Clock::now();
      if (auto r = s.in[0].Write<int8_t>(litert::Span<const int8_t>(rx8.data(), rx8.size())); !r) { err = "input write: " + r.Error().Message(); break; }
    } else {
      rx.resize(rows * n_in);
      if (!rd_all(fd, rx.data(), rx.size() * 2)) { err = "short exchange body"; break; } t2 = Clock::now();
      if (auto r = s.in[0].Write<int16_t>(litert::Span<const int16_t>(rx.data(), rx.size())); !r) { err = "input write: " + r.Error().Message(); break; }
    }
    auto t3 = Clock::now();
    if (auto r = w->layers[hdr[1]].compiled.Run(s.index, s.in, s.out); !r) { err = "run: " + r.Error().Message(); break; } auto t4 = Clock::now();
    size_t total = 0; for (size_t o = 0; o < s.out.size(); o++) total += wire_rows * (s.out_bytes[o] / 2 / max_wire);
    /* Send STRAIGHT out of the tensor buffers instead of staging them into tx first. This is the engine's
     * 9c7e0e7c ("let the GEMM epilogue write into the ring instead of copying to it"): the products are already
     * in mapped host memory, and copying them somewhere else before writing is pure cost. The rows in use are a
     * contiguous prefix of each output (the buffers are sized for rows_max), so one iovec per output describes
     * the reply exactly, and writev sends the lot in a single syscall.
     * Lock/Unlock is best effort -- if any output will not give a host pointer the staging path below still
     * runs, and the counters say which one was taken. */
    /* MEASURED AND OFF (2026-09-21). Sending straight out of the tensor buffers is the engine's 9c7e0e7c
     * ("let the GEMM epilogue write into the ring instead of copying to it"), and it does remove the staging
     * copy -- output-read 0.317 -> 0.061 ms -- but the copy only MOVES: send goes 0.125 -> 1.148 ms, and decode
     * 1.51 -> 1.26 tok/s. The counters say the path was taken every time (direct 4200, staged 0), so this is
     * what it costs, not a silent fallback. The reason it wins on a server and loses here is that there the
     * products are already in pinned host memory, while this Lock hands back device-coherent memory that the
     * kernel's socket path then reads uncached. LiteRT's own Read into cached heap is the cheaper route. */
    static constexpr bool kDirectSend = false;
    bool ok = true; auto t5 = Clock::now(); bool sent = false;
    if (kDirectSend) {
      std::vector<iovec> iov(s.out.size()); std::vector<size_t> locked; locked.reserve(s.out.size());
      for (size_t o = 0; o < s.out.size(); o++) {
        auto hm = s.out[o].Lock(litert::TensorBuffer::LockMode::kRead);
        if (!hm) break;
        iov[o].iov_base = *hm; iov[o].iov_len = wire_rows * (s.out_bytes[o] / 2 / max_wire) * 2; locked.push_back(o);
      }
      if (locked.size() == s.out.size()) {
        t5 = Clock::now();
        sent = wr_all_v(fd, iov.data(), iov.size());
        if (!sent) err = "reply writev failed";
      }
      for (size_t o : locked) (void)s.out[o].Unlock();
      if (!sent && !err.empty()) break;
    }
    if (!sent) {                                                            /* fallback: stage, then write */
      tx.resize(total); size_t off = 0;
      for (size_t o = 0; o < s.out.size() && ok; o++) { const size_t cnt = wire_rows * (s.out_bytes[o] / 2 / max_wire); if (auto r = s.out[o].Read<int16_t>(litert::Span<int16_t>(tx.data() + off, cnt)); !r) { err = "output read: " + r.Error().Message(); ok = false; } off += cnt; }
      if (!ok) break; t5 = Clock::now();
      if (!wr_all(fd, tx.data(), tx.size() * 2)) { err = "reply write failed"; break; }
      staged++;
    } else { direct++; }
    auto t6 = Clock::now();
    n++; wait_us += std::chrono::duration<double, std::micro>(t1 - t0).count(); recv_us += std::chrono::duration<double, std::micro>(t2 - t1).count();
    write_us += std::chrono::duration<double, std::micro>(t3 - t2).count(); run_us += std::chrono::duration<double, std::micro>(t4 - t3).count();
    read_us += std::chrono::duration<double, std::micro>(t5 - t4).count(); send_us += std::chrono::duration<double, std::micro>(t6 - t5).count();
  }
  char buf[512]; const double d = n ? (double)n : 1.0;
  snprintf(buf, sizeof buf, "TPU worker: %llu exchanges; per exchange ms: idle-wait %.3f recv %.3f input-write %.3f tpu-run %.3f output-read %.3f send %.3f | direct %llu staged %llu spin_us %d%s%s",
           (unsigned long long)n, wait_us / d / 1e3, recv_us / d / 1e3, write_us / d / 1e3, run_us / d / 1e3, read_us / d / 1e3, send_us / d / 1e3, (unsigned long long)direct, (unsigned long long)staged, w->spin_us, err.empty() ? "" : " ERROR: ", err.c_str());
  LOGI("%s", buf); return env->NewStringUTF(buf);
}
// What one invocation costs by itself: each signature of two blocks, back to back and then with an idle gap between calls
// (the real exchange pattern: the VM works for a few ms between exchanges). Public zeros in, nothing secret involved.
extern "C" JNIEXPORT jstring JNICALL Java_host_enclave_anchor_avf_TpuWorker_nativeBench(JNIEnv* env, jclass, jlong handle) {
  auto* w = (Worker*)(intptr_t)handle; if (!w) return env->NewStringUTF("TPU bench: not open");
  std::string out = "TPU bench (ms per Run, min/mean):";
  for (size_t L : {size_t(0), w->layers.size() / 2 + 3}) { if (L >= w->layers.size()) continue;
    for (int k = 0; k < 4; k++) { Sig& s = w->layers[L].sig[k]; if (!s.present) continue;
      for (int gap_us : {0, 3000}) { double mn = 1e9, sum = 0; const int N = 40;
        for (int i = -5; i < N; i++) { if (gap_us) usleep(gap_us); auto t = Clock::now(); if (auto r = w->layers[L].compiled.Run(s.index, s.in, s.out); !r) return env->NewStringUTF("TPU bench: run failed"); double u = us_since(t); if (i >= 0) { sum += u; if (u < mn) mn = u; } }
        char b[96]; snprintf(b, sizeof b, " L%zu.%s%s %.2f/%.2f", L, kKinds[k], gap_us ? "+3ms-gap" : "", mn / 1e3, sum / N / 1e3); out += b; } } }
  LOGI("%s", out.c_str()); return env->NewStringUTF(out.c_str());
}
extern "C" JNIEXPORT void JNICALL Java_host_enclave_anchor_avf_TpuWorker_nativeClose(JNIEnv*, jclass, jlong handle) { delete (Worker*)(intptr_t)handle; }
