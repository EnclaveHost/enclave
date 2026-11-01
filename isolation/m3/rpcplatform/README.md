# Native RPC platform identity

This package defines the distinct `enclave-native-rpc-profile/2` canonical
descriptor for a V9 CPU RPC app. Its hash binds the portable controller,
namespace entry ELF, kernel boot/ELF digests and the fixed 1 GiB client root
image with its dm-verity tree, salt and root hash. The namespace entry lives
in the measured bootstrap; it is separately pinned from the client image.

`ParseProfile` requires canonical bytes and rejects unknown/duplicate fields,
trailing content, zero digests, different geometry and desktop profiles.
`CheckBundle` checks the V9 manifest/profile/controller relationship.
`CheckEntry` checks actual entry bytes against the declared ELF digest.
Neither method grants launch, secret, volume or payment authority.

`OpenInstalled()` uses only `/plat/native-rpc`: canonical read-only profile,
root-owned immutable `rpc-native-init`, and the executable ext4 `rootfs` mount.
It verifies the actual active read-only dm-verity table and filesystem mount
root, including device identity, geometry, salt and hash. Corruption-bypassing
options, inactive/suspended/writable mappings and bind-mounted subdirectories
are refused. The RPC root must permit execution; the desktop model volume's
`noexec` policy is not applicable. Returned root and entry descriptors must
stay held through namespace bind/clone; later pathname lookup is not equivalent.

The fixed installed namespace is supplied by the measured bootstrap. Root file
ownership and a matching kernel release alone do not authenticate that boot.
The caller must separately establish the accepted platform and app authority.

There is no accepted platform descriptor yet. The portable controller exists;
accepted monitor/boot/storage integration remains unfinished. Tests use explicit
synthetic wire fixtures. A hash-consistent attacker-selected descriptor is
not an attested or owner-accepted platform. The trusted monitor must derive
the app identity, authenticate the accepted kernel/bootstrap/root composition,
and enforce app-owned volume writer fencing before release.

Existing ordinary and desktop parsing/launch paths remain unchanged. This
package supplies no default platform, host paths, arbitrary command hooks,
external service proxy or legacy fallback.

Schema 2 adds `wrapperSha256`, the exact maintained chain wrapper overlaid from
immutable measured bootstrap at `/plat/native-rpc/chain_service.py`. The older
VM-only wrapper inside the unchanged client image is not a fallback. Root
composition and the supervisor both check this pin. Profile 1 is refused. This
source-level format change has not admitted a production platform.

## Guest boot stages

`../build-rpc-boot.py --profile PROFILE --out NEW_DIRECTORY` now compiles the
distinct `NATIVE_RPC` init and fixed `/plat/rpc-boot` helper. It accepts only the
canonical profile/2, creates output exclusively, retains partial output and
records source/profile/binary pins. These are boot **stages**, not a complete
initramfs, accepted platform or deployment. The build runs inside the caller's
independently bounded and capacity-admitted build unit.

The RPC branch of `native-boot.c` uses exactly two optical containers: the fixed
1 GiB client image and its separate 8,458,240-byte verity tree, each after the
existing 64 KiB container header. It rejects additional block devices, duplicate
roles and existing mapper names. It retains exact media descriptors, verifies
read-only linear and verity tables, mounts executable ext4 with `noload` at
`/plat/native-rpc/rootfs`, and seals `/plat` read-only. No desktop model media,
desktop namespace entry, input devices or desktop module are installed. The
RPC entry, profile and wrapper must already be part of the measured initramfs;
the monitor's existing `OpenInstalled` and composition checks verify them.

RPC init uses the strict native mounts, cgroup delegation and required guest
TPM checks, and rejects a simultaneous desktop build. It creates the sealed
ERPCONE4 clock after proc mounting with **origin zero in this kernel boot's
unshifted monotonic clock**. Thus kernel and guest preparation consume the
same 900 seconds. The clock remains close-on-exec during helper execution and
is inherited only as monitor FD3. Helper waits are capped by that same guest
deadline; re-entering a helper does not start another window.

The guest clock does not represent elapsed preparation on Warden or Windows.
Their independently owned original deadlines must remain armed, and the
earliest deadline wins. No clock frame, elapsed check, `sync`, blocking mount,
or wait/reap loop proves independent termination of a hung kernel operation.
These stages add no guest guardian, persistent serving adoption, storage
credential delivery, broker daemon, writer grant or remote attestation proof.

Qualification compiles the RPC stages and ordinary/desktop compatibility paths
and checks actual C memfd sealing, FD3 inheritance across exec and receipt by
the Go clock consumer. Profile inputs in those builds are explicitly synthetic.
No actual optical/mapper mounts, target guest boot or RPC serving is qualified.
The complete candidate assembler is now `../build-rpc.py`; see
[BUILD-PLATFORM.md](../../../rpc/native/BUILD-PLATFORM.md) for its pinned inputs,
NBD preparation and retained limitations. Authenticated broker/client-key
bootstrap, platform acceptance, target lifecycle admission and end-to-end client
readiness remain required.
