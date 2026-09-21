/* ee-compat.h -- force-included (cl /FI) into EVERY translation unit of the enclave engine:
 * llama.cpp, ggml, the shielded engine and our own runtime. It makes those sources compile
 * unmodified for a VBS enclave, the same way windows/worker-win/win-compat.h does for the
 * worker. What an enclave lacks and how it is supplied (ee-rt.c, ee-stl.cpp, posix/):
 *   threads   no CreateThread in VTL1: a thread is a HOST thread that enters the enclave
 *             through the exported EeThread routine (host-entered threads; see ee-rt.c)
 *   sockets   the worker link is a call-out to the host, which owns the TCP socket
 *   files     the model and the calibration are host memory the enclave reads directly
 *   clock     QueryPerformanceCounter exists; wall time is the host's clock at init + QPC
 *   env       a block handed over at init, then immutable
 *   stdio     printf/fprintf go to the host's log through a call-out
 * The three defines below are what Microsoft's own enclave C++ support uses: kernel32 and
 * CRT declarations lose __declspec(dllimport) so our definitions satisfy them. */
#ifndef EE_COMPAT_H
#define EE_COMPAT_H
#define __ENCLAVE_PROJECT__ 1
#define _KERNEL32_ 1
#define _ADVAPI32_ 1
#define _ACRTIMP
#define _CRTIMP2_IMPORT
#define _CRTIMP2_PURE_IMPORT
#define _CRTDATA2_IMPORT
#define _ALLOW_RUNTIME_LIBRARY_MISMATCH 1
#define _CRT_SECURE_NO_WARNINGS 1
#define _CRT_NONSTDC_NO_WARNINGS 1
#define _CRT_DECLARE_NONSTDC_NAMES 1
#define WIN32_LEAN_AND_MEAN 1
#define NOMINMAX 1
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef GGML_MAX_NAME
#define GGML_MAX_NAME 128
#endif
#define GGML_USE_CPU 1
#define __attribute__(x)
/* a 64-bit off_t before the UCRT can define its 32-bit one */
#define _OFF_T_DEFINED 1
typedef long long _off_t;
typedef _off_t off_t;
#include <stddef.h>
#include <stdint.h>
#include <time.h>
#include <intrin.h>
#ifndef _SSIZE_T_DEFINED
typedef ptrdiff_t ssize_t;
#define _SSIZE_T_DEFINED 1
#endif
typedef int pid_t;
typedef unsigned int mode_t;
typedef int socklen_t;
typedef unsigned short sa_family_t;
#ifdef __cplusplus
extern "C" {
#endif
/* clocks (posix) */
#ifndef CLOCK_MONOTONIC
#define CLOCK_REALTIME 0
#define CLOCK_MONOTONIC 1
#define CLOCK_THREAD_CPUTIME_ID 3
typedef int clockid_t;
#endif
#define PATH_MAX 260
/* gcc builtins the shielded sources use */
#define __builtin_expect(e, c) (e)
#define __builtin_lrintf(x) lrintf(x)
#define __builtin_cpu_init() ((void)0)
#define __builtin_cpu_supports(f) ee_cpu_supports(f)
#define __ATOMIC_RELAXED 0
#define __ATOMIC_CONSUME 1
#define __ATOMIC_ACQUIRE 2
#define __ATOMIC_RELEASE 3
#define __ATOMIC_ACQ_REL 4
#define __ATOMIC_SEQ_CST 5
#define __atomic_load_n(p, o)                 ee_atomic_load_((const volatile void *)(p), sizeof *(p))
#define __atomic_store_n(p, v, o)             ee_atomic_store_((volatile void *)(p), (unsigned long long)(v), sizeof *(p))
#define __atomic_fetch_add(p, v, o)           ee_atomic_fetch_add_((volatile void *)(p), (unsigned long long)(v), sizeof *(p))
#define __atomic_add_fetch(p, v, o)           (ee_atomic_fetch_add_((volatile void *)(p), (unsigned long long)(v), sizeof *(p)) + (v))
#define __atomic_fetch_or(p, v, o)            ee_atomic_fetch_or_((volatile void *)(p), (unsigned long long)(v), sizeof *(p))
#define __atomic_compare_exchange_n(p, e, d, w, so, fo) ee_atomic_cas_((volatile void *)(p), (void *)(e), (unsigned long long)(d), sizeof *(p))
#define __sync_synchronize() __faststorefence()
int ee_cpu_supports(const char *feature);
unsigned long long ee_atomic_load_(const volatile void *p, size_t n);
void ee_atomic_store_(volatile void *p, unsigned long long v, size_t n);
unsigned long long ee_atomic_fetch_add_(volatile void *p, unsigned long long v, size_t n);
unsigned long long ee_atomic_fetch_or_(volatile void *p, unsigned long long v, size_t n);
int ee_atomic_cas_(volatile void *p, void *expected, unsigned long long desired, size_t n);
int posix_memalign(void **out, size_t align, size_t size);
long syscall(long n, ...);
int clock_gettime(clockid_t id, struct timespec *ts);
int usleep(unsigned int us);
unsigned int sleep(unsigned int s);
int nanosleep(const struct timespec *req, struct timespec *rem);
long ftello(void *f);
int fseeko(void *f, long long off, int whence);
#ifdef __cplusplus
}
#endif
#include "ee-rt.h"
#endif
