# Custody v2 owner read: the policy owner reads and edits its own secrets

**Status: source only.** New custodian code means a new measurement. It needs the committee's `code-approve` before any
custodian serves it; an image built before this change (for example candidate `ee8beb38`) does not have it.

## What it is

The deployment's policy owner can ask the committee for its own values, from any client: the CLI
(`enclave --independent … secrets ls|set|rm|clear`) or the browser (`custody/v2/owner-secrets.mjs`). The same DLEQ-proved
partials a guest receives are sealed to an **ephemeral** key the client generates for that one read. Neither the host
operator, the relay nor Enclave is a recipient or an authorizer.

## The opt-in: per policy, explicit, default off

- Rules (SNP `custody/rules.mjs` or Shield `custody/v2/shield-rules.mjs`) may carry `"ownerRead": true`.
  - Missing means false. Every policy written before this change stays exactly as it was, and its rule bytes are
    unchanged.
  - Any other unknown key is still refused.
- `enclave --independent … custody set … --owner-read on|off` writes the key explicitly. `custody status` shows it.

## The request

1. **A fresh challenge.** The client takes one challenge from every committee machine:
   `POST /v2/custody/owner-read/challenge`. It is a separate purpose from a guest release challenge. Each is single-use,
   lives 120 s, and is accepted only for its own purpose.
2. **One EIP-712 signature.** The owner signs `OwnerRead(id, policyRev, secretRev, committeeId, epoch, challengeRoot,
   recipientKey, expiry)` in the vault's domain (`EnclaveSecretVaultV2`, `1`, chain, vault). The expiry is at most 300 s
   ahead. The type is distinct from the vault's `Update`/`Claim`, so this signature is never a vault write.
3. **The request itself.** `POST /v2/custody/owner-read` goes to every machine that challenged:
   `{ v: 2, purpose: "enclave-custody-owner-read/1", id, committeeId, epoch, policyRev, secretRev, recipientKey,
   challenges, expiry, sig }`.

## What each custodian checks, at ONE fresh agreed block

The block comes from the same quorum and high-water marks as a release.

- **Challenge.** Its own owner-read challenge, consumed.
- **Policy state.** A policy exists. The revisions and the committee and epoch are the current ones. The bundle is
  present. This custodian holds shares.
- **Opt-in.** The policy's rules say `ownerRead: true`.
- **Not paused.**
- **Owner identity.** `beneficialOwnerOf(id) == policy.owner`, and the signature is that owner's. An EOA is checked by
  ecrecover (65 bytes, low-s, v 27/28 or the equivalent 0/1). A contract owner is checked by its ERC-1271 `isValidSignature`, at that block.
- **Label proof.** The bundle's label proof verifies.
- **Rate.** At most 30 reads per deployment per 10 minutes. Only reads the owner signed count, so a stranger cannot spend
  the owner's budget; the router's per-client limit bounds everyone else.

It answers with partials over `ownerReadBinding`, a distinct domain covering every signed field, HPKE-sealed to
`recipientKey`.

The domains are distinct in both directions:
- A guest release request is refused if it names a purpose.
- A guest release challenge cannot authorize an owner read, nor the reverse.
- Partials bound to one domain never verify, or open, as the other's.

## The pause guarantee

**Paused means nothing is released, to the owner either.** While paused, `secrets ls`, `rm` and a merging `set` are
refused, because each needs a read. `secrets set --replace`, `secrets clear`, `custody set` and `resume` still work,
because none of them needs a read.

## Ownership transfer

After the ledger moves the deployment, `beneficialOwnerOf ≠ policy.owner`, so every owner read is refused. The new owner
claims (`custody claim`), which destroys the bundle. A previous owner can never read values after a transfer, and a new
owner can never read the previous owner's values.

## Edits never lose a concurrent change

`secrets set KEY=…` (merge) and `secrets rm KEY` follow three steps:
1. Read at revision N.
2. Plan the edit.
3. Write a fresh bundle with `expectPolicyRev = N`. The bundle is encrypted to the committee key, under the same config
   commitment the values were bound to.

The vault's `StaleRevision` guard refuses the write if anyone wrote since; nothing changes and the client re-reads. Each
write is read back exactly through the quorum.

## What the owner's client must protect

- Values exist in plaintext only in the client's memory, and the ephemeral key is zeroed after use.
- Nothing is persisted. The CLI prints values only for `secrets ls --show`.
- A captured request, its signature and every sealed answer do not decrypt without the ephemeral private key.
- No key is derived from a signature.

## Threat note

A thief of the owner key could already change the rules to admit its own image (on chain, visible, and requiring a lease
holder to run it). With `ownerRead: true` it can also read silently. That is why the opt-in is per policy and off by
default. Owners who enable it should treat the owner key as able to read their secrets.
