# ROOT-LEDGER-REVIEW: every pin reconciled against root's live evidence and the deployed contracts

**What this is.** Source and records only: no chain write, key, SSH or production action. Live facts are root's
receipts, not today's truth, and the driver re-reads them at one agreed block (`S0.chain`, `S0.clipins`) before anything
spends.

**Evidence used:**
- `work/existing-custody-audit/evidence/live-custody.json`, block 52849851;
- `work/custody-v2-live-20261023/evidence/known-state.json`, block 52994819 (2026-10-23T18:10Z);
- `work/enclave` `contracts/deployments/network-profile-base.json` (sha256 `ee957827…`, clean) and
  `source-verification-base.json`;
- `work/lease-gas-wallet-signing/trust.mjs`;
- `work/lease-release-packaging/src/test/fixtures/ledger-rev16d-source/EnclaveDeployments.sol` (sha256 `2771a524…` = the
  verified rev16d source of `4b7419bb0`).

## 1. Pin table

| contract | canary pin | live evidence | reviewed code hash | CLI baked default | other pin files | verdict |
|---|---|---|---|---|---|---|
| original vault v2 | `0xe48699b8…eef5` | code `0x4b949b37…`, `book()` = `0xab214342…` (live-custody) | `0x4b949b37…` (live) | — | tracked `contract-pins-base.json` and the reviewed **network profile**: `0x56b81b39…` = the MODIFIED vault (code `0xb27f04b1…`). Untracked `contract-pins-production-base.json`: `0xe486…` | **pin `0xe486`. Never pass the tracked pins file or the profile to the CLI for the canary** |
| address book | `0xab214342…0907` | owner `0x0b2d…`; entries below (both blocks) | not in the profile | `0xab214342…` | — | ok |
| **deployments (ledger)** | **`0xb1783b61…117b`** | book `deployments` = `0xB1783B61…` (both blocks); immutables of proofOfTime/verificationFees/connectivity = this ledger | `0x71d50076…` (rev16d, full match with `4b7419bb0`) | **`0xF9e71385…` (RETIRED)** | all three pin files: `0xb1783b61` | **The PREFLIGHT pin was wrong (it used the CLI default); corrected** |
| registry | `0x868eb7fc…ccac` | book `registry` (both blocks) | `0x39911d6f…` | same | same | ok |
| appCatalog | `0x18419ca2…26e3` | not in the recorded book entries (read live by `S0.clipins`) | `0x3f3c4cc0…` | same | same | ok, re-read live |
| proofOfTime / enclavePay / verificationFees | `0x6f462d77…` / `0x580270e8…` / `0x87c72665…` | — | `0x6b2eff59…` / `0xf902e348…` / `0xf649e393…` | — | same | required by the CLI validator; code checked live |
| sessionVaultFactory | **`0x0` (disabled)** | book `sessionVaultFactory` = `0x0` (live-custody) | — | `0x1f5c887c…` (legacy) | tracked: `0xec9277a3…`; untracked production: `0x1f5c887c…` | **zero**, matching the book. Every session path refuses |
| USDC | (CLI default) `0x833589fc…2913` | — | `0xa6705a10…` | same | — | code checked live |
| lease-gas reserve / executor | `0x12a3f873…3639` / `0x8900baca…d343` | `work/lease-gas-wallet-signing/trust.mjs` PRODUCTION.ledger = `0xB1783B61…` ("ledger16d"); the lease-gas record's own `ledger` field is checked by the existing CLI against its reviewed record (root's `--lease-gas` file, not read here) | reserve `0xcc00efe9…`, executor `0xdd893cd4…` | — | — | ok, as far as these records show |

## 2. Deployed ABI vs CLI ABI (ledger rev16d)

The verified rev16d source exposes the following functions:
- `create(string appRef, uint16 gpuMilli, uint16 cpuMilli, uint32 appPort, string ports, bool isPublic, string configCid, address feeRecipient, uint256 feePerSec6, uint256 maxRate6) returns (bytes32)`;
- `fundWithAuthorization(bytes32, address, uint256, uint256, uint256, bytes32, bytes)`;
- `fundEth(bytes32) payable`;
- `setActive(bytes32, bool)`;
- `deploymentsSchema = 16`;
- `event Created(bytes32 indexed id, address indexed owner, string appRef, uint16 gpuMilli, uint16 cpuMilli, uint256 rate)`.

The CLI's ABI for schema ≥ 8 has exactly these argument lists. Its `DEP_CREATED_TOPIC` `0x3b201eb1…3239` equals
keccak256 of that event signature.

**There is no ABI discrepancy on rev16d.** The hazard is the ADDRESS, not the ABI. The retired ledger also answers
`create`, so a wrong-ledger create would succeed silently and produce a deployment the original vault can never see.

## 3. How the current CLI picks addresses (`work/enclave` e762a9c5; `cli/enclave.mjs` sha256 `f83cab27…`, uncommitted)

- **Default mode.**
  - `resolveAddressBook()` reads `book.all()` through ONE RPC with a 4 s timeout.
  - If that read fails, it **keeps the baked addresses**: ledger = the retired `0xF9e71385…`, with only a stderr
    warning. Catalog writes are refused, but **ledger and registry writes are not**.
  - Default mode is therefore unsafe for the canary.
- **`--contract-pins FILE`** (required by `--chain-only` and independent mode). It overwrites DEFAULTS and disables the
  book. In independent mode a reviewed `--profile` is cross-checked against `--contract-pins` (they must agree).
  - Nothing checks the pins against the book.
  - Without a profile, nothing checks the pinned code.
  - So any wrong pins file is used silently.
- **With the reviewed profile, the custody vault is wrong.** The reviewed profile's derived pins name secretVaultV2 =
  `0x56b81b39…`. Any CLI custody-v2 command run with the profile or the tracked pins file targets the modified vault.
  The canary does not run custody through the CLI: the driver pins `0xE486` itself.
- **Uncommitted / untracked state:**
  - `cli/enclave.mjs` has 1296 inserted lines vs HEAD, including a new `--ledger` default from
    `DEFAULTS.DEPLOYMENTS_ADDRESS`.
  - `contract-pins-production-base.json` is untracked: correct ledger and vault, but `sessionVaultFactory` `0x1f5c…`
    while the book names `0x0`.
  - The canary therefore uses its own committed pins file, and the driver rechecks it at run time.

## 4. Corrections

- **Canary pins file** (`cli-pins/canary-contract-pins.json`, sha256 `bbc47f6c…`, pinned in `pins.example.json`
  `cli.pinsSha256`). The ONLY pins file for the canary's CLI steps.
- **New read step `S0.clipins`.** It resolves the new prerequisite `cli.pins` from the pinned file bytes plus, at one
  agreed block on every RPC:
  - every address = the reviewed one, with the reviewed runtime code hash (USDC too);
  - the original vault's `book()` = `0xab21…`;
  - book `deployments`, `registry` and `sessionVaultFactory` (and `appCatalog` when named) = the pins;
  - no pin names the retired ledger or the modified vault.

  Every CLI spending step (create, lease-gas, stop) requires `cli.pins`, and its command string carries
  `--independent --contract-pins cli-pins/canary-contract-pins.json --max-fee-gwei 0.012 --signer-mode handoff`.
- **`record` for a CLI step** now fails unless:
  - `obs.cliPinsSha256` is that file's hash;
  - every mined transaction's `to` is the step's own contract: the pinned ledger, or for lease steps the reserve
    `0x12a3…`. This is after the fact, but it is detected before any later step.
- **Proposal for `work/enclave` (NOT applied; shared repo untouched): `proposals/cli-ledger-write-guard.patch`.** It
  refuses ledger and registry writes when the addresses came from a silent baked fallback, or name the retired ledger.
  `test/clipins.test.mjs` checks only that it applies to the reviewed `f83cab27…` bytes and parses. It is not a
  behaviour test of the full CLI.

**Unchanged:**
- **Not ready.** The recipient blocker remains, and the CLI steps still need root's manual review of each handoff
  transaction (`PREFLIGHT-CLI.md`).
- **Budget shortfall** and caps: unchanged.
- **Policy 0x4e62 and the old canary:** protected (the plan refuses them; `Z.final` re-reads 0x4e62).
