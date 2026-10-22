# Phone app lease-gas funding: a separate PUBLIC plan (nothing signed, simulated with anyone's balance, or sent)

## Why a separate plan

The approved enrollment is proposal `6e1b0bfb…`: 25 operations, all confirmed on 2026-10-21
(outputs/app-lease-gas-review/enrollment-confirmed.json). It funds the app-funded lease gas reserve (EnclaveLeaseGasReserve
`0x12a3f873041dec436daa0085b766a399a6fa3639`) for 11 apps: 9 Windows and 2 Linux. None of them is an app the phone
(pixel10-pvm-cpu) serves.

In independent mode the phone claims, renews and releases ONLY through that reserve. It has no operator-paid fallback (the
gas worker's `configuredLeaseSender`). So a phone-served app needs its own enrollment, approved by its own owner.

## What enrolling one phone-served app takes (the reserve's own rules, contracts/EnclaveLeaseGasReserve.sol)

| call | who | why |
|---|---|---|
| `deposit(id)` payable | anyone (the owner, or a sponsor) | credits the reserve of the app's CURRENT owner of record |
| `setClaimant(id, <phone operator>, true)` | the owner of record (a SessionVault owner: through its `ownerCall`) | the phone serves apps it does not own, so the policy is ALLOWLIST (`claimPolicy 2`), naming the phone's registered operator only |
| `configure(id, Policy)` | the owner of record (likewise) | the owner's caps |

The proposed caps are the approved enrollment's per-app policy unchanged, with claimPolicy 2 instead of 1 (self-hosted):

- `enabled true`, `sponsorRelease true`, `maxClaimsPerEpoch 4`;
- `maxPerOpWei 31092172031561`, `epochCapWei 310921720315610`;
- `epochSec 3600`, `renewWindow 300`, `minExtension 600`, `claimCooldown 1800`;
- `maxGasPrice 50000000` (0.05 gwei).

**No amount is proposed as approved.** The approved enrollment used 0.0001 ETH per app. That figure is shown for
comparison only and needs a NEW human approval for these apps.

## The exact calls (generated read-only)

`scripts/phone-funding-plan.mjs --endpoint <the phone's registered endpoint>` reads public state only, two RPCs agreeing at
one block: the address book, the registry row, every deployment page, the owner's code and the reserve's claimant flag. It
prints, for each deployment the phone's enclaveId holds:

- the owner;
- whether the owner is a contract (then `ownerCall`-wrapped);
- whether the phone's operator is already allowed;
- the three calls' exact calldata.

It never signs, never estimates with a balance, and reads no key or wallet file. The output of the run made for this work
is `artifacts/phone-funding-plan.json`, when present (see MANIFEST).

## The run made for this work (read-only, Base block 52885288, two RPCs agreeing)

`artifacts/phone-funding-plan.json` (sha256 `d1361859…`):

- **Phone.** Endpoint `https://api.enclave.host/t/pixel10-pvm-cpu`, enclaveId `0xc6a1c08a…5658`, operator
  `0x8179213e3054a29d26011403739a3ab94cdce84e`, active. Registered measurement `ff559327…`: the installed build's code
  hash.
- **Its one live lease.** Deployment `0xaf9fbf3ecb9adc6736aac19c4a1690db1f9dafe427d1b06985737943cde065ef`
  (`catalog://0x5356e8bd…16ed/4`), owned by the EOA `0x29479bf04ed889d46a7afb7f292b9bb26e12647c`. That is not the
  platform administrator, so only that owner can make the two owner calls. The phone's operator is not an allowed
  claimant yet.
- **Calls.** The selectors are the approved enrollment's own (`deposit` 0xb214faa5, `configure` 0x128a3849), plus
  `setClaimant` 0xaea1d0a2. Calldata is in the file.

Until this owner enrolls, an independent-mode phone cannot renew that lease app-funded, and it pays nothing itself. In
legacy (relay) mode the operator-paid path is unchanged.

## Not part of this plan

- Registration, the proof key, checkpoints and withdrawals stay operator-paid (gas worker design B).
- No contract, registry, ownership, binding or policy change.
- No new wallet, account or cloud spend.
