/* worker-spin-test.cpp -- worker_spin.h: the poll is per handle, turns OFF when set to 0 on a handle that was spinning,
 * and never delays data, EOF or an error. The JNI glue stores the value in the Worker it is given, so a handle here is the
 * same shape: a struct holding its own spin_us. */
#include "../worker/worker_spin.h"
#include <cstdio>
#include <sys/socket.h>
#include <unistd.h>
struct Handle { int spin_us = 0; };
static int fails = 0, checks = 0;
static void expect(bool ok, const char *what, long v) { checks++; if (!ok) { fails++; printf("FAIL %s (%ld us)\n", what, v); } }
int main() {
  int sp[2]; if (socketpair(AF_UNIX, SOCK_STREAM, 0, sp)) return 2;
  Handle a, b;
  a.spin_us = worker_spin::clamp_us(5000);
  long t = worker_spin::poll_for_data(sp[0], a.spin_us); expect(t >= 4500, "a spins ~5 ms on an idle link", t);
  expect(b.spin_us == 0 && worker_spin::poll_for_data(sp[0], b.spin_us) == 0, "b is untouched by a's setting", 0);
  a.spin_us = worker_spin::clamp_us(0);                         // on -> off on the SAME handle
  t = worker_spin::poll_for_data(sp[0], a.spin_us); expect(t == 0, "a set back to 0 does not spin", t);
  a.spin_us = worker_spin::clamp_us(20000);
  if (write(sp[1], "x", 1) != 1) return 2;
  t = worker_spin::poll_for_data(sp[0], a.spin_us); expect(t < 2000, "data already waiting ends the poll at once", t);
  char c; expect(read(sp[0], &c, 1) == 1 && c == 'x', "the poll did not consume the byte (MSG_PEEK)", 0);
  close(sp[1]); t = worker_spin::poll_for_data(sp[0], a.spin_us); expect(t < 2000, "EOF ends the poll at once", t);
  close(sp[0]); t = worker_spin::poll_for_data(sp[0], a.spin_us); expect(t < 2000, "a dead descriptor ends the poll at once", t);
  expect(worker_spin::clamp_us(-5) == 0 && worker_spin::clamp_us(99999) == 20000, "clamp to 0..20000", 0);
  printf("%s: %d checks, %d failures\n", fails ? "FAIL" : "PASS", checks, fails);
  return fails ? 1 : 0;
}
