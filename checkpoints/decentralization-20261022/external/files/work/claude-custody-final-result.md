# Custody + shared Shield source closure: final result for coordinator review

**Repository:** `wo/work/enclave`. **Baseline HEAD:** `d0676ff303fb13e5109b8a99b5521012a898b2c8` (unchanged throughout).

**Constraints kept:** nothing committed or staged by me; no image built; no production, wallet or chain writes; no
Wine or GUI. Edited this pass: one test file (below) and two files under `work/`.

**Two distinct artifacts. This closes only the second:**
- **Shield-direct GUEST candidate `c7084346…`** (`work/shield-direct-build-0ed5a8ba/image/vbs-linux-c7084346/BUILD.json`):
  a Hyper-V partition image. It is unactivated, and none of this work builds or changes it.
- **Custody v2 CUSTODIAN image:** the SEV-SNP guest that `scripts/build-custodian-v2.mjs` produces. No custodian image
  was built here. The source for one is inventoried below, and the procedure is in section 3.

## 1. The certificate clock race: fixed (test only)

**File:** `test/custody-v2-shield-daemon.test.mjs`.

**The fix.** In "over HTTP at the custodian: malicious EKs take no pending slot…", the fixtures (`maliciousEks(world,
other)`) are now created **before** the clock is frozen (`let t = Date.now()`). The test then asserts the invariant the
race broke: every fixture's `notBefore` ≤ the frozen clock. Every rejection assertion is unchanged (status 403,
`shield_session`, the per-variant reason).

**Deterministic boundary coverage (new test).** "The certificate clock boundary, deterministically", using the
openssl-issued "discrete" EK:
- at `notBefore − 1 ms`, refused 403 with "does not chain to a pinned TPM root: EK chain cert 0 not yet valid";
- at exactly `notBefore`, refused 403 with the on-die reason.

Either way no pending slot is allocated. This pins the exact cause of the old intermittent failure.

**Runs:** the two cases, 5 serial runs, 2/2 each; the whole file once, 11/11. No broad suite was repeated; the previous
regression set is in `claude-custody-dns-bounds-result.md` and `claude-custody-hardening-result.md`. MemAvailable stayed
at or above 16 GiB.

## 2. Source closure inventory: `work/custody-final-source-inventory.json`

**How it was produced.** By `work/claude-custody-inventory.gen.mjs`, a read-only generator that lives outside the repo,
and can be re-run from `work/enclave` with `node ../claude-custody-inventory.gen.mjs`. It records:
- git porcelain XY (`??` untracked, ` M` unstaged) and sha256 for every listed file;
- the custodian image's actual bundle inputs, computed with the build's own `bundleOptions`/`bundleSources` (54 repository
  files plus `node_modules` packages and the esbuild version);
- the build's static sources, and what the build's own source check would refuse today;
- the DNS responder's import closure;
- each component test's import closure, filtered to dirty files outside this component.

### Component files to review and commit together

Full sha256 values are in the JSON; the first 16 hex characters are shown here.

| Kind | Status | sha256 (16) | File |
| --- | --- | --- | --- |
| prod | ` M` | 7b60672a23c88356 | custody/v2/custodian.mjs |
| prod | `??` | bf9302d98a091495 | custody/v2/shield-evidence.mjs |
| prod | `??` | a9b9e7bf21329c71 | custody/v2/shield-rules.mjs |
| prod | `??` | 0c146e20f3b288b9 | custody/v2/shield-operator.mjs |
| prod | `??` | 6f81e9c70544a004 | custody/v2/http.mjs |
| prod | `??` | 05771b528710d7e5 | custody/v2/host-config.mjs |
| prod | ` M` | 3082d9b8bfaef417 | custody/v2/daemon.mjs |
| prod | ` M` | 73247f905924bbf7 | custody/v2/build-config.mjs |
| prod | ` M` | 7d9b2d1aeae0e81f | custody/v2/ingress.mjs |
| prod | ` M` | 71cec859c0d3fb19 | scripts/build-custodian-v2.mjs |
| prod (shared) | `??` | 60d9ad86522d1e48 | relay/shield-host-session.mjs |
| prod (shared) | `??` | 6a25f5038afd67cb | relay/dns-challenge-shield.mjs |
| doc | `??` | eb739c0354a2d7b8 | docs/security/custodian-shield-recipients.md |
| test | `??` | 5dd6815e54a02501 | test/shield-custody.test.mjs |
| test | `??` | 8e08ff903a09f169 | test/helpers/shield-custody-rig.mjs |
| test | `??` | f7c3d62197625561 | test/custody-v2-shield-daemon.test.mjs |
| test | ` M` | 66d313796b257633 | test/custody-v2-build.test.mjs |
| test | `??` | 62630aba68785b0f | test/shield-host-session.test.mjs |
| test | `??` | 9d8b3a10b2a07290 | test/helpers/malicious-ek.mjs |
| test | `??` | 91373a4b13ad41b3 | test/custody-v2-ingress-ratekey.test.mjs |
| test | `??` | b714f30cd5016130 | test/shield-dns-challenge.test.mjs |
| test | `??` | 5ffeb8a3e0a56a8a | test/windows-shield-verifier.test.mjs (see dependencies) |

The hashes are a snapshot from when the generator ran. Re-run it immediately before committing.

### Imports that still depend on dirty code outside this list

| Dependency | Status | Needed by | Note |
| --- | --- | --- | --- |
| `windows/node/shield-verdict.mjs` | `??` (sha256 `6f134d8b…`) | **The custodian image** (via `relay/shield-host-session.mjs` → `attachMessage`), the DNS responder, and every Shield test | Authored in my earlier S4b work, now under `windows/` (outside my edit scope). **It must be committed with, or before, this component.** Otherwise the build's own source check refuses the image (it is in today's untracked list). |
| `relay/dns-challenge-attested.mjs` | `??` (`6d5ac110…`) | `relay/dns-challenge-shield.mjs` (`pushPreconditions`), and `test/shield-dns-challenge` | Authored in S4b (the pushPreconditions extraction). It must be committed with the DNS part. It is not in the custodian image. |
| `relay/dns-relay.js` | ` M` (`6d25011…`) | Wires `ATTESTED_SHIELD_POLICY` into the responder (the S4b opt-in) | Shared and possibly mixed with other workers' edits: the owner should review the diff. Not in the custodian image. |
| `windows/node/shield-sessions.mjs` | `??` | Tests only (`shield-custody`, `custody-v2-shield-daemon`, `shield-dns-challenge`) | The node's session client. |
| Windows worker's files | `??` / ` M` | `test/windows-shield-verifier.test.mjs` only | It imports `windows/node/{host, apptls, domains, isolation-client, secrets, shield-startup}.mjs`, `windows/vbslike/datapath/node-bridge.mjs`, and `relay/{shield-independent-verifier, shield-market-evidence}.mjs`. Commit this test with the Windows worker's change, or after it. |

**What the build's source check would refuse today** (`custodianImage.buildSourceCheckToday` in the JSON):
- **untracked:** `custody/v2/{host-config, http, shield-evidence, shield-operator, shield-rules}.mjs`,
  `relay/shield-host-session.mjs`, `windows/node/shield-verdict.mjs`;
- **dirty:** the ` M` custody and script files above.

**Static sources** (`isolation/m2/cmd/snpkey`, `go.mod`/`go.sum`, `relay/snp-verify.mjs`, `verifier`, `package*.json`)
are clean.

**Index observation.** During inventory, `custody/v2/build-config.mjs` was briefly **staged** (the index equal to the
working tree), then unstaged again a minute later. HEAD never moved. I did not touch the index. Another session presumably
did; the coordinator may want to confirm.

## 3. Building an unactivated custodian candidate from clean source

Do this only after the files above (with `windows/node/shield-verdict.mjs`) are committed. Then confirm
`git status --porcelain` shows nothing for those paths; the build re-checks every bundle input itself and refuses
otherwise. **Never pass `--allow-dirty` for a candidate.**

```sh
cd work/enclave
node scripts/build-custodian-v2.mjs \
  --base <METAL_DIST_DIR> \
  --out <NEW_OUT_DIR> \
  --vault <0xVAULT> \
  --host-ownership <0xHOSTOWNERSHIP> \
  --transport direct \
  [--independent-admission owner-permits | --independent-owners <owners.json>] \
  [--trusted-proxy 10.0.2.2] \
  [--shield-recipients <shield.json>] \
  [--vcpus 2]
```

### Operator inputs (none supplied here; none invented)

| Input | What it must be | Source of truth |
| --- | --- | --- |
| `<METAL_DIST_DIR>` | A metal control-image dist dir with `manifest.json` (`kernel.sha256`, `initramfs.sha256`), `initramfs.cpio.gz`, `vmlinuz`, `cmdline` (with `${MODE}`), and `/opt/metal/gsup.mjs` inside the cpio | The coordinator's pinned metal build |
| `<0xVAULT>` | The deployed `EnclaveSecretVaultV2` (nonzero) | The chain deployment record |
| `<0xHOSTOWNERSHIP>` | The vault's accepted host wallet authority (nonzero). The daemon refuses a vault whose `hostOwnership()` differs | The deployment record (`docs/security/independent-custody-activation.md` uses the placeholder `0xHOSTOWNERSHIP`) |
| Admission | None (legacy), `owner-permits`, or an `owners.json` of 3..64 wallets. Mutually exclusive. Either independent mode builds the static DKG helper | The committee's formation plan |
| `--transport` | `direct` (operator-owned Caddy ingress). **Required for `--shield-recipients`** (`tunnel` is refused) | The operator |
| `--trusted-proxy` | Recommended `10.0.2.2` for a direct image (QEMU's port-forward source, as documented; **not observed on hardware**). Absent means one shared rate bucket | The operator, after checking the peer address in a real guest |
| `<shield.json>` (optional) | `enclave-custody-shield-operator/1`: `acceptTier` exactly `windows-tpm-host/hv-node/T0-hv/hostExcluded:false`; `ekRoots` as **certificate-only PEM text**; `ekRootPins` exactly the self-signed roots; all 5 limits | The operator's own TPM root decision |

**Reference for the Shield file, not a decision.** The repo's `relay/fixtures/tpm-roots.pem` (the AMD fTPM `CN=AMDTPM`
root, sha256 `67bd2472…d0c6a1` = `AMD_FTPM_ROOT_SHA256`, plus the `CN=PRG-HPT` intermediate):
- **as stored, it is refused**, because of its 6 `#` comment lines (the validator accepts only certificate blocks);
- **with the comment lines removed, it validates**, pinned to `67bd2472a546751caca5f358a78f80727531671338960a9bcfdfbe6a34d0c6a1`
  with the default limits.

Whether to pin AMD only, or Intel too, is the operator's decision.

**Local toolchain.** Present: `go` (go1.27.2; the build pins `GOTOOLCHAIN=go1.27.0`), `cargo` with the
`x86_64-unknown-linux-musl` target, `readelf`, `sev-snp-measure` (`~/.local/bin`), and OVMF at
`~/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd` (override with `$OVMF`).
- **Not verified:** whether `GOTOOLCHAIN=go1.27.0` resolves offline. No Go build was run.
- **Fixed in the script:** the measurement parameters are `--vcpu-family 26 --vcpu-model 2 --vcpu-stepping 1` (Turin).

**Outputs and the next gate.**
- The build writes `<NEW_OUT_DIR>/{initramfs.cpio.gz, vmlinuz, cmdline, manifest.json}`.
- `manifest.json` includes `measurement`, `measurementSha256`, `bundleInputs`, `bundler`, `shieldRecipients`, and
  `trustedProxies`.
- The candidate is **unactivated** until its committee approves the measurement with `code-approve` (an on-chain,
  owner-signed step). That step is not done or prepared here.

## 4. Closed, and open

**Closed in this component:**
- the measured Shield recipient opt-in in the daemon and builder;
- the router extraction and bounds;
- challenge-time EK admission;
- the peer-based rate key with the measured trusted-proxy option;
- the ingress routes;
- the DNS responder bounds;
- the test clock race.

**Open, owned elsewhere:**
- committing `windows/node/shield-verdict.mjs` and `relay/dns-challenge-attested.mjs` (required);
- reviewing the `relay/dns-relay.js` diff;
- the Windows worker's `windows-shield-custody-transport` tests (seen failing in my earlier run against their
  in-progress image-selection change).

**Hardware boundaries, unchanged:**
- no real TPM, host session or custodian session;
- no observed slirp source address;
- no measured custodian image;
- no `code-approve`;
- Shield guest `c7084346` unactivated.
