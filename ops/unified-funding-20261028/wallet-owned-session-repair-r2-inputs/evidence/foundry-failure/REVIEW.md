# Isolated Foundry compile/size/new-test preparation

PREPARED ONLY; no Forge, solc, tests, network/RPC, auth, transactions or product code executed. Root owns admission and one bounded execution. No automatic retry, memory-cap increase, FFI, keys, network or code-size override. Frozen author source remains untouched.

35 local source/config/fixture files have full lexical import closure (no missing imports). Source-origins.json pins the original 33-file dependency closure; fixture-provenance.json documents the two later exact-rev16d files and explicit test-only transformation. Seed-pins/input-pins cover everything, including local Forge, native solc, forge-std transitive sources, P256 fallback fixture and shared guards. No library install or compiler download is needed.

Original WalletSessionVault.t.sol is byte-identical to the author delivery and remains the rev15d historical test. WalletSessionVaultRev16D.t.sol is a SEPARATE copy: renamed class/type/import, exact source-verified ledger SHA2771a5248ed7a68f5521b08dbde466603b02c29ccd961d55fd9eceabe1d11cd1, original assertions retained, one root owner-policy LedgerMoved regression appended. Full diff retained. No product edit. SessionRig generic ledger, catalog and router remain its original dependencies; this is not a complete live-deployment clone.

## Build settings and exactness limits

Native compiler binary /home/steven/.local/share/svm/0.8.35/solc-0.8.35 and Forge are hashed, not executed for version during preparation. Deployed-source-verification names solc0.8.35 Emscripten; its soljson hash fa4345d648d9a09c6601ffc978e78e9f5267b54e6d91e8f8c473f44c0c16323b matches the locally pinned soljson.js. The prepared Foundry harness uses native0.8.35, optimizer1/viaIR, matching the deployed sessions/ledger map settings. Osaka is explicitly selected for the local harness; the deployment map leaves evmVersion unset. Default IPFS metadata is retained (no bytecode_hash=none optimization). Exact source-unit paths and local library addresses differ; no fresh runtime/metadata equivalence is claimed. Catalog map uses runs200; the SessionRig catalog in this uniform runs1 harness is a local test dependency, not a reproduced deployment.

SessionVaultLib is unchanged deployed-source-matching source, linked locally by Foundry for tests. Production library0x5510ae9fed97577d75c69545384af7d8bad05027 must be independently verified during any future deployment. Exact rev16d ledger additionally links EnclaveLedgerBandwidth (historical production0x3dfee18b44b7ecd389eca78da10b6ad032802215); local fixture uses locally linked source library. P256 test helper may etch its existing pinned verifier if native precompile unavailable; no native/hardware P256 claim follows from a pass.

## Execution plan, NOT executed

Only through reviewed launch-command wrapper: 512MiB hard,450RSS,floor27648,CPU1,noSwap,shared queue,unshare network namespace,minimal environment. Runner checks exact pins, CPU1, separate network namespace, fresh root-test-approval matching PREPARED, private tmp and single exclusive attempt. It copies the prepared seed into a fresh run directory.

1. `forge build --root <run> --offline --use <pinned-native-solc> --threads 1 --sizes`, at most720sec.
2. On success only, read artifact sizes: runtime<=24576; factory initcode+5*32<=49152; executor initcode+6*32<=49152; library initcode<=49152. Retain linking metadata. No code-size override. A build/size failure stops here and is useful feedback.
3. Only if compile+size pass, `forge test` same offline/toolchain/threads flags with `--match-contract 'WalletSessionVault(Test|Rev16DTest)' -vv`,180sec, within total900sec.

No original broad/fuzz suite run here. Source changes after freeze are detected before and after; preserve all failure logs/artifacts. Root must confirm process/cgroup terminal before another job. Outer1200sec includes queue/admission delay, so a timeout before launch is not a compile result. A memory refusal is evidence, not permission to increase the cap.

Previously completed Node10=7PASS/3FAIL are referenced by exact root files in fixture-provenance; no Node repeat is prepared or authorized. Those tests use actual helper consumers with inert reads, not actual secret bytes/full vertical path.

## Read-only source audit findings for the next repair

- Policy discovery allows omitted factories / empty pins and caches chain identity; root has reproduced three failures. Do not activate.
- New _ownerBinding reads the mutable book via SessionVaultLib.ownerOf without the pinned-ledger guard. Appending the specific LedgerMoved regression captures this drift; its exact current result remains unexecuted here.
- execute._ledger itself refuses when the foreign platform book moves; this remains a foreign shutdown dependency. Do not simply remove that check while library calls still route via book. The independent-owner design must bind actual immutable/owner-controlled protocol references. Existing deployments are not changed by this review.
- secrets-release custody/lease check precedes asynchronous config/collateral/runtime/attestation; no final policy/row recheck before envOf/sealing. Plain secrets.js also awaits custodyHeldOf after policy check and before readSecrets. Shield alone got a final new check.
- On-chain action scope generally goes through _bound and signed budget/nonce/action checks; setAppRef checks current and target app. Owner policy is revision/domain bound, but transfer-away/back reactivation and detached-policy semantics still need explicit regression/decision. Existing legacy broad delegates remain independently authorized on-chain and cannot be repaired by off-chain refusal.
- Positive SDK client/open, actual host construction/packaging and selected-policy discovery remain unfinished. Source tests do not prove a working end-to-end path.
