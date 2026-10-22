Wallet-local host admission — prepared, not activated

Source: https://github.com/EnclaveHost/enclave/pull/9
Commit: 498aa7b3d01304a7eb88bd5e6620e754c7a6c1b7

Windows claims, scans, forced starts and live renewal checks enforce the owning wallet's host-local policy. Linux claims, version/config gates, audits and renewals enforce the same policy. Denial retires the app on that host before lease release. An independent host can opt to accept catalog-rejected or yanked apps; resource, placement, tenant consent, lease and isolation checks remain in force.

Core registry, ledger, catalog and proof bindings are immutable for the configured process. Both runtimes pass tests with address-book access blocked. The public pin snapshot and code hashes are captured in contract-pins.json and contract-pin-observation.json. The two empty factory/custody entries reflect the address book only. Existing legacy deployments were independently verified in legacy-binding-observation.json; zero does not mean they do not exist. These identity/custody paths are not yet fully migrated to the pin file. Do not activate this as a completed custody release.

windows-host-runtime.tar.gz contains the verified 60-file deployment import closure and npm manifests. Install its locked Windows dependencies through the normal installer. manifest.json records file and archive SHA-256 hashes. This package does not contain host credentials or private keys. The local Linux supervisor image was built and its production imports/pins verified with networking disabled; it is not a signed/measured guest release.

Activation order:
1. Deploy the prepared EnclaveHostOwnership contract and verify its immutable registry and deployed code.
2. For each participating host, explicitly select its owning wallet. Do not infer ownership from a payout address or assign independent hosts to Enclave by default.
3. Create a policy binding that deployed contract, exact host ID, chainId 8453, version 1, requireCatalogApproval (an explicit boolean), denyDeployments and denyAppRefs (explicit arrays).
4. Run scripts/network/prepare-host-policy.mjs with --policy <document.json> --owner <wallet> --registry <pin> --book <address> --out <new-directory>. This performs fresh agreeing RPC reads and writes only unsigned transactions and the hash-named public document. It refuses conflicting ownership and resumes partial enrollment.
5. Place the public document in the host's policy directory. In order, sign the operator nomination, wallet acceptance and wallet policy commitment that the tool requires; re-read and simulate each after its prerequisite confirms.
6. Configure ENCLAVE_CONTRACT_PINS_FILE, ENCLAVE_HOST_OWNERSHIP, ENCLAVE_HOST_REGISTRY_PIN, ENCLAVE_HOST_CATALOG_PIN and ENCLAVE_HOST_POLICY_DIR. Verify authority read-back before activating one host. Missing ownership/documents/quorum refuse locally.
7. Verify own-host denial and continued independent hosting, then migrate compatible measured custody and encrypted bundles before broader rollout.

Validation: 66 targeted runtime/policy/pin/legacy-regression tests passed; the real-chain enrollment sequence passed, including resumption and refusal to take another wallet's host; Windows import closure and Linux image offline import checks passed. No production host has been activated in this mode. No ownership or policy transaction has been signed.
