# Schema-3 accounting and emergency settlement candidate

**Local integration qualified; not deployed or enabled in production.**
This package pairs the real schema-3 ledger and prover with the adjacent
emergency-offline controller. It does not migrate apps, change the address book,
spend a wallet/session balance, or enable a production adapter.

The ledger binds an assignment generation and settles the exact authenticated
emergency cutoff. Pending settlement fences replacement and protects refundable
escrow. Paid topups cannot buy time for a revoked run; late proofs cannot earn
or report time beyond its cutoff. Exact settlement retries cannot pay twice.
Retirement is deprecation metadata for this new ledger, not permission for an
administrator or stranger to cancel somebody else's app. Actual owner controls
remain enforced. See [remaining authority audit](INDEPENDENT-AUTHORITY-AUDIT.md).

The immutable `EnclaveLifecycleAccounting` library shares accounting and import
code to fit EIP170. Owner/import-window, pending-state, run tuple, generation and
acknowledgement checks remain in the ledger. The library has no mutable target
or upgrade setter. It is a trust-bearing dependency: production profiles must
verify its actual deployed code independently of the ledger's embedded address.

## Evidence

| Check | Result |
| --- | --- |
| Actual ledger/controller/prover/library tests | 63 passed; 0 failed; 0 skipped |
| Distinct actual scenarios | 47; 16 baseline cases run in both derived suites |
| Pure link and mock snapshot tests | 15 passed; 0 failed; 0 skipped |
| Ledger runtime template | 24,149 bytes; 427 bytes below EIP170 |
| Accounting library runtime template | 4,929 bytes |
| Emergency controller / prover / identity | 17,253 / 7,115 / 942 bytes |
| Ledger public ABI and storage layout | Unchanged by library extraction |

[Actual test log](evidence/actual-tests.log),
[mock pin test log](evidence/linked-pin-tests.tap),
[size result](evidence/size-result.json), and
[qualification manifest](qualification.json) preserve exact source hashes.
The actual local library was deployed through normal CREATE and its embedded
self-address and code length were checked. Its logged address/code hash belongs
to a disposable Forge test, **not Base production**.

The first real-test compile exceeded its 650 MiB inner cap. Marking two unused
base fixtures abstract removed duplicate test-contract code generation while
retaining every selected assertion. The successful run used the same 768/650 MiB
limits, peaked at 658/595 MiB outer/inner, and preserved source integrity. Failed
size checks and the original resource stop are retained in `evidence/`.

## Build and test

Use the repository's installed dependencies and the pinned
`0.8.35+commit.47b9dedd.Linux.g++` compiler. The portable package changes only
builder filesystem roots and Foundry remapping roots; all four virtual compiler
source inputs are byte-identical to the qualified bundle. No package-specific
recompile is claimed for those path-only packaging changes.

From this directory, within an appropriately bounded shared allocation:

```sh
node candidate/scripts/build-lifecycle-linked-artifacts.mjs /absolute/path/to/solc-0.8.35 /absolute/path/to/new-output
forge test --root . --use /absolute/path/to/solc-0.8.35 --offline --threads 1 --match-contract '^(LifecycleCutoffTest|AccountingConservationTest)$' -vv
node --test --test-concurrency=1 candidate/test-js/lifecycle-linked-artifacts.test.mjs
```

The checked-in bundle contains **unlinked source templates**, not executable
release artifacts or deployed-code pins. Creation/runtime link references and
all constructor immutables must be resolved against the reviewed deployment.
With this pinned viaIR compiler the library self-address is the 32-byte
`library_deploy_address` immutable (currently offset 7), not an assumed PUSH20
prefix. The verifier derives its range from compiler output and refuses caller
overrides, overlapping ranges, missing links, wrong code and wrong pairs.

## Remaining migration requirements

The code-pin helper verifies declared code and pair bindings inside a supplied
trusted snapshot; it does not establish that snapshot capability or replace the
whole recursive authority closure. It is not wired into production. The older
schema-2 adapter must not be widened with a loose `>=` comparison.

Before migration, integrate the explicit schema-3 profile and independent
library pin with the real adapter and its full recursive identity/authority
closure. Complete the independent financial/admission profile, accepted host
ownership, authenticated host-registry offline reporting, protected sponsorship
and final-stop budgets, Base receipt-fee treatment, and live positive authority
qualification. Reconcile each old assigned runner and its financial backing
before importing. An expired legacy lease alone is not a cleared assignment.

Review documents in this directory describe intermediate source proposals;
this README, exact evidence and qualification manifest give the current status.
