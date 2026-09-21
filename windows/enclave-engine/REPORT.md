# The shielded engine inside a VBS enclave: built, generating, attached

The consumer node's trusted half: llama.cpp's CPU path plus the shielded backend, running in VTL1
on a Windows 11 Pro mini PC (GMKtec NucBox K11, Ryzen 7 8845HS, Radeon 780M), offloading every
linear op masked to the untrusted Vulkan worker on the same machine, attesting its keys through
the VBS report, and answering completions over the fleet tunnel. Measured on 2026-09-21.

## What runs where

| piece | where | trust |
|---|---|---|
| `ee-engine.dll` (this directory): llama.cpp ddd4ec1 + ggml + ggml-shielded + the STL runtime half + `ee-rt.c`/`ee-stl.cpp`/`ee-main.cpp` | VTL1 enclave, 2 GB, 64 host-entered threads | trusted, measured (ImageId `ec1a5e00…10…01`, key `ce450a96…d30b3c`) |
| `ee-host.exe`: loads the enclave, serves its call-outs (log, thread entry, the worker socket), offers `keys`/`attest`/`gen` on loopback | VTL0 | untrusted plumbing |
| `shielded-worker.exe` (windows/worker-win, Vulkan) | VTL0, the GPU | untrusted by design: sees masked activations only |
| `tpmattest.exe` (windows/node) | VTL0 | untrusted; the TPM's answers are checked by the relay |
| `agent.mjs` (windows/node) | VTL0 | untrusted; runs the three above and the tunnel |

## Results on the box

| step | measured |
|---|---|
| enclave create + load + init (2 GB, 64 threads) | < 1 s |
| Qwen2.5-0.5B q8 (644 MB) loaded into the enclave, weights registered with the shielded backend (calibration applied) | 12.0 s |
| completion, worker unreachable (enclave CPU fallback, 4 threads) | ` Paris. It is the largest city in`, 657 nodes local, 55.9 ms/token |
| completion, Vulkan worker on the 780M | ` Paris. It is the largest city in`, **657 nodes offloaded, 5252 MMACs, 0 verification failures**, 90 ms/token |
| Linux reference (`shielded-run`, same GGUF + calibration, `The capital of France is`, 8 tokens) | ` Paris. It is the largest city in` |
| first prompt after load (pad pool warm-up) / later prompts | 8.2 s / 0.23 s |
| attach to a fleet-tunnel hub over ZeroTier (windows/vbs/EVIDENCE.md handshake: TPM keys -> minted credential -> transcript, enclave report, quote, credential, boot log) | ACCEPTED, `attestation(vbs-dev)`, mode vbs, transport and pad keys recorded |
| completions routed through the hub (`POST /t/nucbox-k11/v1/completions`) | same texts, 12 tokens / 1.07 s decode, 1606 nodes offloaded, 0 failures |

Three-way identity: the enclave alone, the enclave + GPU worker, and the Linux engine produce the
same tokens. The offloaded path is exact (Slalom recovery in Z_M), so anything else would have
been a bug.

## What it took (the port, in order of pain)

1. **One compatibility header, stub headers, no source edits to llama.cpp/ggml.** `ee-compat.h`
   is force-included into every TU: `_KERNEL32_`/`_ACRTIMP=`/`_CRTIMP2_*=` (Microsoft's own enclave
   C++ trick) turn kernel32 and CRT declarations plain so our definitions satisfy them; `posix/`
   supplies pthread/socket/unistd/mman/stat/… headers over the runtime; a 64-bit `off_t` is
   declared before the UCRT can define its 32-bit one.
2. **`ee-rt.c`: the runtime.** Threads are HOST threads that enter through the exported `EeThread`
   (the enclave asks the host to spawn, `_beginthreadex` waits for the entrant's id); `CreateThread`,
   `WaitForSingleObject`, pthreads and the STL's `_Thrd_*/_Mtx_*/_Cnd_*` (ee-stl.cpp, over SRW
   locks and condition variables, matching the STL's frozen ABI structs) all sit on that. Sockets are
   call-outs (the host owns the TCP socket; `getaddrinfo` returns the host name for the host to
   resolve). Files are a memory filesystem over host memory (`fopen`/`fread`/`_wfopen`; the model is
   read straight from VTL0 RAM). `printf` and `fprintf(stderr)` are call-outs through
   `__stdio_common_vfprintf`. The clock is QueryPerformanceCounter plus the host's epoch at init;
   `getenv` reads a block copied in at init; randomness is `BCryptGenRandom`.
3. **The STL's runtime half.** An enclave links libcmt and libvcruntime but no libcpmt, and llama.cpp
   uses stringstreams and `std::regex`, which need locales. `stl/` holds the relevant microsoft/STL
   sources (locale0/locale/xlocale/wlocale/ulocale, xlock, ios, xthrow, regex, vector_algorithms,
   the `_Getctype`/`_Strcoll` family, …) at the commit whose `_MSVC_STL_UPDATE` (202604) is the
   box's own, compiled as C++20 with `_CRTBLD`; `ee-stl-support.cpp` answers their Win32 NLS and
   UCRT locale calls for the "C" locale (ASCII `LCMapStringEx`/`CompareStringEx`/`GetStringTypeW`,
   a classic ctype table, `setlocale` that only knows "C"). The locale lock had to be a critical
   section: the STL takes it re-entrantly, and an SRW lock deadlocked the first stringstream.
4. **Two llama.cpp files patched by copy** (`patched/`): `llama-mmap.cpp` with every `_WIN32` branch
   disabled under `__ENCLAVE_PROJECT__` so the POSIX fopen path runs, and `llama-model-loader.cpp`
   with its optional tensor validation made synchronous (MSVC's `std::async` is the PPL thread pool
   plus `exception_ptr`, neither of which exists in VTL1). `ee-backend-reg.cpp` replaces ggml's
   registry (no `std::filesystem`, no LoadLibrary): CPU and shielded backends are registered
   statically.
5. **The engine's own portability edits** (wasm/ggml-shielded, shared with Linux): the five
   `__int128` sites became exact 64-bit helpers (`shielded-wide.h`: dot products reduced mod M as
   they accumulate, overflow-checked size arithmetic), the pad header's zero-length padding array is
   guarded, the one `aligned_alloc` became an allocate/free pair. Linux self-tests pass unchanged.
6. **Build hygiene that bit:** a `.c` and a `.cpp` with the same stem overwrote each other's object;
   the host's object landed in the enclave's object directory and broke a relink; PowerShell over SSH
   mangles `--env K=V` (a batch file runs the host); processes started from an SSH session die with it
   (the node runs under a persistent session, or the logon task `install-node.cmd` registers).

## Exports (windows/enclave-engine/ee-rt.h)
`EeInit` (runtime + Ed25519 transport key + X25519 pad key, public halves out), `EeLoad` (model,
context, persistent threadpool), `EeGenerate` (greedy, first index on ties, same rule as
`shielded-run`), `EeAttest` (refuses any transcript that does not name its own keys; report over
`sha256(bound)`; Ed25519 signature over `bound`), `EeThread` (host-entered thread body).

## Build and run
`./sync.sh` copies the sources to the box and runs `build.cmd` (cl: ggml, ggml-cpu, llama + models,
the shielded engine, `stl/`, the runtime; link with the enclave libcmt/libvcruntime/ucrt + vertdll +
bcrypt, `/ENCLAVE /INTEGRITYCHECK /GUARD:MIXED`; `veiid`; test-signed; then the host).
`build.cmd rt` recompiles only the runtime and relinks; `host` rebuilds the host only.
```
ee-host.exe --model m.gguf --calib m.calib --env SHIELDED_HOST=127.0.0.1 --env SHIELDED_PORT=9595 --threads 8 --n 16 --prompt "…"
ee-host.exe … --serve 9596        # keys / attest <bound hex> / gen <n> <prompt hex> for the agent
```

## Not done here, stated plainly
- **Sessions are not yet end-to-end encrypted to the enclave**: a prompt through the tunnel is
  plaintext to the relay and the host. The phone's design (requests boxed to the attested key) is
  the next step; the transport key is already minted inside and bound by the report.
- **Tier is vbs-dev**: test-signed, Secure Boot off, `TESTSIGNING=1` in the log. Production signing
  and the flip to tier vbs are windows/vbs/SIGNING.md (needs the company's Azure account).
- Weights are copied into the enclave (2 GB image, fine for 0.5B–1B); the benchmark shows the
  enclave reads host memory at native speed, so larger models should keep public weights outside.
- Dealt pads (the dealer's seeds to the pad key) are not wired on Windows: the enclave mints its own
  pads. The pad key is generated and attested so the dealer flow can follow.
- The host prints a few `EeThread entry failed: 5` at exit when pool threads race the teardown;
  cosmetic (the host now `_exit`s instead).
