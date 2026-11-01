# Native RPC client root

This is the offline root assembly and filesystem build for the distinct
`ethereum-base-rpc-v1` CPU app. The fixed chain clients live **inside** this
root; they are not host processes or proxies to a third-party RPC provider.
The root contains code and public configuration only. Blockchain databases
remain separate app-owned persistent volumes.

`assemble_root.py plan` inventories a trusted build sysroot. It selects Python
3.11–3.14, the standard-library subset used by the chain wrapper, `findmnt`, a
public CA bundle and their transitive ELF dependencies. It parses ELF program
and dynamic tables without executing the input or using `ldd`. Every selected
file is individually hashed. Library candidates must agree on content;
missing libraries, RPATH/RUNPATH, filter libraries, escaped symlinks and
malformed ELF tables refuse the build.

This is not a general Python installation. Site packages, local customization,
tests, GUI support, pip bootstrap and SQLite are excluded. The wrapper has no
SQLite dependency. The host's SQLite library has a RUNPATH override, so it was
removed from the selected runtime instead of weakening the loader checks.
Dynamic `dlopen` behavior is not fully discoverable from DT_NEEDED; the
isolated runtime checks and eventual full client qualification remain needed.

The input RPC archive must match the reviewed 397,926,400-byte archive with
SHA-256 `3f0bb020ee6c8b67217c55b4bd0208dd1a6c83ed76df21dbfdf34c6daa718e6c`.
All archive entries and metadata are checked. The three client binaries and
maintained `chain_service.py` additionally have fixed content pins. Only the
clients, wrapper, manifest and public chain configuration are carried forward.
The old systemd units and filesystem UUID mapping are omitted.

`assemble` consumes the canonical plan, verifies each source while copying,
and produces deterministic `root.tar`, a full inventory and a receipt. All
tar members are ordinary files/directories with root ownership, fixed modes
and timestamp zero. There are no links, devices, setuid files, credentials,
JWT, state-volume mapping, chain state, host identity or service autostarts.
Fixed role accounts are UID/GID 2101 (EL), 2102 (CL), 2103 (Base), 2104 (probe).
Public CA bytes are installed at both the bundle and OpenSSL default paths.

The plan and every output are created exclusively and fsynced. Inputs are
bounded; copying and hashing stream data. Partial outputs remain for review.
No helper retries itself or overwrites a prior attempt.

```sh
python3 -I -B rpc/native/assemble_root.py plan \
  --sysroot /absolute/path/to/build-sysroot \
  --runtime-tar /absolute/path/to/reviewed/runtime.tar \
  --output /absolute/path/to/new-plan.json
python3 -I -B rpc/native/assemble_root.py assemble \
  --plan /absolute/path/to/new-plan.json \
  --output /absolute/path/to/new-root-directory
```

Use the reviewed build-host admission and bounded execution wrapper, not an
unbounded production shell. The sysroot is an operator-reviewed public build
input, not an app request. Its executable provenance is not authenticated just
because files were hashed. Neither planning nor assembly launches a process.
See [BUILD-IMAGE.md](BUILD-IMAGE.md) for the offline ext4/dm-verity step.

## Production integration still required

The `isolation/m3/cmd/rpc-native-init` entry invokes the Go runner. The candidate
[platform assembler](BUILD-PLATFORM.md) packages it in the measured bootstrap
with a separate executable pin, outside this client root. It has not been
launched by an accepted production monitor. The distinct
`isolation/m3/rpcplatform` descriptor binds that entry, controller, kernel and
this root descriptor; no complete accepted platform has been produced. The
monitor must authenticate that profile and bind the owner's two logical volume
IDs to exclusive writable attachments before any client can start. Per-role
write isolation, JWT provisioning, network policy and independent owner-death
termination are required at that boundary.

The portable controller and readiness-to-serving transition are also pending.
The runner still terminates at the original 900-second deadline. This build
does not authorize persistent service or extend that deadline. Ordinary and
desktop app parsers remain unchanged and refuse the RPC profile. No app
attestation, deployment, whole-stack fit, sync/finality or consumer cutover is
claimed by these artifacts. The catalog preview remains a separate placeholder.

## Actual qualification

Twenty-one bounded unit tests passed. A real root was assembled with 671 files
and 75 directories (440,739,840-byte tar). The 1 GiB ext4 image and 8,458,240-byte
verity tree passed `veritysetup verify`; all 671 file contents were read back
from the image and matched the inventory. In a separate read-only filesystem
and network namespace, Python 3.14.8 imported the required modules and loaded
122 CA roots, `findmnt` loaded, and the pinned clients returned Reth 2.8.0,
Lighthouse 8.3.2 and Base 1.5.1.

The first closure attempt rejected unused SQLite RUNPATH. The next build passed
image/readback/Python/findmnt checks but the version harness omitted `HOME`,
causing Reth's argument parser to panic. A separate bounded check supplied a
private `/tmp` HOME and reused the exact image for all three client versions;
it did not rebuild the image. The maintained chain wrapper already supplies
HOME explicitly. Failed attempts and frozen sources are preserved alongside
the successful evidence in `ops/unified-funding-20261028/rpc-native-root-*`.

These checks ran on the build host's kernel. They are not a target measured
kernel boot, a positive role-credential/namespace qualification, a node start,
an accepted app profile or a deployment. Client version commands use no chain
state and prove loading only. No blockchain synchronization was attempted.
