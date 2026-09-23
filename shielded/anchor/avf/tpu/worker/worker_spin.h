// worker_spin.h -- the TPU worker's optional poll-before-sleep on the VM link, as pure code the host can test.
//
// Between exchanges the worker sleeps in read(), and both the wake (160-200 us on the host) and the TPU's idle-gap
// penalty (0.41 ms per Run in gwcheck: the HOST core going idle, not the TPU's power mode) are paid on every exchange.
// Polling keeps the core awake instead; it only pays when a core is spare, so it is a knob and 0 means block.
//
// The setting is PER WORKER HANDLE and the app sets it on every open, zero included (Main.java). It used to be a
// process global that the app wrote only when asked for a positive value, so a spinning run followed by a
// non-spinning one in the same app process kept spinning, and two handles shared one value.
#pragma once
#include <cerrno>
#include <chrono>
#include <sys/socket.h>

namespace worker_spin {
inline int clamp_us(int us) { return us < 0 ? 0 : us > 20000 ? 20000 : us; }
// Returns how long it polled, in microseconds. Returns as soon as data, EOF or an error is visible; the caller's read sees it.
inline long poll_for_data(int fd, int us) {
  if (us <= 0) return 0;
  using C = std::chrono::steady_clock;
  const auto t0 = C::now(), deadline = t0 + std::chrono::microseconds(us); char c;
  while (C::now() < deadline) {
    const ssize_t r = recv(fd, &c, 1, MSG_PEEK | MSG_DONTWAIT);
    if (r >= 0) break;                                                              // data (r > 0) or EOF (r == 0)
    if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) break;           // an error: the read reports it
  }
  return (long)std::chrono::duration_cast<std::chrono::microseconds>(C::now() - t0).count();
}
}  // namespace worker_spin
