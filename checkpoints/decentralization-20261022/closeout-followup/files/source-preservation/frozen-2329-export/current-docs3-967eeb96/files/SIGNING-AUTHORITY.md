# Custody v2: who signs what (as of 2026-10-23T22:10Z; refreshed 22:20Z, 22:47Z, 22:58Z and 23:27Z)

The agents in this table are:
- **admin**: the Enclave admin wallet `0x0b2d009c0c9Af05b12100D77F3c815fea822eE61`. It is the book owner and the vault `enclaveOwner`,
  and it is held by the human.
- **operator**: metal0's registry operator `0xc9d0835c…e6ab`, root's host key.
- **TEE identity**: a custodian machine's key, generated and sealed inside its SNP guest.
- **submitter**: any funded EOA. It can drop transactions, but never forge them.

| action | must sign | pays gas | status (23:25Z) |
|---|---|---|---|
| `book.set("secretVaultV2", 0xE486…)` | admin | admin | unsigned plan; deliberately held |
| `book.set("sessionVaultFactory", 0x1f5c887c…)` | admin (MetaMask handoff on localhost:39672) | admin | **pending the human** (22:45Z: no chain write) |
| metal0 enrollment TX1 `proposeOwner(metal0, 0x0b2d…)` | operator | operator | **blocked**: balance 376,132,087,579 wei, below the 1.038e12 wei bound; no funding workaround |
| metal0 enrollment TX2 `acceptOwner(metal0)` | admin | admin | after TX1 |
| `proposeCode` / `removeCode` on the original `0x4774` | the current machine `0xF0F8…` over `codeDigest` | submitter | **IMPOSSIBLE**: the running image has no code-signing route; the committee is permanently code-frozen |
| new committee host binding | operator (off-chain `hostDigest`) | none | not started |
| new committee `createCommittee` | the new machine's TEE identity (genesis digest) | submitter (at most about 6.5e12 wei) | not started; needs enrollment and an HTTPS origin |
| `proposeCode` / `removeCode` on a corrected committee | **admin** code permit (≤ 30 d, EIP-191 over `codePermitDigest`, valid only while admin is the host's ACCEPTED owner), then the machine's TEE identity over `codeDigest` | submitter (about 1.2e12 wei) | n/a until the committee exists; then 7 days to `activeAt` |
| handover (propose, deal, ack) | current machines' TEE identities, then new machines' acks | the host submitter | n/a |
| policy `update` / pause / switch committee | the policy owner: an EOA directly, or its SessionVault's beneficial EOA once the factory is set | the owner | the known canary owner is EOA `0x2947…` |
| owner-authorized rewrap | the policy owner (rules update, EIP-712 Rewrap ≤ 3 d, switch update) | the owner | proven on anvil with synthetic attestation only |
| relay copy delete | the owner (signed relay request) | none | per owner |
| metal0 control image admission and activation (`ee5df6b8`, H `08d1f838`) | root (relay allowlist and control) | the operator, for boot registration | **PROVISIONAL**: the ee5 activation failed at 21:32 and was rolled back at 21:37. `08d1` was admitted (allowlist 37) at 22:10 but NOT activated. The cutover was stopped before mutation (GPU-price race). The new candidate `7dd3acd` (`b007d471…`) was built twice at 22:29, staged at 22:49 and admitted (allowlist 38) at 22:50. It is NOT activated; its activation kit is under review. At 22:52 the old `ed918e4b` re-attached (no restart), still unregistered. At 22:55:45 root's funding check refused it: the `setProofKey` fee of 303,866,570,907 wei leaves no 25% headroom on 376,132,087,579 wei. **At 23:10 root activated `b007d471`.** Boot self-registration failed with "total cost … exceeds the balance", no app was adopted, and root rolled back at 23:15:29 to `ed918e4b` (unregistered). The actual fee is NOT measured. The explicit-fee sender fix `9b82acc8` is source-only and not built. |
| app lease renewals (imagegen, EyesOff) | root (protected renewal) | the app reserve | **PROVISIONAL**: paid at 21:43:18, 21:52:36, 22:10:58, 22:39:27 (imagegen) and 22:43:54 (EyesOff). Each adds about 30 min; root maintains them. |
| canary app upload message + catalog publish (0-ETH tx) | admin (MetaMask handoff on localhost:39675) | admin | **awaiting the human** (22:56Z: no confirmation) |
| canary owner top-up, 0.0001 ETH to Base EOA `0x29479Bf…647C` | the human (their wallet) | the human | **requested**; the target was verified at 22:47:45 (code `0x`, balance 61,654,449,641,751 wei); no human confirmation yet |
| site r2 delivery (fronts) | root | none | not delivered |
| IPNS `setConfig` `/ipfs/<CID>` | the publisher deployment owner | the owner | blocked: the local publisher is at sequence 0, not durable |

**Admin rights are preserved throughout.** Nothing in this plan removes or bypasses an admin or business control, and no existing
contract is changed.
