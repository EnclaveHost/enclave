# nvenc-shim — hardware video encode behind wasi-nn

A flat C ABI (`enclave_nvenc.h`) over NVIDIA's NvEncodeAPI, bound by the
`nvenc` wasi-nn backend (`wasmtime-nn-nvenc.patch`, applies on top of
`wasmtime-nn-sdcpp.patch` — it reuses the `preload_kind` lookup that patch adds
to `backend/mod.rs` and `lib.rs`). Sibling of `llama-shim/` and `sd-shim/`, and
the same discipline: std + FFI, no cargo dependencies.

## Why it exists

An app that produces frames could already stream them, but only through a
native sidecar running beside the CVM (`risc-box/gs-bridge`), which pulls
plaintext framebuffers out over HTTP and encodes them on the host. That puts
the desktop's pixels, the user's keystrokes and the session keys outside the
trust boundary and outside the deployment's attestation. Software encode in
wasm cannot hold 60 fps at desktop resolution, and the GPU is reachable only
through these shims — none of which encoded video. This is that missing verb.

It is not RISC-Box-specific. Any app that can produce frames gets remote
desktop or video streaming out of it.

## Nothing NVIDIA is linked

`libcuda.so.1` and `libnvidia-encode.so.1` are both **dlopened**, and the CUDA
driver entry points the shim needs are declared rather than included. So a
build host needs no CUDA toolkit, and a node with no GPU loads the library fine
and answers `env_caps() == 0`. That is what lets the backend be compiled into
every wasmtime build rather than only GPU ones, and it is why a GPU-less node
degrades with a diagnostic instead of failing to start:

```
wasi-nn: preload of nvenc::/tmp FAILED (... nvenc: no hardware video encoder on
this host (no GPU, no NVENC, or the driver predates the NVENCAPI this was built
against): cuInit failed (100) — no usable GPU); graph skipped
```

`nvEncodeAPI.h` is vendored here (NVIDIA's MIT-licensed header from
`FFmpeg/nv-codec-headers`, NVENCAPI 13.1). A driver older than the header fails
at `NvEncodeAPICreateInstance` with a message that says so.

## THE THREE settings, which is why this is a shim and not an ffmpeg subprocess

None of these are reachable through the ffmpeg CLI, and each fails **silently**
— the encoder reports hundreds of frames sent while the client shows a black
screen and times out. All three cost real debugging time in `gs-bridge` before
they were understood.

- **`repeatSPSPPS = 1`.** Moonlight identifies a keyframe by the access unit
  *starting with an SPS*, not by containing an IDR slice (moonlight-common-c,
  `VideoDepacketizer.c:isIdrFrameStart`). Emit the parameter sets once at stream
  start and every mid-stream IDR is invisible: the client drops every frame and
  times out with `ML_ERROR_NO_VIDEO_FRAME`.
- **`enableFillerDataInsertion = 0`.** CBR padding is emitted as filler NALs
  (type 12) which land *in front of* the SPS. The client skips AUD and SEI when
  hunting for that SPS but not filler, so the same total blackout occurs — and
  only against static content, which is exactly what an idle desktop is.
- **`NV_ENC_PIC_FLAG_FORCEIDR` honoured per frame.** The client asks for an IDR
  when it loses packets. A host that cannot produce one on demand recovers only
  at the next GOP boundary, and a streaming session has no GOP boundaries by
  default (`gop: 0`). `gs-bridge` cannot do this at all — it drives ffmpeg
  through a pipe and can only shorten the GOP — so the verb is strictly better
  than the native implementation it replaces.

`nvenc-selftest.c` checks all three by parsing the NALs back out of the
bitstream, because frame counts prove nothing here: an encoder emitting
perfectly valid H.264 that Moonlight cannot see reports exactly the same
numbers as one that works.

## Build

```bash
cc -shared -fPIC -O2 -Wall -Wextra -Wl,-soname,libenclave_nvenc.so \
   -I. enclave_nvenc.c -ldl -lpthread -o libenclave_nvenc.so

# wasmtime build (after applying wasmtime-nn-nvenc.patch):
ENV_LIB_LOCATION=<dir with libenclave_nvenc.so> cargo build --release -p wasmtime-cli \
  --features wasmtime-wasi-nn/nvenc
```

Self-test, on a machine with an NVIDIA GPU:

```bash
cc -O2 -I. nvenc-selftest.c -L. -lenclave_nvenc -o nvenc-selftest
LD_LIBRARY_PATH=. ./nvenc-selftest out.h264
ffmpeg -v error -i out.h264 -f null -      # independent decode check
```

Verified on an RTX 3070 (driver 610.57.04), 1024x768 NV12, 60 frames:

```
caps: 0x3  h264=1 hevc=1 av1=0
  frame  0: keyframe  29173 bytes, first NAL type 7 (IDR slice present)
  frame 30: keyframe  29031 bytes, first NAL type 7 (IDR slice present)
1. every keyframe AU starts with an SPS: ok
2. no filler NALs in the stream:          ok
3. the forced IDR at frame 30 is an IDR:  ok
4. exactly 2 keyframes (0 and forced):    ok (2)
```

(`av1=0` is correct on a 3070 — AV1 encode starts at Ada. The H200 reports it.)

## Wiring (host side)

`wasm_manager.py` emits `-S nn-graph=nvenc::<dir>` for a tenant that already has
the `-Snn` grant and a `gpuShare`, gated on the preload probe. No new launch
flag and no purchase of its own: the graph holds no VRAM and opens no encoder
session until the guest calls `load_by_name("nvenc")`, so granting it to every
GPU tenant is cheaper than metering it. The directory is not read — there is no
model, the graph *is* the encoder — but preload is still the delivery mechanism,
because that is what reports "this node cannot encode" at startup in front of an
operator rather than at the first frame in front of a user.

The probe distinguishes three answers, which matter separately: `preload done`
(backend present, encoder present), `no hardware video encoder` (backend
present, node cannot encode — a driver problem, not a rollout problem), and
`unknown graph encoding` (toolchain predates the backend). Only the first emits
the flag; `nvenc` appears in `ENCLAVE_NN_PRELOADS` when it does.

**Open, and deliberately not decided here: accounting.** Encode is *not*
wrapped in the MPS arbiter. The arbiter exists because MPS statically partitions
SMs; NVENC is a separate fixed-function engine, and one 720p stream measured
4-5% encoder utilization against 8-9% overall, so taking an arbiter turn per
frame would queue encodes behind inference tenants that are not competing for
the same silicon. Whether encode wants its own arbiter class, and what the
per-card concurrent-session cap should be, is a fleet-capacity question — the
cap is real (unrestricted on datacenter parts, limited on consumer ones) and it
bounds how many streaming deployments fit on a node.

## Guest contract (wasi-nn, WIT named tensors)

`load_by_name("nvenc")` → `init_execution_context()` → one `compute()` per
frame.

**One context is one encoder session.** This is the first stateful backend
here: frame N references frame N-1, so a session cannot be rebuilt per call the
way a diffusion pipeline can. Dropping the context closes the session; a guest
that wants two streams inits two contexts. The session opens on the first
`config` rather than at `init_execution_context`, because nothing before that
call knows the frame size.

| input | type | meaning |
|---|---|---|
| `config` | U8 [n] | JSON; once per context before the first frame, again to reconfigure |
| `frame` | U8 [n] | one raw frame in the session's pixel format |
| `idr` | I32 [1] | optional, beside `frame`: force this frame to be an IDR |
| `caps` | I32 [1] | probe; needs no session and no config |

| output | type | meaning |
|---|---|---|
| `bitstream` | U8 [n] | exactly one access unit (Annex-B for H.264/HEVC, OBUs for AV1) |
| `keyframe` | I32 [1] | 1 if that unit is an IDR |
| `caps` | I32 [1] | bit0 h264, bit1 hevc, bit2 av1 |

`config` keys: `codec` (`h264` default, `hevc`, `av1`), `format` (`nv12`
default, `iyuv`, `argb`, `abgr`), `width`, `height`, `fps`, `bitrate`, `gop`
(0 = no automatic IDRs, the streaming default).

An identical `config` sent again is a no-op rather than a teardown, so a guest
may send it beside every frame without paying a new encoder and a forced IDR
each time.

**NV12, not RGB.** A frame crosses the sandbox boundary on every call: at 1080p
that is 3.1 MB as NV12 against 6.2 MB as RGB24, which at 60 fps is 185 MB/s
against 370 MB/s of copy. Worth measuring the sustained rate against
`hostcall-fuel` (default 128 MiB per call, already 4 GiB for nn tenants) — the
per-call size is fine either way.

A guest reads a missing `caps` bit as "no" and reports streaming as
unavailable, the same way the ggml probe degrades, so an older host fails
honestly instead of trapping.
