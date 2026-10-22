# Measured independent control guest: result

Repository: `work/enclave`, HEAD `abe86262`. Nothing was committed or staged. No image was compiled, no VM started, no
SSH, production, registry, chain or wallet action taken. All keys were disposable and generated in tests.

Contract: `work/measured-control-interface.txt`, published before the code; sha256 `0ac618e8…a9`.

## The gap, and how it is closed

Before this work, an independent host ran `supervisor.js` as a host systemd service. Its proof key, its session key and
its `/v1/attestation` were bound to nothing measured. `gsup.mjs` had no direct-only path.

Now a host can run the direct-only supervisor **inside an SEV-SNP control CVM**, and the owner can verify it with no
Enclave service. Three things make that work:

- **The configuration is bound, not trusted.**
  - The owner's direct config covers: pins, the 2-8 RPC quorum, the release pin, replicas, identity and operator, price,
    guestd endpoints, the host-admission digest and the control port.
  - It travels in fw_cfg, and its digest is launched into SEV-SNP **HOST_DATA**.
  - `gsup` reads HOST_DATA from its own report and starts nothing unless it binds exactly the config it received.
  - `metal.control=direct` rides the measured cmdline, so a direct control image has its own measurement.
- **The keys and process are minted in the guest.** PID 1 mints the proof key and the session key, written where the
  unmodified supervisor reuses them, plus a control TLS key.
- **Evidence is fresh per request.**
  - A statement names those keys, the config digest and HOST_DATA.
  - Each verifier nonce gets a fresh report:
    - `report_data[0:32] = sha256(domain || sha256(statement) || nonce)`;
    - `report_data[32:64] = CONTROL_ROLE`, which an app guest's AppID cannot equal.
  - The guest's TLS front serves the evidence and proxies, path and query only, to the supervisor in the guest.

The verifier (`metal/measured-control-verify.mjs`) runs these checks:

1. the evidence and the TLS peer key come from one socket;
2. the statement is canonical, with the owner's config digest and HOST_DATA;
3. the peer key is the attested control key;
4. the report passes the repository's `verifier/snp.mjs`, **unchanged**: AMD chain, CRL, signature, TCB, policy,
   measurement, binding, role and HOST_DATA;
5. the running supervisor, over a pinned second connection, serves the minted proof and session keys;
6. the registry entry, through the owner's quorum, is active, with the operator and the minted proof key.

Only `verified` is READY. `pending`, `unknown` and `rejected` are not.

**Not done to get there:** no attestation claim was weakened, the host process was not relabelled as trusted, and
`ATTESTATION_URL` presence still never means READY. Legacy metal boots are byte-identical: the test compares the legacy
launch block with HEAD's.

## Source inventory (sha256, final)

New files I own:

| file | sha256 |
|---|---|
| `metal/guest/measured-control.mjs` | `57db26ae6e1929cffc7567ac1c65b8ce99a274a641e1530f5ea4069894a6bc24` |
| `metal/measured-control-verify.mjs` | `121ae7abc1d0430fe064f2ab888746fa70c6cac4097650610912aa3e45e8fcbf` |
| `test/metal-measured-control.test.mjs` | `69c79da030cc9db57b36680de6250a54f665c6f8fc281e772fd9ebe536222bac` |
| `docs/network/measured-control-guest.md` | `9c4a492f1a3eb645fff2d6249ff20f21dd5551b13914e8c2bfcdc2fd88d4c657` |

Existing files with narrow edits; I own them for this task, as recorded in the interface:

| file | HEAD | now | change |
|---|---|---|---|
| `metal/guest/gsup.mjs` | `e0dd6af1…dd0c` | `a1bc90c0e4bd3338961a9764fe99f179542d1e95c52814c2a2934209539089f7` | the direct branch, only for `metal.control=direct` |
| `metal/enclave-metal.mjs` | `b641d8e0…b20d` | `3f83d993e6c95d48161b6be422cae05d2fdfb604df8d1117a6f969e3274f64c8` | `control: "direct"`: cmdline token, bound config in fw_cfg, HOST_DATA, refusals |
| `metal/build-image.mjs` | `a34ff924…8b20` | `6cfef52e34ee5dcff5fcc3981e8274ac6466f141f603ed24159256b85d0b0f21` | `--control direct` cmdline token and manifest entry; helper copied into the image |
| `metal/overlay-control-image.py` | `f3e03b64…beeb` | `2c90a7d470b6c3407024c3346a37458badc78ac76a909ed6777339c1b393467e` | the helper is installed exactly when the committed gsup imports it |

Integration for coordinator-owned files, under `work/measured-control-integration/`, NOT applied. Details are in its
`README.txt`.

| file | sha256 |
|---|---|
| `lifecycle.patch` | `6ed91ee56d8890e21315d07b1308913643129e642e3751e2615950fa023ac40a` |
| `onboarding-doc.patch` | `f3aec90e206a2973f1456558537a883d4c0ce12f894f70ecd02676ccfbce9bbd` |
| `cli-host-measured-control.test.mjs` | `da656f9bdd6bdc70461db9f87afb75de2fd955d561cfd6ac0f8c0da4765fbe0b` |

The patches apply to these bases and produce these results:

| file | base | after the patch |
|---|---|---|
| `cli/host-independent-lifecycle.mjs` | `ad52747a…7a20` | `9cb69332f51d0e41…4d35` |
| `docs/network/independent-host-onboarding.md` | `1d5df966…adf0` | `f8239177…a6` |

`supervisor.js` (`8d1b9262…`), `cli/enclave.mjs` and `cli/independent.mjs` need no patch; the reasons are in the
README.

## Checks actually run

Every run was gated on ≥18 GiB available, used `systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0`, ran in
the foreground, and used concurrency 1. Waits for memory were bounded (a few seconds to 30 s).

| Suite | Sources | Result |
|---|---|---|
| `test/metal-measured-control.test.mjs` | the final sources above | **13/13 pass, exit 0**, maxRSS 108,624 KB |
| regression: metal-launcher-isolation, metal-launcher-certs, metal-shielded-build, metal-update, shielded-fault-logs, shielded-multi-card, tenant-compute-eligibility | edited gsup, launcher, builder | **61/61 pass, exit 0** |
| regression: `python3 test/metal-control-overlay.test.py` | edited overlay | **6/6 OK** |
| scratch tree with `lifecycle.patch`: `cli-host-independent-lifecycle.test.mjs` (10 existing) + `cli-host-measured-control.test.mjs` (3 new) | patched lifecycle `9cb69332`, final metal sources (byte-compared) | **13/13 pass, exit 0** |

The regression run came before my last source change. That change made `canonicalDirectConfig` accept the bare-origin
RPC form that `cli/independent.mjs` writes, and it is reachable only in direct mode, which those tests never use.

What the module suite covers:

- **Config.** Strict and canonical; every field is bound; refusals for HTTP RPCs, duplicate hosts, the Enclave relay
  name, a zero registry, name-based plain-HTTP replicas, port clashes and the wrong chain.
- **Boot plan.**
  - A bound config yields the direct-only environment.
  - Both `directEnvProblems` and the lifecycle tool's mirror of the supervisor rules accept that environment.
  - The hosted flavor's address book and Enclave payout wallet are not inherited.
- **Boot refusals.** All listed: wrong or unreadable HOST_DATA, a host swapping the RPCs, relay/tunnel/fleet inputs,
  volumes, another operator's key, an unbound host policy, different guestd endpoints, a release ticket, a mode
  mismatch, missing measured tokens, TDX.
- **Legacy gsup path.** Byte-identical to HEAD; the direct branch is gated.
- **Keys.** Mode 0600, in the exact formats `supervisor.js` reuses; the self-signed control certificate verifies; the
  statement is canonical; the binding is fresh per nonce and carries the role.
- **End to end.** The **real supervisor.js**, running under the derived environment (network targets moved to closed
  loopback ports; everything ran through the loopback-only fetch hook) behind the real front, adopts the minted keys.
  The verifier passes all six checks.
- **Registry through the quorum.**
  - Not registered, or the proof key not republished: pending.
  - Another operator, or inactive: rejected.
  - No reader: pending.
  - A REAL `QuorumChain` whose peers disagree: unknown.
- **Refused evidence:**
  - a forged signature (not the VCEK);
  - a replayed (other-nonce) report;
  - a foreign-statement report;
  - an app guest's AppID in `[32:64]`;
  - the wrong measurement;
  - the wrong HOST_DATA;
  - CRL omitted (`limited`);
  - an unattested dev launch;
  - an owner config that differs from the guest's;
  - a MITM TLS key;
  - an impostor supervisor process;
  - an unreachable endpoint (unknown).
- **Front.** Nonce required and lowercase; one report per nonce; absolute-form targets refused.
- **Real launcher with a recording QEMU.**
  - The measured cmdline equals the builder template.
  - fw_cfg carries the canonical config.
  - The `host-data=` argument equals HOST_DATA, and the guest-side plan accepts the result.
  - It refuses: relayUrl, a forward of the plain supervisor port, an inline registryKey, a missing isolation tier, TDX,
    an unknown control mode, and another operator's key file.

## Honest limits: hardware and platform

- **No hardware proof.**
  - The SNP evidence in the tests is SYNTHETIC: `test/helpers/snp-synth.mjs` builds an AMD-shaped chain whose ARK the
    test pins, and the real AMD pin refuses it.
  - This proves the code paths and every refusal. It does NOT prove that a real control image produces the expected
    measurement, that configfs-tsm in that guest returns the bound report, or that QEMU's `host-data=` reaches the
    report on the target host and firmware.
- **SEV-SNP only.** TDX is refused: there is no HOST_DATA binding in this path, and the verifier marks TDX unsupported.
- **Measurement reproducibility.** The metal image packs the build host's kernel. The owner must rebuild from the
  recorded pinned digests, or inspect the artifacts. The measurement depends on: OVMF (use the owner-pinned firmware;
  the launcher default is the distro OVMF), the vCPU count, the CPU signature, and the exact cmdline with
  `metal.isolation=snp-guest-per-app metal.control=direct`.
- **Guest policy.** It is left at QEMU's default (DEBUG off). The verifier refuses DEBUG or MIGRATE_MA either way.
- **What the host retains.** Availability (it can stop the VM or drop the forward), traffic metadata, and the operator
  key (its own key). Misuse of that key to register another proof key shows up as `pending` or `rejected`.
- **Browsers.** There is no WebPKI certificate in direct mode. The control endpoint serves pinned native verifiers.
  Publishing it needs TCP passthrough; a TLS-terminating proxy is refused by design.
- **Supervisor chain reads.** The supervisor's own reads remain first-answer `BASE_RPC` until its quorum work. That is
  unchanged here. `BASE_RPCS` is already set for patch 02.
- **Wallet policy.** Host-owner wallet policy in a measured guest needs `hostAdmission` delivery; the config already
  binds its digest. The lifecycle tool refuses `--policy-dir` together with measured mode until it derives that.

## Remaining activation procedure (needs hardware and the reviewed commit)

The full commands are in `docs/network/measured-control-guest.md`, "Activation on real hardware".

1. Review and commit the sources and patches.
2. Build the control image with `--isolation snp-guest-per-app --control direct`, from pinned digests and the
   owner-pinned OVMF.
3. Recompute the launch digest independently with `sev-snp-measure`, using the direct cmdline. It must equal the
   manifest.
4. Run `init … --control-image/--control-measurements/--control-min-tcb/--control-ovmf`.
5. Run `build`, with collateral fetched by `--fetch-crl`.
6. Run `install --apply --enable`. The unit user needs `/dev/kvm` and `/dev/sev`.
7. Fund the operator. Wait for registration and `setProofKey`.
8. `check`: the control attestation row must be READY.
9. **Accept a new owner-committed deployment on that host.** Only this proves the onboarding on hardware.

## Separately: the signer report correction

`work/claude-independent-signer-result.md` now states that `network/rpc-identity.mjs` is already committed
(`50a37f6d`). The signer module, tests, docs and glue are frozen.
