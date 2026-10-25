# DNS-relay fleet on the relay chain authority: review follow-up (PREPARED; NOT RUN; NOT DEPLOYED; NO CUTOVER)

**Scope**
- **Where:** `consumer-remaining-stage/` only.
- **Not done by Claude:** no tests, bundle build, queue use, native compile, SSH, deploy or commit.
- **Other source trees are untouched.** `relay-consumer-source` was only read: `git archive e78a764d1` and `git show`.
- **Product code is unchanged since root's review.** `src/relay/fleet.mjs` (`3f6d7900…`) and `src/relay/dns-relay.js`
  (`d775a7bd…`) are byte-identical to r1, and there are no refactors. Only tests, the tree and the launcher were added.

## Artefacts (`consumer-remaining-stage/`; `MANIFEST.sha256` = `21e30c0d354dae9b71e625102d71cc497e1e96c16bc5a73ddf09e7875cee39c7`)

| file | sha256 (prefix) | what |
|---|---|---|
| `consumer-remaining.r2.patch` | `4f7f7d36…` (full `4f7f7d36167783949a8b90b890840e32b1dd8d9a84058c4b602eb43ad9f938d2`) | 4 files against `e78a764d1`: the 2 unchanged relay files + 2 tests |
| `src/test/relay-fleet-chain-authority.test.mjs` | `fda019c5…` | unit tests (6) |
| `src/test/dns-relay-chain-authority.smoke.test.mjs` | `88ee9c8f…` | real-bundle startup smoke (4) |
| `jobs/root-dns-review.sh` | `d83175ef…` | root launcher |
| `tree/` | — | private `git archive e78a764d1` + overlay (copies equal `src/`, pinned) |
| `logs/consumer-remaining.r1.patch`, `logs/relay-fleet-chain-authority.test.r1.mjs` | `6f5ae99e…` (reproduced byte-identical), `87f125e7…` | r1 history |

## New unit assertions (`relay-fleet-chain-authority.test.mjs`; `fetch` spy, no network)

r1's four tests are kept unchanged.
1. Injected client, registry: all reads go to it, and no provider URL is requested.
2. Injected outage **at startup**: the fleet is empty and `BASE_RPC` is never tried. This is a startup-only property.
3. Legacy default unchanged: `mainnet.base.org` is requested.
4. Selection: unset gives null; verifier + `BASE_RPC` is refused; a public verifier URL is refused.

**New: address book + deployments ledger** (both client-construction sites, `readRegistry` and `runnerClient`):
- the registry is resolved from the book (`addr(registry)`), and rows are read at that registry;
- `runnerEndpointFor` reads `addr(deployments)`, `deploymentsSchema` and `getPage` through the injected client and
  resolves the in-fleet runner;
- zero provider requests.

**New: outage AFTER a healthy refresh.** The refresh interval runs every 50 ms through the existing `registryPollSec`;
then the injected authority fails. The test asserts:
- refreshes keep asking the injected authority;
- **zero** public-RPC requests;
- **inherited stale-cache behaviour, documented, not claimed to be fail-closed:**
  - `refresh()` keeps the **last known fleet with no expiry**, so `origins()` and `operatorForEndpoint()` keep the
    pre-outage answer, and the log says `registry read failed (keeping 1 known)`;
  - the ledger keeps its **10 s cache** (`ledgerRows`), so `runnerEndpointFor` returns the cached runner inside it. Past it
    (simulated by advancing `Date.now`), the failed read gives `null`, the caller's probe path, never a provider read;
  - a failed book read keeps the last known registry and deployments addresses (unchanged `fleet.mjs`).

**So:** with the verifier, an outage never falls back to a public RPC. But an existing fleet keeps serving its last
verifier-read routing indefinitely; this candidate does not change that. Whether to add an expiry is a separate product
decision.

## Real-bundle startup smoke (`dns-relay-chain-authority.smoke.test.mjs`)

- **Setup:** it spawns the real `relay/dns-relay.js` from the tree, importing the `relay/network-runtime.bundle.mjs` the
  launcher has just generated there.
  - The test refuses to run if the bundle is missing, and it checks that the bundle exports `relayChainAuthority`.
  - Only local resources: free loopback ports for DNS and the API; `DNS_BIND`/`DNS_API_BIND` set to 127.0.0.1;
    `ENCLAVE_PLATFORM_HOST_POLICY=off`; local fake JSON-RPC servers.
- **Mixed** (verifier + `BASE_RPC`):
  - exit code 1;
  - stderr matches `fatal: chain authority: …BASE_RPC`;
  - no udp/tcp/API listener log line;
  - zero requests to either fake server.
- **Clean verifier:** the fleet's `count()` `eth_call` to `REGISTRY_ADDRESS` reaches the fake **local verifier** within
  20 s; the daemon is still running; the log says `on-chain fleet: EnclaveRegistry`; no `eth_sendRawTransaction`.
- **Legacy (no verifier env, `BASE_RPC` = a local fake):** the same registry read reaches `BASE_RPC`, so the default path
  is unchanged.

## Root job (prepared; NOT run)
```
S=/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/consumer-remaining-stage
python3 /home/steven/Documents/Codex/2026-10-18/wo/work/claude-test-queue.py --mib 512 --log $S/logs/root-dns-review.guard -- unshare -rn bash $S/jobs/root-dns-review.sh
```
**Steps:**
1. Bring up `lo` and check that it is UP.
2. Verify `MANIFEST.sha256`.
3. Check the tree against `git archive e78a764d1` with `tar -d`: it must differ in exactly `relay/dns-relay.js` and
   `relay/fleet.mjs` (owner-only differences ignored).
4. Refuse a pre-existing bundle.
5. **Build the bundle** with `(cd tree/relay && node build-network.mjs)`; record its sha256 and manifest.
6. Run 4 suites, each on its own:
   - `test/fleet.test.mjs` (unchanged);
   - `test/relay-chain-authority.test.mjs` (unchanged);
   - the 2 candidate tests.

**Pass criteria:** each suite needs rc 0, fail 0, skipped 0, todo 0, cancelled 0 and pass > 0. The job exits 1 on any
failed suite, 2 on a harness error. The `node_modules` references are symlinks to
`/home/steven/Documents/Codex/2026-10-18/wo/work/enclave/node_modules` and `…/enclave/network/node_modules` (read-only
use; esbuild and viem present).

## Limits (honest)

**Test coverage limits**
- **Selection only, not proof:** these tests prove endpoint selection, not proof or finality. The fake verifier proves
  nothing; the verifier's guarantees (unsafe tier, no L1 finality, logs = inclusion only) are covered by other suites.
- **Other startup reads:** in clean verifier mode, any OTHER `dns-relay` startup code that read a public default would not
  hit a local fake. Inside `unshare -rn` such an attempt simply fails and is not detected by an assertion.
  - Host policy is off in the smoke test.
  - The app-challenge, attested and read-only modes are not exercised.
- **Not exercised:** viem ABI decoding of registry/ledger rows (the unit fakes return decoded rows; the smoke test's
  `count()` returns 0, so the fleet is empty), and `fleet.mjs` users outside this repo.

**Run uncertainties**
- **Untried environment:** the smoke test's env set has never been tried. If `dns-relay` needs another variable, the test
  fails with the daemon's output; that is an environment fix, not a pass.
- **Bundle sha:** a bundle built in the private tree may differ in sha from the deployed `5432bacf…`, because esbuild
  records input paths relative to the tree. The bundle's inputs do not include the candidate files.

**Production behaviour**
- **Stale fleet cache:** the inherited no-expiry fleet cache is unchanged (see above).

## Deployment prerequisites (none met; no cutover claimed)
1. **Root runs this job, with a full pass.**
2. **Build and deploy:**
   - review the bundle build;
   - the own Base node finished, the A2–A4/bytecode gates closed, and the local verifier qualified;
   - deploy `dns-relay` with `ENCLAVE_CHAIN_AUTHORITY=verifier`, a loopback `ENCLAVE_CHAIN_VERIFIER`, and `BASE_RPC` and
     the other provider settings unset.
3. **Live checks:** check the startup log, then zero connections to public RPC hosts, then a verifier stop. The expected
   result is NO fallback while the last-known fleet keeps serving; an operator must decide whether that is acceptable.
