/*
 * enclave_nvenc — NvEncodeAPI behind a flat C ABI. See enclave_nvenc.h.
 *
 * Everything NVIDIA is dlopened, nothing is linked: the CUDA driver API and
 * libnvidia-encode both live in the driver, so a build host needs no CUDA
 * toolkit and a node with no GPU loads this library fine and answers
 * env_caps() == 0. That is the same "degrade honestly" contract the ggml probe
 * has, and it is why the wasi-nn backend can be compiled into every wasmtime
 * build rather than only GPU ones.
 *
 * Three settings in here are the whole reason this is a shim and not a
 * subprocess driving ffmpeg. None are reachable through the ffmpeg CLI, and
 * each fails silently — the encoder reports hundreds of frames sent while the
 * client shows a black screen and times out. They are marked THE THREE below.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "enclave_nvenc.h"
#include "nvEncodeAPI.h"

/* ---- CUDA driver API, declared rather than included -------------------- */
/*
 * Six functions out of cuda.h, which we would otherwise need the toolkit for.
 * The types are stable ABI: CUdevice is an int, CUcontext an opaque pointer.
 */
typedef int CUresult;
typedef int CUdevice;
typedef void *CUcontext;

static CUresult (*p_cuInit)(unsigned int);
static CUresult (*p_cuDeviceGet)(CUdevice *, int);
static CUresult (*p_cuCtxCreate)(CUcontext *, unsigned int, CUdevice);
static CUresult (*p_cuCtxDestroy)(CUcontext);
static CUresult (*p_cuCtxPushCurrent)(CUcontext);
static CUresult (*p_cuCtxPopCurrent)(CUcontext *);

static NVENCSTATUS(NVENCAPI *p_NvEncodeAPICreateInstance)(NV_ENCODE_API_FUNCTION_LIST *);

static NV_ENCODE_API_FUNCTION_LIST g_nv;
static int g_ready;              /* driver + entry points resolved */
static pthread_once_t g_once = PTHREAD_ONCE_INIT;

/* ---- errors ------------------------------------------------------------ */

static __thread char g_err[512];

static void set_err(const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(g_err, sizeof(g_err), fmt, ap);
    va_end(ap);
}

const char *env_last_error(void) { return g_err; }

/* NVENC's own message for a status, which is far more useful than the enum. */
static const char *nv_str(void *enc, NVENCSTATUS st) {
    if (enc && g_nv.nvEncGetLastErrorString) {
        const char *s = g_nv.nvEncGetLastErrorString(enc);
        if (s && *s) return s;
    }
    static __thread char buf[32];
    snprintf(buf, sizeof(buf), "NVENCSTATUS %d", (int)st);
    return buf;
}

/* ---- one-time driver load --------------------------------------------- */

static void load_driver(void) {
    void *cuda = dlopen("libcuda.so.1", RTLD_NOW | RTLD_GLOBAL);
    if (!cuda) {
        set_err("libcuda.so.1: %s", dlerror());
        return;
    }
    p_cuInit           = dlsym(cuda, "cuInit");
    p_cuDeviceGet      = dlsym(cuda, "cuDeviceGet");
    p_cuCtxCreate      = dlsym(cuda, "cuCtxCreate_v2");
    p_cuCtxDestroy     = dlsym(cuda, "cuCtxDestroy_v2");
    p_cuCtxPushCurrent = dlsym(cuda, "cuCtxPushCurrent_v2");
    p_cuCtxPopCurrent  = dlsym(cuda, "cuCtxPopCurrent_v2");
    if (!p_cuInit || !p_cuDeviceGet || !p_cuCtxCreate || !p_cuCtxDestroy ||
        !p_cuCtxPushCurrent || !p_cuCtxPopCurrent) {
        set_err("libcuda.so.1 is missing the driver API entry points");
        return;
    }

    void *nvenc = dlopen("libnvidia-encode.so.1", RTLD_NOW);
    if (!nvenc) {
        set_err("libnvidia-encode.so.1: %s", dlerror());
        return;
    }
    p_NvEncodeAPICreateInstance = dlsym(nvenc, "NvEncodeAPICreateInstance");
    if (!p_NvEncodeAPICreateInstance) {
        set_err("libnvidia-encode.so.1 has no NvEncodeAPICreateInstance");
        return;
    }

    CUresult cu = p_cuInit(0);
    if (cu != 0) {
        set_err("cuInit failed (%d) — no usable GPU", cu);
        return;
    }

    memset(&g_nv, 0, sizeof(g_nv));
    g_nv.version = NV_ENCODE_API_FUNCTION_LIST_VER;
    NVENCSTATUS st = p_NvEncodeAPICreateInstance(&g_nv);
    if (st != NV_ENC_SUCCESS) {
        /* Almost always a driver older than the header this was built against. */
        set_err("NvEncodeAPICreateInstance failed (%d): driver too old for "
                "NVENCAPI %d.%d",
                (int)st, NVENCAPI_MAJOR_VERSION, NVENCAPI_MINOR_VERSION);
        return;
    }
    g_ready = 1;
}

static int ready(void) {
    pthread_once(&g_once, load_driver);
    return g_ready;
}

/* ---- session ----------------------------------------------------------- */

struct env_session {
    CUcontext cuctx;
    void *enc;
    NV_ENC_INPUT_PTR inbuf;
    NV_ENC_OUTPUT_PTR bitbuf;
    NV_ENC_BUFFER_FORMAT fmt;
    uint32_t w, h;
    size_t frame_bytes;
    uint64_t pts;
};

static int guid_eq(const GUID *a, const GUID *b) {
    return memcmp(a, b, sizeof(GUID)) == 0;
}

/* Pixel format name -> NVENC format + the exact byte count of one frame. */
static int parse_format(const char *name, uint32_t w, uint32_t h,
                        NV_ENC_BUFFER_FORMAT *fmt, size_t *bytes) {
    if (!name || !*name) name = "nv12";
    if (!strcmp(name, "nv12")) {
        *fmt = NV_ENC_BUFFER_FORMAT_NV12;
        *bytes = (size_t)w * h * 3 / 2;
    } else if (!strcmp(name, "iyuv") || !strcmp(name, "i420")) {
        *fmt = NV_ENC_BUFFER_FORMAT_IYUV;
        *bytes = (size_t)w * h * 3 / 2;
    } else if (!strcmp(name, "argb")) {
        *fmt = NV_ENC_BUFFER_FORMAT_ARGB;
        *bytes = (size_t)w * h * 4;
    } else if (!strcmp(name, "abgr")) {
        *fmt = NV_ENC_BUFFER_FORMAT_ABGR;
        *bytes = (size_t)w * h * 4;
    } else {
        return -1;
    }
    return 0;
}

static int parse_codec(const char *name, GUID *out) {
    if (!name || !*name) name = "h264";
    if (!strcmp(name, "h264")) { *out = NV_ENC_CODEC_H264_GUID; return 0; }
    if (!strcmp(name, "hevc") || !strcmp(name, "h265")) { *out = NV_ENC_CODEC_HEVC_GUID; return 0; }
    if (!strcmp(name, "av1"))  { *out = NV_ENC_CODEC_AV1_GUID;  return 0; }
    return -1;
}

/* Open a CUDA context on device 0 and an NVENC session on it. */
static int open_session(CUcontext *ctx, void **enc) {
    CUdevice dev;
    CUresult cu = p_cuDeviceGet(&dev, 0);
    if (cu != 0) {
        set_err("cuDeviceGet(0) failed (%d)", cu);
        return -1;
    }
    cu = p_cuCtxCreate(ctx, 0, dev);
    if (cu != 0) {
        set_err("cuCtxCreate failed (%d)", cu);
        return -1;
    }
    /* cuCtxCreate leaves the context current on THIS thread; every entry point
       pushes it explicitly, so pop it back off and keep the thread clean. */
    CUcontext prev;
    p_cuCtxPopCurrent(&prev);

    NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS params;
    memset(&params, 0, sizeof(params));
    params.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
    params.deviceType = NV_ENC_DEVICE_TYPE_CUDA;
    params.device = *ctx;
    params.apiVersion = NVENCAPI_VERSION;

    p_cuCtxPushCurrent(*ctx);
    NVENCSTATUS st = g_nv.nvEncOpenEncodeSessionEx(&params, enc);
    CUcontext popped;
    p_cuCtxPopCurrent(&popped);

    if (st != NV_ENC_SUCCESS) {
        /* The usual cause is the per-card concurrent-session cap, which is a
           licensing limit on consumer parts and absent on datacenter ones. */
        set_err("nvEncOpenEncodeSessionEx failed (%d) — out of encoder sessions?",
                (int)st);
        p_cuCtxDestroy(*ctx);
        *ctx = NULL;
        return -1;
    }
    return 0;
}

uint32_t env_caps(void) {
    static uint32_t caps;
    static int probed;
    if (probed) return caps;

    if (!ready()) { probed = 1; return 0; }

    CUcontext ctx = NULL;
    void *enc = NULL;
    if (open_session(&ctx, &enc) != 0) { probed = 1; return 0; }

    uint32_t count = 0;
    if (g_nv.nvEncGetEncodeGUIDCount(enc, &count) == NV_ENC_SUCCESS && count) {
        GUID *guids = calloc(count, sizeof(GUID));
        uint32_t got = 0;
        if (guids && g_nv.nvEncGetEncodeGUIDs(enc, guids, count, &got) == NV_ENC_SUCCESS) {
            for (uint32_t i = 0; i < got; i++) {
                if (guid_eq(&guids[i], &NV_ENC_CODEC_H264_GUID)) caps |= ENV_CAP_H264;
                if (guid_eq(&guids[i], &NV_ENC_CODEC_HEVC_GUID)) caps |= ENV_CAP_HEVC;
                if (guid_eq(&guids[i], &NV_ENC_CODEC_AV1_GUID))  caps |= ENV_CAP_AV1;
            }
        }
        free(guids);
    }

    g_nv.nvEncDestroyEncoder(enc);
    p_cuCtxDestroy(ctx);
    probed = 1;
    return caps;
}

env_session *env_open(const env_config *cfg) {
    g_err[0] = 0;
    if (!cfg || cfg->width < 16 || cfg->height < 16) {
        set_err("width/height must be at least 16");
        return NULL;
    }
    /* NVENC wants even dimensions for every 4:2:0 format we accept. */
    if ((cfg->width & 1) || (cfg->height & 1)) {
        set_err("width/height must be even (got %ux%u)", cfg->width, cfg->height);
        return NULL;
    }
    if (!ready()) return NULL;

    GUID codec;
    if (parse_codec(cfg->codec, &codec) != 0) {
        set_err("unknown codec %s (want h264, hevc or av1)", cfg->codec);
        return NULL;
    }
    NV_ENC_BUFFER_FORMAT fmt;
    size_t frame_bytes;
    if (parse_format(cfg->format, cfg->width, cfg->height, &fmt, &frame_bytes) != 0) {
        set_err("unknown pixel format %s (want nv12, iyuv, argb or abgr)", cfg->format);
        return NULL;
    }

    env_session *s = calloc(1, sizeof(*s));
    if (!s) { set_err("out of memory"); return NULL; }
    s->fmt = fmt;
    s->w = cfg->width;
    s->h = cfg->height;
    s->frame_bytes = frame_bytes;

    if (open_session(&s->cuctx, &s->enc) != 0) { free(s); return NULL; }
    p_cuCtxPushCurrent(s->cuctx);

    uint32_t fps_num = cfg->fps_num ? cfg->fps_num : 60;
    uint32_t fps_den = cfg->fps_den ? cfg->fps_den : 1;
    uint32_t bitrate = cfg->bitrate ? cfg->bitrate : 8000000;
    uint32_t gop = cfg->gop ? cfg->gop : NVENC_INFINITE_GOPLENGTH;

    /* Start from the preset the way NVIDIA intends, then override. P4 with the
       low-latency tuning is the streaming point on the speed/quality curve;
       going slower buys quality this workload cannot spend, because the frame
       has to be on the wire before the next one is scanned. */
    NV_ENC_CONFIG enc_cfg;
    memset(&enc_cfg, 0, sizeof(enc_cfg));
    NV_ENC_PRESET_CONFIG preset;
    memset(&preset, 0, sizeof(preset));
    preset.version = NV_ENC_PRESET_CONFIG_VER;
    preset.presetCfg.version = NV_ENC_CONFIG_VER;
    NVENCSTATUS st = g_nv.nvEncGetEncodePresetConfigEx(
        s->enc, codec, NV_ENC_PRESET_P4_GUID,
        NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncGetEncodePresetConfigEx: %s", nv_str(s->enc, st));
        goto fail;
    }
    enc_cfg = preset.presetCfg;
    enc_cfg.version = NV_ENC_CONFIG_VER;

    enc_cfg.gopLength = gop;
    /* IPPP. A B-frame is a frame of latency held for reordering, which an
       interactive desktop pays for and never uses. */
    enc_cfg.frameIntervalP = 1;
    enc_cfg.rcParams.rateControlMode = NV_ENC_PARAMS_RC_CBR;
    enc_cfg.rcParams.averageBitRate = bitrate;
    /* One frame of VBV. The point of a low-latency stream is that the encoder
       never buffers ahead of the wire. */
    enc_cfg.rcParams.vbvBufferSize = (uint32_t)((uint64_t)bitrate * fps_den / fps_num);
    enc_cfg.rcParams.vbvInitialDelay = enc_cfg.rcParams.vbvBufferSize;

    if (guid_eq(&codec, &NV_ENC_CODEC_H264_GUID)) {
        NV_ENC_CONFIG_H264 *h = &enc_cfg.encodeCodecConfig.h264Config;
        /* THE THREE, part 1. Moonlight decides a frame is a keyframe by the
           access unit STARTING with an SPS, not by containing an IDR slice
           (moonlight-common-c, VideoDepacketizer.c:isIdrFrameStart). Emit the
           parameter sets only at stream start and every mid-stream IDR is
           invisible: the client drops every frame and times out with
           ML_ERROR_NO_VIDEO_FRAME while this side reports frames sent. */
        h->repeatSPSPPS = 1;
        /* THE THREE, part 2. CBR padding is emitted as filler NALs (type 12),
           and they land in FRONT of the SPS. The client skips AUD and SEI when
           hunting for that SPS but not filler, so the same total blackout
           happens — and only against static content, which is exactly what an
           idle desktop is. */
        h->enableFillerDataInsertion = 0;
        h->idrPeriod = gop;
        h->outputAUD = 0;
    } else if (guid_eq(&codec, &NV_ENC_CODEC_HEVC_GUID)) {
        NV_ENC_CONFIG_HEVC *h = &enc_cfg.encodeCodecConfig.hevcConfig;
        h->repeatSPSPPS = 1;
        h->enableFillerDataInsertion = 0;
        h->idrPeriod = gop;
        h->outputAUD = 0;
    } else {
        /* AV1 spells the same two ideas differently, and emits OBUs rather
           than Annex-B NALs — a client has to be told which it is getting. */
        NV_ENC_CONFIG_AV1 *a = &enc_cfg.encodeCodecConfig.av1Config;
        a->repeatSeqHdr = 1;
        a->enableBitstreamPadding = 0;
        a->idrPeriod = gop;
    }

    NV_ENC_INITIALIZE_PARAMS init;
    memset(&init, 0, sizeof(init));
    init.version = NV_ENC_INITIALIZE_PARAMS_VER;
    init.encodeGUID = codec;
    init.presetGUID = NV_ENC_PRESET_P4_GUID;
    init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
    init.encodeWidth = s->w;
    init.encodeHeight = s->h;
    init.darWidth = s->w;
    init.darHeight = s->h;
    init.frameRateNum = fps_num;
    init.frameRateDen = fps_den;
    init.enablePTD = 1;   /* the encoder decides picture type; we override per frame */
    init.encodeConfig = &enc_cfg;

    st = g_nv.nvEncInitializeEncoder(s->enc, &init);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncInitializeEncoder: %s", nv_str(s->enc, st));
        goto fail;
    }

    NV_ENC_CREATE_INPUT_BUFFER cin;
    memset(&cin, 0, sizeof(cin));
    cin.version = NV_ENC_CREATE_INPUT_BUFFER_VER;
    cin.width = s->w;
    cin.height = s->h;
    cin.bufferFmt = fmt;
    st = g_nv.nvEncCreateInputBuffer(s->enc, &cin);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncCreateInputBuffer: %s", nv_str(s->enc, st));
        goto fail;
    }
    s->inbuf = cin.inputBuffer;

    NV_ENC_CREATE_BITSTREAM_BUFFER cout;
    memset(&cout, 0, sizeof(cout));
    cout.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
    st = g_nv.nvEncCreateBitstreamBuffer(s->enc, &cout);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncCreateBitstreamBuffer: %s", nv_str(s->enc, st));
        goto fail;
    }
    s->bitbuf = cout.bitstreamBuffer;

    CUcontext popped;
    p_cuCtxPopCurrent(&popped);
    return s;

fail: {
        CUcontext p;
        p_cuCtxPopCurrent(&p);
        env_close(s);
        return NULL;
    }
}

/* Copy one frame into the locked input buffer, honouring its pitch. */
static void copy_in(env_session *s, const uint8_t *src, uint8_t *dst, uint32_t pitch) {
    uint32_t w = s->w, h = s->h;
    switch (s->fmt) {
    case NV_ENC_BUFFER_FORMAT_NV12:
        for (uint32_t y = 0; y < h; y++) memcpy(dst + (size_t)y * pitch, src + (size_t)y * w, w);
        src += (size_t)w * h;
        dst += (size_t)h * pitch;
        for (uint32_t y = 0; y < h / 2; y++) memcpy(dst + (size_t)y * pitch, src + (size_t)y * w, w);
        break;
    case NV_ENC_BUFFER_FORMAT_IYUV:
        for (uint32_t y = 0; y < h; y++) memcpy(dst + (size_t)y * pitch, src + (size_t)y * w, w);
        src += (size_t)w * h;
        dst += (size_t)h * pitch;
        /* U and V are half-width planes and the locked buffer halves the pitch
           to match. */
        for (uint32_t y = 0; y < h / 2; y++)
            memcpy(dst + (size_t)y * (pitch / 2), src + (size_t)y * (w / 2), w / 2);
        src += (size_t)w * h / 4;
        dst += (size_t)(h / 2) * (pitch / 2);
        for (uint32_t y = 0; y < h / 2; y++)
            memcpy(dst + (size_t)y * (pitch / 2), src + (size_t)y * (w / 2), w / 2);
        break;
    default: /* ARGB / ABGR */
        for (uint32_t y = 0; y < h; y++)
            memcpy(dst + (size_t)y * pitch, src + (size_t)y * w * 4, (size_t)w * 4);
        break;
    }
}

int env_encode(env_session *s, const uint8_t *frame, size_t len, int force_idr,
               uint8_t *out, size_t out_cap, size_t *out_len, int *is_keyframe) {
    g_err[0] = 0;
    if (!s || !frame || !out_len || !is_keyframe) {
        set_err("null argument");
        return ENV_E_ARG;
    }
    *out_len = 0;
    *is_keyframe = 0;
    if (len != s->frame_bytes) {
        set_err("frame is %zu bytes, this %ux%u session wants %zu", len, s->w, s->h,
                s->frame_bytes);
        return ENV_E_ARG;
    }

    p_cuCtxPushCurrent(s->cuctx);
    int rc = ENV_OK;

    NV_ENC_LOCK_INPUT_BUFFER lin;
    memset(&lin, 0, sizeof(lin));
    lin.version = NV_ENC_LOCK_INPUT_BUFFER_VER;
    lin.inputBuffer = s->inbuf;
    NVENCSTATUS st = g_nv.nvEncLockInputBuffer(s->enc, &lin);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncLockInputBuffer: %s", nv_str(s->enc, st));
        rc = ENV_E_ENCODE;
        goto done;
    }
    copy_in(s, frame, lin.bufferDataPtr, lin.pitch);
    g_nv.nvEncUnlockInputBuffer(s->enc, s->inbuf);

    NV_ENC_PIC_PARAMS pic;
    memset(&pic, 0, sizeof(pic));
    pic.version = NV_ENC_PIC_PARAMS_VER;
    pic.inputBuffer = s->inbuf;
    pic.bufferFmt = s->fmt;
    pic.inputWidth = s->w;
    pic.inputHeight = s->h;
    pic.outputBitstream = s->bitbuf;
    pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
    pic.inputTimeStamp = s->pts++;
    /* THE THREE, part 3. The client asks for an IDR when it loses packets. A
       host that cannot produce one on demand recovers only at the next GOP
       boundary, and this session has no GOP boundaries by default. */
    if (force_idr) pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR;

    st = g_nv.nvEncEncodePicture(s->enc, &pic);
    if (st == NV_ENC_ERR_NEED_MORE_INPUT) {
        /* Not an error: the encoder is holding this frame back. Cannot happen
           with frameIntervalP=1 and no lookahead, but saying so in the return
           value beats asserting it. */
        goto done;
    }
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncEncodePicture: %s", nv_str(s->enc, st));
        rc = ENV_E_ENCODE;
        goto done;
    }

    NV_ENC_LOCK_BITSTREAM lb;
    memset(&lb, 0, sizeof(lb));
    lb.version = NV_ENC_LOCK_BITSTREAM_VER;
    lb.outputBitstream = s->bitbuf;
    st = g_nv.nvEncLockBitstream(s->enc, &lb);
    if (st != NV_ENC_SUCCESS) {
        set_err("nvEncLockBitstream: %s", nv_str(s->enc, st));
        rc = ENV_E_ENCODE;
        goto done;
    }

    *out_len = lb.bitstreamSizeInBytes;
    *is_keyframe = (lb.pictureType == NV_ENC_PIC_TYPE_IDR);
    if (lb.bitstreamSizeInBytes > out_cap) {
        /* Report the size rather than truncate: a half access unit decodes to
           nothing and looks like a network fault. */
        set_err("access unit is %u bytes, buffer is %zu", lb.bitstreamSizeInBytes, out_cap);
        rc = ENV_E_SHORT_BUFFER;
    } else if (out) {
        memcpy(out, lb.bitstreamBufferPtr, lb.bitstreamSizeInBytes);
    }
    g_nv.nvEncUnlockBitstream(s->enc, s->bitbuf);

done: {
        CUcontext popped;
        p_cuCtxPopCurrent(&popped);
    }
    return rc;
}

void env_close(env_session *s) {
    if (!s) return;
    if (s->cuctx) p_cuCtxPushCurrent(s->cuctx);
    if (s->enc) {
        /* Flush. An encoder torn down mid-stream can leave the driver holding
           a frame; EOS is how you tell it there is no frame N+1 coming. */
        NV_ENC_PIC_PARAMS eos;
        memset(&eos, 0, sizeof(eos));
        eos.version = NV_ENC_PIC_PARAMS_VER;
        eos.encodePicFlags = NV_ENC_PIC_FLAG_EOS;
        g_nv.nvEncEncodePicture(s->enc, &eos);

        if (s->bitbuf) g_nv.nvEncDestroyBitstreamBuffer(s->enc, s->bitbuf);
        if (s->inbuf) g_nv.nvEncDestroyInputBuffer(s->enc, s->inbuf);
        g_nv.nvEncDestroyEncoder(s->enc);
    }
    if (s->cuctx) {
        CUcontext popped;
        p_cuCtxPopCurrent(&popped);
        p_cuCtxDestroy(s->cuctx);
    }
    free(s);
}
