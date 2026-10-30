# Platform host policy (admin host bans without a server or a new contract)

The platform administrator decides which hosts may serve Enclave traffic. Before Nan's
retirement, the Nan relay enforced this with `TRUSTED_OPERATORS`, tunnel tokens and an
attested-measurement allowlist. This document defines the same authority so that it works
without that relay. It is a **service-refusal** mechanism. The deployed ledger has no
per-host admin ban, so a banned host can still claim a lease on chain. Enforcement points
then refuse it routes, discovery listing, tunnel attach, custody secrets and management
traffic, and a measured guest on that host stops serving.

## Authority and anchor

- **Signer.** The signer is `EnclaveAddressBook.owner()` (Base `0xab214342…`), read at an
  agreeing fresh block.
  - An EOA owner signs EIP-712: domain `EnclavePlatformHostPolicy` v1, chain 8453,
    verifyingContract set to the book.
  - A contract owner answers ERC-1271 at that block.
- **Owner rotation.** The book's existing two-step owner handoff rotates the key. Documents
  signed by a former owner stop verifying.
- **Anchor.** The full 32-byte EIP-712 digest is stored in two existing address-valued book
  keys, written together with the existing owner-only `setMany`:
  - `hostPolicyDigestHi` = `0x00000000 ‖ digest[0..16)`
  - `hostPolicyDigestLo` = `0x00000000 ‖ digest[16..32)`
- **Reading the anchor.** Both values are read in one agreed snapshot.
  - Both zero means unanchored. Enforcing gates refuse unanchored operation.
  - Exactly one zero, or bad padding, is a torn or malformed anchor and is refused.
  - A non-zero anchor admits exactly one document. A mirror therefore cannot give a cold
    client a withheld older, still-signed policy.
- **Unsigned transaction.** `network/platform-host-policy.mjs` `anchorTransaction(book, digest)`
  produces the unsigned `setMany` transaction for review. Nothing in this repository signs
  or sends it.

## Document

`enclave-platform-host-policy/v1` is canonical JSON with these fields:

- `book`, `registry`, `hostOwnership` (bindings);
- `sequence`, `issuedAt`, `expiresAt` (at most 30 days after `issuedAt`);
- `maxStaleSec` (at most 14 days);
- `previousDigest`;
- `mode`: `denylist` or `allowlist`;
- `deny[{kind, value, reason}]` and `admit[{kind, value}]`.

Each entry's `kind` is one of `registryId`, `operator`, `owner`, `chipId` or `endpoint`:

- `owner` means the **accepted** host wallet on the host-ownership extension, read at the
  agreed block, never a value the host reports about itself.
- `chipId` is `0x` + lowercase hex sha256 of the 64-byte SEV-SNP report CHIP_ID: the EnclaveSecretVaultV2
  `Machine.chipId`. No chain read carries a chip. An entry is matched only where an enforcement point supplies a
  chip that a VCEK-verified report proved:
  - custody v2 machines (the vault record, checked against the member's verified quote);
  - native control routes (`network/native-control-routes.mjs`, from `verifyMeasuredControl`'s verified report).
  Where a native control host's chip is not proven, a `chipId` denial refuses instead of admitting. Other enforcement
  points that judge only registry facts do not see chip entries.
- Denials always win.
- Expiry never lifts a ban. A stale policy refuses NEW hosts.

### Expiry modes

- `expiresAt: 0`, with `maxStaleSec: 0`, is the **anchored non-expiring** mode and the
  default for admission policies.
  - It stays valid exactly while its full digest is the anchor in a fresh, majority-agreed
    book snapshot. The anchor supplies revocation and version freshness, so the admin signs
    and anchors only when the policy actually changes, never on a renewal schedule.
  - It is refused whenever it is not the current anchor.
  - Stale chain snapshots are still refused by the quorum reader (120 s).
- `expiresAt > 0` is an intentionally **time-limited** policy.
  - It expires even while anchored.
  - It is the only kind an explicitly unanchored, offline gate may use. A signed-only TTL
    policy cannot prove the latest revocation to a new client, which is why enforcing gates
    require the anchor.

## Distribution and state

- **Mirrors.** Mirrors are any HTTPS origins serving `<digest>.json` as `{document, signature}`.
  They are untrusted transport, and one reachable honest mirror is enough.
- **Persisted state.** Nodes persist the last accepted document. A tampered record is
  discarded and reported. The book cannot roll a node back below its persisted sequence, and
  equivocation (the same sequence with a different digest) is refused.

## Enforcement points

Wired in the candidate:

- custody release (`custody/v2/custodian.mjs`);
- custody admission and handover (`custody/v2/member.mjs`);
- route verification (`network/route-record.mjs`);
- discovery candidates (`network/service-index.mjs applyHostPolicy`);
- the measured host gate (`network/host-policy-adapters.mjs measuredHostGate`).

Provided as integration hunks:

- relay discovery, dial and tunnel attach;
- the measured-control config.

Provided as call-site adapters (`network/host-policy-runtime.mjs`): CLI, supervisor, Windows
host, browser and management client.

Platform-wide enforcement is not live until every point is wired, deployed, and the admin
has signed, mirrored and anchored a reviewed policy.
