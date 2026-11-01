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
