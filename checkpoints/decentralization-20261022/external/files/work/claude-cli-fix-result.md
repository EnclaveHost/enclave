# Independent CLI: feature parity, fixtures and staging bundle (2026-10-19/20)

Repo: `work/enclave` at HEAD `b3256349`. Nothing is committed.

**What I did not do:** no production use, SSH, chain writes (all mutation ran on throwaway local anvil chains), Wine,
GUI, commits or pushes.

**What I did not edit:**
- the management modules, supervisor, SDK, site, Windows, custody, isolation, authority-profile or provider files;
- the coordinator's guest/Shield integration files;
- `cli/dist`, which is preserved.

`cli/host.ps1` shows as modified in git status, but that change is not mine. No session key or environment value is
printed anywhere: the session store stays 0600, and RPC URLs appear only as redacted labels.

## Finished features (all in `cli/enclave.mjs`, `cli/independent.mjs`, `cli/independent-host.mjs`)

**Independent mode.** Run as `enclave --independent`.
- **Authorities:** a reviewed profile plus the digest you supply (`--profile`/`--profile-digest`), or `--contract-pins`
  (with `--usdc-token`).
- **Quorum:** k-of-n RPCs (`--rpc`, `--quorum`, `--confirmations`, `--max-block-age`) agreeing at one confirmed, fresh
  block.
- **No hosted fallback:** no API, no address book, no first-answer RPC. The first-answer clients `pub()`/`pubEach()`
  throw in this mode, and `api()` refuses.
- **Shared RPC rule (new today):** RPC URLs are validated with the coordinator's shared `network/rpc-identity.mjs`
  policy and vote identity. Peer failure text is passed through `redactUrls`, so an API key in a URL never reaches output.

**Reads:**
- `ls` (the wallet plus its pinned-factory vault) and `status` (including the runner's registry entry);
- `hosts` and `pricing` from the **deployed schema-4** registry. Schema 5, capability bits, relays and regions are
  refused;
- `apps`, `whoami`, and `session inspect`/`status`.

A failed read is never shown as an empty answer.

**Ledger actions:** `deploy` (chain-only; the spend ceiling defaults to the cheapest live registry price), `fund`
(USDC and ETH), `stop`, `resume`, `rate-cap`, `refund`, `transfer`, `upgrade`/`set-version`, `resize`,
`bootstrap … --storage-plan`, and `publish --storage-plan`. Each one is:
- simulated at an agreed block;
- signed once and broadcast unchanged to every RPC;
- confirmed by quorum.

If no RPC confirms accepting it, the result is reported as outcome-unknown and is never re-signed or resent.

**Relay-free sessions on the pinned factory, using the unmodified SDK.** The SDK reads through a quorum-backed
`publicClient`.
- **`session new`:** the owner's key signs the grant and submits `openFor`. Alternatively, `--owner ADDR` prints the
  exact EIP-712 SessionGrant typed data, and `session open <pending> --owner-signature SIG` verifies it is that owner's
  signature over exactly this grant before anything is sent.
- **Session-signed calls:** the SDK's `prepareCall` signs with the session key; a separate wallet only pays gas.
- **`--unsigned`:** with an active session and no `--from`, it prints the session-signed `execute` call for any gas
  payer.
- **Other subcommands:** `session terminate` (signed by the session key), `top-up` (an owner USDC authorization),
  `revoke-all` (the owner's DIRECT call, or the exact unsigned call for the owner's wallet) and `delegate`.
- **No hosted dependencies:** no relay and no key-attestation service. Grants carry no TEE measurement.
- **Refused before anything is signed:** another chain, another factory, and a revoked, ended or expired session.

**Owner management through the existing `ManagementClient`** (constructor unchanged by `b3256349`):
- the commands are `status --host`, `logs`, `restart`, `app-token` and `cpu-profile`;
- session liveness, scope and holder are checked on chain before any host is contacted;
- the client pins the host's TLS key before any byte is written;
- a lost mutation answer exits 4.

**Attestation.** `attest --native-profile` uses the native client's own SNP verification. `--host-report` is labelled
NOT VERIFIED and exits 3.

**Startup targets.**
- `bootstrap --target snp` is the default and unchanged; `--target shield` is explicit.
- Shield AppIDs are derived with the Windows host's own rule: `isolationPlan` plus `derive()` over the CID-checked
  component, with the operator-supplied `--shield-manager` and the partition `--runtime-id`. Shield packages must be
  public and carry no names.
- `deploy --prepare-only --startup-target shield` creates a Shield record.
- **New today:** the record's own `isolation.require` must match the target for `prepare`, `publish` and `activate`.
  Activation can no longer silently rewrite a record's tier.

**Fixes found today by the bundle smoke:**
- In independent mode, an unreachable quorum was reported by `assertPinnedSessionFactory` as "legacy factory without
  authorityPins". Only an agreed revert now means that; an outage propagates as an outage.
- `leaseReaderClients` now hands viem clients to `LeaseReader` directly, so the shared identity rule counts them. The
  shared rule now admits loopback HTTP, so the earlier wrapper is no longer needed.

## Test 12: intended behaviour

Independent `session new` is a **supported** relay-free command, so exit 0 with an owner key is correct, and that is
exercised end to end in the sessions suite. The meaningful refusals are now asserted in test 12:
- `session new` with **no owner** (no key, no `--owner`) exits 1 with "name the owner wallet: --owner ADDRESS". The
  test also checks that the error is not mislabelled as a relay refusal and that **no transaction was sent**;
- `session resume-wait` and `session top-up-link` refuse as hosted-relayer-only.

## Test results (exact)

**Verified runs (previous round, after the session, sessions-suite and `walletChosen` changes):**

| Suite | Result | Peak own RSS |
| --- | --- | --- |
| `test/cli-independent.test.mjs`, source | 14/14, 0 skipped | 567 MiB |
| `test/cli-independent.test.mjs`, staged bundle (`ENCLAVE_CLI_ENTRY`) | 14/14 | 539 MiB |
| `test/cli-independent-sessions.test.mjs`, source | 10/10, 0 skipped | 528 MiB |
| `test/cli-independent-sessions.test.mjs`, staged bundle | 10/10 | 518 MiB |
| Hosted: `test/cli.test.mjs` | 76/76 | 285 MiB |
| Hosted: `cli-session`, `cli-deploy-visibility`, `cli-deploy-isolation`, `cli-attest-verifier` | 25/25, 0 skipped/todo/cancelled | 760 MiB |

The sessions suite covers:
- owner-key `session new`;
- session-signed deploy, fund, rate-cap, upgrade, stop and resume, with a different gas payer, exactly 3 broadcasts each,
  and the budget accounted;
- `--unsigned` printing the `execute` call;
- a lost session call reported outcome-unknown and sent once;
- refusal of the wrong factory and of a wrong-chain copy of the store;
- the external owner signature, with a forged signature refused and nothing sent;
- `terminate`;
- `revoke-all`, both the unsigned DIRECT call and the actual revoke, after which a call is refused;
- `set-version`;
- `fund --eth`, with a disabled feed refused at simulation;
- SNP bootstrap through 3 real HTTPS storage adapters: a short plan is refused, and a lost activate is sent once;
- Shield prepare/publish/activate, where `windows/node/shield-startup.mjs` `materialize()` accepted exactly the CLI's
  AppID and RuntimeID;
- `publish --storage-plan`.

**Today, within the 250 MiB budget** (anvil suites were not launched because they need 280–760 MiB):
- `node --check` on all owned files;
- shared RPC validator cases: loopback by port; duplicates; `A.example.` vs `a.example` as one vote; plain HTTP to a
  public host; userinfo; a query key accepted under the shared policy;
- URL redaction: the quorum error contains no key text;
- the staging bundle rebuilt under a capped guard, peak 43 MiB:
  `work/cli-staging/enclave.mjs`, 1944 KB, sha256 `88c15b5057cbb65f202077547d8e6e9df7068334dbb281fb956ed658ca602e37`.
  `cli/dist/enclave.mjs` is unchanged (`9db0f36a…`).
- an offline smoke of the built entry under the network guard: `version`, digest-mismatch refusal, quorum outage
  against dead loopback RPCs, the `secrets` refusal, and `session new` now reporting the outage. The independent runs
  made **0** non-loopback attempts. The 16 guard entries in that smoke all came from the deliberately hosted-mode
  `hosts` call, which reads the address book as hosted mode does.

**Not yet run under anvil, needed before review:** today's edits (shared RPC rule, `LeaseReader` passthrough,
redaction, tier validation, the factory-check outage fix) and the new assertions in test 12, the Shield test and the
SNP test.

## Exact next commands

Run one at a time, each needing about 600 MiB of RSS plus 16 GiB free.

```sh
cd work/enclave
node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent.test.mjs
node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent-sessions.test.mjs
ENCLAVE_CLI_ENTRY=$(realpath ../cli-staging/enclave.mjs) node --test --test-concurrency=1 --test-timeout=180000 test/cli-independent.test.mjs test/cli-independent-sessions.test.mjs
node --test --test-concurrency=1 --test-timeout=180000 test/cli.test.mjs          # hosted, ~300 MiB
node --test --test-concurrency=1 --test-timeout=180000 test/cli-session.test.mjs test/cli-deploy-visibility.test.mjs test/cli-deploy-isolation.test.mjs test/cli-attest-verifier.test.mjs   # ~760 MiB peak
```

I used `/tmp/s6/run-guarded.sh LOG cmd…`, which kills the run's process group below 16 GiB free or after 600 s and
logs its own RSS. Every resource of the rigs registers its cleanup before the next fallible step.

## Files

| File | Change |
| --- | --- |
| `cli/enclave.mjs` | Independent mode, session flows, startup targets. The naming worker's bootstrap `--names`/ACME flags are preserved. |
| `cli/independent.mjs`, `cli/independent-host.mjs` | New: quorum, trust, sender, registry, sessions, management and native attest. |
| `test/cli-independent.test.mjs` (14 tests), `test/cli-independent-sessions.test.mjs` (10 tests) | New. |
| `test/helpers/cli-independent-rig.mjs`, `test/helpers/cli-network-guard.mjs` | New. |
| `test/fixtures/registry-schema4/EnclaveRegistry.sol` | New: the exact source of `b17db9a3`. |
| `docs/network/independent-cli.md` | Updated today: shared RPC rule, sessions, principals, `--unsigned`, startup targets. |
| `work/cli-staging/enclave.mjs` | Staging bundle; not promoted to `cli/dist`. |

## Remaining activation

1. **Run the commands above** to cover today's edits, then review the staged bundle and promote it to `cli/dist`
   (`node cli/build.mjs`).
2. **Not independent yet:** `config` (set/clear), custody, `secrets`, `move`, `account`, `encvol` and `host`. Also
   session `resume-wait`/`top-up-link` (hosted by nature); the independent equivalents are `session open` and
   `session top-up`.
3. **Native attestation, positive path:** not exercised in these suites. It delegates unchanged to `NativeClient`.
4. **Delegation for wallet-held deployments:** not checked client-side, because the deployed ledger's mapping is
   private. The host gateway decides.
5. **External-owner `session new` with a budget:** it would need the second (deposit) signature, so it opens with
   budget 0 and is topped up from the owner's key.
6. **Shield operator input:** the Shield `--shield-manager` input must come from the host operator's published
   `/health`. A wrong file yields a package the host refuses; it never yields one the host would run under a different
   AppID.
