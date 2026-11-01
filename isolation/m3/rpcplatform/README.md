# Native RPC platform identity

This package defines the distinct `enclave-native-rpc-profile/1` canonical
descriptor for a V9 CPU RPC app. Its hash binds the portable controller,
namespace entry ELF, kernel boot/ELF digests and the fixed 1 GiB client root
image with its dm-verity tree, salt and root hash. The namespace entry lives
in the measured bootstrap; it is separately pinned from the client image.

`ParseProfile` requires canonical bytes and rejects unknown/duplicate fields,
trailing content, zero digests, different geometry and desktop profiles.
`CheckBundle` checks the V9 manifest/profile/controller relationship.
`CheckEntry` checks actual entry bytes against the declared ELF digest.
Neither method grants launch, secret, volume or payment authority.

There is no accepted platform descriptor yet: the real portable controller
and monitor/boot/storage integration remain unfinished. Tests use explicit
synthetic wire fixtures. A hash-consistent attacker-selected descriptor is
not an attested or owner-accepted platform. The trusted monitor must derive
the app identity, authenticate the accepted kernel/bootstrap/root composition,
and enforce app-owned volume writer fencing before release.

Existing ordinary and desktop parsing/launch paths remain unchanged. This
package supplies no default platform, host paths, arbitrary command hooks,
external service proxy or legacy fallback.
