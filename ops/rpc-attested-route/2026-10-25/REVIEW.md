# Attested provider source candidate

Reviewed October 25. No production provider or measured image has been changed. The provider side composes the newer route policy with the reviewed image-lineage verifier; it does not replace the older metal tree wholesale.

The seven new tests use synthetic AMD evidence and an unverified proof stand-in. They prove integration behavior, not real SNP or MPT verification. Existing regression totals remain 204 pass, 7 fail, 16 skipped; the failures/skips were reproduced on the clean parent. They are not passed production gates.

All chain-dependent admission reads share the explicit attested authority. Administrator ban/unban, current-owner policy signatures, rollback checks and ERC-1271/SessionVault read shapes remain covered. A missing/expired attestation refuses without a public RPC fallback. Paid-provider writes remain explicitly unsupported in this candidate and block enabling this mode for paid providers.

The generated verifier bundle records input hashes and a declared source commit. The build script does not authenticate an arbitrary input directory from the commit argument: release review must export the pinned commit, verify its source hashes, reproduce the artifact and compare both bundle and manifest. Regenerate this bundle when composing a new measured image/config schema. Do not infer that a caller-supplied commit label proves its inputs.

Before activation: finish paid-provider submission parity, compose/reproduce the measured image, test real SNP attestation including revoked/expired collateral and restart behavior, establish direct transport that does not depend on the chain route being bootstrapped, and validate provider outage/recovery with the previous artifact/config retained. Ordinary policy mirrors remain untrusted content transports. No live measurements or contract controls were changed.
