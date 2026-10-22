# The measured control guest of an independent host

An independent host (see [independent-host-onboarding.md](independent-host-onboarding.md)) can run its supervisor in one
of two places:

- **On the host.** This is the path implemented by `cli/host-independent-lifecycle.mjs`. The supervisor
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

`host-independent-lifecycle check` does not yet perform this verification: its `control attestation` row is
`unknown` when an attestation URL is configured, or `missing` otherwise. Use `verifyMeasuredControl` directly;
configuring a URL alone is not proof that the measured guest owns the running supervisor keys.

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

## Native control names (optional `nativeControl`)

A guest that runs the platform API role can also serve the native control names `api.enclavehost.eth` and
`mcp.enclavehost.eth`. Native clients verify these names with the existing native CA. The guest presents, for exactly
these SNI names, a native-CA leaf whose public key is THIS boot's attested control TLS key. Nothing else is accepted: the
group's shared WebPKI key is refused, and so is a leaf for any other key.

- **Config.** `"nativeControl": { "names": [<sorted subset of the two names>], "caSha256": "<sha256 of the native CA DER>" }`.
  It needs `platformApi`, and the names must differ from `platformApi.hostname`. HOST_DATA binds it like every member. The
  statement then states `native: { names, caSha256 }`; other statements keep their exact bytes.
- **Certificate.** The leaf is public, and the CA holder issues it OUTSIDE the guest, over the attested public key.
  The guest's private key never leaves the guest. Run `scripts/native-control-certificate.mjs`:
  - `request` verifies the boot against its trusted config, measurements and the original registry;
  - `issue` runs where the CA key is kept, reading the key only through openssl;
  - `install` sends the leaf over a connection pinned to the attested key on the secure socket.
- **Acceptance.** The front accepts `PUT /.well-known/enclave-native-certificate` only under these conditions:
  - one install at a time;
  - a declared length up to 16 KiB;
  - the body within 10 s;
  - the chain is the leaf plus the bound CA;
  - the leaf carries the guest's own key;
  - a real TLS handshake under that CA succeeds for every bound name;
  - the leaf expires strictly later than the installed one.

  A refused or interrupted install leaves the current leaf serving.
- **Serving.** A native name with no current leaf fails the handshake; it is never served under another key. SNI and Host
  must name the same native name, or the front answers 421. `api.enclavehost.eth` reaches the platform API role exactly as
  its WebPKI host does. `mcp.enclavehost.eth` reaches the relay's own MCP endpoint (`/mcp` on that host, path and query
  kept). The hosted independent MCP adapter's `POST /mcp` route is unchanged.
- **Discovery.** `network/native-control-routes.mjs` takes candidate addresses from kind-9 `native-control` ads in the pinned
  service index. For each address it checks, in order:
  - the native TLS connection;
  - the leaf key equals the attested key;
  - the unchanged `verifyMeasuredControl` at that address;
  - a fresh platform host policy decision for THAT registry id.

  The advertiser is never judged. The chip is the verifier's: `0x` + sha256 of the verified 64-byte CHIP_ID (null when
  masked or zero). It is added to that host's chain facts, never replacing them, so a `chipId` deny or allowlist entry
  matches per host. A host whose chip is not proven is refused while the policy denies any `chipId`.

Issuance remains a deployment prerequisite: the native CA key is held in one place today (the minipc control VM).
Distributed issuance or custody is not provided here.

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
- **The supervisor's own chain reads** are still first-answer `BASE_RPC` until the supervisor's quorum work lands.
  `BASE_RPCS` is set for integration patch 02. The owner's `check` always reads through the quorum.
- **Host-owner wallet policy** in a measured guest must arrive through the launcher's bound `hostAdmission`. The
  lifecycle tool refuses to combine `--policy-dir` with a measured control plan until it derives that.

## Activation on real hardware (not yet performed)

1. **Commit and review the source.** Image compilation waits for that.
2. **Build the control image** from pinned digests:
   ```
   node metal/build-image.mjs --isolation snp-guest-per-app --control direct \
     --supervisor <ref@sha256> --wasm <ref@sha256> --ovmf <owner-pinned OVMF>
   ```
   Alternatively, use `python3 metal/overlay-control-image.py --control direct BASE OUT COMMIT` over a verified
   `snp-guest-per-app` base image. It keeps the base's kernel and modules, installs the commit's runtime, its platform
   API bundle with the bundle's sidecars and its hosted MCP bundle with the bundle's runtime files (each checked against
   its committed bundle manifest; a manifest-named file must be a plain relative path and may not replace another file),
   and appends `metal.control=direct` to the measured cmdline. A base that already carries a control mode must be overlaid with the
   same `--control`.
3. **Recompute the launch digest independently**, on a second machine or a second rebuild:
   ```
   sev-snp-measure --mode snp --vcpus <cpus> --vcpu-family/model/stepping <the host's> --vmm-type QEMU \
     --ovmf <OVMF> --kernel vmlinuz --initrd initramfs.cpio.gz \
     --append "console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct"
   ```
   Record the independently reproduced digest with the exact artifact hashes and CPU/firmware parameters. An
   overlay build removes `manifest.expectedMeasurement`; use the verified build receipt as the reference. A real
   hardware report must subsequently match it.
4. **Prepare the launch files.** The implemented launcher is `metal/enclave-metal.mjs`; the lifecycle CLI does not
   implement `--control-image`, `--control-measurements`, `--control-min-tcb` or `--control-ovmf` flags.
   Prepare a host config with `control: "direct"`, `mode: "snp"`, `direct` pointing to the canonical owner config,
   `dist` pointing to the verified image, the pinned `ovmf`, and the measured `cpus`. Configure the
   `snp-guest-per-app` isolation backend with release tickets off. The two configs must agree on guestd endpoints,
   and `hostAdmissionSha256` must bind the actual host wallet policy. Only the bound control port may be forwarded.
   For a selling host, provide its operator key through a private `registryKeyFile` (0600 or 0400).
5. **Prepare verifier trust.** Supply current AMD collateral, including the CRL, the minimum TCB, the owner config
   digest and the reproduced measurement to `verifyMeasuredControl`. Platform API group members and hosted MCP
   clients must also pin the corresponding direct-control expectations. A direct guest does not attach to the
   legacy fleet tunnel, so adding its measurement to `METAL_ALLOWED_MEASUREMENTS` is not a prerequisite.
6. **Launch under the host's service manager**, with access to `/dev/kvm` and `/dev/sev`:
   ```
   node metal/enclave-metal.mjs --config /path/to/host-config.json
   ```
   This launches the guest; it is not an attestation check. Do not replace an existing control guest until its
   application adoption, ingress, owner configuration and rollback have been reviewed.
7. **Verify registry readiness.** A selling host needs an authorized operator gas budget for registration and
   `setProofKey`. Wait until the original registry names the bound operator and newly minted proof key.
8. **Verify hardware evidence.** Call `verifyMeasuredControl` with the pinned expectations and collateral above;
   require `verified`. The lifecycle CLI's generic `check` is not a substitute. Direct guests retain Enclave's
   platform-admin policy enforcement. Publish the admin-signed policy document to the configured carriers before
   anchoring it, so hosts can retrieve and enforce it.
9. **Accept a new deployment.** Submit an owner-authorized deployment and confirm that the guest claims and launches
   it. Verify application behavior and recovery separately; a successful image build alone does not prove onboarding.
