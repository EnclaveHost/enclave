/*
 * enclave_nvenc — a flat C ABI over NVIDIA's NvEncodeAPI, for the `nvenc`
 * wasi-nn backend.
 *
 * Same role as enclave_sd.h: no cargo dependencies, nothing NVIDIA-shaped in
 * the Rust FFI, linked from ENV_LIB_LOCATION at build time. The Rust side sees
 * pointers and scalars only.
 *
 * The one thing that makes this different from the inference shims: an encoder
 * is STATEFUL. Frame N is coded against frame N-1, so a session cannot be
 * rebuilt per call the way a diffusion pipeline can. `env_open` owns that
 * state; the backend maps one session onto one wasi-nn execution context.
 */
#ifndef ENCLAVE_NVENC_H
#define ENCLAVE_NVENC_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* An open encoder. Opaque; one per stream. */
typedef struct env_session env_session;

typedef struct {
    /* "h264" (default), "hevc", "av1" */
    const char *codec;
    /* "nv12" (default), "iyuv", "argb", "abgr". NV12 halves what crosses the
       sandbox boundary against RGB and is what the encoder wants anyway. */
    const char *format;
    uint32_t width;
    uint32_t height;
    uint32_t fps_num;   /* 0 -> 60 */
    uint32_t fps_den;   /* 0 -> 1  */
    uint32_t bitrate;   /* bits/sec, 0 -> 8 Mbit */
    /* Frames between automatic IDRs. 0 means never: a streaming host wants
       keyframes when the client asks for one (packet loss) and not otherwise,
       because an unrequested IDR is a bandwidth spike that fixes nothing. */
    uint32_t gop;
} env_config;

/* env_caps bits */
#define ENV_CAP_H264 0x1u
#define ENV_CAP_HEVC 0x2u
#define ENV_CAP_AV1  0x4u

/*
 * Which codecs this host can encode. Probe only: no session, no config, safe
 * to call before anything else and on a machine with no GPU at all (returns 0).
 *
 * A guest reads a missing capability as "no" and reports streaming as
 * unavailable, rather than trapping — same contract as the ggml probe.
 */
uint32_t env_caps(void);

/*
 * Is there an encoder on this host at all? Cheap: dlopens the driver and
 * resolves the NVENC entry points, and STOPS there — no CUDA context, no
 * encoder session, no MPS client.
 *
 * That distinction is the whole point. `env_caps` has to open a session to ask
 * which codecs the card supports, and opening one means a CUDA context inside
 * the calling process. A preload that wants only "can this node encode?" must
 * not pay that: it runs in every GPU tenant, including the ones that never
 * encode anything, and a CUDA context is not free to a process that is other-
 * wise CPU-bound.
 *
 * Returns 1 if an encoder is plausibly present, 0 if not (and sets the error).
 */
int env_probe(void);

/* Open one encoder session. NULL on failure; see env_last_error(). */
env_session *env_open(const env_config *cfg);

/*
 * Encode exactly one frame into exactly one Annex-B access unit.
 *
 * `frame` is one raw frame in the session's pixel format. `force_idr` makes
 * this frame an IDR — the client asks for that on packet loss, and a host that
 * cannot honour it recovers only at the next GOP boundary.
 *
 * Returns 0 on success, negative on failure. `*out_len` is the bitstream
 * length, `*is_keyframe` whether the unit is an IDR. If `out_cap` is too small
 * the call fails with ENV_E_SHORT_BUFFER and sets `*out_len` to what was
 * needed, so a caller can size a buffer without guessing.
 */
int env_encode(env_session *s, const uint8_t *frame, size_t len, int force_idr,
               uint8_t *out, size_t out_cap, size_t *out_len, int *is_keyframe);

void env_close(env_session *s);

/* Last error on this thread, or "" — valid until the next call on this thread. */
const char *env_last_error(void);

#define ENV_OK              0
#define ENV_E_ARG          -1
#define ENV_E_NO_DRIVER    -2
#define ENV_E_SESSION      -3
#define ENV_E_ENCODE       -4
#define ENV_E_SHORT_BUFFER -5

#ifdef __cplusplus
}
#endif

#endif /* ENCLAVE_NVENC_H */
