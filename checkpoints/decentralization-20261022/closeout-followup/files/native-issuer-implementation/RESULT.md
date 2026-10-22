# Native CA issuer on the platform API primary: implementation (source and tests only)

Worker: Claude. Date: 2026-10-22. Author/committer: SteveDeFacto <5148995+SteveDeFacto@users.noreply.github.com>.

**Status: implemented and tested in source. NOT activated, NOT imaged, NOT measured.**
- No live CA, SSH, RPC, wallet, signing, funds, provider action or image build happened.
- The only key material used is throwaway test keys generated per run.

## Delivered

| Item | Value |
|---|---|
| Repo | `repo/`: an isolated clone of `native-control-attested/repo` at **8e77ff1eca24be3c02e281dc9f431af597165adf**, origin removed, branch `native-issuer` |
| Commit 1 (source, tests, docs) | **2abf2bfde6c89963f3b590b08406c35a5b75387a** (tree b467c7b7). Patch: `native-issuer-source.patch` |
| Commit 2 (regenerated platform API guest bundle) | **9b164d3ac3d8846db2b24a157fd61c907cbdaa8f** (tree ee1f8268). Patch: `native-issuer-bundle.patch.gz` |
| Bundle | sha256 `a0c8527a…959953`, 8 702 016 bytes, 2219 inputs (was `3078345b…` at the base). Its gitignored prerequisite `relay/network-runtime.bundle.mjs` is `8399d143…` (copied). Root may drop commit 2 and rebuild at composition. |
| Hashes and evidence pointers | `MANIFEST.json` |

### Files
- **NEW `metal/guest/native-certificate.mjs`**: a library with no command line.
  - It holds the request, the pins and the install moved from the CLI.
  - It adds a bounded GET-only `untrustedRead`.
  - It adds `signNativeLeaf`, a narrow DER encoder for exactly the existing leaf profile.
- **NEW `metal/guest/native-issuer.mjs`**: the issuer (`createNativeIssuer`, `issuerDeps`, `servedLeaf`).
- **`metal/guest/platform-api-role.mjs`**:
  - issuer lifecycle;
  - `GET /platform-api/config` (read-only);
  - the relay-child environment and file filter;
  - per-sink archive pairs;
  - production dependencies in `main()`.
- **`scripts/native-control-certificate.mjs`**: re-exports the moved functions. It keeps its openssl `issue` as the offline/admin fallback.
- **`scripts/build-platform-api-guest-bundle.mjs`**: requires the new modules and refuses to bundle the CLI.
- **Docs**: `docs/network/measured-control-guest.md` and `docs/network/hosted-platform-api.md` (credentials table).
- **Tests**: `test/native-certificate-leaf.test.mjs` and `test/platform-api-native-issuer.test.mjs`.

## How it works (as implemented)

- **Where the CA key lives.** Only in the admin-signed platform credentials `NATIVE_CA_KEY` (PEM) and `NATIVE_CA_CERT`. These use the existing package, sealed to the primary's boot.
  - They are replicated as AEAD under K and archived as ciphertext, with K escrowed to `platformApi.recovery`.
  - The relay child never sees them. The role deletes every `NATIVE_CA_*` name at the final environment boundary, whatever its source: sealed credentials, `relayEnvBase`, or a bound `relayEnv` such as `NATIVE_CA_CERT`. The credential files on the RAM fs are rewritten as exactly the current set.
- **Who issues.** Only the current primary: `onLeader` → `syncIssuer`. Leadership loss, `stop()`, and any credentials package that removes or replaces the native CA stop the run. The stop aborts the run's timer and every connection it holds.
- **For each `platformApi.members[i]`, in single-flight rounds, one attempt per member at a time:**
  1. **Is renewal due?** `servedLeaf` makes an untrusted GET of the served chain. Renewal counts as unnecessary only if every one of these holds:
     - the leaf is signed and issued by the held CA, and the served CA has the same DER;
     - the leaf is over the key the front presented;
     - the leaf is not a CA and has serverAuth;
     - its SAN lists only native names;
     - its validity has started, and it is not past the CA;
     - more than 2 days remain before expiry.

     Anything else proceeds to full verification. A refused member backs off, unless it rebooted (a new presented key).
  2. **The member's bound config.**
     - It is read from its control URL with a GET only, unpinned, and trusted only after step 3.
     - The leader uses its own config.
     - It must carry this group's exact `platformApi` member and the member's identity, and bind `nativeControl` to this CA. The config must also come from the same key that then verifies.
  3. **The serving boot.** `verifyMeasuredControl`, unchanged, at that URL with exactly that config, the group's measurements and TCB floor, the original registry quorum, and AMD collateral. `issuerDeps` uses a cached KDS source in production and a synthetic one in tests.
  4. **Fresh admission.** A platform host policy decision with the verifier's chip, through `nativeHostDecision`, the same decision native discovery makes. Policy explicitly `off` refuses issuance.
  5. **The request.** It comes from evidence re-read over a connection pinned to the attested key, through `nativeCertificateRequest`. It carries the public key and bound names only.
  6. **The signature.** `signNativeLeaf`:
     - issuer = the CA subject DER verbatim;
     - extensions in openssl's order: BC critical CA:FALSE, KU critical digitalSignature, EKU serverAuth, SAN, SKI, and AKI = the CA's SKI (omitted when the CA has none);
     - 7 days, never past the CA, notBefore 10 minutes back for clock skew;
     - only a P-256 CA key that is the CA certificate's own key;
     - the CA itself is never re-encoded or changed.
  7. **The barrier before install.**
     - The run must still be the current one, and the credentials digest unchanged.
     - Admission is decided **again**, so a ban since step 4 stops the install.
     - `node.commit()` must succeed as primary with the lease valid.
  8. **The install.** The existing PUT, through `installNativeCertificate`, which **refuses** a missing, null or malformed pin before connecting. Over a wrong key it sends zero application bytes. The guest's own install checks (its key, the bound CA, a real TLS handshake per name, a later expiry) stand.
- **The leader's own leaf** goes over loopback, `https://127.0.0.1:<controlPort>`, to its own front, which is another process in the guest. There is no public hairpin, and native names are never used for issuance, so there is no bootstrap loop.
- **The issuer never has a guest private key.** Its checks are public: signature, issued-by, SPKI and profile. `checkNativeCertificate`, which needs the target key, is used only by the guest's front and by explicitly labelled test fixtures.
- **Archives.** A sink counts only when BOTH its snapshot and its recovery envelope were written. Crossed half-writes across sinks fail the archive. `status().archive` records the head and the complete-pair count.

## Test evidence (all through `work/claude-test-queue.py`)

Every job ran offline in a fresh user and network namespace (loopback only, no default route) with ssh, scp and sftp denial stubs proven first in PATH. Logs are in `logs/`.

| Job | Cap | Result |
|---|---|---|
| **`final-r1`** (last) | 512 | **rc 0**. Bundle rebuild, `--check`, start smoke (reaches the role's config read; no CLI text in the bundle). Leaf 5/5, role wiring **11/11**, `native-control-attested` 9/9, `platform-api-hosted` 6/6. Peak 429 MiB (esbuild). |
| `regress-r1` | 512 | rc 0. Existing suites 9/9 + 6/6, peak 291 MiB. |
| `bundle-r1` | 512 | rc 0. Bundle `a0c8527a…`, smoke OK, peak 305 MiB. |
| `issuer-r3` | 512 | rc 0. 5/5 + 10/10, before the ban-at-barrier test was added. |

**Role-wiring tests** (real fronts, real roles with the real relay child, the real verifier on a synthetic two-chip AMD chain, the original-registry JSON-RPC quorum, the anchored admin policy world):
1. Admin credentials make the primary issue every bound member, itself included over loopback, with exactly the bound names. On the next round each member is `current`. The relay child environment has `STRIPE` but no `NATIVE_CA_*`, base-injected or bound canary, and no key text. The creds dir holds exactly the current `_FILE` set; a replacement leaves no stale file. Logs, status and archives hold no key text.
2. `servedLeaf` treats a genuine leaf as current. All of these are not current: a self-signed leaf next to the copied CA, a leaf from another CA, a wrong presented key, a CA-flag leaf, a non-native name, not-yet-valid, three certificates.
3. No leaf under an operator ban, a chip ban (sha256 CHIP_ID), an unproven chip under a chip denial, or an unregistered boot (verifier pending). Lifting each one issues.
4. **A ban published after signing and before install** is refused at install; nothing is installed.
5. A member bound to another CA, an impostor of another group, and an impostor lying about its config (HOST_DATA mismatch) get no leaf.
6. **Credential replacement** during a paused round aborts its install; the new run refuses members bound to the old CA. **Removal** makes the issuer inactive. Restoring issues again.
7. A **stop releases a held connection at once** (a silent front sees the close well within the 8 s request timeout), and no new connection follows.
8. **Leadership loss** between signing and install: every member is partitioned through the role's real replica transport. The primary steps down, its issuer stops, nothing is installed, and no primary exists meanwhile. After healing, the new primary issues.
9. **Archives**: crossed half-writes fail, with no archive recorded. One complete pair counts as 1 of 2; both pairs as 2.
10. **Total loss**: kill all members, admin `recover` from one sink's pair to fresh boots. The restored credentials restart the issuer, which issues all fresh boots.

**Leaf and pin tests:**
- OpenSSL `verify -verify_hostname` under a name-constrained, pathlen-0, multi-RDN CA. A non-bound name gives a hostname mismatch.
- Byte comparison by an independent DER walk: the issuer field equals the CA subject and equals the openssl-issued leaf's issuer field.
- Identical extension list and criticality versus the existing openssl issuance; SKI and AKI values checked.
- CA-expiry cap; a CA without SKI gets no AKI; refusals for a mismatched, RSA, P-384 or non-CA key or certificate, a wrong `caSha256`, foreign names or a wrong SPKI, never echoing key text.
- **Pins**: undefined, null, `''`, malformed, uppercase and truncated SPKI produce **0 TCP connections and 0 application bytes**. A well-formed wrong SPKI produces 2 connections and **0 application bytes**.
- `untrustedRead` sends a body-less GET only; an abort closes the socket in under 2 s.

**Mutation controls** (`mutants-r1/r2/r3`, cap 512, baselines green):

| Mutant | Result |
|---|---|
| M1: final relay-env filter removed | KILLED |
| M2: servedLeaf without signature/issued-by | KILLED |
| M3: barrier `holds()` → true | SURVIVED (see below) |
| M3b: M3 plus no live step after the re-decision | SURVIVED (see below) |
| M3c: M3b plus install not tied to the run abort | KILLED |
| M4: no re-decision at the barrier | KILLED (by the bound, exit 124, after the ban test failed) |
| M5: a half-written sink counts | KILLED |
| M6: null SPKI accepted at socket and install | KILLED |

M3 and M3b are not tested-away defects. "No install after a stop or credential change" has three independent layers: the live checks, the holds/digest check, and the run abort that refuses the install connection itself. Only removing all three (M3c) is observable. The credentials-digest comparison in `holds()` is defense in depth: `syncIssuer` already restarts the run on every credential change.

**Failed logs preserved:**
- **`logs/leaf-r1.log`** has no `.rc`. Cause:
  - test 2's TLS client socket was never destroyed, and failed tests left server sockets open, so `node --test` kept the event loop alive;
  - my outer `timeout 590` wrapped `q.sh` itself, so `q.sh` was killed before writing `.rc`.

  Fixes:
  - every socket is tracked and destroyed in `after()`;
  - every test has a timeout;
  - `--test-force-exit` is set;
  - the bound sits inside the job;
  - `tmp/` holds no leftover process or dir.
- **`logs/issuer-r1.log`** (rc 1): an impostor fixture lacked `sessionDir` (EACCES on `/mnt/ramdisk`), which cascaded into an unremoved member and an occupied port.
- **`logs/issuer-r2.log`** (rc 1): test 7 started while the primary's relay restarted. Tests now wait for a primary.

All failures were in the test harness, not the issuer. Fixed and re-run green.

## Activation recipe (root only; NOT performed)

1. **Compose.** Merge with the native-forwarding fix (ca311820) and the front-cancellation fix (0454 worker, `native-front-abort`).
   - This change does not touch `createControlFront` or the role's standby forwarding (line ~296).
   - Rebuild `relay/network-runtime.bundle.mjs` first, then `node scripts/build-platform-api-guest-bundle.mjs` and `--check`, then the image. This means **a new measurement**.
2. **Group.** At least 3 registered SEV-SNP members with distinct operators. Their configs carry the identical `platformApi` member and `nativeControl: { names, caSha256: 86bf2c48…a62c }` (the live CA). Genesis or import as in `docs/network/hosted-platform-api.md` "Activation".
3. **Provision.**
   - The admin builds the **complete current credential set** from their own held copy, plus `NATIVE_CA_KEY` and `NATIVE_CA_CERT` (the live CA key and certificate, extracted by root or the admin from the minipc control VM or its existing encrypted backup).
   - The package REPLACES all credentials, so never send the CA alone.
   - Run `scripts/platform-api-admin.mjs credentials` against the primary, signed by a `platformApi.admins` wallet. This is a signature, not a transaction.
   - Check that the 200 answer's `names` equals the previous names plus the two.
4. **Observe.**
   - `GET /platform-api/status` shows `nativeIssuer.state = active` and each bound member `issued`, then `current`.
   - Native clients verify `api.enclavehost.eth` and `mcp.enclavehost.eth` with the pinned CA.
   - Keep the minipc timer running through at least one full renewal cycle (leaves under 2 days are renewed).
5. **Retire minipc issuance.** Root disables `enclave-native-certs.timer` and removes the CA key from the minipc VM. The encrypted cold backup stays admin escrow; that is root's decision.

**Rollback:** a newer admin credentials package without `NATIVE_CA_*` stops issuance at once. Leaves already installed expire within 7 days. Re-enable the minipc timer, or use the offline CLI. Image rollback is the previous measurement.

## External prerequisites (real)

- **Hardware.** At least 3 SEV-SNP measured control hosts with distinct operators, registered in the original EnclaveRegistry. Today only metal0 exists, and all authorized hardware is at one site.
  - **Three guests on one chip or at one site are NOT independent failure domains.** They test quorum mechanics only.
- **Admin.** Admin wallets plus `platformApi.recovery` X25519 keys held by the admin, and a platform host policy anchored by the admin.
- **AMD collateral reachability** from member guests: KDS or a mirror, cached on the RAM fs. This is unverified on hardware.
  - Existing defect, not fixed here: the role's HANDOFF verifier `productionVerifier(cfg)` passes no collateral. On real hardware it cannot complete `verifySnp`, which would fail with "no AMD ASK/ARK chain". The issuer has its own cached-KDS collateral, but **a new or rebooted member cannot receive K in production until that is fixed** (one line in `main()`; root decides).

## Residual limits

- **Separate open work, not done here:**
  - native `get`, `ipfs` and `sia.enclavehost.eth` (the shared minipc `services.key` leaf);
  - placement of `relay/native-discovery.mjs` (it serves `/native/ca.pem` and routes from the minipc VM);
  - ENS-authorized CA bootstrap for new clients.
- **DigitalOcean stays minimal WireGuard transport.** Nothing here adds a service there. My earlier report's SNI wording is not an approval.
- **Policy not activated.** When the book anchors no policy (activation `anchor`), the decision is `not-activated` and admits, the same semantics as native discovery. An explicit `off` refuses.
- **Verifier calls cannot be aborted.** A timed-out `verifyMeasuredControl` call cannot be aborted mid-flight. Its requests carry their own timeouts (8–15 s), its result is discarded, and that member is not re-attempted until it finishes. At most one per member is outstanding.
- **Served-leaf names.** `servedLeaf` checks that the SAN lists only native names, not that it equals the member's bound names. The member's own install check requires every bound name, so a real front never serves fewer.
- **Synthetic tests.** All attestation in the tests is synthetic. Nothing proves AMD hardware, a real measurement, or production RPC and policy-mirror behaviour.
