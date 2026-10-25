# Custody v2 from the independent CLI

`enclave --independent … custody …` manages a deployment's custody v2 secrets with no Enclave service in the path. The
implementation is `cli/custody-independent.mjs`; it is wired in by `cli/enclave.mjs` (see `work/custody-cli-interface.txt`).

- **Reads.** Every read is one value agreed by a majority quorum of your own `--rpc` endpoints, at one confirmed block
  (`custody/v2/chain.mjs`).
- **Writes.** Every write is signed once on your machine, broadcast to every RPC, and confirmed by quorum.
- **Readback.** Every write is then read back exactly: the policy and bundle bytes, at or after the receipt block.

```
enclave --independent --profile P --profile-digest sha256:… --rpc https://a,https://b,https://c custody status <id>
… custody set <id> KEY=VALUE… [--file .env] --rules rules.json --committee 0x… [--config-file app-config.json | --no-config]
… custody migrate <id> --from export.json|export.enc [--passphrase-file F] (same policy options)
… custody pause <id> | resume <id> | clear <id> --yes | claim <id>
… custody seal-export --id <id> --in .env --out export.enc --passphrase-file F
```

## What it trusts, and what it refuses

- **The vault** is the reviewed pin (`secretVaultV2`).
  - With a reviewed profile, its code hash and every immutable binding are checked on chain.
  - With `--contract-pins`, its ledger, registry and session factory must be the pinned ones, and `status` reports
    `codeReviewed: false`.
- **The committee** is the one you name with `--committee` the first time; after that, it is the policy's own. There is no
  platform default.
  - A committee with an Enclave-operated seat is refused unless you pass `--allow-enclave-seat`.
  - The seat layout and threshold are printed before encrypting.
- **The rules** are your file: SEV-SNP custody rules, or Enclave Shield rules (`enclave-custody-shield-rules/1`, with its
  explicit `acceptTier` acknowledgement).
  - Each kind is parsed by its own validator, and neither stands in for the other.
  - `pause`, `resume`, and a `set` without `--rules` re-write the policy's existing rule bytes verbatim. A tier is never
    relabelled.
  - There is no relay prediction (`--rules-from-relay` is refused) and no lowered default.
- **The owner** is the vault's own rule, checked before anything is signed:
  - the policy owner;
  - for a first write, the ledger's beneficial owner;
  - after a ledger transfer, only `claim` by the new owner, which destroys the old bundle.
- **Values** are never printed.
  - `set` and `migrate` replace the whole set: custody cannot read values back.
  - `clear --yes` destroys the bundle.

## Gas: `--payer-key FILE`

- You sign the vault's EIP-712 update (`updateBySig` or `claimPolicyBySig`, valid for 600 s from the agreed block time).
- The wallet in `FILE`, a private 0600 file that is not your key, only submits it and pays the gas.
- The policy stays yours. Your wallet needs no ETH.

## Migrating relay-held secrets

1. **Export the hosted copy.** Run the hosted CLI (not `--independent`):
   `enclave secrets ls <id> --show --json > values.json`. This is the explicit legacy step. Seal the file
   (`custody seal-export`) or keep it private.
2. **Migrate.** Run `enclave --independent … custody migrate <id> --from values.json` (or the sealed file with
   `--passphrase-file`). A sealed export is bound to its deployment id.
3. **Clean up.** After a fresh start confirms the app has its values, clear the relay copy with the hosted
   `enclave secrets clear <id>`, and rotate each credential at its issuer. The relay operator could read them.

## Listing, showing and editing single values

`enclave --independent … secrets ls <id> [--show] | set <id> KEY=VALUE… [--replace] | rm <id> KEY… | clear <id> --yes`.

- It works for policies whose rules say `ownerRead: true` (`custody set … --owner-read on`), through the committee's owner
  read. The design and checks are in `docs/security/custody-owner-read.md`.
- A merging `set` and `rm` are guarded by the exact revision they read, so a concurrent edit is refused, never lost.
- It needs custodians running code that serves the owner read: a new measurement, approved by the committee.
