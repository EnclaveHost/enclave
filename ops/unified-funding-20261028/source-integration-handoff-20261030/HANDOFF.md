# Source composition for synchronized main

Root runtime owner publishes fix/rpc-production-bootstrap-20261025; integration chat owns main and its separate worktree. Do not run production deploy on source merge. This is a source-composition map, not activation approval or a declaration that all157 branches are superseded.

## Current live frontend

Exact local release: U/wallet-release-reader-site-r4/composite/site (U is the sibling unified-funding-20261028 directory). release.json enumerates1490 output hashes and CIDbafybeigpmrrdbibmlqiljg5v6a5bnstuv36ovixm7vbuxsala2hhhu2mea; source-pins.json pins130 build inputs. All4edges activation350a05fde057405f8f267669423700d0 passed348 normal TLS hash checks. That is last verified deployment, not a fresh remote observation now.

Tracked full build source: ops/unified-funding-20261028/wallet-release-reader-site-r4/source/enclave/. READER-R4-SOURCE-MAP.json maps exact files into their canonical repository destinations by removing enclave/. This graph is the latest source for the deployed wallet-release reader, sessions UI and included selfhost manual gas Top up. It is a release snapshot: merge its changes into canonical site/network/test paths, retain immutable evidence, then maintain canonical source. It is NOT safe to wholesale replace all lifecycle files with this older reconstructed graph. Preserve unrelated newer main/lifecycle changes through per-file three-way review.

Build overlay chain: selfhost-topup-production-r1 preserves Host Copy CIDbafybeidf6n5ipdrfbiru5qr6e6phxdegzcrjeu76ypjbzpyit5fqn2ppxe; search-clear boot module remains imported; wallet-release-site-production-r2 -> wallet-release-prod-site-r3 -> wallet-release-reader-site-r4. Latest build.mjs and metafile.json define exact dependencies. It replaces only js/boot.js and adds80 files over1410file r3. Never run old edge helpers, deploy whole stale S/site, or interpret preserved old assets as active entrypoints.

Required migration tests: wallet-release-reader-repair-r4/run.py + test-pins.json/remaining-test-files.json bind original60 plus16 reader regressions (76PASS). Latest source graph test paths contain the prior wallet-release tests; reader-index.test.mjs and root-boundaries.test.mjs in repair-r4 are additional canonical test candidates, not generated runtime assets. REAL IndexedDB/browser inert signer checks from prod-root-review-r1 cover separate promotion/release and pending recovery; they do not prove on-chain transactions or simultaneous races. Human a62 transfer finalized;875 included/walletowner verified, finality last pending. No replay.

## Future wallet-owned creation

ops/unified-funding-20261028/wallet-owned-session-repair-r2-delivery/candidate is the235file frozen INCOMPLETE candidate. author-delivery-manifest.json/source-changes.json identify25 changes; DELIVERY-REVIEW.md lists8 blocking findings. Do not treat it as deployed or qualified, do not let merging it change default constructors/routes. Source locations under candidate/enclave map to canonical matching paths ONLY after integration fixes/review. It lacks relay/CLI transport, authenticated import ancestry, full-history completeness, strict pre-sign factory identity, case-sensitive content comparison, transfer-away/back revocation and compiled protocol manifest. Previous7PASS3FAIL/old compile-size result do NOT qualify r2. Preserve candidate/evidence and integrate as explicit unfinished development until repaired.

## RPC and runtime

RPC canonical lifecycle code and this branch's operational fixes must be reconciled separately; snapshots are immutable evidence, not the maintained-code destination. Latest offline OS writer candidate is rpc-escaped-unit-root-repaired-r1/candidate/offline_mask.py (2ac02fe85db023fe86e9ebc46047f685ce9654f40cd143e50cc763bf8ea1a2d1),86PASS including actual synthetic ext4 names; actual private OS r3 is currently running. No RPC boot, synchronization, memory-fit or consumer-readiness claim. Earlier originals/refusals and separate repaired candidates must remain auditable. Product uses fixed tool/image identity and bounded private derivative workflow; do not generalize hardcoded production authority silently.

Windows baseline manager/relay remain running their installed pinned modules, not newest ops candidates. Operator R4 has140 JS fixture passes, not native Windows qualification. Shared allocation repair retains a failing reconciliation case. Do not activate these as part of main merge, restart managers, lose relay pipes, discard nonce/quarantine journals, or introduce a second financial submitter. Root owns live changes.

Universal Add runtime with automatic USDC-to-gas refill is NOT live. Current frontend offers manual quoted gas purchase; no label-only substitution. DNS/KVM sameIDs each externally funded5USDC; restoration pending. No duplicate historic payments/refunds/contracts/funding-session migrations.

## Integration discipline

Keep deploy explicit and gated; merge source without deployment. Use exact pinned dependencies/manifests and preserve every failed test alongside repairs. No blanket branch retirement can be certified from this map. Newer tip does not mean every archived author candidate is authoritative. The canonical maintained-source inventory must distinguish live source, qualified-but-uninstalled source and incomplete candidates. No hook bypass: public dependency SHA false positives can use a verified reversible path/sha256 array encoding, preserving original private-local input bytes and recording round-trip hash.
