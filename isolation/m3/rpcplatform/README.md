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
source-level format change has not produced or admitted a new actual platform.
