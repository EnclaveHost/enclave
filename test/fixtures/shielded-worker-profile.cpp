#include "../../shielded/worker-cuda/exchange-profile.h"
#include <cassert>

using Profile = WorkerExchangeProfile;
static Profile::Time at(int us) { return Profile::Time{} + std::chrono::microseconds(us); }

int main() {
    Profile a, b;
    // Interleave two connections. Each elapsed interval uses its own start,
    // and closing/resetting one connection cannot erase the other's samples.
    a.begin(at(0)); b.begin(at(100));
    assert(a.mark(Profile::LOCK_WAIT, at(10)));
    assert(b.mark(Profile::LOCK_WAIT, at(130)));
    assert(a.mark(Profile::STAGING, at(12)));
    assert(b.mark(Profile::STAGING, at(135)));
    assert(a.samples[Profile::LOCK_WAIT].total_us == 10);
    assert(b.samples[Profile::LOCK_WAIT].total_us == 30);
    a = Profile{};
    assert(b.samples[Profile::LOCK_WAIT].count == 1);
    assert(b.samples[Profile::STAGING].total_us == 5);
    b.begin(at(200));
    assert(b.mark(Profile::LOCK_WAIT, at(210)));
    assert(b.samples[Profile::LOCK_WAIT].count == 2);
    assert(b.samples[Profile::LOCK_WAIT].total_us == 40);
    assert(b.samples[Profile::LOCK_WAIT].max_us == 30);
    // A failed/unreached phase gets no fabricated sample. An invalid clock
    // interval is reported and cannot contaminate a subsequent measurement.
    assert(b.samples[Profile::STREAM_SYNC].count == 0);
    assert(!a.mark(Profile::STAGING, at(1)));
    a.begin(at(10));
    assert(!a.mark(Profile::STAGING, at(9)));
    assert(a.invalid_intervals == 2 && a.samples[Profile::STAGING].count == 0);
    a.begin(at(20)); assert(a.mark(Profile::STAGING, at(20)));
    assert(a.samples[Profile::STAGING].count == 1 && a.samples[Profile::STAGING].total_us == 0);
    b.begin(at(1000)); assert(b.mark(Profile::TCP_REPLY, at(1007)));
    assert(b.samples[Profile::TCP_REPLY].total_us == 7);
    assert(b.samples[Profile::LOCK_WAIT].total_us == 40);
}
