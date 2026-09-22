/* ee-rt.h -- the enclave engine's runtime interface: what the enclave and its host share.
 * Every struct here lives in HOST memory (VTL0): the enclave reads and writes host memory
 * directly, the host can never read the enclave's. So nothing secret is ever put in one. */
#ifndef EE_RT_H
#define EE_RT_H
#include <stddef.h>
#include <stdint.h>
#include <stdarg.h>
#ifdef __cplusplus
extern "C" {
#endif
#define EE_ABI_VERSION 1
/* The enclave's only way out. 1-6 are the engine's (the log, its threadpool, the socket to the
 * shielded GPU worker); 7-10 exist for a tenant's app inside the enclave, which is a SERVER: it
 * binds a port, accepts connections and waits for readiness, and none of that can happen in VTL1.
 * The host owns every real socket and carries bytes it cannot read into a TLS session the guest
 * terminates inside the enclave. */
enum { EE_OP_LOG = 1, EE_OP_SPAWN = 2, EE_OP_CONNECT = 3, EE_OP_SEND = 4, EE_OP_RECV = 5, EE_OP_CLOSE = 6,
       EE_OP_LISTEN = 7,     /* arg = port (0 = any), loopback only; ret = handle, arg = bound port */
       EE_OP_ACCEPT = 8,     /* handle = listener; ret = handle, or -EAGAIN when none is pending */
       EE_OP_POLL = 9,       /* data = ee_poll_item[]; arg = timeout ms; ret = how many are ready */
       EE_OP_RESOLVE = 10 }; /* data = hostname; ret = bytes of "addr\n" text written back */
/* One entry of an EE_OP_POLL set. The host overwrites `events` with what is actually ready, which
 * is how a guest thread blocks on a socket without spinning the enclave's CPU. */
typedef struct ee_poll_item { uint32_t handle, events; } ee_poll_item;
#define EE_POLL_READ  1u
#define EE_POLL_WRITE 2u
/* One per enclave thread, in host memory: the header, then `cap` bytes of data. The enclave
 * fills op/handle/len/arg (+data), calls out, reads ret (+data). */
typedef struct ee_callout {
    uint32_t op, handle;
    uint64_t len;      /* bytes valid in data[] (log/send) or wanted (recv) */
    uint64_t arg;      /* spawn: thread id; connect: port (host name in data[]) */
    int64_t  ret;      /* < 0: -errno */
    uint64_t cap;      /* data capacity */
    uint32_t slot, pad;
    uint8_t  data[8];
} ee_callout;
#define EE_MAX_FILES 8
typedef struct ee_file_desc { const char *name; const uint8_t *data; uint64_t len; } ee_file_desc;
typedef struct ee_init_params {
    uint32_t size, version;
    void *callout;                                   /* VTL0 routine: void* WINAPI (ee_callout*) */
    uint8_t *slots; uint64_t slot_bytes; uint32_t n_slots;   /* n_slots blocks of slot_bytes */
    const char *env; uint64_t env_len;               /* "K=V\0K=V\0\0" */
    uint32_t cpu_count;
    int64_t unix_time, filetime;                     /* host clock at init */
    ee_file_desc files[EE_MAX_FILES]; uint32_t n_files;
    /* out */
    int32_t status; char error[256];
    uint8_t sign_pk[32], box_pk[32];                 /* Ed25519 transport key, X25519 pad key */
} ee_init_params;
typedef struct ee_load_params {
    uint32_t size; const char *model; int32_t n_threads, n_ctx, n_batch;
    int32_t status; char error[256]; int32_t n_vocab, n_embd, n_layer; int64_t load_us;
    uint32_t n_devices; char devices[8][64];
} ee_load_params;
typedef struct ee_gen_params {
    uint32_t size; const char *prompt; uint64_t prompt_len; int32_t n_predict;
    char *out; uint64_t out_cap; uint64_t out_len; int32_t n_tokens; int32_t status; char error[256];
    int64_t prompt_us, decode_us; uint64_t offloaded, local, macs, verify_fail;
} ee_gen_params;
typedef struct ee_attest_params {
    uint32_t size; const uint8_t *bound; uint64_t bound_len;   /* "enclave-vbs-bind-v1\n" || spki(44) || padKey(32) || nonce(32) */
    uint8_t *report; uint64_t report_cap; uint64_t report_len;
    uint8_t signature[64]; uint8_t challenge[32];
    int32_t status; int32_t hr; char error[256];
} ee_attest_params;
/* A boxed session (windows/node/client.mjs): in = client_pk(32) || nonce(24) || crypto_box(request) where
 * request = max_tokens u32 LE || prompt utf-8, sealed to the enclave's attested X25519 pad key; out =
 * nonce(24) || crypto_box(reply) sealed to client_pk, reply = n_tokens u32 LE || text utf-8. The host and
 * the agent carry these bytes without being able to read them. */
typedef struct ee_session_params {
    uint32_t size; const uint8_t *in; uint64_t in_len; uint8_t *out; uint64_t out_cap; uint64_t out_len;
    int32_t status; char error[256]; int32_t n_tokens; int64_t prompt_us, decode_us; uint64_t offloaded, local, macs, verify_fail;
} ee_session_params;
/* ---- a tenant's app inside the enclave (ee-app.cpp + windows/enclave-rt) -------------------
 * Same rule as every struct above: these live in HOST memory, so they carry frames and sizes and
 * nothing secret. The app's bytecode is Pulley bytecode (windows/enclave-rt/precompile), which is
 * data: an enclave has no page it may execute, and interpreting is what makes this possible.
 *
 * The request/response frames are length-prefixed, little-endian, and defined in one place
 * (windows/enclave-rt/src/lib.rs, the codec):
 *   request : u32 method | u32 path | u32 nheaders | (u32 name, u32 value) * n | u32 body
 *   response: u16 status | u32 nheaders | (u32 name, u32 value) * n | u32 body */
/* There is no ABI constant here on purpose. The runtime answers for its own ABI (ee_rt_abi in
 * windows/enclave-rt/src/lib.rs, reported through EeAppAbi) and the node names its cached bytecode
 * after that number; a second copy in this header only ever disagrees with it, which it did. */
/* Which world the artifact was built for. The HOST reads the bytes and says which (the node's
 * appframe.mjs worldOf), and the enclave serves that world or refuses by name.
 *   EE_WORLD_ENCLAVE  enclave:app@0.1.0 - written for this box, four host imports, the model
 *   EE_WORLD_HTTP     wasi:http - an ORDINARY platform app, unchanged from the catalog */
#define EE_WORLD_ENCLAVE 1
#define EE_WORLD_HTTP    2
typedef struct ee_app_open_params {
    uint32_t size; const uint8_t *cwasm; uint64_t cwasm_len;   /* host memory: copied in */
    uint32_t world;                                            /* EE_WORLD_* */
    const uint8_t *env; uint64_t env_len;                      /* "K=V\0K=V\0\0": ENCLAVE_CONFIG lands here */
    uint32_t id;                                               /* out: the handle for Handle/Close */
    int32_t status; char error[256]; int64_t load_us;
} ee_app_open_params;
typedef struct ee_app_params {
    uint32_t size, id;
    const uint8_t *req; uint64_t req_len;                      /* host memory: copied in */
    uint8_t *out; uint64_t out_cap; uint64_t out_len;          /* status -5: out_len = needed */
    uint64_t now_ms;                                           /* the host's clock, for this call */
    int32_t status; char error[256]; int64_t handle_us;
} ee_app_params;
typedef struct ee_app_close_params { uint32_t size, id; int32_t status; } ee_app_close_params;
/* A wasi:cli app: it binds its own port through the brokered sockets and its run() does not
 * return, so the HOST enters EeAppRun on a thread of its own and the call sits in VTL1 for the
 * life of the app. EeAppStop bumps the runtime's epoch, which traps the guest wherever it is. */
typedef struct ee_app_run_params {
    uint32_t size, id; int32_t status; char error[256]; int64_t ran_us;
} ee_app_run_params;

/* The sockets a tenant's app gets: the host's, brokered. Handles are small integers in the host's
 * table, never pointers, and every call goes through the enclave's own call-out slot for the
 * calling thread (ee_slot), so a guest server thread and the gate never share one. */
int      ee_net_listen(uint16_t port, uint16_t *bound);
int      ee_net_accept(int h);
int      ee_net_connect(const char *addr, uint16_t port);
int64_t  ee_net_send(int h, const uint8_t *p, size_t n);
int64_t  ee_net_recv(int h, uint8_t *p, size_t n);
void     ee_net_close(int h);
int      ee_net_poll(uint32_t *handles, uint32_t *events, size_t n, uint32_t timeout_ms);
int      ee_net_resolve(const char *name, char *out, size_t cap);

/* The engine's own completion path, for the app's `generate` import: the one host function that is
 * a product rather than plumbing. Inside VTL1 from end to end. */
int ee_engine_generate(const char *prompt, size_t plen, int n_predict,
                       char *out, size_t cap, size_t *out_len);

/* runtime services for the shims (ee-rt.c) */
void ee_logv(const char *fmt, va_list ap);
void ee_log(const char *fmt, ...);
void ee_write_log(const void *p, size_t n);
int64_t ee_callout_call(ee_callout *c);
ee_callout *ee_slot(void);
void ee_sleep_ms(uint32_t ms);
int64_t ee_now_us(void);
int64_t ee_unix_time(void);
int64_t ee_filetime(void);
const char *ee_getenv(const char *k);
int ee_random(void *p, size_t n);
void ee_fatal(const char *msg);
uint32_t ee_cpu_count(void);
int ee_rt_init(const ee_init_params *p);
void *ee_thread_entry(void *param);
/* memfs: the host's files by name */
const ee_file_desc *ee_file_lookup(const char *name);
#ifdef __cplusplus
}
#endif
#endif
