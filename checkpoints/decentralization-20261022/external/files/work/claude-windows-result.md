# S4: Windows host independence (2026-10-19)

**Repository:** `enclave`, branch `decentralize/nan-retirement`, base `af16a74c`.

**Not done:** no commits, pushes, SSH, live services, wallet or chain transactions, publishing, signing keys,
private-configuration reads or Nan restarts.

**Files touched:** only my assigned files, new Windows helper modules, new tests and the new document. Other
workstreams' uncommitted changes (custody, Sia, native client, site, isolation, management plane) were left alone.

## Result

| Area | Status |
| --- | --- |
| Signed update channel: operator-pinned P-256 keys with a threshold, operator-selected mirrors | **Implemented and tested** (Node). Also implemented natively in C# and PowerShell, which were **not run**. |
| Hashes from an unsigned manifest are never trust; substituted or unsigned data is rejected in policy mode | **Implemented and tested** |
| Mirror freeze, rollback, corruption and truncation handling; equivocation stop | **Implemented and tested** |
| Installer and runtime identity with an explicit endpoint, pins and gateways; no relay tunnel or name reservation | **Implemented**. Runtime tested by booting the real agent; installer PowerShell not run. |
| Relay-free name check (chain, through agreeing RPCs) and an offline path | **Implemented and tested** (Node module and `keys.mjs --offline`) |
| No update or re-run silently changes identity, policy or pins | **Implemented** (recorded identity, `-Reconfigure`, capability markers). Contracts tested structurally. |
| Release publishing off Nan | **Implemented and tested.** No built-in destination; explicit `--dest`; staged channel; immutable files. |
| `0xF5E9…` ownership preparation (no nomination or acceptance) | **Implemented and tested** against the real verified record with fake RPCs |
| Wallet veto and Shield attestation | **Unchanged.** Market scope still needs a relay's hv-node verdict; nothing raises it locally. |
| Documentation | `docs/network/independent-windows.md` |

**Overall:** the full Windows independence goal is **not** complete. Remaining gates are listed below.

## What changed

### New modules (`windows/node/`)

**`release-channel.mjs`: the signed channel**

- **Policy.** `release-policy.json` lives in `ProgramData\Enclave\node`, which only SYSTEM and Administrators can access:
  `{format, channel, keys: ["ecdsa-p256:<SPKI>"], threshold, mirrors}`.
  - Validation is strict: unknown fields are refused, mirrors must be https (http only on loopback), and keys may not
    repeat.
- **Envelope.** `latest.signed.json` holds a base64 statement plus raw `r||s` signatures over
  `"enclave-windows-release-signature/v1\n" || statement bytes`.
- **Statement.** It binds version, channel, issue time, optional expiry, and for the zip, setup and manifest: a name fixed
  by the version, a size and a sha256.
- **Resolve.** Every mirror is asked. Valid statements count only if signed by distinct pinned keys up to the threshold.
  The highest version wins. Two different statements for one version stop the update.
- **Download.** Bounded by the signed size, hash-checked, falls back across mirrors, and leaves no partial files.
- **Policy installation** refuses to replace a different existing policy unless `--replace` is given.
- **CLI:** `check-policy`, `install-policy`, `resolve`, `download` (used by `update-host.ps1`), `statement`, `sign`,
  `cosign`, `verify` (used by the publisher) and `pubkey`. No command generates a key.
- **Why P-256 instead of the audit's Ed25519:** .NET Framework 4.8 and Windows PowerShell 5.1 have no Ed25519. With
  P-256, setup and `host.ps1` verify natively through CNG `ECDsaCng`, with no bundled crypto.

**`host-identity.mjs`: identity resolution**

- **`resolveIdentity`**
  - **Relay mode** returns exactly the legacy values.
  - **Independent mode** (`ENCLAVE_IDENTITY_MODE=independent`):
    - requires an exact https `PUBLIC_URL`, `IPFS_GATEWAYS` and `ENCLAVE_CONTRACT_PINS_FILE`;
    - uses a relay or `RELAY_BASE` only when named;
    - lists unavailable relay-only features;
    - warns if the endpoint is still an Enclave relay route.
- **`quorumReader`**: all RPCs are read at one confirmed block, at least two must answer, and all answers must agree.
- **`checkEndpointOnChain`** reads `get(keccak256(endpoint))` on the pinned registry and returns free, ours or taken.
- **CLI:** `check-endpoint`; exit code 2 means taken.

**`host-ownership.mjs`: ownership preparation for `0xF5E9…`**

- `verifiedOwnershipAuthority` cross-checks `independent-authorities-base.json` against the host's pins: address, code
  hash, registry binding and catalog.
- `prepareOwnershipEnrollment` reuses `scripts/network/prepare-host-policy.mjs` and also requires the deployed code hash
  to equal the verified one.
- `ownershipActivation` produces the six `ENCLAVE_HOST_*` / pins settings.
- `ownershipStatus` reports ready only when the owner has accepted and the committed policy document is on the host.

### Modified files

**`agent.mjs`**

- Identity comes from `resolveIdentity`, and the startup log lists unavailable features.
- **Independent mode turns off** each of these:
  - Enclave session-API front doors and tunnel names;
  - the relay base for secrets, certificates and domains;
  - the sponsored registration;
  - the relay price list;
  - Shield sealed secrets and the certificate pass, when there is no relay base;
  - network enrollment without explicit `ENCLAVE_NETWORK_DIRECTORIES`.
- **Update watch:**
  - With a policy, it signals an update only for versions signed by the pinned keys.
  - A broken policy is an error, never a fallback.
  - An independent host with no policy does not update itself.

**`update-watch.mjs`:** documentation only. The logic is unchanged and its existing test still passes.

**`apptls.mjs`:** an explicit empty base means "no certificate service". It refuses before minting a key or writing a
file. `undefined` keeps the legacy default.

**`keys.mjs`:** no hard-coded `nucbox-k11` endpoint. Adds `--offline`. A chain failure is reported as unknown instead of
failing the install.

**`host-onchain.mjs`:**

- An explicit `PUBLIC_URL` or `NODE_NAME` is required; there is no default host.
- `OWNER_KEY` is needed only for commands that send transactions.
- New read-only commands `prepare-ownership` and `ownership-status`. Both require `ENCLAVE_CONTRACT_PINS_FILE` and an
  explicit `--policy-dir`, and write to a new directory with `wx` (never overwriting).

**`install-host.ps1`**

- **New parameters:** `-NoRelay`, `-PublicUrl`, `-Gateways`, `-ContractPins`, `-Rpcs`, `-Directories`,
  `-NetworkCheckers`, `-NameCheck relay|chain|offline`, `-ReleasePolicy`, `-Reconfigure`.
- **Recorded identity:** the identity is written to `host.json` (`enclave-host-identity/v1`, marker
  `ENCLAVE-IDENTITY-RECORD-V1`).
  - Updates reuse it.
  - A legacy host's recorded identity is its existing relay identity.
  - Any change needs `-Reconfigure`, and the message says a new endpoint is a new host on chain.
- **Name check:** the relay check runs only for relay hosts; independent hosts get the chain check (or `offline`).
- **Pins and policy** are validated early with the bundle's node, written after the files step, and refuse replacement.
- **Relay hosts keep byte-identical config values:** the same gateway, tunnel and checker lines, each now inside a relay
  branch.
- `node-config.local.cmd`, where the wallet veto lives, is still read last.

**`update-host.ps1`**

- **Signed mode** applies when the policy exists (marker `ENCLAVE-RELEASE-POLICY-V1`):
  - It verifies with the **installed** `node.exe` and `release-channel.mjs`.
  - All downloads, including delta files through the signed manifest, go through the verifier.
  - It never reads `latest.json`.
- **Independent host without a policy:** refuses to update.
- **Legacy mode:** logs that the channel is unsigned.
- **Capability check:** it refuses to install, or automatically roll back to, a release whose scripts lack identity
  records or policy verification, on any host that relies on them.
- Native-stderr handling is safe under PowerShell 5.1's `Stop` preference.

**`EnclaveSetup.cs`**

- **`ReleaseChannel` class:** CNG verification, mirror resolution with refusal notes, the equivocation stop, and bounded
  hash-checked downloads.
- **`SetupOptions` class:** independent arguments, validated and passed to the installer. They are saved to
  `setup-options.json` across the Hyper-V restart, because a RunOnce entry is limited to 260 characters.
- **Independent mode:**
  - no relay name lookup;
  - EnclaveDNS is off by default;
  - the welcome text says what this mode means.
- The legacy download message now says the hash came from an UNSIGNED `latest.json`.

**`cli/host.ps1`**

- **Signed path** (`ENCLAVE_RELEASE_KEYS` / `MIRRORS` / `THRESHOLD` / `CHANNEL`):
  - verifies in PowerShell 5.1 with CNG;
  - downloads setup across mirrors and checks the signed size and sha256;
  - passes the same policy to setup with `--release-policy`.
- The legacy path is unchanged except for the "unsigned" wording.

**`scripts/publish-windows-host.sh`: rewritten**

- Builds a static channel directory (`--stage`), signs it with the publisher's key files, and verifies it before
  mirroring.
- Copies only to explicit `--dest` targets (local directories or rsync targets): release files first, pointers last.
- **Published files are immutable.**
- **One statement per version:** a re-run reuses it and adds only co-signatures, so it can never cause equivocation.
- Writes the legacy `latest.json` during the transition; `--no-legacy-latest` stops that.
- `--require-signed` refuses to publish without a signing key.
- Contains no `ssh`, `scp`, `nan` or `get.enclave.host`.

**`docs/network/independent-windows.md`:** modes, install, residual gates, signed releases, publishing, migration (with
the bootstrap caveat), `0xF5E9` steps, test coverage and limits, and S4b follow-up files.

## Tests

`node --test test/windows-*.test.mjs windows/node/*.test.mjs`: **517 of 517 pass.** This includes all existing Windows
suites, plus 4 new files with 29 tests:

| Test file | Result | What it covers |
| --- | --- | --- |
| `test/windows-release-channel.test.mjs` | 11 of 11 | Real P-256 keys made in the test; key and policy strictness; unsigned or legacy envelopes and unpinned keys refused; substituted statements and signatures without domain separation refused; threshold over distinct keys; statement checks (channel, version-bound names, sizes, expiry, future issue); real loopback mirrors (highest version wins over stale, garbage and forged mirrors; the legacy `latest.json` is never requested; equivocation stops); download corruption, truncation and oversize, with fallback and no partial files left; refuse-to-replace policy (PowerShell byte-order mark accepted); the exact CLI chain `update-host.ps1` calls, including a substituted setup on a mirror; the agent's minute watch ignoring unpinned or broken-policy data. |
| `test/windows-host-identity.test.mjs` | 9 of 9 | Relay-mode compatibility; independent requirements; no Enclave origin in any resolved value; quorum agreement and disagreement; free/ours/taken on chain; disagreeing RPCs refuse; `0xF5E9` preparation against the real `independent-authorities-base.json` (wrong code hash refused, `0xbbd885d3` refused, unsigned transactions in order); ownership status; `keys.mjs --offline`; **the real `agent.mjs` started** in independent mode (refuses without pins; serves locally, opens no tunnel, makes no relay-route identity, logs disabled features). |
| `test/windows-publish-host.test.mjs` | 3 of 3 | No Nan or SSH; stage, sign and mirror to two directories; host-side resolve and download from the mirrors over loopback with one mirror corrupted; a re-run with a second signer keeps the same statement and the result meets 2-of-2; immutability; `--require-signed`; unsigned warning. |
| `test/windows-installer-independence.test.mjs` | 7 of 7 | Structural only: the C# and PowerShell constants equal the module's (formats, signing context, SPKI prefix, blob magic and offsets, statement field set); setup arguments map to installer parameters; an update passes no identity; every emitted step is known to setup; installer relay branches; update ordering (signed, then independent refusal, then legacy; exactly one `latest.json` request; installed-code paths; capability markers); setup and `host.ps1` signed paths never touch `get.enclave.host`. |

**Also run:**

- `test/release-signing.test.mjs`, `test/host-contract-pins.test.mjs` and `test/host-admission-policy.test.mjs`: 15 of
  15 pass.
- The bundle import closure from `agent.mjs`, `host.mjs`, the manager and `keys.mjs` closes with no missing files, and
  includes `release-channel.mjs`, `host-identity.mjs` and `update-watch.mjs`.

## Limits (Linux only)

- **Not compiled or run:**
  - `EnclaveSetup.cs`. It needs `System.Core` for CNG; the in-box `csc.rsp` normally references it. `build-setup.cmd` is
    not in my scope and was not changed.
  - `install-host.ps1`, `update-host.ps1` and `cli/host.ps1`. No PowerShell parser was available, so they were reviewed by
    hand and checked structurally only.
- **Not exercised:** Hyper-V, Shield partitions, TPM attach, scheduled tasks, ACLs, a live chain name check, live RPCs,
  live mirrors.
- **Windows run needed:**
  1. A fresh independent install.
  2. A legacy-host update, confirming its identity is recorded unchanged.
  3. Policy installation and then a signed update.
  4. A corrupt-mirror update.
  5. A refused unsigned update.
  6. A refused identity change without `-Reconfigure`.

## Gates that still need an Enclave relay (honest list)

- **Shield market scope** still requires an attached relay's hv-node attestation verdict (`host.mjs`
  `meetsIsolationContract`). Independent hosts run owner-only. Not relaxed.
- **Relay-held secrets and sealed Shield secrets:** deployments with secrets are held on independent hosts. The
  replacement is custody v2 (another workstream).
- **App and custom-domain certificates and domain lists** come from the relay CA and store. Independent hosts keep
  self-signed certificates. Depends on S2 plus S4b.
- **Remote owner management** (SIWE, logs and restart over the tunnel) has no relay-free path on Windows. Another
  workstream has added uncommitted `network/management-*.mjs` (S3); I did not wire it in.
- **The tray** shows "not connected to the network yet" on independent hosts. That text comes from `host.mjs`, which is
  not in my file set.
- **Bootstrap:** every installed host gets the verifier over the **unsigned** channel. A policy protects only later
  updates. The document says so, and describes an optional out-of-band check against the signed `manifestSha256` and a
  reproducible `stage-bundle.sh` build.
- **No independent organizations** run mirrors, gateways, directories, checkers or RPCs today. Enclave-operated mirrors
  are not independence.
- **No production release key exists.** A key is an authority only for hosts whose operators pin it, and a threshold of
  separately held keys removes the single-signer authority.

## Activation (none performed; listed in order)

1. Publish one release with this change, signed and with the legacy pointer:

   ```
   scripts/publish-windows-host.sh <out> --stage <dir> --sign-key <offline P-256 key> --dest <mirror>...
   ```

   The key is made offline by the publisher (the document gives `openssl` commands).
2. Hosts take that release through the legacy channel. An optional out-of-band check is described in the document.
3. Install the policy on each host as Administrator:

   ```
   release-channel.mjs install-policy --policy ... --dest C:\ProgramData\Enclave\node\release-policy.json
   ```

   Alternatively, re-run setup with `--release-policy`.
4. Publish later releases with `--no-legacy-latest` once the hosts that matter have policies.
5. Move nucbox-k11-4 to `0xF5E9…`:
   - Run `host-onchain.mjs prepare-ownership` (read-only).
   - The operator key nominates; the owner wallet accepts and commits the policy.
   - Run `ownership-status` until it reports ready.
   - Add `node-config.ownership.cmd` to `node-config.local.cmd` and restart the node.

   The host's private config was not read. Its current `ENCLAVE_HOST_POLICY_DIR` must be supplied with `--policy-dir`.

## Next files for S4b (Shield owner-committed startup)

| File | Change needed |
| --- | --- |
| `windows/node/host.mjs` | Launch from an owner-committed package (`sdk/bootstrap/package.mjs`, like `isolation/m4/guestd/bootstrap.go`) instead of `fetchSecrets` / `secretsExist`. |
| `windows/vbslike/manager/main.mjs` | Carry the startup package into the partition config bundle. |
| `windows/node/shield-secrets.mjs` | Release from custody v2 instead of `/v1/secrets/shield-release`. |
| `windows/node/hvcert.mjs` and `apptls.mjs` | Certificates for owner-committed names. Depends on S2. |
| `windows/node/domains.mjs` and `network-enroll.mjs` | Owner-committed name sets instead of `/v1/domains/map`. |
| `windows/node/hvnode-evidence.mjs` and `relay/shield-marketplace.mjs` | An operator-selected verifier set for hv-node evidence, so market scope stops depending on Enclave's relay without being raised locally. |

## Audit claims checked against source

- **Confirmed:**
  - The unsigned `latest.json` was trusted by `agent.mjs` and `update-host.ps1`, which checked hashes only against that
    same file.
  - The installer aborted when the relay name check failed.
  - Identity was `$Relay/t/$Name`.
  - The publisher used `ssh nan`.
  - Secrets, certificates and domains defaulted to `api.enclave.host`.
  - Gateways defaulted to `ipfs.enclave.host`.
- **Additional findings:**
  - `keys.mjs` and `host-onchain.mjs` hard-coded the `nucbox-k11` endpoint, and `keys.mjs` failed the install when the
    chain was unreachable.
  - `RELAY_URL=none` still sent secrets, certificate and domain requests to `api.enclave.host`, because `RELAY_BASE`
    defaulted independently.
  - Rolling back to an older bundle would have run an installer that rewrites identity. That is now guarded.
- **Deviation from the audit:** P-256 instead of Ed25519, for native verification on .NET Framework and PowerShell 5.1.
