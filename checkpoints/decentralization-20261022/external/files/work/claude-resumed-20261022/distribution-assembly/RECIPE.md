# Unsigned Windows release 2026.10.22.1: assembly, statement, signing gap (ROOT review required)

Prepared by Claude, 2026-10-22. Nothing was published, installed, signed or built, and no remote call was made. Root reviews
this package before any archive is accepted.

## What the release is

The release is the installed 2026.10.12.47 (manifest 5b966e81, the one root's native read found on minipc), plus exactly
the proven live overlay:

- 45 files carry their exact live/approved bytes, found locally by sha256 (`inventory.json`):
  - root's applied control package: 18 control files and privacy-agent cfb69370;
  - the live keep set: verifier f690c29b, update-watch 9104b137, the network bundles, natives…;
  - install-host.ps1 r5 1d1580c8 (native-proven, 51853);
  - update-host.ps1 36f9e0d6 (installed, 91208).
- 45 more required paths are byte-identical in the .47 base.
- **No native binary is rebuilt.** Every runtime, guest, bin and tray file, and both natives, are the .47 base's own bytes,
  which is what minipc runs today.
- No changed native source is in the required set. EnclaveSetup is the published .47 program f9779425. Its parameters
  (Name, Owner, CheckOnly, NoStart, Relay, SetupExe, Delta, Referral, EnclaveDNS) are all accepted by install-host r5.

**Version 2026.10.22.1** is newer than the published .47 and newer than the built-but-unpublished 2026.10.20.1
(abe86262). No local release inventory uses it.

**Manifest** uses .47's exact format: `product`, `version`, `control`, `files[path, sha256, bytes]`, UTF-8 BOM.
- `control` is written as `fb6561c0+live-overlay`. No single source commit exists for this overlay, so none is invented.
- Nothing reads that field; I checked install-host r5, update-host 36f9 and the candidate tree.
- Provenance goes to `ASSEMBLY.json`, outside the zip.

## Steps (ROOT)

1. **Inputs (ROOT-REQUEST Q2):** put the published `enclave-host-2026.10.12.47.zip` and `EnclaveSetup-2026.10.12.47.exe`
   into `inputs/`.
2. **Assemble:**

   ```
   python3 work/claude-test-queue.py --mib 512 --log <unique> -- python3 -B assemble.py --inputs inputs --out out-2026.10.22.1
   ```

   - It refuses on any pin mismatch.
   - Outputs:
     - `enclave-host-2026.10.22.1.zip` (deterministic: sorted names, date 2026-01-01, DEFLATE 9);
     - `manifest-2026.10.22.1.json` (== the zip's `manifest.json`);
     - `EnclaveSetup-2026.10.22.1.exe`;
     - `SHA256SUMS`;
     - `release-2026.10.22.1.statement.json`, **UNSIGNED**, built by the live verifier's own `statement` command over
       the actual artifact hashes and sizes;
     - `ASSEMBLY.json`.
3. **Root review** of `ASSEMBLY.json` and the archive, before acceptance.
4. **Missing for a signed release (OWNER; nothing invented here):**
   - the owner's P-256 **public** key spec(s) (`release-channel.mjs pubkey`). The keyholder(s) and threshold are the
     owner's choice; none is chosen here.
   - the owner's signature(s) over the exact `release-2026.10.22.1.statement.json`:

     ```
     release-channel.mjs sign --statement ... --key <owner pem> --out latest.signed.json
     ```

5. **Gate:** with the owner's public spec(s), root builds the policy and runs the gate (G1–G6):

   ```
   distribution-closeout/make-policy.py   ...
   distribution-closeout/release-gate.py --channel-dir out-2026.10.22.1 --policy <policy> --on-disk live-hashes.json
   ```

   Run optional Q1 first to get `live-hashes.json`.
6. **Publish or install: NOT in this package.** Publishing stays frozen.

## Blockers and preconditions (precise)

- **B1 Base input (Q2).** The archive cannot be assembled until the two published .47 files are supplied. This is the
  only missing input; all 90 required/top-level files are otherwise proven (inventory: 45 BASE, 45 OVERLAY, 0 MISSING).
- **B2 Signature.** No production release public key or signature exists. The statement stays unsigned until the owner
  signs. No policy, test key or fictional key is made into a production one.
- **B3 Live launcher/config regeneration (feature/admin-config preservation).** Every install by install-host r5 rewrites
  these from its templates:
  - `ProgramData\Enclave\run-node.cmd`
  - `node-config.cmd`
  - `run-network.cmd`
  - `shield-config.cmd`
  - `run-card.cmd`

  Only `node-config.local.cmd` (called last, never written by an update) and `network\privacy-config.json` survive.
  - The live `run-node.cmd` is root's repaired launcher, carrying the 5-RPC `BASE_RPCS` line from the RPC repair. It is
    NOT the template's output, so a release install would drop those settings.
  - Precondition before any install of this release: root moves every live-only launcher/config setting into
    `node-config.local.cmd`. That includes the RPC set, and the platform host policy activation that root's worker 54825
    is preparing (A1).
  - Then verify the agent's effective environment read-only after install.
  - The release sets no platform-policy value: it does not hard-code it off.
- **B4 A1 fix pending.** If the platform-policy fix changes any release-carried file, re-run, in order:
  1. `distribution-closeout/compose-required.py` with the new applied package;
  2. `inventory.py`;
  3. `assemble.py`, into a new out directory.

  The current archive would then be superseded.
- **B5 Channel independence.** The statement fixes integrity only. Every Windows-channel copy today is on the DigitalOcean
  fronts. External-provider independence needs a channel copy served by Enclave hosting outside DigitalOcean, in an
  independent failure domain. None serves the Windows channel yet: hs2 host services are not activated, and minipc is one
  site. Non-Enclave operators are not required. **No unsigned or DigitalOcean path is called independent.**
- **B6 New-user bootstrap.** Setup is the .47 program, which does not verify the signed channel. The candidate
  `EnclaveSetup.cs` (e55a8a90) does, but it is not built: that would be a C# build on Windows, not Rust/Go, and it is
  root's call. New users still trust the download origin for their first install.
- **B7 Publisher.** The candidate publisher 9d69fae2 does **not** apply cleanly by itself to published main (b2a79e9a,
  which still targets `nan`). It runs `windows/node/release-channel.mjs`, which main lacks.
  - It applies only as a 3-file set: the publisher plus `release-channel.mjs` f690c29b and `update-watch.mjs` 9104b137,
    both byte-identical to minipc's live files.
  - It keeps main's `host.ps1` publication.
  - No standalone patch is issued; root decides on the set.
  - The dirty `work/enclave` tree and published main 7752a423 are untouched.

## Rollback

There is no production effect until root installs or publishes; deleting `out-*` discards an assembly. After a future
install, rollback follows `distribution-closeout/RECIPE.md` section 5.
