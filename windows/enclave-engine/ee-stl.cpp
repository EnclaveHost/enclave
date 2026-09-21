/* ee-stl.cpp -- the MSVC STL's runtime entry points (normally msvcp/libcpmt, which no enclave has):
 * std::thread/mutex/condition_variable/chrono/atomic-wait/system_error over vertdll's primitives.
 * The declarations come from the STL's own headers, so a signature that drifts fails to compile
 * rather than silently mismatching the ABI. Threads are host-entered (ee-rt.c _beginthreadex). */
#include <windows.h>
#include <cstring>
#include <mutex>
#include <thread>
#include <condition_variable>
#include <chrono>
#include <system_error>
#include <stdexcept>
#include <functional>
#include <xthreads.h>
#include <xtimec.h>
#include "ee-rt.h"

extern "C" {
_Thrd_result __cdecl _Thrd_detach(_Thrd_t t) noexcept { CloseHandle(t._Hnd); return _Thrd_result::_Success; }
_Thrd_result __cdecl _Thrd_join(_Thrd_t t, int *res) noexcept { WaitForSingleObject(t._Hnd, INFINITE); CloseHandle(t._Hnd); if (res) *res = 0; return _Thrd_result::_Success; }
void __cdecl _Thrd_yield() noexcept { YieldProcessor(); }
unsigned int __cdecl _Thrd_hardware_concurrency() noexcept { return ee_cpu_count(); }
_Thrd_id_t __cdecl _Thrd_id() noexcept { return GetCurrentThreadId(); }
void __stdcall _Thrd_sleep_for(unsigned long ms) noexcept { ee_sleep_ms(ms); }

static PSRWLOCK srw(_Mtx_t m) { return (PSRWLOCK)&m->_Critical_section._M_srw_lock; }
void __cdecl _Mtx_init_in_situ(_Mtx_t m, int type) noexcept { m->_Type = type; m->_Critical_section._Unused = nullptr; m->_Critical_section._M_srw_lock = nullptr; m->_Thread_id = -1; m->_Count = 0; }
void __cdecl _Mtx_destroy_in_situ(_Mtx_t) noexcept {}
int __cdecl _Mtx_current_owns(_Mtx_t m) noexcept { return m->_Count != 0 && m->_Thread_id == (long)GetCurrentThreadId(); }
_Thrd_result __cdecl _Mtx_lock(_Mtx_t m) noexcept {
    const long me = (long)GetCurrentThreadId();
    if (m->_Thread_id == me && m->_Count) { if (m->_Type & _Mtx_recursive) { m->_Count++; return _Thrd_result::_Success; } return _Thrd_result::_Busy; }
    AcquireSRWLockExclusive(srw(m)); m->_Thread_id = me; m->_Count = 1; return _Thrd_result::_Success;
}
_Thrd_result __cdecl _Mtx_trylock(_Mtx_t m) noexcept {
    const long me = (long)GetCurrentThreadId();
    if (m->_Thread_id == me && m->_Count) { if (m->_Type & _Mtx_recursive) { m->_Count++; return _Thrd_result::_Success; } return _Thrd_result::_Busy; }
    if (!TryAcquireSRWLockExclusive(srw(m))) return _Thrd_result::_Busy;
    m->_Thread_id = me; m->_Count = 1; return _Thrd_result::_Success;
}
_Thrd_result __cdecl _Mtx_unlock(_Mtx_t m) noexcept { if (--m->_Count == 0) { m->_Thread_id = -1; ReleaseSRWLockExclusive(srw(m)); } return _Thrd_result::_Success; }

static PCONDITION_VARIABLE cvp(_Cnd_t c) { return (PCONDITION_VARIABLE)&c->_Cv_storage; }
void __cdecl _Cnd_init_in_situ(_Cnd_t c) noexcept { std::memset(&c->_Cv_storage, 0, sizeof c->_Cv_storage); }
void __cdecl _Cnd_destroy_in_situ(_Cnd_t) noexcept {}
_Thrd_result __cdecl _Cnd_wait(_Cnd_t c, _Mtx_t m) noexcept {
    const long tid = m->_Thread_id; const int cnt = m->_Count; m->_Thread_id = -1; m->_Count = 0;
    SleepConditionVariableSRW(cvp(c), srw(m), INFINITE, 0);
    m->_Thread_id = tid; m->_Count = cnt; return _Thrd_result::_Success;
}
_Thrd_result __stdcall _Cnd_timedwait_for_unchecked(_Cnd_t c, _Mtx_t m, unsigned int ms) noexcept {
    const long tid = m->_Thread_id; const int cnt = m->_Count; m->_Thread_id = -1; m->_Count = 0;
    const BOOL ok = SleepConditionVariableSRW(cvp(c), srw(m), ms, 0);
    m->_Thread_id = tid; m->_Count = cnt; return ok ? _Thrd_result::_Success : _Thrd_result::_Timedout;
}
_Thrd_result __cdecl _Cnd_broadcast(_Cnd_t c) noexcept { WakeAllConditionVariable(cvp(c)); return _Thrd_result::_Success; }
_Thrd_result __cdecl _Cnd_signal(_Cnd_t c) noexcept { WakeConditionVariable(cvp(c)); return _Thrd_result::_Success; }
void __cdecl _Cnd_register_at_thread_exit(_Cnd_t, _Mtx_t, int *) noexcept {}
void __cdecl _Cnd_unregister_at_thread_exit(_Mtx_t) noexcept {}
void __cdecl _Cnd_do_broadcast_at_thread_exit() noexcept {}

long long __cdecl _Xtime_get_ticks() noexcept { return ee_filetime() - 116444736000000000LL; }   /* 100 ns since 1970 */
long long __cdecl _Query_perf_counter() noexcept { LARGE_INTEGER c; QueryPerformanceCounter(&c); return c.QuadPart; }
long long __cdecl _Query_perf_frequency() noexcept { LARGE_INTEGER f; QueryPerformanceFrequency(&f); return f.QuadPart; }
long __cdecl _Xtime_diff_to_millis2(const _timespec64 *a, const _timespec64 *b) noexcept {
    long long ms = (a->tv_sec - b->tv_sec) * 1000 + (a->tv_nsec - b->tv_nsec + 999999) / 1000000; return ms < 0 ? 0 : (long)ms;
}

void __stdcall __std_atomic_notify_all_direct(const void *s) noexcept { WakeByAddressAll(const_cast<void *>(s)); }
void __stdcall __std_atomic_notify_one_direct(const void *s) noexcept { WakeByAddressSingle(const_cast<void *>(s)); }
int __stdcall __std_atomic_wait_direct(const void *s, void *cmp, size_t sz, unsigned long to) noexcept { return WaitOnAddress(const_cast<volatile void *>(s), cmp, sz, to); }
unsigned long long __stdcall __std_atomic_wait_get_deadline(unsigned long long rel) noexcept { return (unsigned long long)(ee_now_us() / 1000) + rel; }
unsigned long __stdcall __std_atomic_wait_get_remaining_timeout(unsigned long long deadline) noexcept { unsigned long long now = (unsigned long long)(ee_now_us() / 1000); return deadline > now ? (unsigned long)(deadline - now) : 0; }
size_t __stdcall __std_system_error_allocate_message(unsigned long, char **) noexcept { return 0; }
void __stdcall __std_system_error_deallocate_message(char *) noexcept {}
}

namespace std {
const char *__cdecl _Syserror_map(int) { return "unknown error"; }
int __cdecl _Winerror_map(int) { return 0; }
[[noreturn]] void __cdecl _Throw_Cpp_error(int code) { throw system_error(code, generic_category(), "thread"); }
[[noreturn]] void __cdecl _Throw_C_error(int code) { throw system_error(code, generic_category(), "c error"); }
}
