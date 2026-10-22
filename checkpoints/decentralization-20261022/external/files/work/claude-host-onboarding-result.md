# Independent host CLI onboarding: result

**Status:** implemented and tested as a standalone tool. Integration into
`cli/enclave.mjs` and `supervisor.js` is prepared as exact patches and **not
applied**, because those files belong to other workers.

**Interface:** `work/host-onboarding-interface.txt` was written first. The
implementation differs from it in one way: the plan stores one
`guestd.collateralDir` instead of separate `vcek`, `minTcb` and `chain` paths.
`host-collateral.mjs prepare` always writes `vcek.der`, `cert_chain.pem` and
`min-tcb.json` into one `--out` directory, so the three paths are derived from
it.

## What was built

`cli/host-independent-lifecycle.mjs` (607 lines). It works as a standalone
entry (`node cli/host-independent-lifecycle.mjs <cmd> --dir HOST_DIR`) and as an
exported `hostLifecycle(argv, {out, err, env, fetchImpl, now, chainFactory})`.

**init**
- Validates every explicit input:
  - profile against the digest you supply, or contract pins;
  - 2-8 distinct RPCs and a quorum, via the existing `validateRpcOrigins`;
  - an https endpoint, with `*.enclave.host` refused;
  - the release pin and replica origins (plain HTTP only for a literal IP);
  - the guest budget, price and payout;
  - the wallet-policy directory and origins, via `hostPolicyOrigins`;
  - the referral code.
- Writes `host-plan.json` (0600, no secrets), `contract-pins.json`,
  `operator.key` (viem `generatePrivateKey`, 0600) and `supervisor.secret`
  (32 random bytes, 0600). Only the operator address is printed.
- `--dry-run` writes nothing. An existing plan is refused; `--replace-plan`
  lists the changed fields and keeps the keys. A different pins file is never
  overwritten. A key file with loose permissions is refused.

**build**
- `release`: the real `fetchRuntime` from the plan's gateways, with the firmware
  pin and `release-manifest.py verify`.
- `guestd`: `go build -trimpath` from the operator's checkout.
- `pair-key`: only by running the real `guestd -gen-key`.
- `collateral`: needs SEV hardware, so the exact `sev-inventory` and
  `host-collateral.mjs inventory/prepare` commands are printed.
- Existing outputs are kept and checked. `--only` and `--dry-run` are
  supported.

**install**
- Prints by default, with secrets redacted.
- `--apply` writes two systemd user units and `supervisor.env` (0600). It
  refuses to replace a file with different content and writes nothing partial.
- `--enable` runs `systemctl --user`. `--unit-dir` picks another directory.
- The environment follows the documented direct-only setup. It is checked by
  `directOnlyEnvProblems`, which mirrors `supervisor.js directOnlyProblems` and
  is stricter in one respect: an *unset* service variable is refused, because
  unset means the Enclave default. With a reviewed profile and `--policy-dir`,
  it sets the wallet-policy pins from `profile.contracts.hostOwnership`.

**run**
- Starts `--component guestd|supervisor` in the foreground with exactly the
  unit's argv and environment. `--dry-run` prints them as shell-quoted,
  redacted text.

**check**
- Read-only. Rows are ready, missing, failed or unknown.
- Chain reads go through `QuorumChain`, `assertReviewedCode` and `readHost`
  (schema 4). A failed or disagreeing read is **unknown**; reviewed code that is
  absent is **failed**.
- The wallet policy is resolved through the host's own
  `readHostAdmissionPolicy` and `publicHostPolicyLoader`.
- guestd is probed through the authenticated `openGuestdTransport`. The
  supervisor's `/v1/health` must have the supervisor's shape; any other service
  on the port counts as failed.
- Exit codes: 0 ready, 3 not ready, 4 unknown, 1 bad input.

**referral**
- Optional; with no code it does nothing.
- Writes an operator-signed statement bound to chain, registry, host id,
  endpoint and code, and never replaces it with a different code.
- `--verify FILE` uses the verifier's own plan and quorum to check that the
  signer is the registered operator.
- There is no on-chain referral. `REFERRAL_ONCHAIN_MISSING` names the missing
  interface: `setReferral(bytes32 id, string code)` restricted to the operator,
  plus a `ReferralSet(bytes32 indexed id, address indexed operator, string code)`
  event and a reader. No contract was written.

**Unchanged:** `status`, `fund`, `declare-payout` and `clear-payout` are not
rewritten; the tool prints the existing `enclave --independent host …` command
where one of them is the next step.

Docs: `docs/network/independent-host-onboarding.md`.

## Tests: `test/cli-host-independent-lifecycle.test.mjs`

8 tests, serial, about 2 s, `--max-old-space-size=200`. **8/8 pass** in the real
tree; the final run was after the last source edit.

1. **Init refusals:** bad digest, one RPC, same-host RPCs, http RPC,
   `enclave.host` endpoint, http endpoint, bad release id, HTTP replica
   hostname, a `/ipfs` replica, zero CPUs, bad referral, non-loopback
   attestation URL, wallet policy with pins only. Each refused init writes
   nothing, and a dry run writes nothing.
2. **Keys:** modes 0700/0600; no secret in stdout, stderr or the plan; refusal
   to overwrite; `--replace-plan` keeps the key; a 0644 key is refused.
3. **Build:** the real `fetchRuntime` against a real HTTP replica fixture
   (6 files); idempotent; `check --deep` reports ready, then failed after a
   file is tampered; the printed collateral commands; pair-key refused without
   guestd; pair-key through a stand-in guestd that implements only the
   documented `-gen-key` contract, never regenerated.
4. **Install:** dry run redacted with no Enclave origin and nothing written;
   apply writes `supervisor.env` at 0600; re-apply is a no-op; a different unit
   is refused and `check` reports it as differing. Run dry-runs are redacted
   and quoted.
5. **Real `supervisor.js`:** it logs `[direct] direct-only host control` with
   the derived environment, and exits 2 with `SECRETS_API` unset, matching
   `directOnlyEnvProblems`.
6. **Chain rows** against two real JSON-RPC fixture servers, read through
   viem and `QuorumChain`:
   - registration: missing, then ready; then failed when the operator is
     changed;
   - proof key; payout (optional); gas;
   - wallet policy: no owner (missing), unresolvable document (failed),
     resolved (ready), tampered document (failed);
   - reviewed-code mismatch is failed;
   - RPC disagreement is unknown.
7. **Unreachable RPCs** are unknown and the check exits 3. An impostor
   service on the supervisor port is failed. Verdict codes 0, 4 and 3 are
   tested.
8. **Referral:**
   - with no code, nothing is written;
   - signing prints no secrets and prints the missing on-chain interface;
   - no replacement with a different code;
   - verification with a separate verifier plan: not registered gives 3,
     verified gives 0, a forged code gives 3, a changed operator gives 3.

**Mutation check** in a scratch tree that symlinked the shared source. 8 of 8
mutants were caught:
- a failed registration read reported as ready;
- the verdict ignoring unknown;
- the referral operator check skipped;
- install overwriting a different file;
- an unset service variable accepted;
- an unresolvable policy treated as ready;
- any HTTP 200 accepted as the supervisor;
- the secret not redacted in `run`.

**Not exercised:**
- An actual `go build` of guestd, avoided to keep load low. `go list` confirms
  `isolation/m4/guestd` is package `main`.
- `systemctl --enable`.
- Live guestd health. That probe uses the real `openGuestdTransport`; the tests
  only cover the no-key and no-listener paths.

## Integration patches: `work/host-onboarding-integration/` (not applied)

Each patch passed `patch -p1 --dry-run` against the current tree. Patches
01+02+03 were applied together in a scratch tree, and there the suite passed
8/8 and the CLI delegation was exercised.

- **01 `cli/enclave.mjs`:** `cmdHost` delegates
  init/build/install/run/check/referral under `--independent` to
  `hostLifecycle`, before `flags()` runs. `init` forwards the global
  profile/digest or pins file, and the RPCs, quorum, confirmations and maximum
  block age. Exit codes are passed through, and the refusal text is updated.
  Base sha256 `5c21db40…125d`.
- **02 `supervisor.js`:**
  - `BASE_RPCS` makes `RPC_POOL` exactly the operator's RPCs. Today the pool
    always appends publicnode, drpc, 1rpc and mainnet.base.org.
  - `REGISTRY_PRIVATE_KEY_FILE` reads the key from a regular file owned by the
    user, mode 0600/0400. Problems are `FATAL` plus `exit(1)`. A plain throw is
    swallowed by the supervisor's `uncaughtException` guard; testing caught
    this.
  - Base sha256 `2b7dd8b8…8cdc`.
- **03 (this workstream's files):** the lifecycle emits
  `REGISTRY_PRIVATE_KEY_FILE` and `BASE_RPCS`, and the tests are updated. It
  **must land with 02**: alone, the host would silently never register.

**Coordination:** a move-fix worker now owns `supervisor.js` and the CLI move
code. If their edits land first, re-base 01 and 02; both are small and
self-contained.

## What still needs live hardware, a wallet or another service

These are reported honestly by `check` as missing or unknown:

- **SEV-SNP hardware:** collateral, starting guestd, running guests.
- **A funded operator key:** registration and heartbeats.
- **The host-owner wallet:** it accepts ownership and commits a policy. Until
  then, a host with `--policy-dir` refuses every deployment.
- **The measured control guest that provides `ATTESTATION_URL`:** owned by the
  direct-supervisor workstream. Until it exists, the host is honestly *not
  ready*.
- **Independent replica operators.**

Residuals until 02 lands:

- The supervisor's own chain reads are first-answer over a pool that includes
  default public RPCs. Even after 02 the pool uses viem fallback, not a quorum.
- `supervisor.env` holds the operator key, at mode 0600.

On-chain referral needs a new reviewed contract interface; none exists.

## Constraints kept

- No edits to `cli/enclave.mjs`, `cli/host.ps1`, `metal/`, `supervisor.js`,
  `windows/`, `network/management-*` or the browser code.
- No commits or staging; no SSH, production, real wallet, real keys or private
  configs; no GUI or Wine. No public network was used: all chain and replica
  reads went to local fixtures or unreachable addresses.
- Memory stayed above about 18 GiB available. Each test job used a 200 MiB
  heap cap, and the supervisor child a 160 MiB cap.
- All work ran in the foreground. My scratch directories were removed. No
  processes of mine remain; the remaining `supervisor.js` and claude processes
  belong to other workers.

## Hash inventory (sha256)

Created by this workstream:

```
886ef1521b2ea9d8fd53e59948ff646215ba877dc8843ec0a45a1152582f5570  enclave/cli/host-independent-lifecycle.mjs
2ff02e0c9cfa02ce3d44143550323c982cd94702503e55c22518e513d79181e4  enclave/test/cli-host-independent-lifecycle.test.mjs
c64d2bd6e08af74c0c003a1ab7641fafd27bcab4d1597812fc2582a28b731bd0  enclave/docs/network/independent-host-onboarding.md
28d81bf238b29310ebb014d89d1cbc473a2350a3f3399853f5fb41838c1c576f  host-onboarding-interface.txt
c90b93c956f3e907440973fe2113d66a1fd800d18350cdd6472424e3bb9cdcf2  host-onboarding-integration/01-cli-enclave-cmdHost-delegation.patch
e1034418676788ced74d61db2bb69822ba6c6d6cd71a6f5bfddd80dcda11d222  host-onboarding-integration/02-supervisor-key-file-and-explicit-rpcs.patch
26dcc293a115cbc8e3f671606aa1f78e91cc953478841a75a691429f052c69bc  host-onboarding-integration/03-lifecycle-companion-for-02.patch
c59c696a231edd6d3fe33cfbca901cc4563e94e34fe4a010fcf9292dd43ca280  host-onboarding-integration/README.md
```

Dependencies read at these hashes (not modified):

```
36b3a364e3252cdcf795f12b2de0e28dccc2bba53e2185b6b6a912c86589561f  enclave/cli/independent.mjs
f804b7a23d8d8a6e6b807a0d3cf0229fcbf78396d813bf1e9198f2189479749e  enclave/scripts/network/fetch-runtime.mjs
50b6d288c620e6ea826e594444ec68ea599a53ec15e8c6a5b894d9d8a3373c70  enclave/sdk/storage/raw-artifacts.mjs
0a89412be69ee07be51d34e7b677e44bf0a397342e247cd1ad75a2cd887cbb1e  enclave/network/contract-pins.mjs
fd760b317a9b48153419919979d025190e2992b2afee6ad148e5ed02e0db0328  enclave/network/authority-profile.mjs
778ecf86fc9ec47642f17d367a6adaac21bd28f3aff5b9be965beb324da1b154  enclave/network/host-admission-runtime.mjs
291797372a4d905f117504c3276d355d91f61dca364ccea2dde16d65abc2aa42  enclave/network/host-admission-policy.mjs
bd8579ba7daae01f4160c72c6c937dacb151b3e9ffef21d1e9f93706e0fbcb75  enclave/isolation/m4/guestd/supervisor-transport.mjs
2b7dd8b8bd455aa6556a472dd86093b84c7bb410ef7906cc79698c9d54b88cdc  enclave/supervisor.js            (patch 02 base)
5c21db40f393806f9da44392c35174d626e580356a7b206c0f30a361e599125d  enclave/cli/enclave.mjs          (patch 01 base)
ee957827032cf7208434e4c73f9e859a27e4fc5c6cab5f4a2153308c09eb4cb8  enclave/contracts/deployments/network-profile-base.json
```
