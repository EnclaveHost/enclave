Measured control guest: integration for coordinator-owned files (NOT applied)
=============================================================================
All paths are relative to work/enclave. The bases are the CURRENT working-tree files; `git apply --check` passes for both
patches.

lifecycle.patch       cli/host-independent-lifecycle.mjs
                        base  ad52747a0bddb529bb1caab872ffe0adf845b065d73660790f7b8f6fa09f7a20 (= work/host-onboarding-coordinator-inventory.json)
                        after 9cb69332f51d0e41a5f0b5f0b87f86c2b0fb75fd7023013af5356abc7e784d35
                      Adds an optional plan `control` section (mode "measured-guest") and the flags --control-image,
                      --control-measurements, --control-min-tcb, --control-ovmf and --control-port/cpus/mem-mib. Also adds:
                      - directControlConfig() and controlLauncherConfig() derivations;
                      - in measured mode: a control unit (metal/enclave-metal.mjs) instead of the host supervisor unit;
                        install writes direct-control.json and control-launcher.json; `run --component supervisor` is
                        refused;
                      - check: the "control attestation" row calls metal/measured-control-verify.mjs. verified maps to
                        READY, pending to MISSING, unknown to UNKNOWN, rejected to FAILED. The registry is read through
                        the plan's quorum (readHost). No host supervisor port is probed.
                      Refused combinations: walletPolicy (needs hostAdmission delivery to the guest; not derived yet), and
                      attestationUrl.
                      A plan without `control` behaves exactly as before. The only text change is the "control
                      attestation" MISSING detail, which now names the measured option.
onboarding-doc.patch  docs/network/independent-host-onboarding.md
                        base  1d5df96681b9d022c3cdbb5b96315945b7cb7e89c1aa1318c7c91860494eadf0
                        after f8239177f4faa41c8f16f145eed8fa415d13d8c9d631217db884e940afbefba6
cli-host-measured-control.test.mjs  -> test/cli-host-measured-control.test.mjs (3 tests: init, install plus the REAL
                      launcher, check mapping)

supervisor.js: NO PATCH REQUIRED.
- The measured guest hands the supervisor its keys through the files it already reuses:
  SESSION_KEY_DIR/proof-secp256k1.hex (initProofKey) and SESSION_KEY_DIR/session-ec-p256.pkcs8.pem (initSessionKey).
- The end-to-end test runs the REAL supervisor.js (8d1b9262…) and confirms it serves exactly those keys on
  /v1/attestation.
- BASE_RPCS is set for patch 02 when it lands; REGISTRY_PRIVATE_KEY is used until REGISTRY_PRIVATE_KEY_FILE exists.
- Residual, unchanged: the supervisor's own chain reads are first-answer BASE_RPC.

cli/enclave.mjs and cli/independent.mjs: NO PATCH REQUIRED.
- The verifier takes an injected quorum reader, so metal/* does not import cli/independent.mjs.
- `enclave --independent host …` reaches these commands through coordinator patch 01 (delegation), unchanged.

Tested (scratch tree /tmp/mc-integ/tree: the static import closure of the lifecycle, the supervisor and the metal code,
56 files, plus the patched lifecycle and the profile fixture; node_modules symlinked):
  node --test --experimental-test-isolation=none --test-concurrency=1 \
    test/cli-host-independent-lifecycle.test.mjs test/cli-host-measured-control.test.mjs
  -> 13/13 pass, exit 0 (the 10 existing lifecycle tests unchanged, plus the 3 new ones), under systemd-run
     MemoryMax=512M MemorySwapMax=0.
