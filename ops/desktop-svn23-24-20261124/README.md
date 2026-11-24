# KVM Box native desktop: SVN23 and SVN24 (record of 2026-11-24)

Main's earlier records end at SVN22 on the NucBox (`ops/stream-flow-20261115/README.md`,
`docs/operations/windows-release-2026.11.18.md`). Two later images have run there. This is the record of their source
and pins. It was written from the exports and from read-only observation of nucbox-k11-4; the sessions that activated
them wrote the scripts recorded here.

| | SVN23 | SVN24 |
|---|---|---|
| Signed image (`igvmSha256`) | `097affc33f87fc4603e273aee2ffc1e5571da9f2fd454222855ff1ac9e6bfede` | `a5a8c9fcb54dd937c2ba51666206b336d496adc4d4f708995a0fff0edb1b4e79` |
| Launch measurement | `725f0e12da503b1a5be84df54f833621adb7bb8f8576454282c2e7fa520721e6` | `b228281e5a4eb03bd24b65689eff8491b2736754952ce6ec42e6f60793dd712c` |
| Profile | `38ccf65dc0aef83b66ee9815e067b061eb6073f04525b7446b9bf81f4f2e45e2` | `629e87f8c1dcfc2e1a96cf25be261e184ef77a6e469bb709f02e9eabbc183046` |
| Runtime identity | `f548e338e4e41bb1326693688c7b0067c9f330a24f4a21a61037bd334449c74f` | the same |
| Controller | `e05247f88eb521d48507ff49bb88d16b5bba2df75fb2794b2082382ae7506630`, CID `bafybeig564vcjghux3gnfgzpcdddtxl6mlvrzelmhe7qnapi7ejnsmpoxa` | the same |
| Platform source | `3ee89bc16` = `kvm-box/purchased-shares-20261120` | the same |
| App source (enclave-apps) | `4c48c9076` | the same |
| Change | guest contract and worker lease take the purchased GPU share (as main `f56ff8912`); new root and profile (direct route) | one root file, `usr/local/bin/xdoom` (sound lag) |
| Export, outside the repository | `native-platform-v20-direct-route` | `native-platform-v21-doom-audio` |

Release record schema for both: `enclave-desktop-release/2` (main `b602b569a`), policy `cpuPercent` 400, `vcpus` 4.

## Source

The platform source of SVN18 to SVN24 is not on main's history. It is the line
`codex/native-masked-desktop-20261024` .. `82ea9c16f` (SVN18 to SVN21) .. `3b0679ad8` =
`kvm-box/stream-flow-20261115` (SVN22) .. `3ee89bc16` = `kvm-box/purchased-shares-20261120` (SVN23, SVN24). Both
`kvm-box/*` branches were pushed to origin on 2026-11-24; before that the last seven commits existed in one local
repository only. The branch is not to be merged (`ops/branch-triage-20261124/`): its content is on main by replay,
and the GPU-share change is main `f56ff8912`.

## Activation scripts

Beside the earlier releases', in `ops/unified-funding-20261028/funding-reactivation-20261111/queued-apps-20261113/`:
`desktop-svn23-prepare.mjs`, `desktop-svn23.sh`, `desktop-svn23.ps1`, `desktop-svn23-sign-lease-gas-reserve.sh`,
`desktop-svn24-prepare.mjs`, `desktop-svn24.sh`, `desktop-svn24.ps1`. They are copies of the files that were run
from `native-direct-image-v20/activation` and `native-audio-image-v21/activation`, and still name those paths. No key
material is in them; the image signing key stays outside the repository.

## What was observed

- 2026-11-20: host bundle 2026.11.20 installed on nucbox-k11-4 (`install-status.json`, 20:49:03Z), built from main
  `b602b569a`. SVN23 release folder staged 20:37Z. Deployment `0xf9bb979a` (`kvm-box:0.9.2`, 100 milli GPU, 170 milli
  CPU) was running on SVN23 on 2026-11-24 07:13Z.
- 2026-11-24: the box's local hook pointed at the SVN24 folder from about 07:26Z; the manager reported SVN24 ready and
  `0xf9bb979a` was adopted on it at 07:52Z.
- Not observed here: the relay's installed code and policy (inferred from the desktop running), and a login to the
  desktop. An SVN25 (Shield overlay 0.6.12 on SVN24) was announced on 2026-11-24 by another session; its record is
  that session's.

## Still open

- `network/host-services/packages/route-dns.mjs` and `metal/guest/platform-api.bundle.mjs` on main are built files
  that carry the `/1` release validator and the 500 milli GPU bound until they are rebuilt.
- The unsigned image `6190aac78d91…` (work folder `native-shares-image-v19`) was a first SVN23 candidate from the same
  source. It was never signed or installed.
