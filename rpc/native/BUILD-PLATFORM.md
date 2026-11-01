# Native RPC platform assembly

`isolation/m3/build-rpc.py --spec SPEC --out NEW_DIRECTORY` assembles the
candidate RPC initramfs and two optical client-root containers. Run it in an
independently bounded, admitted offline build unit. It never loads a module,
boots a guest, attaches writable blockchain state or publishes an app.

The exact `enclave-native-rpc-build/1` input object contains:

- `kernel`: pinned `boot` and `elf` files plus the fixed kernel release.
- `controller`: the pinned WASI component, used only for the profile identity.
- `root`: pinned `descriptor`, `image` and `hash` files from the existing client
  root build. Its image is exactly 1 GiB; the verity tree is 8,458,240 bytes.
- `runtime`: the six fixed Wasmtime 49.0.3 runtime files and identity record.
- `storage`: the fixed dmsetup/veritysetup/loader and reviewed library pins.
- `nbd`: the pinned amd64 NBD module for the same kernel release and symbols.

Each file pin is `{ "path": "/absolute/input", "sha256": "..." }`. The builder
checks geometry, digests, component/ELF shapes, dependency closure, NBD identity
and vermagic before compiling. It materializes the identical storage loader at
`/usr/lib/ld-linux-x86-64.so.2`, required by the pinned libc. No symlinks, caller
commands, secret inputs or alternate runtime selectors are accepted.

Current maintained RPC entry, monitor and front are compiled offline with the
RPC build tags, followed by the two C boot stages. The actual entry and maintained
chain wrapper hashes become the canonical profile/2. The source inventory includes
the monitor's amd64 assembly and the front's embedded CA inputs. The controller
itself is not embedded: it remains an app payload supplied through authenticated
LOAD. The root image's old wrapper is not a fallback.

`rpc.cpio.gz` is deterministic root-owned newc with regular files/directories,
fixed modes and no device or symlink entries. `image.container` and
`hash.container` prepend 64 KiB of zero bytes to the existing read-only client
root and verity tree. These are **not blockchain databases**. Database volumes
remain separate and require authenticated, exclusive attachment.

The fixed kernel builds NBD as a module. RPC boot loads only the measured module
with two devices and no partition minors, after rejecting unexpected existing
block devices and mounting the verified client root. It passes no force or
ignore-version flag and checks the module parameters, both device numbers and
both zero sizes. This prepares devices only; it does not connect a socket or
open a writable state filesystem. Actual target module loading remains a boot
qualification requirement.

Outputs are exclusive, retained on failure and never overwritten. `build.json`
records the input/source/tool/command pins, full archive inventory and container
hashes. It explicitly reports `platformAccepted`, `brokerProvisioned`, `rpcReady`
and `deployed` as false. Tool version strings are provenance, not a hermetic
compiler attestation. A caller must retain its independent whole-build deadline;
the compiler phase has its own fixed 120-second budget.

The resulting image still needs accepted bootstrap and guest identity,
authenticated broker/client-key provisioning, real storage-owner authorization
and writer settlement, target lifecycle/resource qualification, actual volume
attachment, client startup, sync/finality and serving adoption. A successful
archive build or inert version command proves none of those outcomes. The
original startup deadline is not extended by image assembly or guest boot.

## OpenHCL firmware packaging

The initramfs above is not an IGVM firmware image. The native Windows definition
requires both a firmware image and separately qualified initial VMGS. Use the
maintained `isolation/m3/build-rpc-igvm.py --spec SPEC --out NEW_DIRECTORY` for
offline firmware packaging, under an independently bounded admitted build unit.
This command does not create VMGS, register a VM, accept an image or change a
verifier policy.

Its `enclave-rpc-igvm-build/1` object has exactly `schema` and `inputs`. Each
input is an absolute `path` plus `sha256`. Required names are `igvmfilegen`,
`manifest`, `openhcl_boot`, `underhill_kernel`, `underhill_initrd`,
`linux_kernel`, `linux_initrd`, `profile` and `guestReceipt`.
The first five are fixed reviewed pins in the maintained builder. In particular,
the paravisor must contain the guest-only volatile report-input patch; the old
stock persistent-NV image is refused. The fixed manifest selects non-debug
VBS/VTL2 with static Linux-direct command lines; callers cannot add flags.
The current profile and guest receipt bind the supplied kernel and initramfs.

The builder streams pinned inputs into an exclusive private directory, records
an intent, invokes the pinned tool once with a 60-second limit and preserves
partial outputs on failure. It checks the output's bounded IGVM header and VBS
platform structure, sidecar shape and input stability before publishing its
receipt. The sidecar digest is compiler-generated, not independently recomputed
or measured on hardware. No acceptance or boot claim follows from packaging.

Historical `rpc-igvm-package-r1` passed three refusal/structural tests but
failed at the 512 MiB cap before writing firmware. Its partial sidecars remain
failed-attempt evidence. The maintained IGVM serializer patch subsequently
removed two unnecessary payload copies; 82 affected library tests passed.
The rebuilt tool reproduces archived firmware byte for byte. The packager now
pins tool `9375a04e` and independently checks streamed IGVM header CRC.

Actual `rpc-igvm-package-r2` successfully assembled the current guest firmware:
91,301,340 bytes, SHA-256
`1f5e0e7993783c52549278b4030c1e4b10755fc3ee5fc77be4c4b7412fff5386`,
VBS sidecar digest
`774c8e088104520aa51067e4eafb120c82f7b6b4c64d48cecd4f8c657cebcd86`.
The complete packaging/readback took 5.08 seconds and peaked at 342 MiB aggregate
RSS within the original 512 MiB cap. The separate tool compiler used the explicit
1.5 GiB exception; production and packaging limits were unchanged. Evidence is
in `ops/rpc-igvm-serializer-r1`. This is a complete offline firmware artifact,
not an accepted platform or hardware measurement. VMGS and actual target boot
remain unqualified; no production readiness follows from this successful build.


## RPC boot supervisor

The RPC-specific `dominit` now retains the original guest PID1 as a small C
supervisor. After the fixed kernel/UID check, it creates an absolute monotonic
900-second kernel-boot timer and forks a gated preparation worker **before mounts,
TPM setup, native tools or monitor initialization**. The worker installs its
parent-death signal and acknowledges that gate; PID1 captures its exact pidfd,
caps its own address space at32MiB and core dumps at0, checks timer/process
liveness, then releases the worker once. The worker performs existing boot steps
and execs the monitor without changing that process identity or clock.

PID1 never performs storage work, network calls, credential parsing or Go
callbacks. It polls only its kernel timer and child pidfd. Deadline, child exit
or handshake failure requests guest poweroff immediately, without a potentially
blocking console write, sync or child wait. No restart or serving adoption is
implemented. Killing namespace PID1 also kills descendants; the monitor worker's
parent-death signal is installed before release. Ordinary and desktop images
retain their original topology.

This is an independent **guest process**, not an independent kernel or hardware
watchdog. Kernel stalls, failed poweroff, pre-guardian initialization and host
preparation still require the independently owned host deadline. The32MiB limit
is a post-fork address-space limit, not evidence of earlier allocation peaks or
whole-stack fit; admission must count supervisor/worker startup overheads. It
neither fences the remote storage writer nor releases its reservation. Real target
boot/poweroff and accepted measured image remain required. The current
`rpc-full-image-current-r1` initramfs includes this source integration, but has
been packaged successfully as the firmware above, but has not booted on the target.
