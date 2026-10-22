# CLI feature parity without Enclave services: result

The full detail is in `work/claude-cli-fix-result.md`: exact files, commands, test assertions and the interruption fix.
User documentation is in `enclave/docs/network/independent-cli.md`.

## Implemented

`enclave --independent` takes its authorities from one of:
- `--profile FILE --profile-digest sha256:…`;
- `--contract-pins FILE [--usdc-token]`.

Its RPCs come from `--rpc A,B[,C]`, with `--quorum` (default 2), `--confirmations` and `--max-block-age`.

There is no Enclave API, no address book and no first-answer RPC. The first-answer clients `pub()` and `pubEach()`
throw in this mode, and `api()` refuses. A failed or disagreeing read is never shown as an empty answer.

**Read commands:**
- `ls` covers the wallet and its pinned-factory vault.
- `status` includes the runner's registry entry.
- `hosts` and `pricing` read the deployed schema-4 registry, and refuse caps, `registerRelay` and regions.
- `apps`, `whoami`, and `session inspect`/`status`.

**Ledger actions:** `deploy` (chain-only, with the ceiling taken from the cheapest live registry price), `fund`,
`stop`, `resume`, `rate-cap`, `refund`, `transfer`, `upgrade` and `resize`. Each one is:
- simulated at an agreed block;
- signed once and broadcast unchanged;
- confirmed by the quorum;
- reported as outcome-unknown and never resent when no RPC confirms accepting it.

**Owner management**, through the existing `ManagementClient`: `status --host`, `logs`, `restart`, `app-token` and
`cpu-profile`.
- The session's liveness, scope and holder are checked on chain before the host is contacted.
- The client pins the host's TLS key before any byte is written.
- A mutation whose answer is lost exits 4.

**Attestation.** `attest --native-profile` uses the native client's own SNP verification. `attest --host-report` is
labelled NOT VERIFIED and exits 3.

**Live read-only evidence (Base, reviewed profile `sha256:ee957827…`):**
- `hosts --all`: 11 registered hosts at block 52832508, 3 of 3 RPCs agreeing;
- `ls --owner 0x0b2d…`: block 52832514;
- `pricing`: cheapest live node $0.01/h, card $6.00/h.

**Tests:**
- `test/cli-independent.test.mjs`: 14/14 pass, 0 skipped.
- Hosted CLI suites: all 101 baseline tests pass. One file had a transient SIGSEGV in the combined run and passed 3/3
  when rerun alone.

The unfinished integrations are listed in `work/claude-cli-fix-result.md`.

---

## Update 2026-10-20: remaining refusals mapped; config, encvol and host chain actions made independent

**Feature map:** `work/cli-remaining-interface.txt`. It lists every remaining independent-mode refusal, with its exact
protocol dependency, a classification (supported now, needs protocol, hosted by nature, owned elsewhere) and the plan.

### Implemented (`cli/enclave.mjs` only)

**`config show|set|clear`.**
- **Authority:** the owner's `setConfig`, or a session's `deploy.setConfig` on a STAGING record its vault holds,
  through the quorum sender and session `prepareCall`.
- **Fleet checks:** the `/availability` fleet-flag checks are replaced by explicit statements that a host must support
  the namespace.
- **Oversized configs:** a config over 4096 bytes is replicated with the owner's own `--storage-plan`, wallet-signed
  per adapter and read back to at least `minimumCopies`, before its CID is referenced. Sessions refuse here because the
  upload is a wallet signature. `--storage-plan` is refused in hosted mode.
- **Invariants kept:**
  - the isolation tier is copied verbatim;
  - an owner-committed startup record accepts waf edits only (unchanged);
  - NEW: a Shield (`hyperv-partition-per-app`) record refuses any waf;
  - config is public on chain; nothing from secrets or custody is moved into it.

**`encvol`:** allowed. It is local only (a wallet signature and key derivation), with no network.

**`host`:**
- `declare-payout` and `clear-payout`: the deployed schema-4 `setPayoutWallet` and `clearPayoutWallet`, from the payout
  wallet itself;
- `fund`: an ETH transfer to the operator, through `sendQuorumTx`;
- `status`: the agreed registry entry for the endpoint plus the operator's gas. The relay listing is not shown, because
  it is not a chain fact.
- `host init|build|install|run|check|referral` stay refused, with a pointer to `docs/network/direct-host-control.md`.

**Refusals:** each now names its exact dependency: `move`, `gpu`, `secrets`, `custody`, `account`, `login` and `logout`
(table `INDEPENDENT_REFUSALS`).

**Needs new host protocol (not claimed):**
- `move` needs management operations `release` (owner-signed, a mutation, forwarded to the supervisor's owner DELETE)
  and `claimHint` on the target;
- `gpu` needs a `gpu` management operation;
- `availability` needs signed capacity records in the directories, or a capacity management operation.

**Owned elsewhere or hosted by nature:** `secrets` (custody v2 owns the independent path), `custody` (`cli/custody.mjs`
still uses first-answer clients and relay hooks), `account`/`login`/`logout`, and `session resume-wait`/`top-up-link`.

### Verification (within the 250 MiB budget; no anvil)

- `node --check` passes on `cli/enclave.mjs` and `test/cli-independent-sessions.test.mjs`.
- **Source-CLI smoke** (network guard, dead loopback RPCs, 119 MiB peak):
  - precise refusals for `move`, `gpu`, `secrets`, `custody`, `account`, `host init` and `host run`;
  - `encvol message` works; `encvol derive --json` returns the fields `sig`, `password` and `salt` (values not printed);
  - `config set` with a key and `host status` reach the quorum and report it unavailable, not empty;
  - hosted-mode `config --storage-plan` is refused;
  - **0 non-loopback attempts** by the independent runs. The only guard entries in a mixed run came from the
    deliberately hosted-mode check's normal address-book read.
- **Staging bundle rebuilt:** `work/cli-staging/enclave.mjs`, 1950 KB, sha256
  `cc91b3adada055b94d68b1952a48eae360f67a1e497ea800530c3e452de8ca74`. Build peak 38 MiB.
  - Bundle smoke: `encvol`, the `move` and `host init` refusals, and `config set` reaching the quorum, all at about
    40 MiB, with 0 non-loopback attempts.
  - `cli/dist/enclave.mjs` is unchanged (`9db0f36a…`).

**Focused anvil tests added but not run** (they wait for a memory allocation) to `test/cli-independent-sessions.test.mjs`,
now 13 tests:
1. session config set/clear on the vault's staging record (3 broadcasts; clearing config keeps the waf);
2. wallet config: override plus waf; an oversized config refused without a plan and replicated with one (two or more
   adapters hold the CID); Shield waf and startup-config refusals with no send;
3. `encvol` local; `host declare-payout`/`status`/`fund`/`clear-payout` against the schema-4 registry; the host setup
   and `move`/`gpu`/`secrets`/`account` refusals.

**Exact next command** (when allocated about 600 MiB with 16 GiB free):
`node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent-sessions.test.mjs`. Then the same with
`ENCLAVE_CLI_ENTRY=$(realpath ../cli-staging/enclave.mjs)`, then `test/cli-independent.test.mjs`, then the hosted
suites (`test/cli.test.mjs` and the four `cli-*` files).
