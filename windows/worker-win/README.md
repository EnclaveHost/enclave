# The shielded worker on Windows

Builds [`shielded/worker-cuda/worker.cu`](../../shielded/worker-cuda/worker.cu)
for Windows **without modifying it**.

## Why "without modifying it" is the design constraint

`worker.cu` is not just a CUDA server. It carries the admission rules that make
the shielded tier safe to run on a machine nobody attested:

- the op allowlist — `{FIELD_GEMM, VIEW, RESHAPE, PERMUTE, TRANSPOSE, CONT, CPY}`
  and a *named* refusal for everything else, including plain `MUL_MAT`
  specifically because it would run on unmasked data;
- the VRAM reservation accounting a tenant performs at HELLO (protocol 1.3);
- the exact wire framing the CVM's boot probe asserts against.

A Windows build that drifted on any of those would be a different security
artifact wearing the same name, and the drift would not show up in a test that
only checks that tokens come out. So the port is **a header and a build file**,
and the security-critical source is compiled byte-identical on both platforms.

If a future change to `worker.cu` needs a POSIX call that is not shimmed, add it
to `win-compat.h`. Do not add an `#ifdef _WIN32` to `worker.cu`.

## How it works

| piece | role |
|---|---|
| `win-compat.h` | POSIX socket names over Winsock. Force-included with `/FI`, so the names are macros before `worker.cu` uses them. Wrappers set the CRT `errno` from `WSAGetLastError()`, so the existing `EAGAIN`/`EWOULDBLOCK`/`EINTR` tests and `strerror()` logging work verbatim. |
| `posix-stubs/` | `worker.cu` includes the POSIX headers unconditionally. Most stubs are empty because `<winsock2.h>` already supplies what is wanted; three carry real content (below). |
| `Makefile.win` | `nmake /f Makefile.win`. nvcc + MSVC. |

The mappings that matter: `read`/`write` on a socket become `recv`/`send`
(Windows SOCKETs are not file descriptors — the one substitution that compiles
cleanly on a naive port and then fails at run time); `MSG_DONTWAIT` becomes a
non-blocking socket plus a no-op flag; `writev` becomes `WSASend` with two
`WSABUF`s, kept as one real scatter-gather send because header and body are one
exchange and splitting them would add a packet per reply at ~49 exchanges per
decoded token; `poll` becomes `WSAPoll`.

### The two stubs with real content

- **`sys/mman.h`** — `mmap` always fails with `ENOSYS`. The `--shm` ring is the
  ivshmem backing store of a QEMU CVM, and Hyper-V has no ivshmem. Passing
  `--shm` on Windows is a configuration error, and `worker.cu`'s existing check
  reports it as one rather than half-working.
- **`linux/vm_sockets.h`** — supplies `sockaddr_vm` and `AF_VSOCK` (Linux's
  value, which Winsock does not implement), so `socket(AF_VSOCK, ...)` fails
  with `EAFNOSUPPORT` and `worker.cu`'s own handler logs *"vsock unavailable
  (...); TCP only"*. That is the correct outcome, produced by the existing code
  path rather than by a new branch.

**The guest needs no change at all.** Linux backs `AF_VSOCK` with its `hv_sock`
transport over Hyper-V's VMBus, so
[`shielded-wire.c`](../../wasm/ggml-shielded/shielded-wire.c) connects with the
same code on Hyper-V as on QEMU.

## The flag that must not be lost

`--fmad=false`. The Linux Makefile states why: *"an FMA would round differently
from the TEE and unmasking would return noise."* The masked protocol recovers
`x·W` exactly in a prime field, so the TEE and the worker must produce
bit-identical products — otherwise the unmask yields noise and Freivalds rejects
every reply. `clang`'s `-ffp-contract=off` becomes nvcc's `--fmad=false`, and
the host compiler stays on `/fp:precise`. If verifications start failing on
Windows only, check this first.

## Staging

**Phase 1 — TCP only. Zero diff to `worker.cu`.** The guest reaches the host
over the Hyper-V virtual switch; the worker's existing TCP listener serves it.
Higher latency than a VMBus socket, but it is the configuration that proves the
port before any new code exists.

**Phase 2 — `AF_HYPERV` listener.** The host side of the guest's `AF_VSOCK`
link. `win-compat.h` already carries the address type and the ServiceId
derivation (Hyper-V substitutes the port into the first field of the VSOCK
template GUID, so guest vsock port 9500 arrives at
`0000251c-facb-11e6-bd58-64006a7986d3`). This one needs a small, reviewable
addition to `accept_loop`'s caller — a listener, not a rule change.

## Build

From an *x64 Native Tools Command Prompt for VS 2022*, with the CUDA Toolkit on
`PATH`:

```
cd windows\worker-win
nmake /f Makefile.win
```

## Status: UNCOMPILED

This has never been built. It was written by reading `worker.cu`'s POSIX surface
(11 distinct calls) on a Linux machine with no Windows toolchain available, so
treat the first `nmake` as the real design review. Expect to iterate on:

- MSVC vs `std::` ambiguities that clang accepts (`NOMINMAX` is set, which
  handles the usual `min`/`max` collision);
- whether `pollfd`/`POLLIN` come through `<winsock2.h>` on the SDK in use;
- `ssize_t` and `socklen_t` collisions with the CUDA headers.

## What must be true before it is used

Do not ship a Windows worker that has not passed the same four assertions the
CVM's boot probe makes — `exact`, `verified`, `lie_rejected`, `denylist_refused`
— against the bytes that actually crossed. `shieldedCapacity()` treats a partial
pass as no pass, and it is right to. In particular assert that the **Windows**
binary refuses a denylisted op on the wire: that is the assertion which
distinguishes a shielded card from an ordinary one.

`shielded/worker-cuda/test_reservation.py` drives HELLO 1.3 against a scratch
worker and should be run against the Windows build too.
