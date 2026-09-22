/* ee-rt.c -- the enclave engine's runtime: everything an enclave lacks that llama.cpp, ggml and
 * the shielded engine expect, supplied over vertdll's real primitives (SRW locks, condition
 * variables, WaitOnAddress, QueryPerformanceCounter, TLS, CallEnclave) and call-outs to the host.
 * See ee-compat.h for the map. Nothing here is a security boundary: the host is untrusted and
 * everything that crosses is public (masked frames, log lines) or verified afterwards. */
#include <windows.h>
#include <bcrypt.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <errno.h>
#include <process.h>
#include "ee-rt.h"
#include "posix/pthread.h"
#include "posix/sys/socket.h"
#include "posix/sys/uio.h"
#include "posix/netdb.h"
#include "posix/poll.h"
#include "posix/unistd.h"
#include "posix/sys/stat.h"
#include "posix/sys/mman.h"
#include "posix/dirent.h"
#include "posix/dlfcn.h"
#include "posix/sys/time.h"
#include "posix/sys/resource.h"
#include "posix/fcntl.h"

/* ---- init state -------------------------------------------------------------------------- */
static void *g_callout;                          /* VTL0 routine */
static uint8_t *g_slots; static uint64_t g_slot_bytes; static uint32_t g_n_slots;
static DWORD g_tls_slot = TLS_OUT_OF_INDEXES;
/* THE THREAD'S IDENTITY, AND WHY IT IS NOT `c->slot`.
 *
 * `g_slots` is the HOST's buffer - it is how the two sides pass a call-out - so every byte of the
 * ee_callout header, `slot` included, is writable by VTL0 at any moment. Reading it back as this
 * thread's identity let the host rename a thread, or give two live threads the same name. The
 * runtime above indexes per-thread state by that name and hands out unsynchronised `&mut` from it
 * on the strength of its uniqueness, so the host could have produced two `&mut` to one object.
 *
 * So identity lives HERE, in enclave memory, and the host never sees it: an index into
 * `g_tok_used` plus an EPOCH that increments every time the index is handed out. The epoch is
 * what makes reuse safe - a consumer that cached state under an index can tell that the index is
 * now a different thread, rather than inheriting the old one's state.
 *
 * Both the slot and the token are RETURNED when a thread exits. The previous slot allocator only
 * ever counted up and `__fastfail`ed on the 97th thread of the enclave's LIFE, even if they ran
 * one after another; a guest that spawns and joins in a loop would have killed the image. */
#define EE_MAX_TOK 256
static volatile LONG g_tok_used[EE_MAX_TOK];
static volatile LONG64 g_tok_epoch[EE_MAX_TOK];
static volatile LONG64 g_epoch_next = 1;
static DWORD g_tls_tok = TLS_OUT_OF_INDEXES;      /* token + 1, so 0 means "none yet" */
static char *g_env; static size_t g_env_len;
static uint32_t g_cpus = 4;
static int64_t g_unix0, g_ft0, g_qpc0, g_qpf;
static ee_file_desc g_files[EE_MAX_FILES]; static char g_file_names[EE_MAX_FILES][260]; static uint32_t g_n_files;

int ee_rt_init(const ee_init_params *p) {
    if (!p || p->size < sizeof(ee_init_params) || p->version != EE_ABI_VERSION) return -1;
    if (!p->callout || !p->slots || p->slot_bytes < 65536 || !p->n_slots) return -2;
    g_callout = p->callout; g_slots = p->slots; g_slot_bytes = p->slot_bytes; g_n_slots = p->n_slots;
    if (g_tls_slot == TLS_OUT_OF_INDEXES) { g_tls_slot = TlsAlloc(); if (g_tls_slot == TLS_OUT_OF_INDEXES) return -3; }
    if (g_tls_tok == TLS_OUT_OF_INDEXES) { g_tls_tok = TlsAlloc(); if (g_tls_tok == TLS_OUT_OF_INDEXES) return -3; }
    g_cpus = p->cpu_count ? p->cpu_count : 4;
    LARGE_INTEGER f, c; QueryPerformanceFrequency(&f); QueryPerformanceCounter(&c); g_qpf = f.QuadPart; g_qpc0 = c.QuadPart;
    g_unix0 = p->unix_time; g_ft0 = p->filetime;
    /* copy the environment and the file table INTO the enclave: the host can change its copy later */
    if (p->env && p->env_len && p->env_len < (1u << 20)) { g_env = (char *)malloc(p->env_len + 2); memcpy(g_env, p->env, p->env_len); g_env[p->env_len] = 0; g_env[p->env_len + 1] = 0; g_env_len = p->env_len; }
    g_n_files = p->n_files > EE_MAX_FILES ? EE_MAX_FILES : p->n_files;
    for (uint32_t i = 0; i < g_n_files; i++) {
        const char *n = p->files[i].name; size_t k = 0; while (n && n[k] && k < 259) { g_file_names[i][k] = n[k]; k++; } g_file_names[i][k] = 0;
        g_files[i].name = g_file_names[i]; g_files[i].data = p->files[i].data; g_files[i].len = p->files[i].len;
    }
    return 0;
}
uint32_t ee_cpu_count(void) { return g_cpus; }
const ee_file_desc *ee_file_lookup(const char *name) {
    if (!name) return NULL;
    /* match on the tail so "C:\x\model.gguf", "./model.gguf" and "model.gguf" all find "model.gguf" */
    const char *base = name; for (const char *q = name; *q; q++) if (*q == '/' || *q == '\\') base = q + 1;
    for (uint32_t i = 0; i < g_n_files; i++) if (!strcmp(g_files[i].name, name) || !strcmp(g_files[i].name, base)) return &g_files[i];
    return NULL;
}

/* ---- call-outs --------------------------------------------------------------------------- */
/* Claim this thread's identity, once, from enclave memory. Returns the token or -1 when the
 * enclave is out - which the caller reports rather than dying on. */
static LONG ee_tok_claim(void) {
    const LONG cap = (LONG)(g_n_slots < EE_MAX_TOK ? g_n_slots : EE_MAX_TOK);
    for (LONG i = 0; i < cap; i++) {
        if (InterlockedCompareExchange(&g_tok_used[i], 1, 0) == 0) {
            InterlockedExchange64(&g_tok_epoch[i], InterlockedIncrement64(&g_epoch_next));
            return i;
        }
    }
    return -1;
}
static void ee_tok_free(LONG i) {
    if (i < 0 || i >= EE_MAX_TOK) return;
    /* Bump the epoch on release too, so state cached against the OLD incarnation is stale the
     * moment the thread is gone, not merely once the index is handed out again. */
    InterlockedExchange64(&g_tok_epoch[i], InterlockedIncrement64(&g_epoch_next));
    InterlockedExchange(&g_tok_used[i], 0);
}
/* This thread's token, claimed on first use. `__fastfail` only when there is genuinely no way to
 * continue: a thread with no token cannot call out at all. */
static LONG ee_tok(void) {
    const uintptr_t v = (uintptr_t)TlsGetValue(g_tls_tok);
    if (v) return (LONG)(v - 1);
    const LONG i = ee_tok_claim();
    if (i < 0) { __fastfail(7); }
    TlsSetValue(g_tls_tok, (void *)(uintptr_t)(i + 1));
    return i;
}
ee_callout *ee_slot(void) {
    void *v = TlsGetValue(g_tls_slot);
    if (v) return (ee_callout *)v;
    /* One slot per token, so the slot is the token's index - no second allocator to keep in step,
     * and returning the token returns the slot. */
    const LONG i = ee_tok();
    ee_callout *c = (ee_callout *)(g_slots + (uint64_t)i * g_slot_bytes);
    c->cap = g_slot_bytes - offsetof(ee_callout, data); c->slot = (uint32_t)i;
    TlsSetValue(g_tls_slot, c);
    return c;
}
/* Give back this thread's slot and token. Called when a spawned thread's body returns. */
static void ee_slot_release(void) {
    const uintptr_t v = (uintptr_t)TlsGetValue(g_tls_tok);
    if (!v) return;
    TlsSetValue(g_tls_slot, NULL);
    TlsSetValue(g_tls_tok, NULL);
    ee_tok_free((LONG)(v - 1));
}
int64_t ee_callout_call(ee_callout *c) {
    void *ret = NULL;
    if (!CallEnclave((LPENCLAVE_ROUTINE)g_callout, c, TRUE, &ret)) return -EIO;
    return c->ret;
}
void ee_fatal(const char *msg) { ee_log("[enclave] FATAL: %s\n", msg); __fastfail(8); }

/* ---- park / unpark ------------------------------------------------------------------------
 * The blocking primitive `memory.atomic.wait` needs. See EE_OP_PARK in ee-rt.h for why it has to
 * leave the enclave at all and why it is a PERMIT rather than a signal.
 *
 * The token is the thread's own call-out slot index: already unique per enclave thread, already
 * bounded by n_slots, and already allocated lazily on first use - so a thread that never parks
 * costs nothing. */
/* ENCLAVE-OWNED, deliberately: see the note beside g_tok_used. `ee_slot()->slot` would be the
 * host's copy of this number and the host may change it. */
uint32_t ee_park_token(void) { return (uint32_t)ee_tok(); }
/* The incarnation of this thread's token. State cached per token must be discarded when this
 * changes, which is what makes reusing a token safe. */
uint64_t ee_park_epoch(void) { return (uint64_t)g_tok_epoch[ee_tok()]; }
int ee_park(uint32_t token, uint64_t timeout_ms) {
    ee_callout *c = ee_slot();
    c->op = EE_OP_PARK; c->handle = token; c->len = 0; c->arg = timeout_ms;
    return (int)ee_callout_call(c);
}
void ee_unpark(uint32_t token) {
    ee_callout *c = ee_slot();
    c->op = EE_OP_UNPARK; c->handle = token; c->len = 0; c->arg = 0;
    ee_callout_call(c);
}

/* ---- what the wasm runtime asks for --------------------------------------------------------
 * The four hooks crates/wasmtime/src/runtime/vm/nostd_threads.rs declares. They are named for
 * wasmtime rather than for this engine on purpose: wasmtime should not know it is inside a VBS
 * enclave, and an embedder on some other OS-less target provides these same four and nothing
 * else. Everything the threads proposal needs that an OS would normally give - blocking, waking,
 * thread identity, a monotonic clock - is here and is four functions long. */
int32_t wasmtime_thread_park(uint64_t timeout_ms) { return (int32_t)ee_park(ee_park_token(), timeout_ms); }
void wasmtime_thread_unpark(uint32_t token) { ee_unpark(token); }
uint32_t wasmtime_thread_token(void) { return ee_park_token(); }
uint64_t wasmtime_thread_epoch(void) { return ee_park_epoch(); }
/* MONOTONIC, which is all the runtime needs: ee_now_us counts from enclave start off the
 * performance counter, so it cannot go backwards the way a host wall clock can. */
/* How many threads a guest may usefully run. The enclave has no environment to read and no OS to
 * ask, so this is the cpu_count the host passed at init - which is also where an operator's
 * override belongs, since only the host can see one. */
/* SPAWN and JOIN. The enclave already has a threading layer - CreateThread here routes through
 * _beginthreadex to the host's EE_OP_SPAWN, and WaitForSingleObject blocks on the thread record's
 * `done` flag - so the runtime does not need a new mechanism, only a name for the one that exists.
 *
 * `entry` is a trampoline the runtime supplies; `arg` is its boxed closure. The handle is the
 * enclave's own thread record, opaque to the caller and released by the join. */
static DWORD WINAPI ee_rt_thread_tramp(LPVOID p) {
    struct { void (*entry)(void *); void *arg; } *b = p;
    void (*entry)(void *) = b->entry; void *arg = b->arg;
    free(b);
    entry(arg);
    return 0;
}
void *wasmtime_thread_spawn(void (*entry)(void *), void *arg) {
    struct { void (*entry)(void *); void *arg; } *b = malloc(sizeof *b);
    if (!b) return NULL;
    b->entry = entry; b->arg = arg;
    HANDLE h = CreateThread(NULL, 1u << 20, ee_rt_thread_tramp, b, 0, NULL);
    if (!h) { free(b); return NULL; }
    return (void *)h;
}
int32_t wasmtime_thread_join(void *handle) {
    if (!handle) return -1;
    const DWORD r = WaitForSingleObject((HANDLE)handle, INFINITE);
    CloseHandle((HANDLE)handle);
    return r == WAIT_OBJECT_0 ? 0 : -1;
}
/* Let go of a thread without waiting for it - the `detach` half of a join handle. */
void wasmtime_thread_detach(void *handle) { if (handle) CloseHandle((HANDLE)handle); }

/* The environment the host passed at init, read-only. Same block a tenant's app sees. */
const char *wasmtime_getenv(const char *name) { return ee_getenv(name); }
uint32_t wasmtime_available_parallelism(void) { const uint32_t n = ee_cpu_count(); return n ? n : 1; }
uint64_t wasmtime_now_ms(void) { const int64_t us = ee_now_us(); return us > 0 ? (uint64_t)(us / 1000) : 0; }

/* ---- logging (stdout/stderr) ------------------------------------------------------------- */
void ee_write_log(const void *p, size_t n) {
    ee_callout *c = ee_slot(); const uint8_t *s = (const uint8_t *)p;
    while (n) { size_t k = n > c->cap ? (size_t)c->cap : n; c->op = EE_OP_LOG; c->len = k; memcpy(c->data, s, k); ee_callout_call(c); s += k; n -= k; }
}
void ee_logv(const char *fmt, va_list ap) { char buf[2048]; int n = vsnprintf(buf, sizeof buf, fmt, ap); if (n < 0) return; if (n > (int)sizeof buf - 1) n = (int)sizeof buf - 1; ee_write_log(buf, (size_t)n); }
void ee_log(const char *fmt, ...) { va_list ap; va_start(ap, fmt); ee_logv(fmt, ap); va_end(ap); }

/* ---- clock, sleep, env, random ----------------------------------------------------------- */
int64_t ee_now_us(void) { LARGE_INTEGER c; QueryPerformanceCounter(&c); return (int64_t)((double)(c.QuadPart - g_qpc0) * 1e6 / (double)g_qpf); }
int64_t ee_unix_time(void) { return g_unix0 + ee_now_us() / 1000000; }
int64_t ee_filetime(void) { return g_ft0 + ee_now_us() * 10; }
void ee_sleep_ms(uint32_t ms) { static volatile LONG dummy = 0; LONG cmp = 0; if (ms == 0) { YieldProcessor(); return; } WaitOnAddress(&dummy, &cmp, sizeof cmp, ms); }
const char *ee_getenv(const char *k) {
    if (!g_env || !k) return NULL; size_t kl = strlen(k);
    for (const char *p = g_env; *p; p += strlen(p) + 1) if (!strncmp(p, k, kl) && p[kl] == '=') return p + kl + 1;
    return NULL;
}
int ee_random(void *p, size_t n) { return BCryptGenRandom(NULL, (PUCHAR)p, (ULONG)n, BCRYPT_USE_SYSTEM_PREFERRED_RNG) == 0 ? 0 : -1; }
char *__cdecl getenv(const char *k) { return (char *)ee_getenv(k); }
__time64_t __cdecl _time64(__time64_t *t) { __time64_t v = (__time64_t)ee_unix_time(); if (t) *t = v; return v; }
int clock_gettime(clockid_t id, struct timespec *ts) { int64_t us = id == CLOCK_REALTIME ? ee_unix_time() * 1000000 + ee_now_us() % 1000000 : ee_now_us(); ts->tv_sec = (time_t)(us / 1000000); ts->tv_nsec = (long)(us % 1000000) * 1000; return 0; }
int usleep(unsigned int us) { ee_sleep_ms(us / 1000 + (us % 1000 ? 1 : 0)); return 0; }
unsigned int sleep(unsigned int s) { ee_sleep_ms(s * 1000); return 0; }
int nanosleep(const struct timespec *req, struct timespec *rem) { (void)rem; ee_sleep_ms((uint32_t)(req->tv_sec * 1000 + req->tv_nsec / 1000000)); return 0; }
ssize_t getrandom(void *p, size_t n, unsigned flags) { (void)flags; return ee_random(p, n) == 0 ? (ssize_t)n : -1; }
int gettimeofday(struct timeval *tv, void *tz) { (void)tz; int64_t us = ee_unix_time() * 1000000 + ee_now_us() % 1000000; tv->tv_sec = (long)(us / 1000000); tv->tv_usec = (long)(us % 1000000); return 0; }
long sysconf(int name) { (void)name; return 4096; }
pid_t getpid(void) { return 1; }

/* ---- kernel32 the sources call directly (declared plain by _KERNEL32_) ------------------- */
/* Threads: a host thread enters through EeThread (ee-main.cpp) and runs the body here. */
#define EE_MAX_THREADS 256
/* `gen` and `entered` are the whole reason this struct is not the obvious one.
 *
 * The host chooses which id enters: `EeThread` is a dllexport and `thr_enter` passes whatever
 * `EE_OP_SPAWN` was given. Nothing stopped it entering the same id twice, or entering a STALE id
 * whose record had since been freed and its slot handed to a different thread. The body would
 * then run more than once - and a body that owns its argument, as the wasm runtime's trampoline
 * does (it reconstitutes a boxed Rust closure), turns that into a double free inside the trusted
 * image.
 *
 * So: `gen` makes an id unique over time, and `entered` is claimed exactly once with an
 * interlocked compare-and-swap before `fn` is ever called. A repeat, a stale id, or a race all
 * lose the CAS and return without running anything. */
typedef struct ee_thread { unsigned (__stdcall *fn)(void *); void *arg; volatile LONG tid; volatile LONG done; volatile LONG refs; unsigned ret; LONG id; LONG64 gen; volatile LONG entered; } ee_thread;
static volatile LONG64 g_thr_gen = 1;
static ee_thread *volatile g_thr[EE_MAX_THREADS]; static SRWLOCK g_thr_lock = SRWLOCK_INIT;
static void thr_release(ee_thread *t) { if (InterlockedDecrement(&t->refs) == 0) { AcquireSRWLockExclusive(&g_thr_lock); g_thr[t->id] = NULL; ReleaseSRWLockExclusive(&g_thr_lock); free(t); } }
uintptr_t __cdecl _beginthreadex(void *sec, unsigned stack, unsigned (__stdcall *fn)(void *), void *arg, unsigned flags, unsigned *tid_out) {
    (void)sec; (void)stack; (void)flags;
    ee_thread *t = (ee_thread *)calloc(1, sizeof *t); if (!t) return 0;
    t->fn = fn; t->arg = arg; t->refs = 2; t->id = -1; t->entered = 0;
    AcquireSRWLockExclusive(&g_thr_lock);
    for (LONG i = 0; i < EE_MAX_THREADS; i++) if (!g_thr[i]) { g_thr[i] = t; t->id = i; break; }
    if (t->id >= 0) t->gen = InterlockedIncrement64(&g_thr_gen);
    ReleaseSRWLockExclusive(&g_thr_lock);
    if (t->id < 0) { free(t); errno = EAGAIN; return 0; }
    /* id in the low 32 bits, generation in the high 32: the host carries it opaquely and hands it
     * back, and a value it invents or replays fails the check on entry. */
    ee_callout *c = ee_slot(); c->op = EE_OP_SPAWN;
    c->arg = ((uint64_t)(uint32_t)t->gen << 32) | (uint32_t)t->id; c->len = 0;
    if (ee_callout_call(c) != 0) { AcquireSRWLockExclusive(&g_thr_lock); g_thr[t->id] = NULL; ReleaseSRWLockExclusive(&g_thr_lock); free(t); errno = EAGAIN; return 0; }
    while (!t->tid) { LONG z = 0; WaitOnAddress(&t->tid, &z, sizeof z, 1000); }
    if (tid_out) *tid_out = (unsigned)t->tid;
    return (uintptr_t)t;
}
static void ee_keys_run_dtors(void);     /* defined below, beside the key table */
void *ee_thread_entry(void *param) {
    const uint64_t v = (uint64_t)(uintptr_t)param;
    const LONG id = (LONG)(uint32_t)(v & 0xffffffffu);
    const uint32_t gen = (uint32_t)(v >> 32);
    if (id < 0 || id >= EE_MAX_THREADS) return (void *)(intptr_t)-1;

    /* Look the record up and take a reference UNDER THE LOCK, so it cannot be released and freed
     * between the read and the claim. The generation check rejects a stale id whose slot has been
     * handed to a different thread since. */
    AcquireSRWLockExclusive(&g_thr_lock);
    ee_thread *t = g_thr[id];
    if (t && (uint32_t)t->gen == gen) InterlockedIncrement(&t->refs); else t = NULL;
    ReleaseSRWLockExclusive(&g_thr_lock);
    if (!t) return (void *)(intptr_t)-2;

    /* EXACTLY ONCE. A second entry - a replay, a race, a confused host - loses here and runs
     * nothing. The body may own its argument; running it twice would free that argument twice. */
    if (InterlockedCompareExchange(&t->entered, 1, 0) != 0) { thr_release(t); return (void *)(intptr_t)-3; }

    InterlockedExchange(&t->tid, (LONG)GetCurrentThreadId()); WakeByAddressAll((void *)&t->tid);
    t->ret = t->fn(t->arg);
    InterlockedExchange(&t->done, 1); WakeByAddressAll((void *)&t->done);
    /* This thread is finished with the enclave. Destructors first - they may still call out, so
     * they need the slot - then the slot and token go back, or the enclave leaks one identity per
     * thread and dies at the cap. */
    ee_keys_run_dtors();
    ee_slot_release();
    thr_release(t);                      /* the reference taken above */
    thr_release(t);                      /* the spawn's own reference */
    return 0;
}
/* ---- thread-specific keys ------------------------------------------------------------------
 * See posix/pthread.h for why the destructors run in ee_thread_entry rather than from a TLS
 * callback. The table is small and never shrinks: keys are created once at startup by the code
 * that needs them, not per request. */
#define EE_MAX_KEYS 64
static struct { DWORD tls; void (*dtor)(void *); volatile LONG used; } g_keys[EE_MAX_KEYS];
int pthread_key_create(pthread_key_t *key, void (*dtor)(void *)) {
    for (int i = 0; i < EE_MAX_KEYS; i++) {
        if (InterlockedCompareExchange(&g_keys[i].used, 1, 0) == 0) {
            const DWORD t = TlsAlloc();
            if (t == TLS_OUT_OF_INDEXES) { InterlockedExchange(&g_keys[i].used, 0); return EAGAIN; }
            g_keys[i].tls = t; g_keys[i].dtor = dtor;
            if (key) *key = (pthread_key_t)i;
            return 0;
        }
    }
    return EAGAIN;
}
int pthread_key_delete(pthread_key_t key) {
    if (key >= EE_MAX_KEYS || !g_keys[key].used) return EINVAL;
    TlsFree(g_keys[key].tls); g_keys[key].dtor = NULL;
    InterlockedExchange(&g_keys[key].used, 0);
    return 0;
}
void *pthread_getspecific(pthread_key_t key) {
    return (key < EE_MAX_KEYS && g_keys[key].used) ? TlsGetValue(g_keys[key].tls) : NULL;
}
int pthread_setspecific(pthread_key_t key, const void *value) {
    if (key >= EE_MAX_KEYS || !g_keys[key].used) return EINVAL;
    TlsSetValue(g_keys[key].tls, (void *)value);
    return 0;
}
/* Run every key's destructor for THIS thread, once, at its exit. */
static void ee_keys_run_dtors(void) {
    for (int i = 0; i < EE_MAX_KEYS; i++) {
        if (!g_keys[i].used || !g_keys[i].dtor) continue;
        void *v = TlsGetValue(g_keys[i].tls);
        if (!v) continue;
        TlsSetValue(g_keys[i].tls, NULL);
        g_keys[i].dtor(v);
    }
}

/* ---- the adversarial seam ------------------------------------------------------------------
 * Driven by EE_THREAD_SELFTEST in the host. See ee_thr_test in ee-rt.h for why the test has to be
 * the host rather than something in here. */
static ee_thr_test *volatile g_tt;
static unsigned __stdcall tt_body(void *p) {
    ee_thr_test *t = (ee_thr_test *)p;
    /* Hold the record LIVE while the host tries to enter it a second time, so the test
     * distinguishes "refused the replay" from "the record happened to be gone". */
    for (int i = 0; i < 10000 && !t->gate; i++) ee_sleep_ms(1);
    InterlockedIncrement((volatile LONG *)&t->runs);
    return 0;
}
/* Claims a call-out slot, which is the point: a body that does nothing never takes an identity,
 * so a test built on one would not notice slots that are never given back. */
static unsigned __stdcall tt_noop(void *p) { (void)p; (void)ee_park_token(); return 0; }
__declspec(dllexport) void *WINAPI EeThreadTest(void *param) {
    ee_thr_test *t = (ee_thr_test *)param;
    if (!t) return (void *)(intptr_t)-1;
    switch (t->op) {
    case 1: {                                  /* spawn a gated body and report its entry value */
        g_tt = t; t->runs = 0; t->gate = 0;
        uintptr_t h = _beginthreadex(NULL, 0, tt_body, t, 0, NULL);
        if (!h) { t->status = -1; return (void *)(intptr_t)-1; }
        ee_thread *th = (ee_thread *)h;
        t->entry_param = ((uint64_t)(uint32_t)th->gen << 32) | (uint32_t)th->id;
        t->status = 0; return (void *)0; }
    case 2: {                                  /* let it finish, then join and release */
        t->gate = 1;
        t->status = 0; return (void *)0; }
    case 3:                                    /* what this thread believes its identity is */
        t->token = ee_park_token(); t->status = 0; return (void *)0;
    case 5:
        /* Claim the identity FIRST, announce, and only read it back after the host has had its
         * chance to scribble. Reading it before the scribble - or on a thread that claims its slot
         * afterwards and so rewrites the header - tests nothing, which is what the first version
         * of this did. */
        (void)ee_park_token();
        InterlockedExchange((volatile LONG *)&t->runs, 1);
        for (int i = 0; i < 10000 && !t->gate; i++) ee_sleep_ms(1);
        t->token = ee_park_token();
        t->status = 0; return (void *)0;
    case 4: {                                  /* sequential spawn+join, past the slot count */
        for (uint32_t i = 0; i < t->n; i++) {
            uintptr_t h = _beginthreadex(NULL, 0, tt_noop, NULL, 0, NULL);
            if (!h) { t->status = -(int32_t)(i + 1); return (void *)(intptr_t)-1; }
            WaitForSingleObject((HANDLE)h, INFINITE);
            CloseHandle((HANDLE)h);
        }
        /* HOW MANY IDENTITIES ARE STILL HELD. Counting the threads that finished proves nothing -
         * a build that never gives a token back finishes them just the same, until it runs out.
         * What distinguishes the two is whether 200 threads left 200 tokens behind. */
        { uint32_t held = 0;
          for (int i = 0; i < EE_MAX_TOK; i++) if (g_tok_used[i]) held++;
          t->token = held; }
        t->status = 0; return (void *)0; }
    default:
        t->status = -99; return (void *)(intptr_t)-1;
    }
}

static int thr_wait(ee_thread *t, DWORD ms) { LONG z = 0; if (ms == INFINITE) { while (!t->done) WaitOnAddress(&t->done, &z, sizeof z, INFINITE); return 0; } if (!t->done) WaitOnAddress(&t->done, &z, sizeof z, ms); return t->done ? 0 : 1; }
HANDLE WINAPI CreateThread(LPSECURITY_ATTRIBUTES a, SIZE_T stack, LPTHREAD_START_ROUTINE fn, LPVOID arg, DWORD flags, LPDWORD tid) {
    unsigned u = 0; uintptr_t h = _beginthreadex(a, (unsigned)stack, (unsigned (__stdcall *)(void *))fn, arg, flags, &u); if (tid) *tid = u; return (HANDLE)h;
}
DWORD WINAPI WaitForSingleObject(HANDLE h, DWORD ms) { if (!h) return WAIT_FAILED; return thr_wait((ee_thread *)h, ms) ? WAIT_TIMEOUT : WAIT_OBJECT_0; }
BOOL WINAPI CloseHandle(HANDLE h) { if (h && h != INVALID_HANDLE_VALUE) thr_release((ee_thread *)h); return TRUE; }
void WINAPI Sleep(DWORD ms) { ee_sleep_ms(ms); }
BOOL WINAPI SwitchToThread(void) { YieldProcessor(); return TRUE; }
DWORD_PTR WINAPI SetThreadAffinityMask(HANDLE h, DWORD_PTR m) { (void)h; return m; }
BOOL WINAPI SetThreadPriority(HANDLE h, int p) { (void)h; (void)p; return TRUE; }
int WINAPI GetThreadPriority(HANDLE h) { (void)h; return 0; }
ULONGLONG WINAPI GetTickCount64(void) { return (ULONGLONG)(ee_now_us() / 1000); }
void WINAPI GetSystemTimeAsFileTime(LPFILETIME ft) { int64_t v = ee_filetime(); ft->dwLowDateTime = (DWORD)v; ft->dwHighDateTime = (DWORD)(v >> 32); }
void WINAPI GetSystemTimePreciseAsFileTime(LPFILETIME ft) { GetSystemTimeAsFileTime(ft); }
DWORD WINAPI GetModuleFileNameW(HMODULE m, LPWSTR p, DWORD n) { (void)m; if (p && n) p[0] = 0; return 0; }
DWORD WINAPI GetModuleFileNameA(HMODULE m, LPSTR p, DWORD n) { (void)m; if (p && n) p[0] = 0; return 0; }
HMODULE WINAPI LoadLibraryW(LPCWSTR n) { (void)n; return NULL; }
HMODULE WINAPI LoadLibraryA(LPCSTR n) { (void)n; return NULL; }
HMODULE WINAPI LoadLibraryExW(LPCWSTR n, HANDLE f, DWORD fl) { (void)n; (void)f; (void)fl; return NULL; }
BOOL WINAPI FreeLibrary(HMODULE m) { (void)m; return TRUE; }
DWORD WINAPI GetEnvironmentVariableA(LPCSTR k, LPSTR v, DWORD n) { const char *e = ee_getenv(k); if (!e) return 0; size_t l = strlen(e); if (v && n > l) memcpy(v, e, l + 1); return (DWORD)l; }
void WINAPI GetSystemInfo(LPSYSTEM_INFO si) { memset(si, 0, sizeof *si); si->dwNumberOfProcessors = g_cpus; si->dwPageSize = 4096; si->dwAllocationGranularity = 65536; si->wProcessorArchitecture = PROCESSOR_ARCHITECTURE_AMD64; }
void WINAPI GetNativeSystemInfo(LPSYSTEM_INFO si) { GetSystemInfo(si); }
DWORD WINAPI GetActiveProcessorCount(WORD g) { (void)g; return g_cpus; }
DWORD WINAPI GetCurrentProcessorNumber(void) { return 0; }
BOOL WINAPI GetLogicalProcessorInformationEx(LOGICAL_PROCESSOR_RELATIONSHIP r, PSYSTEM_LOGICAL_PROCESSOR_INFORMATION_EX b, PDWORD n) { (void)r; (void)b; (void)n; SetLastError(ERROR_NOT_SUPPORTED); return FALSE; }
BOOL WINAPI GetProcessAffinityMask(HANDLE h, PDWORD_PTR p, PDWORD_PTR s) { (void)h; *p = *s = ((DWORD_PTR)1 << (g_cpus < 64 ? g_cpus : 63)) - 1; return TRUE; }
HANDLE WINAPI GetStdHandle(DWORD n) { (void)n; return INVALID_HANDLE_VALUE; }
BOOL WINAPI WriteFile(HANDLE h, LPCVOID p, DWORD n, LPDWORD w, LPOVERLAPPED o) { (void)h; (void)o; ee_write_log(p, n); if (w) *w = n; return TRUE; }
DWORD WINAPI FormatMessageA(DWORD f, LPCVOID s, DWORD id, DWORD l, LPSTR b, DWORD n, va_list *a) { (void)f; (void)s; (void)l; (void)a; if (b && n) { snprintf(b, n, "error %lu", id); return (DWORD)strlen(b); } return 0; }
HLOCAL WINAPI LocalFree(HLOCAL h) { (void)h; return NULL; }

/* ---- stdio: a memory filesystem for the host's files, the log for the streams ------------ */
typedef struct ee_file { const uint8_t *data; uint64_t len, pos; int eof, err, log; } ee_file;
static FILE g_iob[3]; static ee_file g_iof[3] = { {0,0,0,0,0,1}, {0,0,0,0,0,1}, {0,0,0,0,0,1} };
static ee_file *EF(FILE *f) { return f ? (ee_file *)f->_Placeholder : NULL; }
FILE *__cdecl __acrt_iob_func(unsigned i) { if (i > 2) i = 2; g_iob[i]._Placeholder = &g_iof[i]; return &g_iob[i]; }
FILE *__cdecl fopen(const char *name, const char *mode) {
    const ee_file_desc *d = ee_file_lookup(name);
    if (!d || (mode && (strchr(mode, 'w') || strchr(mode, 'a') || strchr(mode, '+')))) { errno = ENOENT; return NULL; }
    FILE *f = (FILE *)calloc(1, sizeof *f); ee_file *e = (ee_file *)calloc(1, sizeof *e); if (!f || !e) { free(f); free(e); errno = ENOMEM; return NULL; }
    e->data = d->data; e->len = d->len; f->_Placeholder = e; return f;
}
FILE *__cdecl _wfopen(const wchar_t *name, const wchar_t *mode) {
    char n[520], m[16]; int a = WideCharToMultiByte(CP_UTF8, 0, name, -1, n, sizeof n, NULL, NULL); int b = WideCharToMultiByte(CP_UTF8, 0, mode, -1, m, sizeof m, NULL, NULL);
    if (a <= 0 || b <= 0) { errno = ENOENT; return NULL; } return fopen(n, m);
}
errno_t __cdecl fopen_s(FILE **f, const char *n, const char *m) { *f = fopen(n, m); return *f ? 0 : ENOENT; }
int __cdecl fclose(FILE *f) { ee_file *e = EF(f); if (!e || e->log) return 0; free(e); free(f); return 0; }
size_t __cdecl fread(void *p, size_t sz, size_t n, FILE *f) {
    ee_file *e = EF(f); if (!e || e->log || !sz) return 0; uint64_t want = (uint64_t)sz * n, left = e->pos < e->len ? e->len - e->pos : 0;
    if (want > left) { want = left; e->eof = 1; } memcpy(p, e->data + e->pos, (size_t)want); e->pos += want; return (size_t)(want / sz);
}
size_t __cdecl fwrite(const void *p, size_t sz, size_t n, FILE *f) { ee_file *e = EF(f); if (!e) return 0; if (e->log) { ee_write_log(p, sz * n); return n; } e->err = 1; return 0; }
int __cdecl _fseeki64(FILE *f, __int64 off, int whence) { ee_file *e = EF(f); if (!e || e->log) return -1; __int64 base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? (__int64)e->pos : (__int64)e->len; if (base + off < 0) return -1; e->pos = (uint64_t)(base + off); e->eof = 0; return 0; }
int __cdecl fseek(FILE *f, long off, int whence) { return _fseeki64(f, off, whence); }
__int64 __cdecl _ftelli64(FILE *f) { ee_file *e = EF(f); return e && !e->log ? (__int64)e->pos : -1; }
long __cdecl ftell(FILE *f) { return (long)_ftelli64(f); }
long ftello(void *f) { return (long)_ftelli64((FILE *)f); }
int fseeko(void *f, long long off, int whence) { return _fseeki64((FILE *)f, off, whence); }
void __cdecl rewind(FILE *f) { _fseeki64(f, 0, SEEK_SET); }
int __cdecl feof(FILE *f) { ee_file *e = EF(f); return e ? e->eof : 1; }
int __cdecl ferror(FILE *f) { ee_file *e = EF(f); return e ? e->err : 1; }
void __cdecl clearerr(FILE *f) { ee_file *e = EF(f); if (e) e->eof = e->err = 0; }
int __cdecl fflush(FILE *f) { (void)f; return 0; }
int __cdecl fgetc(FILE *f) { ee_file *e = EF(f); if (!e || e->log || e->pos >= e->len) { if (e) e->eof = 1; return EOF; } return e->data[e->pos++]; }
int __cdecl getc(FILE *f) { return fgetc(f); }
int __cdecl ungetc(int c, FILE *f) { ee_file *e = EF(f); if (!e || e->log || !e->pos) return EOF; e->pos--; e->eof = 0; return c; }
char *__cdecl fgets(char *s, int n, FILE *f) { int i = 0; if (n <= 1) return NULL; while (i < n - 1) { int c = fgetc(f); if (c == EOF) break; s[i++] = (char)c; if (c == '\n') break; } if (!i) return NULL; s[i] = 0; return s; }
int __cdecl fputs(const char *s, FILE *f) { return fwrite(s, 1, strlen(s), f) ? 0 : EOF; }
int __cdecl fputc(int c, FILE *f) { char b = (char)c; return fwrite(&b, 1, 1, f) ? c : EOF; }
int __cdecl putc(int c, FILE *f) { return fputc(c, f); }
int __cdecl putchar(int c) { return fputc(c, __acrt_iob_func(1)); }
int __cdecl puts(const char *s) { ee_write_log(s, strlen(s)); ee_write_log("\n", 1); return 0; }
int __cdecl setvbuf(FILE *f, char *b, int m, size_t s) { (void)f; (void)b; (void)m; (void)s; return 0; }
int __cdecl _fileno(FILE *f) { ee_file *e = EF(f); return e ? (e->log ? 2 : -1) : -1; }
int fileno(FILE *f) { return _fileno(f); }
void __cdecl perror(const char *s) { ee_log("%s: errno %d\n", s ? s : "", errno); }
int __cdecl __stdio_common_vfprintf(unsigned __int64 opt, FILE *f, const char *fmt, _locale_t loc, va_list ap) {
    char stack[4096]; va_list ap2; va_copy(ap2, ap);
    int n = __stdio_common_vsprintf(opt | _CRT_INTERNAL_PRINTF_STANDARD_SNPRINTF_BEHAVIOR, stack, sizeof stack, fmt, loc, ap);
    if (n < 0) { va_end(ap2); return n; }
    if ((size_t)n < sizeof stack) { fwrite(stack, 1, (size_t)n, f); va_end(ap2); return n; }
    char *big = (char *)malloc((size_t)n + 1); if (!big) { va_end(ap2); return -1; }
    __stdio_common_vsprintf(opt | _CRT_INTERNAL_PRINTF_STANDARD_SNPRINTF_BEHAVIOR, big, (size_t)n + 1, fmt, loc, ap2); va_end(ap2);
    fwrite(big, 1, (size_t)n, f); free(big); return n;
}
int __cdecl __stdio_common_vfprintf_s(unsigned __int64 opt, FILE *f, const char *fmt, _locale_t loc, va_list ap) { return __stdio_common_vfprintf(opt, f, fmt, loc, ap); }

/* ---- posix files/dirs (nothing exists: every path fails cleanly) ------------------------ */
int open(const char *p, int flags, ...) { (void)p; (void)flags; errno = ENOENT; return -1; }
int close(int fd) { return sock_close(fd) == 0 ? 0 : 0; }
ssize_t read(int fd, void *b, size_t n);   /* sockets, below */
ssize_t write(int fd, const void *b, size_t n);
ssize_t pread(int fd, void *b, size_t n, off_t off) { (void)fd; (void)b; (void)n; (void)off; errno = EBADF; return -1; }
int fstat(int fd, struct stat *st) { (void)fd; (void)st; errno = EBADF; return -1; }
int stat(const char *p, struct stat *st) { const ee_file_desc *d = ee_file_lookup(p); if (!d) { errno = ENOENT; return -1; } memset(st, 0, sizeof *st); st->st_size = (off_t)d->len; st->st_mode = S_IFREG | 0400; return 0; }
int lstat(const char *p, struct stat *st) { return stat(p, st); }
int mkdir(const char *p, mode_t m) { (void)p; (void)m; errno = EACCES; return -1; }
int unlink(const char *p) { (void)p; errno = ENOENT; return -1; }
int rename(const char *a, const char *b) { (void)a; (void)b; errno = EACCES; return -1; }
int access(const char *p, int m) { (void)m; return ee_file_lookup(p) ? 0 : -1; }
int ftruncate(int fd, off_t n) { (void)fd; (void)n; errno = EBADF; return -1; }
int fsync(int fd) { (void)fd; return 0; }
int fdatasync(int fd) { (void)fd; return 0; }
int flock(int fd, int op) { (void)fd; (void)op; return 0; }
int isatty(int fd) { (void)fd; return 0; }
int dup(int fd) { (void)fd; errno = EBADF; return -1; }
int pipe(int fds[2]) { (void)fds; errno = ENOSYS; return -1; }
int posix_fadvise(int fd, off_t o, off_t l, int a) { (void)fd; (void)o; (void)l; (void)a; return 0; }
DIR *opendir(const char *p) { (void)p; errno = ENOENT; return NULL; }
struct dirent *readdir(DIR *d) { (void)d; return NULL; }
int closedir(DIR *d) { (void)d; return 0; }
void *mmap(void *a, size_t n, int prot, int flags, int fd, off_t off) { (void)a; (void)n; (void)prot; (void)flags; (void)fd; (void)off; errno = ENOSYS; return MAP_FAILED; }
int munmap(void *a, size_t n) { (void)a; (void)n; return 0; }
int madvise(void *a, size_t n, int adv) { (void)a; (void)n; (void)adv; return 0; }
int posix_madvise(void *a, size_t n, int adv) { (void)a; (void)n; (void)adv; return 0; }
int mlock(const void *a, size_t n) { (void)a; (void)n; return 0; }
int munlock(const void *a, size_t n) { (void)a; (void)n; return 0; }
int mprotect(void *a, size_t n, int p) { (void)a; (void)n; (void)p; return 0; }
void *dlopen(const char *p, int f) { (void)p; (void)f; return NULL; }
void *dlsym(void *h, const char *s) { (void)h; (void)s; return NULL; }
int dlclose(void *h) { (void)h; return 0; }
char *dlerror(void) { return "dynamic loading is not available inside the enclave"; }
int getrusage(int who, struct rusage *u) { (void)who; memset(u, 0, sizeof *u); return 0; }
ssize_t pwrite(int fd, const void *b, size_t n, off_t off) { (void)fd; (void)b; (void)n; (void)off; errno = EBADF; return -1; }
int mkstemp(char *t) { (void)t; errno = EACCES; return -1; }
int getrlimit(int r, struct rlimit *l) { (void)r; l->rlim_cur = l->rlim_max = 0; return 0; }
int setrlimit(int r, const struct rlimit *l) { (void)r; (void)l; return 0; }

/* ---- sockets: the worker link is a call-out, the host owns the TCP socket ---------------- */
#define EE_MAX_SOCK 64
typedef struct ee_sock { int used; uint32_t handle; int connected; char host[256]; int port; } ee_sock;
static ee_sock g_sock[EE_MAX_SOCK]; static SRWLOCK g_sock_lock = SRWLOCK_INIT;
static ee_sock *SK(int fd) { return fd >= 0 && fd < EE_MAX_SOCK && g_sock[fd].used ? &g_sock[fd] : NULL; }
int socket(int af, int type, int proto) {
    (void)type; (void)proto; if (af != AF_INET && af != AF_INET6 && af != AF_UNSPEC) { errno = EAFNOSUPPORT; return -1; }
    AcquireSRWLockExclusive(&g_sock_lock); int fd = -1;
    for (int i = 3; i < EE_MAX_SOCK; i++) if (!g_sock[i].used) { memset(&g_sock[i], 0, sizeof g_sock[i]); g_sock[i].used = 1; fd = i; break; }
    ReleaseSRWLockExclusive(&g_sock_lock); if (fd < 0) errno = EMFILE; return fd;
}
int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
    (void)hints; struct addrinfo *ai = (struct addrinfo *)calloc(1, sizeof *ai); struct sockaddr_ee *sa = (struct sockaddr_ee *)calloc(1, sizeof *sa);
    if (!ai || !sa) { free(ai); free(sa); return EAI_MEMORY; }
    sa->sa_family = AF_INET; sa->port = service ? atoi(service) : 0; strncpy(sa->host, node ? node : "127.0.0.1", sizeof sa->host - 1);
    ai->ai_family = AF_INET; ai->ai_socktype = SOCK_STREAM; ai->ai_protocol = IPPROTO_TCP; ai->ai_addr = (struct sockaddr *)sa; ai->ai_addrlen = sizeof *sa; *res = ai; return 0;
}
void freeaddrinfo(struct addrinfo *ai) { while (ai) { struct addrinfo *n = ai->ai_next; free(ai->ai_addr); free(ai); ai = n; } }
const char *gai_strerror(int e) { (void)e; return "getaddrinfo"; }
int connect(int fd, const struct sockaddr *addr, socklen_t len) {
    ee_sock *s = SK(fd); if (!s) { errno = EBADF; return -1; }
    if (!addr || len < (socklen_t)sizeof(struct sockaddr_ee)) { errno = EINVAL; return -1; }
    const struct sockaddr_ee *sa = (const struct sockaddr_ee *)addr;
    ee_callout *c = ee_slot(); c->op = EE_OP_CONNECT; c->arg = (uint64_t)sa->port; c->len = strlen(sa->host) + 1; memcpy(c->data, sa->host, c->len);
    int64_t r = ee_callout_call(c); if (r < 0) { errno = (int)-r; return -1; }
    s->handle = (uint32_t)r; s->connected = 1; strncpy(s->host, sa->host, sizeof s->host - 1); s->port = sa->port; return 0;
}
ssize_t send(int fd, const void *b, size_t n, int flags) {
    (void)flags; ee_sock *s = SK(fd); if (!s || !s->connected) { errno = EBADF; return -1; }
    ee_callout *c = ee_slot(); const uint8_t *p = (const uint8_t *)b; size_t done = 0;
    while (done < n) { size_t k = n - done; if (k > c->cap) k = (size_t)c->cap; c->op = EE_OP_SEND; c->handle = s->handle; c->len = k; memcpy(c->data, p + done, k);
        int64_t r = ee_callout_call(c); if (r < 0) { errno = (int)-r; return done ? (ssize_t)done : -1; } done += (size_t)r; if ((size_t)r < k) break; }
    return (ssize_t)done;
}
ssize_t recv(int fd, void *b, size_t n, int flags) {
    (void)flags; ee_sock *s = SK(fd); if (!s || !s->connected) { errno = EBADF; return -1; }
    ee_callout *c = ee_slot(); size_t k = n > c->cap ? (size_t)c->cap : n; c->op = EE_OP_RECV; c->handle = s->handle; c->len = k;
    int64_t r = ee_callout_call(c); if (r < 0) { errno = (int)-r; return -1; } if (r > 0) memcpy(b, c->data, (size_t)r); return (ssize_t)r;
}
ssize_t read(int fd, void *b, size_t n) { return recv(fd, b, n, 0); }
ssize_t write(int fd, const void *b, size_t n) { return send(fd, b, n, 0); }
ssize_t writev(int fd, const struct iovec *iov, int cnt) { ssize_t t = 0; for (int i = 0; i < cnt; i++) { ssize_t r = send(fd, iov[i].iov_base, iov[i].iov_len, 0); if (r < 0) return t ? t : -1; t += r; if ((size_t)r < iov[i].iov_len) break; } return t; }
ssize_t readv(int fd, const struct iovec *iov, int cnt) { ssize_t t = 0; for (int i = 0; i < cnt; i++) { ssize_t r = recv(fd, iov[i].iov_base, iov[i].iov_len, 0); if (r <= 0) return t ? t : r; t += r; if ((size_t)r < iov[i].iov_len) break; } return t; }
int poll(struct pollfd *fds, unsigned long n, int timeout) { (void)timeout; for (unsigned long i = 0; i < n; i++) fds[i].revents = fds[i].events & (POLLIN | POLLOUT); return (int)n; }
int setsockopt(int fd, int level, int name, const void *v, socklen_t l) { (void)level; (void)name; (void)v; (void)l; return SK(fd) ? 0 : -1; }
int getsockopt(int fd, int level, int name, void *v, socklen_t *l) { (void)level; (void)name; (void)v; (void)l; if (!SK(fd)) return -1; errno = ENOPROTOOPT; return -1; }
int getsockname(int fd, struct sockaddr *a, socklen_t *l) { (void)a; (void)l; if (!SK(fd)) return -1; errno = ENOTSUP; return -1; }
int shutdown(int fd, int how) { (void)how; return SK(fd) ? 0 : -1; }
int fcntl(int fd, int cmd, ...) { (void)cmd; return SK(fd) ? 0 : -1; }
int sock_close(int fd) { ee_sock *s = SK(fd); if (!s) return -1; if (s->connected) { ee_callout *c = ee_slot(); c->op = EE_OP_CLOSE; c->handle = s->handle; c->len = 0; ee_callout_call(c); } s->used = 0; return 0; }

/* ---- gcc builtins: atomics by size, cpu features, once ------------------------------------- */
unsigned long long ee_atomic_load_(const volatile void *p, size_t n) {
    unsigned long long v; switch (n) { case 1: v = *(const volatile unsigned char *)p; break; case 2: v = *(const volatile unsigned short *)p; break; case 4: v = *(const volatile unsigned int *)p; break; default: v = *(const volatile unsigned long long *)p; }
    _ReadWriteBarrier(); return v;
}
void ee_atomic_store_(volatile void *p, unsigned long long v, size_t n) {
    _ReadWriteBarrier(); switch (n) { case 1: *(volatile unsigned char *)p = (unsigned char)v; break; case 2: *(volatile unsigned short *)p = (unsigned short)v; break; case 4: *(volatile unsigned int *)p = (unsigned int)v; break; default: *(volatile unsigned long long *)p = v; } _ReadWriteBarrier();
}
unsigned long long ee_atomic_fetch_add_(volatile void *p, unsigned long long v, size_t n) {
    switch (n) { case 1: return (unsigned char)_InterlockedExchangeAdd8((volatile char *)p, (char)v); case 2: return (unsigned short)_InterlockedExchangeAdd16((volatile short *)p, (short)v); case 4: return (unsigned int)_InterlockedExchangeAdd((volatile long *)p, (long)v); default: return (unsigned long long)_InterlockedExchangeAdd64((volatile long long *)p, (long long)v); }
}
unsigned long long ee_atomic_fetch_or_(volatile void *p, unsigned long long v, size_t n) {
    switch (n) { case 1: return (unsigned char)_InterlockedOr8((volatile char *)p, (char)v); case 2: return (unsigned short)_InterlockedOr16((volatile short *)p, (short)v); case 4: return (unsigned int)_InterlockedOr((volatile long *)p, (long)v); default: return (unsigned long long)_InterlockedOr64((volatile long long *)p, (long long)v); }
}
int ee_atomic_cas_(volatile void *p, void *expected, unsigned long long desired, size_t n) {
    switch (n) {
    case 1: { char e = *(char *)expected, r = _InterlockedCompareExchange8((volatile char *)p, (char)desired, e); if (r == e) return 1; *(char *)expected = r; return 0; }
    case 2: { short e = *(short *)expected, r = _InterlockedCompareExchange16((volatile short *)p, (short)desired, e); if (r == e) return 1; *(short *)expected = r; return 0; }
    case 4: { long e = *(long *)expected, r = _InterlockedCompareExchange((volatile long *)p, (long)desired, e); if (r == e) return 1; *(long *)expected = r; return 0; }
    default: { long long e = *(long long *)expected, r = _InterlockedCompareExchange64((volatile long long *)p, (long long)desired, e); if (r == e) return 1; *(long long *)expected = r; return 0; }
    }
}
int ee_cpu_supports(const char *f) {
    int r1[4], r7[4]; __cpuidex(r1, 1, 0); __cpuidex(r7, 7, 0);
    if (!strcmp(f, "avx2")) return (r7[1] >> 5) & 1; if (!strcmp(f, "avx")) return (r1[2] >> 28) & 1; if (!strcmp(f, "fma")) return (r1[2] >> 12) & 1;
    if (!strcmp(f, "ssse3")) return (r1[2] >> 9) & 1; if (!strcmp(f, "sse4.1")) return (r1[2] >> 19) & 1; if (!strcmp(f, "f16c")) return (r1[2] >> 29) & 1;
    if (!strcmp(f, "avx512f")) return (r7[1] >> 16) & 1; if (!strcmp(f, "avx512bw")) return (r7[1] >> 30) & 1; if (!strcmp(f, "avx512dq")) return (r7[1] >> 17) & 1;
    if (!strcmp(f, "avx512vl")) return (r7[1] >> 31) & 1; if (!strcmp(f, "avx512vnni")) return (r7[2] >> 11) & 1; if (!strcmp(f, "avx512vbmi")) return (r7[2] >> 1) & 1;
    if (!strcmp(f, "avxvnni")) { int r71[4]; __cpuidex(r71, 7, 1); return (r71[0] >> 4) & 1; }
    return 0;
}
int pthread_once(pthread_once_t *once, void (*init)(void)) {
    if (*(volatile long *)once == 2) return 0;
    if (_InterlockedCompareExchange((volatile long *)once, 1, 0) == 0) { init(); _InterlockedExchange((volatile long *)once, 2); WakeByAddressAll((void *)once); return 0; }
    while (*(volatile long *)once != 2) { long one = 1; WaitOnAddress((volatile void *)once, &one, sizeof one, 10); }
    return 0;
}
clock_t __cdecl clock(void) { return (clock_t)(ee_now_us() / 1000); }   /* CLOCKS_PER_SEC is 1000 on Windows */
long syscall(long n, ...) { if (n == 186) return (long)GetCurrentThreadId(); errno = ENOSYS; return -1; }
long long lseek(int fd, long long off, int whence) { (void)fd; (void)off; (void)whence; errno = EBADF; return -1; }
int posix_memalign(void **out, size_t align, size_t size) { (void)align; (void)size; *out = NULL; return ENOMEM; }   /* only the direct-IO path asks; open() never succeeds here */

/* ---- pthreads over the above ------------------------------------------------------------- */
int pthread_mutex_init(pthread_mutex_t *m, const pthread_mutexattr_t *a) { (void)a; m->srw = NULL; return 0; }
int pthread_mutex_destroy(pthread_mutex_t *m) { (void)m; return 0; }
int pthread_mutex_lock(pthread_mutex_t *m) { AcquireSRWLockExclusive((PSRWLOCK)&m->srw); return 0; }
int pthread_mutex_unlock(pthread_mutex_t *m) { ReleaseSRWLockExclusive((PSRWLOCK)&m->srw); return 0; }
int pthread_mutex_trylock(pthread_mutex_t *m) { return TryAcquireSRWLockExclusive((PSRWLOCK)&m->srw) ? 0 : EBUSY; }
int pthread_cond_init(pthread_cond_t *c, const pthread_condattr_t *a) { (void)a; c->cv = NULL; return 0; }
int pthread_cond_destroy(pthread_cond_t *c) { (void)c; return 0; }
int pthread_cond_wait(pthread_cond_t *c, pthread_mutex_t *m) { SleepConditionVariableSRW((PCONDITION_VARIABLE)&c->cv, (PSRWLOCK)&m->srw, INFINITE, 0); return 0; }
int pthread_cond_timedwait(pthread_cond_t *c, pthread_mutex_t *m, const struct timespec *abs) {
    struct timespec now; clock_gettime(CLOCK_MONOTONIC, &now);
    long long ms = ((long long)abs->tv_sec - now.tv_sec) * 1000 + ((long long)abs->tv_nsec - now.tv_nsec) / 1000000; if (ms < 0) ms = 0;
    if (!SleepConditionVariableSRW((PCONDITION_VARIABLE)&c->cv, (PSRWLOCK)&m->srw, (DWORD)ms, 0)) return ETIMEDOUT; return 0;
}
int pthread_cond_signal(pthread_cond_t *c) { WakeConditionVariable((PCONDITION_VARIABLE)&c->cv); return 0; }
int pthread_cond_broadcast(pthread_cond_t *c) { WakeAllConditionVariable((PCONDITION_VARIABLE)&c->cv); return 0; }
typedef struct { void *(*fn)(void *); void *arg; } pt_start;
static unsigned __stdcall pt_tramp(void *p) { pt_start s = *(pt_start *)p; free(p); s.fn(s.arg); return 0; }
int pthread_create(pthread_t *t, const pthread_attr_t *a, void *(*fn)(void *), void *arg) { (void)a; pt_start *s = (pt_start *)malloc(sizeof *s); s->fn = fn; s->arg = arg; uintptr_t h = _beginthreadex(NULL, 0, pt_tramp, s, 0, NULL); if (!h) { free(s); return EAGAIN; } *t = (pthread_t)h; return 0; }
int pthread_join(pthread_t t, void **ret) { WaitForSingleObject((HANDLE)t, INFINITE); CloseHandle((HANDLE)t); if (ret) *ret = NULL; return 0; }
int pthread_detach(pthread_t t) { CloseHandle((HANDLE)t); return 0; }
pthread_t pthread_self(void) { return (pthread_t)(uintptr_t)GetCurrentThreadId(); }
int pthread_setname_np(pthread_t t, const char *n) { (void)t; (void)n; return 0; }
int pthread_attr_init(pthread_attr_t *a) { *a = 0; return 0; }
int pthread_attr_destroy(pthread_attr_t *a) { (void)a; return 0; }
int pthread_attr_setstacksize(pthread_attr_t *a, size_t s) { (void)a; (void)s; return 0; }
int sched_yield(void) { YieldProcessor(); return 0; }

/* ---- posix odds the pad and cache sources name but never reach in the enclave ------------ */
int unlinkat(int d, const char *p, int f) { (void)d; (void)p; (void)f; errno = ENOENT; return -1; }
int openat(int d, const char *p, int f, ...) { (void)d; (void)p; (void)f; errno = ENOENT; return -1; }
int linkat(int a, const char *b, int c, const char *d, int e) { (void)a; (void)b; (void)c; (void)d; (void)e; errno = EACCES; return -1; }
int link(const char *a, const char *b) { (void)a; (void)b; errno = EACCES; return -1; }
int mkostemp(char *t, int f) { (void)t; (void)f; errno = EACCES; return -1; }
int fstatat(int d, const char *p, struct stat *st, int f) { (void)d; (void)f; return stat(p, st); }
char *strdup(const char *s) { return _strdup(s); }
char *strcasestr(const char *h, const char *n) { size_t ln = strlen(n); if (!ln) return (char *)h; for (; *h; h++) if (!_strnicmp(h, n, ln)) return (char *)h; return NULL; }
int pthread_condattr_init(pthread_condattr_t *a) { *a = 0; return 0; }
int pthread_condattr_setclock(pthread_condattr_t *a, int c) { (void)a; (void)c; return 0; }
int pthread_condattr_destroy(pthread_condattr_t *a) { (void)a; return 0; }
