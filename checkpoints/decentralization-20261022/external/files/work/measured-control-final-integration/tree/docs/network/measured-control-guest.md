# The measured control guest of an independent host

An independent host (see [independent-host-onboarding.md](independent-host-onboarding.md)) can run its supervisor in one
of two places:

- **On the host.** This is the default, `cli/host-independent-lifecycle.mjs` with no `control` section. The supervisor
  is an ordinary process the host operator controls. Its proof-of-time key, its session key and its `/v1/attestation`
  answers are only the operator's word. `check` never reports this as attested.
- **In the measured control guest.** The supervisor runs inside an SEV-SNP control CVM booted from a reviewed image with
  `metal.control=direct` on its measured cmdline. A verifier checks, with no Enclave service, that:
  - the endpoint answering is that guest;
  - the guest runs the owner's configuration;
  - the running supervisor holds keys that were minted inside it.

This page covers the second option. The contract is `work/measured-control-interface.txt`.

## What runs where

| Where | What |
|---|---|
| HOST | `metal/enclave-metal.mjs` (`control: "direct"`) launches the control CVM. guestd launches each app in its own SEV-SNP guest (unchanged). The host forwards ONE TCP port: the control front. |
| CONTROL CVM (measured) | `gsup.mjs` runs as PID 1. It checks that HOST_DATA binds the owner's config, mints the keys, and starts three services: `supervisor.js` with `ISOLATION_DIRECT_ONLY=1` and the owner's pins, RPCs and replicas; `agent.mjs`, serving only the loopback RAD (no relay, no tunnel); and `measured-control.mjs serve`, the TLS front for evidence and the attested channel. |

1. **The owner's config is bound, not trusted.**
   - The config (`enclave-direct-control-config/v1`) names:
     - the contract pins;
     - the 2-8 RPCs and the quorum;
     - the CPU release pin;
     - the replicas;
     - the endpoint, repo and operator address;
     - the price and payout;
     - the guestd endpoints;
     - the host-admission digest;
     - the control port.
   - It reaches the guest over fw_cfg, which is not measured.
   - The launcher puts `sha256("enclave-measured-control/v1\nconfig " + sha256(canonical config) + "\n")` into SEV-SNP
     `HOST_DATA`, which the PSP signs into every report.
   - `gsup` reads HOST_DATA from its own report. It refuses to start the supervisor, the agent or the front unless
     HOST_DATA names exactly the config it received.
   - Legacy inputs are refused, never ignored: relay URL, tunnel token, fleet secret, certificate service, ACME pair and
     volumes.
   - The operator key must belong to the bound operator.
2. **The keys are minted in the guest.** Before any service starts, `gsup` mints:
   - the proof-of-time key and the session key, written where `supervisor.js` already reuses them
     (`SESSION_KEY_DIR/proof-secp256k1.hex`, `session-ec-p256.pkcs8.pem`);
   - the control TLS key and its self-signed certificate.
   The operator never sees any of them.
3. **One statement is bound per request.**
   - The control statement names: the config digest, HOST_DATA, the endpoint and operator, the proof public key, the
     session JWK, the control TLS key, and a per-boot id.
   - For every verifier nonce, the front asks the PSP for a fresh report with:
     - `report_data[0:32] = sha256("enclave-measured-control/v1\n" || sha256(statement) || nonce)`;
     - `report_data[32:64] = sha256("enclave measured control guest role v1")`.
     An app guest's report carries its AppID in `[32:64]`, so it can never stand in for the control guest.
4. **The endpoint is the guest.**
   - The front terminates TLS with the minted control key.
   - `GET /.well-known/enclave-control?nonce=<64 hex>` returns the evidence.
   - Every other path is proxied, path and query only, to the in-guest supervisor.
   - A verifier that pins the attested key talks to the measured supervisor end to end. The host only forwards bytes.
   - QEMU forwards the control port on the host's loopback (`127.0.0.1:<hostPort>`). To publish the endpoint, forward TCP
     from it WITHOUT terminating TLS (for example a TCP or SNI passthrough). A TLS-terminating proxy would put the host
     back in the path, and the verifier refuses it (endpoint key).

## Verifying it

`metal/measured-control-verify.mjs` `verifyMeasuredControl({ url, expect, collateral, registry })` runs these checks in
order:

1. It opens one TLS connection without CA validation, and captures the peer key on the socket that returns the evidence.
2. The statement must be canonical, and must name the owner's config digest and the HOST_DATA derived from it.
3. The TLS peer must be the attested control key. Otherwise a relay or another process is in the path.
4. The report goes through the repository verifier, unchanged (`verifier/snp.mjs`):
   - AMD chain to the pinned ARK, the CRL, the signature, the VCEK identity, the TCB floor, DEBUG and MIGRATE_MA off,
     VMPL 0;
   - the measurement must be one the owner expects;
   - the binding must cover this statement and OUR nonce;
   - the role must be the control guest's;
   - HOST_DATA must be the expected value.
   Only `verified` passes. A relaxed check (`limited`) is not ready.
5. The running supervisor, over a second connection pinned to the same key, must report the minted proof key and session
   key.
6. The registry entry, read through the owner's RPC quorum, must be active, have the bound operator and the minted proof
   key.

| Result | Meaning |
|---|---|
| `verified` | Every check passed. |
| `pending` | Not registered yet, or the proof key not yet republished after a reboot. |
| `unknown` | Unreachable, the quorum did not agree, or collateral was unavailable. |
| `rejected` | Any definite mismatch. |

With the integration patch, `host-independent-lifecycle check` reports the `control attestation` row as READY only for
`verified`.

## What this does not change, and what it cannot do

The host operator **cannot**, as long as SEV-SNP behaves as specified:

- read the guest's keys;
- run another image (the measurement);
- change the config (HOST_DATA);
- put its own TLS terminator in the path (the SPKI binding);
- replay old evidence (the nonce);
- present an app guest as the control guest (the role).

The host operator **can**:

- stop the VM or drop the port forward;
- see traffic metadata;
- hold the operator key, which is its own key;
- use that key outside the guest to register another proof key. Check 6 shows the mismatch.

Per-app guests are still launched by guestd on the host and attested separately to their clients, as before.

Legacy metal boots (no `metal.control` token) take exactly the previous path.

## Platform limits

- **SEV-SNP only.** HOST_DATA binding and the evidence path are implemented for SNP. TDX is refused.
- **No hardware proof yet.** The tests use a synthetic AMD-shaped chain and a recording QEMU. A real guest measurement
  has not been booted or checked on hardware (see the activation procedure below).
- **The measurement is reproducible only from the same inputs.**
  - The metal image packs the build host's kernel. Rebuild from the recorded digests, or inspect the artifacts.
  - The measurement depends on OVMF. Use the owner-pinned firmware, not the distro default.
  - It depends on the vCPU count and CPU signature.
  - The cmdline must include `metal.isolation=snp-guest-per-app metal.control=direct`.
- **No browser access.** Direct mode has no WebPKI certificate (no certificate service or ACME). The control endpoint is
  for pinned native verifiers (CLI, SDK); browsers cannot use it as is.
- **Keys rotate every boot.** Verifiers re-verify, and the supervisor republishes its proof key on chain.
- **The supervisor's chain reads are quorum-agreed.** In direct mode `supervisor.js` reads ONLY through
  `network/direct-chain.mjs`: `quorum` of the bound RPCs agreeing at one fresh, confirmed block (`confirmations`,
  `maxBlockAgeSec` are bound in the config). That covers claims, payments, the owner veto, identity and proof key,
  ownership/config, leases, releases and sessions.
  - The operator's transactions go to every RPC with the agreed nonce.
  - Gas estimates and fee suggestions are the only single-RPC answers, and they authorize nothing. An inflated fee
    suggestion can make a transaction overpay; there is no fee ceiling yet.
- **Host-owner wallet policy works in the guest.**
  - The config binds `hostOwnership` (the reviewed profile's contract and code hash) and the digest of the delivered
    policy wire.
  - The guest refuses a wire for another host id, another contract or other pins.
  - The supervisor checks the code hash, the registry and the owner's CURRENT commitment at one agreed block. See
    "Wallet policy" below.

## Activation on real hardware (not yet performed)

1. **Commit and review the source.** Image compilation waits for that.
2. **Build the control image** from pinned digests:
   ```
   node metal/build-image.mjs --isolation snp-guest-per-app --control direct \
     --supervisor <ref@sha256> --wasm <ref@sha256> --ovmf <owner-pinned OVMF>
   ```
   Alternatively, use `python3 metal/overlay-control-image.py BASE OUT COMMIT` over a verified base image built with
   `--control direct`.
3. **Recompute the launch digest independently**, on a second machine or a second rebuild:
   ```
   sev-snp-measure --mode snp --vcpus <cpus> --vcpu-family/model/stepping <the host's> --vmm-type QEMU \
     --ovmf <OVMF> --kernel vmlinuz --initrd initramfs.cpio.gz \
     --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct"
   ```
   It must equal `manifest.expectedMeasurement` for that vCPU count.
4. **Initialise the host plan:**
   ```
   node cli/host-independent-lifecycle.mjs init … --control-image <dist> --control-measurements <digest> \
     --control-min-tcb <floor.json> --control-ovmf <OVMF> [--control-port 18444 --control-cpus 4 --control-mem-mib 8192]
   ```
5. Run `build`. Collateral needs `--fetch-crl`, so that `crl.der` exists.
6. Run `install --apply --enable`. The unit user needs access to `/dev/kvm` and `/dev/sev`.
7. **Fund the operator.** Wait for registration and `setProofKey`.
8. **Run `check`.** The `control attestation` row must be READY.
9. **Accept a new deployment.** Commit a new owner startup deployment and confirm the guest claims and launches it.
   Only this step shows the onboarding works on real hardware.

## Wallet policy (the host owner's veto) in the measured guest

- **Delivery.** `host init … --policy-dir DIR` with a reviewed profile and a measured plan:
  - `install` puts the documents in DIR that belong to THIS host and the profile's `hostOwnership` (at most 8) into the
    launcher's `hostAdmission`;
  - the config binds that wire's digest and `hostOwnership {contract, codeHash}`;
  - the launcher refuses any other wire, and so does the guest (`hostAdmissionProblems`).
- **Use.** The supervisor (`directHostWalletAdmission`) reads, at one agreed block:
  - the ownership contract's code hash, which must equal the bound one;
  - `registry()`, which must equal the pinned registry;
  - `authority(hostId)`: owner, revision and policy hash.

  A document counts only when its hash is the current on-chain commitment for this host id and contract. A local file
  can never carry another wallet's veto, and an older revision's document is never used.

| state | outcome |
|---|---|
| no wallet policy configured | Enclave catalog approval decides, as before |
| owner set, no policy committed | accept |
| owner's policy | that policy decides (`denyDeployments`, `denyAppRefs`, `requireCatalogApproval`) |
| configured but no owner on chain | every deployment refused, with that reason |
| a newer commitment whose document is not available | refused until it is |
| wrong code, a registry mismatch, a disagreeing quorum, another host's config | refused |

  A host without wallet configuration is never affected by any wallet. An owner who does not require catalog approval
  may accept what Enclave's catalog has not approved.
- Evidence: `test/direct-chain-quorum-supervisor.test.mjs` (real supervisor, real contracts, lying peers) and
  `test/metal-measured-control.test.mjs` / `test/cli-host-measured-control.test.mjs` (delivery and binding).
