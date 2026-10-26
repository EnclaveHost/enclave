# Lifecycle adapter `get(bytes32)` decode failure (root 1369): diagnosis (read-only, 2026-10-26)

**Scope:**
- Nothing was edited, and no tests, builds, network or commits were run.
- r4 (owned by Claude6d) was only read.

**Evidence:** `lifecycle-chain-adapter-stage/r3/logs/run-20261026T141734Z-1891850/`. Every failure there has one identical error:
- r2-corrected: 6 of 7 failures;
- r3: 10 of 10 failures.

## Precise cause: a stale TEST DOUBLE, not a production ABI mismatch
**Where it fails.** In every case the failing call is the adapter's host read, `call(C('registry'), DEP_ABI.registry, 'get', [pins.host])`:
- r2 `network/deployment-chain-adapter.mjs:164`;
- r3 `:268`;
- r4 `:351` (same code).

The ledger's `get` is not involved: the address is the registry double, and the argument is `HOST`.

**The two shapes that disagree:**

| side | source | `Enclave` fields |
|---|---|---|
| adapter ABI | `abi/dependencies-34a3c0d6.json` → registry; gitBlob `eefa1974` = `source` 34a3c0d6 `contracts/EnclaveRegistry.abi.json` (verified with `git hash-object`) | 13: …`payoutWallet`, **`uint64 caps`, `string region`** |
| real registry | 34a3c0d6 `contracts/EnclaveRegistry.sol:76-101` | same 13 (`caps` and `region` APPENDED at schema 5) |
| test double `TestRegistry` | r2 `test/fixtures/LifecyclePlatformDoubles.sol` (`3c8e08ea…`; r3's job reuses it) and r4 `test/fixtures/LifecycleR4Doubles.sol` (`933a84bf…`) | **11**: stops at `payoutWallet` |

The real registry's `registrySchema` is 5. The doubles return 4.

**Why it fails with exactly this number.**
- The double returns an 11-slot head followed by tails.
- The adapter's 13-component decoder reads:
  - slot 11 (`caps`) = the endpoint length, 9;
  - slot 12 (`region` offset) = the endpoint bytes.
- The rejected value `0x68747470733a2f2f68…00` is ASCII `"https://h"`, which is the tests' `enclave({ endpoint: 'https://h' })`.
- viem refuses to use it as an offset ("not in safe integer range").
- This is deterministic, and it is independent of the lifecycle logic.

The base-r1 tests passed 23/23 because they never read the registry.

## Production: no mismatch found
- **Adapter ↔ real registry:** the adapter's ABI is the real 34a3c0d6 registry ABI (13 fields).
- **Candidate ledger ↔ real registry:** the KVM frozen candidate ledger (`source-r1/deploy/lifecycle/EnclaveDeployments.sol:190-203`) declares an 11-field `IEnclaveRegistry.Enclave`. It calls `registry.get` at lines 241, 254, 424 and 802.
  - That is a strict PREFIX of the real struct, and the registry appends fields precisely so that "the first seven fields keep their offsets".
  - Under ABI rules, the ledger's 11-field decode of a 13-field return reads the same head offsets and ignores the extra `caps`/`region`. So the real ledger is compatible with the real registry.
  - This is reasoned from the encoding, not executed. The corrected tests below execute it.
- **Conclusion:** the defect is confined to the double. The fix is NOT to change the adapter ABI or `dependencies-34a3c0d6.json`. Either change would make the adapter wrong against the real registry.

## r4 (current, read-only)
**Not fixed in r4:**
- `LifecycleR4Doubles.sol` still has the 11-field `Enclave` and `registrySchema` 4.
- `r4-world.mjs:111` builds `enclave()` without `caps`/`region`.
- The adapter at `:351` still decodes with the 13-field ABI.

**Why it has not shown up yet:** root 1378's r4 run failed earlier, in `validatePins` (`sessionVaultFactory.authorityPins[0]`, 20 times). That failure happens before any `registry.get`, so this bug is latent there and will appear once that one is fixed.

## Minimal correct change (fixtures only; no adapter or ABI change, no weakening)
1. **Doubles (both `LifecyclePlatformDoubles.sol` and `LifecycleR4Doubles.sol`, in the next stage that composes them):**
   - append `uint64 caps; string region;` to `struct Enclave`, exactly in the 34a3c0d6 order;
   - make `registrySchema()` return `5`, the real value (the adapter's `>= 4` check is unchanged).
2. **Test helpers** (`enclave()` in the r2 and r3 tests and in `r4-world.mjs`): add `caps: 0n` (0 reads as CAP_HOST in the real registry) and a NON-empty `region` (for example `'us-west'`), so the trailing dynamic field is really decoded.
3. **Anti-drift assertion:** in each suite, assert that the compiled `TestRegistry` `get` output components (names and types) deep-equal `DEP_ABI.registry`'s `get`. The double can then never silently diverge from the pinned real ABI again. This makes the tests use the actual artifact rather than a hand copy.
4. **r4 also gets real-ledger coverage:** r4 deploys the REAL candidate ledger against `TestRegistry`. After step 1, the real ledger's 11-field interface decodes a real-shaped 13-field registry return (`lifecycleOperator`, `rateFor` → `_hostRate`). That executes the production prefix-compatibility claim instead of hiding it behind a double shaped like the ledger's own interface.

**Where these changes go:**
- r2 and r3 stay frozen. Their 1369 evidence is preserved as the failed baseline.
- Root or Claude6d applies the change in the r4/r5 composition. I did not edit r4.
