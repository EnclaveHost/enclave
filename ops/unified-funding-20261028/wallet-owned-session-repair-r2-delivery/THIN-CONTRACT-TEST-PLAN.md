# Smaller contract testing proposal — no execution

The 33-file Foundry build exceeded512MiB because test rigs compile many real contracts/embedded constructor paths together. Native product-only standardJSON (3whole sources, limited outputSelection) already compiled at109MiB inner. Reuse that separation; do not raise caps or repeat the old build unchanged.

## Compile artifacts independently, same512/450/floor27648/CPU1/noSwap limits

Each is a separately root-admitted native-solc standardJSON invocation, streamed output, no compiler download, no network, exact input/source/tool hashes. Do not auto-run all batches after this preparation.

A. New product: exact repaired WalletSessionVault/Policy/profile sources + unchanged SessionVault.sol. Only new implementation/factory/profile and linked SessionVaultLib outputs. Old product-compile output can be reused ONLY while source/input hashes match; it is INVALID for changed repaired contracts.

B. Real deployed rev16d ledger: one whole source, evidence/review/ledger-rev16d-EnclaveDeployments.sol SHA2771a5248ed7a68f5521b08dbde466603b02c29ccd961d55fd9eceabe1d11cd1. outputSelection only EnclaveDeployments and EnclaveLedgerBandwidth, optimizer1/viaIR. Preserve exact source and library; no fabricated ledger/mock authority. Native/Emscripten equivalence and sourceunit naming/metadata limits remain recorded.

C. Real catalog: exact source-verified catalog SHA b31744361efbb43fcf60152a5eaaa185d1af07bdc27f077af0a2b48e7de3b191, optimizer200/viaIR from deployed map. Only EnclaveAppCatalog output. Readonly original source available in the ownership review. No live chain use.

D. Test support: existing EnclaveAddressBook.sol and PaymentRouter.sol plus WHOLE original contracts/foundry/test/mocks/SessionMocks.sol. Request only AddressBook, PaymentRouter, MockUSDC3009 and SessionRegistryStub (and Mock1271Owner/MockKeyAttestations only if a test needs them). Do not request unrelated hostile ledger outputs. Token/registry are expressly existing test doubles; ledger/catalog/router behavior remains real. Separate support outputs if memory exceeds bounded gate; no silent cap increase.

All artifacts retain ABI, creation/runtime bytecode, immutable/link references and metadata. Every artifact manifest binds source hashes, compiler/settings and selected unit/contract. Size-limit gate includes constructor arguments for each deployed product. Unresolved links are explicit, never treated as deployed code identity.

## Thin isolated Foundry project

Only test harness, small ABI interfaces and required Vm/test utilities compile in this project. It MUST NOT import product .sol, full SessionRig or construct products with `new Contract(...)`; that would re-embed large initcodes. Interfaces are test ABI adapters derived/matched against exact compiled ABIs, not rewritten product logic. Keep full source/original assertion files as readonly evidence outside Foundry src/test compilation.

Use pinned VM readFile/parseJsonBytes to load precompiled creation bytes from artifact files (read-only permission restricted to that artifact directory). Deploy using local EVM CREATE with actual ABI constructor args. Do not etch product/ledger/storage or use fake runtimes; library self-address guards and constructors must execute normally. The existing P256 test fallback is a separately declared fixture; no claim of hardware/native signature verification if used. No FFI, fork/RPC, production/private keys or code-size override.

Link SessionVaultLib and EnclaveLedgerBandwidth locally BEFORE dependent deployment. Use compiler linkReferences (source,library,start,length) to patch only the expected20byte placeholders; validate bounds/non-overlap/all-required-sites-exactly-once/source+contract identity and refuse unknown/unresolved references. Verify deployed runtime identity against compiled template with only compiler-declared immutable/link locations allowed. Then deploy real ledger/catalog/router/book/newfactory with local addresses, verify actual owner/profile/library bindings, fund only mockUSDC. This supports faithful atomic create/transfer/fund tests without large compiler codegen in test harness.

## Assertion mapping, not a replacement fake test

Preserve each original WalletSessionVault.t.sol assertion's name, inputs and invariant in a mapping. Thin copies may replace construction/types only; changes to behavior expectations are explicit separate regressions. Keep exact-rev16d variant. Test full positive finalowner/originalID/events/funding/refund/fees/rollback, scopes for every action, signatures/domains/replay/expiry/budget, explicit delegation, publisher cap, ownerpolicy/revocation and finalpolicy consumers. The Node7+3 remain a separate test plane; a contract pass cannot erase their failures.

For immutable-profile repair, map old book-move-refusal expectations to new foreign-book-no-effect and wrong-local-binding-refusal tests per root instruction; original failures remain evidence. Transfer-away/back behavior needs an explicit achievable rule: the immutable ledger provides no callback to the new policy on a direct wallet transfer, so new executor state cannot magically observe an intervening transfer that has already returned. Do not claim a generation fence without a real ledger/history proof mechanism; fail/limitation must be reported.

## Concrete execution stages for later root review

1. Review/hash admitted artifact batches A–D. Existing product result qualifies A only for its exact old sources.
2. Generate source-only ABI adapters + artifact link manifest + thin tests, reviewed against original assertion map. Preparation, not execution.
3. Compile only thin harness under pinned offline Foundry/native compiler. Normal EIP limits; no original full rig imported.
4. Run only named thin test contract(s) with local artifacts in isolated network namespace, shared queue and512/450 caps. Preserve before/after source/artifact hashes and every failure. No automatic retries or activation.

No artifacts B–D, harness or tests have been compiled/generated/executed by this proposal. Root must review actual next inputs; this is a concrete smaller boundary, not a claim of an executable test closure already passing.
