# Windows release distribution closeout: signed path activation (ROOT-ONLY recipe)

Prepared by Claude on 2026-10-22, from source and evidence only. Nothing in this package has been run against a host. It
creates no key, statement, signature or policy, and it does not publish. Root owns every step marked ROOT; the owner owns
every step marked OWNER.

## 1. Where things stand

| Fact | Evidence |
|---|---|
| minipc installed release is 2026.10.12.47 (manifest 5b966e81) | root native read 23:12Z, `g4-release-train-20261021/root-read/native-result.json` |
| Installed updater is 36f9e0d6, which is signed-capable and has the rollback guard | root Apply 91208 at 03:28:34Z (`work/root-updater-first-hop-20261022/r4`) |
| The verifier `control/windows/node/release-channel.mjs` f690c29b is live | control package `keep[]` (live snapshot 01:44:55Z) |
| No release policy is installed, so minipc follows the **unsigned** `latest.json` | same root reads; `releasePolicy: false` in Check 67399 |
| `get.enclave.host/windows/latest.json` is at 2026.10.12.47; `latest.signed.json` returns 404 | release-train anonymous GETs |
| Windows publishing is frozen | release-integration U2 |
| Root's control package is applied on disk (18 control files and privacy-agent cfb69370); node activation is in progress in root's lane | `root-control-rpc-final-20261022/control-package/helper/runs/apply-control-result-20261022T033011Z.json` |

## 2. Remaining legacy, unsigned and single-provider dependencies

These are exact; none of them is fixed by this package alone.

- **L1 Unsigned update authority.** minipc has no policy, so whoever can write `get.enclave.host/windows/` decides minipc's
  next code. Steps P3/P4 remove this, and they need only the owner's **public** key.
- **L2 Single-provider channel origin.** `get.enclave.host` resolves only to the 4 DigitalOcean fronts. The zip, setup,
  manifest and `files/<sha>` are all DigitalOcean-only. Signing fixes **integrity** only. Availability through a
  DigitalOcean or account loss needs mirrors run by other operators on other infrastructure. **None exists today**
  (`docs/network/independent-windows.md`). Mirrors on the DigitalOcean fronts, on minipc, or on GitHub are labelled as
  what they are, never as independent; `make-policy.py` and `release-gate.py` always report
  `providerIndependence: false`.
- **L3 Publisher.** Published main's `scripts/publish-windows-host.sh` (b2a79e9a) still `scp`s to `nan`. The candidate
  publisher 9d69fae2 (reconciled candidate) has no built-in destination and supports `--require-signed`; use only that one.
- **L4 New-user bootstrap.** A new host downloads EnclaveSetup.exe and the zip from `get.enclave.host` (DigitalOcean) and
  trusts the origin for that first install. The candidate EnclaveSetup.cs (e55a8a90) verifies the signed channel only
  when given a policy (`--release-policy`), and the key spec must reach the new user out of band. The doc states this:
  installing a policy protects **future** updates, not the bootstrap.
- **L5 No compatible release exists.** No release since .47 carries the applied control set. A default-dated build from
  published main would regress minipc (release-train S3) and would be newer, so it would auto-install.

## 3. What root can do without owner signatures, and what only the owner can do

**ROOT, no signature needed:**

- **R0** Keep the publication freeze (release-train RT-1) until R5 passes.
- **R1** Build the release from the reconciled candidate plus the **applied** control-package bytes, then check it.
  - The required set is `required-release-files.v2.json` (89 paths). Sources, in precedence order:
    - the applied deploy set;
    - the live keep set;
    - the installed updater;
    - for two paths only (`host-onchain.mjs` 1a750655 and `keys.mjs` 7453fd58), ecbe8e29. Root must confirm these two
      by a fresh read.
  - The 5 older ecbe8e29 pins are superseded by the applied package and must not ship: agent ec5e75c7, chain 753818e2,
    host 0c82e9ba, lease-gas d2e363c5, privacy 7ef4e230.
  - The bundle must carry exactly update-host.ps1 36f9e0d6, install-host.ps1 r5 1d1580c8 and release-channel.mjs
    f690c29b. Those carry the IDENTITY-RECORD, ROLE-PRESERVATION, RELEASE-POLICY and ROLLBACK-GUARD markers that the
    installed updater's `Capable()` and `RolesBeside` checks require.
  - Use an explicit `-Version` newer than 2026.10.12.47. Build-tool chain: C# (EnclaveSetup) and PowerShell, no Rust/Go;
    the natives wg cbaf8313 and firewall 78daec71 are reused as-is.
- **R2** Stage the release with no destination and no key:
  `publish-windows-host.sh <out> --stage <dir> --require-signed` refuses to run without a key, so instead produce the
  statement only:

  ```
  node release-channel.mjs statement --channel stable --version <v> --zip <zip> --setup <exe> --manifest <manifest> --out release-<v>.statement.json
  ```

  Hand `release-<v>.statement.json` to the owner. It is public data: names, sizes and sha256s.
- **R3** Write the host policy from the owner's **public** key spec(s):

  ```
  python3 make-policy.py --key <spec> [--key <spec> ...] --threshold N --mirror <url> ... --out release-policy.json
  ```

  It is validated by the live verifier's own `check-policy`, refuses workspace test keys, and labels mirror providers.
- **R4 (optional, needs no signature)** Install the policy on minipc as Administrator, with the installed verifier:

  ```
  node.exe ...\control\windows\node\release-channel.mjs install-policy --policy C:\ops\release-policy.json --dest C:\ProgramData\Enclave\node\release-policy.json
  ```

  - **Effect:** minipc ignores the unsigned `latest.json` from then on (L1 closed). It takes **no** update at all until
    a release signed by the pinned key(s) exists on a listed mirror. There is no fallback, which is safe but freezes
    updates.
  - **Rollback:** an Administrator deletes `ProgramData\Enclave\node\release-policy.json`. That is the only way back to
    unsigned updates, and it is deliberate.
- **R5** Gate the signed release, offline, before anything is copied to a mirror:

  ```
  python3 release-gate.py --channel-dir <stage> --policy release-policy.json --on-disk <root fresh live read {path: sha256}>
  ```

  It must exit 0, which needs all of G1 to G6 (`release-gate.py` header). It never reports independence.
- **R6** Publish only after R5 passes:

  ```
  publish-windows-host.sh <out> --stage <dir> --require-signed --dest <mirror> ...
  ```

  - A re-run reuses `release-<v>.signed.json`.
  - Keep the legacy `latest.json` only while policy-less hosts must still update. `--no-legacy-latest` ends it.

**OWNER, the legitimate signing step; no secret ever leaves the owner:**

- **O1** Create the release key or keys offline. The holders and the threshold are the owner's choice; a threshold of 2 of
  3 removes the single-signer authority:

  ```
  openssl ecparam -name prime256v1 -genkey -noout | openssl pkcs8 -topk8 -nocrypt -out release-key.pem
  node release-channel.mjs pubkey --key release-key.pem      # -> {"key":"ecdsa-p256:...","keyId":...}  PUBLIC: give to root
  ```

- **O2** Sign the exact statement from R2, and co-sign for the threshold:

  ```
  node release-channel.mjs sign --statement release-<v>.statement.json --key release-key.pem --out latest.signed.json
  node release-channel.mjs cosign --envelope latest.signed.json --key other.pem --out latest.signed.json
  ```

  The owner may instead run the candidate publisher with `--sign-key`. Either way, root places the envelope into the stage
  and runs R5.
- **O3 (for real provider independence)** Line up mirror operators other than Enclave, on infrastructure other than
  DigitalOcean, and pin them in the policy. This is not available today and no one should claim it.

## 4. Compatibility

- **Installed updater 36f9e0d6.**
  - With a policy, it calls the **installed** verifier f690c29b: `resolve`, then `download`. `release-gate.py` uses that
    same file, byte-identical, so the gate's verdict is the host's verdict.
  - It installs only a version newer than 2026.10.12.47.
  - On minipc (roles beside the release) it refuses an installer without ROLE-PRESERVATION-V1.
  - It does not roll back to the kept non-preserving .47 bundle (RECOVERY REQUIRED). That is by design; see Rollback.
- **Live channel 2026.10.12.47.** Hosts without a policy keep reading `latest.json`. A signed release published with the
  legacy pointer is newer for them too, so it is installed through the unsigned path. Gate R5 covers the files they
  receive, but not their trust; that is L1 for those hosts.
- **C1.** The next updater run on minipc moves the non-private `Enclave-setup` aside: the .46/.47 bundles are left
  untouched, and the next update is a full zip. That is safe under the r5 installer: a full install no longer deletes
  hs2 (native-proven r5).

## 5. Rollback

| Change | Rollback |
|---|---|
| R3 (a local file) | Delete it. |
| R4 (the policy on minipc) | An Administrator deletes `release-policy.json`; minipc then follows the legacy channel again. |
| R6 (published files) | Published files are immutable; stop by publishing nothing newer. A bad release already installed on minipc is NOT rolled back automatically, because r5 refuses the non-preserving .47 installer. Root recovers by hand: reinstall the previous preserving release by hand as an administrator, or restore files from the private backups. That stays root's procedure. |

## 6. Package

All files are in this directory; see RESULT.json for hashes.

- `compose-required.py` produces `required-release-files.v2.json` and its flat form.
- `channel_common.py`, `make-policy.py` and `release-gate.py` are the tools above.
- `test/test_gate.py` and `logs/gate1.out`: 11/11 on the shared queue (256 lane), local only, not Windows evidence. The
  cases are:
  - 2 positive releases: 1-of-1, and 2-of-2 both owners signed;
  - a byte added to the zip → G3;
  - an unpinned signer → G2;
  - version not newer → G4;
  - the legacy updater in the zip → G5;
  - the applied agent missing → G6;
  - a workspace test key refused by make-policy and by the gate;
  - 2-of-2 with one signature → G2.

  A throwaway P-256 key existed in a temp directory during the test only, and it was deleted.

## 7. Correction (root, after review): what independence means here

This replaces the parts of sections 2, 3 and 5 that say otherwise.

- The requirement is independence from **external** providers, not resistance to Enclave administrators or to Enclave's
  refusal.
- Mirror operators outside Enclave are **not** required. Channel copies served by Enclave hosts or apps in independent
  failure domains (not DigitalOcean, not one shared site) satisfy placement.
- No 2-of-3 or other new signing authority is a goal. The existing verifier supports the owner's policy. Keyholders and the
  threshold stay unchosen until the owner hands over the public spec(s).
- What remains for the channel's independence is a Windows-channel mirror on Enclave hosting outside DigitalOcean. None
  exists today: the hs2 host services are not activated, and minipc is one site.
