# Independent review: Shield lineage integration and direct custody startup

Reviewer: Claude.

**Inputs:**
- `outputs/shield-independent-startup.json`
- `docs/network/independent-shield-image.md`
- worktree `work/shield-lineage-integration`: `90c432d8` → `48ba612c` (restoration) → `7f019ce2` (direct custody)

Nothing was committed, staged, discarded or deployed. There was no VM, SSH, Wine, GUI, production or chain activity.

## What was reviewed, and how

1. **Main matches the worktree.** All 41 files changed by `90c432d8..7f019ce2` are byte-identical in main's working tree.
2. **The restoration matches production `1dad2bb5`.** These files are byte-identical:
   - `domexec.c`, `monitor/main.go`, `secretrun`;
   - `shieldconfig/*`, `front/shield_secrets.go`;
   - `egress/{socks,app_routes,dialer}.go`, `cmd/shield-egress`, `contract/bundle.go`, `egress-probe.c`.

   Only these files were merged: `egress/{web,forward,policy}.go` and `front/shield_egress.go`.
   - `web.go` differs only by renaming `publicConnect` → `publicWebConnect` and moving `PublicSOCKSAddress` into `public.go`.
   - SNP `public-https` and Shield `public-web` share `127.0.0.2:1080`. `Forwarder.Start` refuses a policy that is both, so they cannot collide.
3. **The direct custody delta, read line by line** (`shield_direct_custody.go`, `shield_direct.go`, `shield_direct_off.go`, `main.go`, `policy.go FromShieldBootstrap`, `shield_egress.go startDirect`), together with the runtime and launcher sides (`secretrun`, `domexec` secret mode, monitor file writes) and the JS custodian adapter it talks to.
4. **Re-ran the suites myself**, one job at a time with `GOMEMLIMIT=200MiB`:
   - m2 `front`, `egress`, `shieldconfig`, `custody`, `bootstrap` and `cmd/shield-egress`, in the default, `bootstrapdirect` and `bootstrapdirect shielddirect` builds: all ok;
   - every m3 package: all ok;
   - JS Shield, S4b, preclaim, isolation-host and attested-responder suites: 86 pass, 0 fail, 1 todo (finding F2 below).

## Requested properties: verdicts

| Property | Verdict | Evidence |
| --- | --- | --- |
| Default SNP `PublicHTTPS` unchanged | **Holds** | `deriveOrigins` → `derivePolicy(…, false)`: the `shield=false` branch is logically identical to the previous code (a non-object document still falls through to `walkStrings`; `"public-web"` on SNP is still an error). `f.publicHTTPS` is still set only on the M2 init path. |
| Shield public-web stays measured | **Holds** | The monitor's marker, the front's mode (`FromShieldBootstrap` / `ForShield` take `PublicWeb` from the committed or measured bytes, never resolved values) and `secretrun`'s `ENCLAVE_EGRESS` all derive from the same measured bytes. The front refuses a marker disagreement. Shield never sets `PublicHTTPS`. |
| Measured config and deployment bind the exact bootstrap | **Holds, strict equality** (see F1) | `/app.config` must equal the committed `configText` byte for byte, both in `prepareShieldDirect` and again in `startDirect`. The monitor-owned `/secret.id` must equal the package's deployment. The AppID comes from the monitor-written `/app.sha256`, checked by `Authorize`. |
| Custody bundle hash | **Holds** | `bundle.ConfigSha256 == sha256(configText)`, the same rule as SNP `custodySecrets`. The partials' DLEQ proofs are checked against the pointer's `R`, so a pointer bundle that differs from the vault's fails to combine or open. |
| Owner/lease revalidation immediately before the secret pipe | **Holds** | `auth.Revalidate` runs after custody, again after egress setup, then the pipe is written. `owner-changed-during-egress` covers this with a real ABI owner flip. |
| No relay fallback in the direct build | **Holds** | `f.secrets` (the legacy relay release) is never constructed when `directBootstrap`. `FromShieldBootstrap` passes no relay origin, and a test asserts `api.enclave.host` is not allowed. A non-Shield direct build given a secret pipe closes it and dies (`shield_direct_off.go`). |
| Report binding: owner, recipient, runtime, app; no nonce | **Holds in the guest**; one cross-side mismatch (F2) | Input = `ShieldReleaseInput(BindingV2(…RuntimeID, transport SPKI, R, challenges…), owner) ‖ AppID(monitor)`. The document has no `nonce`, and tier and format are checked. A clean wx scan is required. The Go fixture custodians recompute the binding. |
| Front, monitor and native command lifecycle | **Holds** | `domexec` gives the front fd 7 (write end) and `secretrun` fd 7 (read end), and closes both originals after the spawns. A front that fails or dies means the pipe reaches EOF, `secretrun` exits 125, and `domexec` ends the domain. On success `secretrun` execs only `/plat/rt/…` → `/app.wasm`, with validated names and values off argv. |
| Runtime blocking and cleanup | **Holds** | The runtime waits on the pipe. Every error path closes the pipe unwritten (deferred twice, harmlessly). The forwarder is closed unless kept, and the payload is zeroed. Timing: the V6/V7 readiness deadline is 300 s, which covers authorization (≤30 s) plus `custodyWindow` (3 min) plus revalidations. The front's 120 s listen wait starts only after the synchronous custody step. |
| Shared image selection | **Defect in deployment shape** (F3) | See below. |

## Findings

### F1: a non-canonical `configText` is accepted by the host and refused by the guest (fixed, host side)

- **What happens.** The partition's bundle stores the manager's canonical rendering of the config: `appConfigText(configText || "{}")`, `_media` removed, or no file at all for a public app with no effective config. The Shield-direct front requires `/app.config == configText` exactly.
- **Why the host missed it.** The S4b host derived the correct AppID from the normalized config, so it accepted packages spelled `"{}"`, with whitespace, or with `_media`.
- **The consequence.** Such a package would be claimed, spawned, and then the partition would die (`Shield measured config differs from owner commitment`). The lease would be given back after gas was spent.
- **Not a security problem.** The guest fails closed.
- **Fix.** `windows/node/shield-startup.mjs materialize` refuses, before any claim (`package.configText`, definite), a package whose `configText` is not exactly the bytes the partition measures, whenever the manager states a Shield-direct image. Managers without a Shield-direct image are unchanged.
- **Regression test.** `test/windows-shield-startup.test.mjs`, "a Shield-direct partition is started only for a configText that IS the bytes it measures…". It failed before the fix, and now `"{}"`, whitespace and `_media` spellings are refused while `""` and canonical V5 text pass; a legacy manager is unchanged.
- **Follow-up (owner tooling: CLI and site).** Shield packages must commit the canonical text:
  - `""` for no config;
  - `"{}"` for a secrets-only package;
  - and the custody bundle's `configSha256` over those same bytes.

  The guest equality is the right invariant and was not changed.

### F2: owner binding mismatch for session-vault-owned deployments (reported, not fixed: custody/v2 verifier is out of scope)

- **Guest side.** The guest binds `auth.NameGrant().Owner`, the ledger row owner (`shield_direct_custody.go`).
- **Custodian side.** `custody/v2/shield-evidence.mjs` is called by `custodian.mjs` with `owner: pol.owner`. The custodian requires `pol.owner == beneficialOwnerOf(id)`, and `EnclaveSecretVaultV2.beneficialOwnerOf` resolves a session vault to its human owner.
- **The consequence.** For any deployment owned through a session vault, the two owners differ, so every Shield custody release is refused (`evidence_refused: guest binding differs from verifier request`). This fails closed. EOA-owned deployments are unaffected.
- **Reproduction.** `test/shield-custody.test.mjs`, "session-vault owner: …", added as a `todo`. It asserts the correct outcome and currently fails at exactly that check. The rig gained a `ledgerOwner` option whose default keeps every other test identical.
- **Suggested fix (coordinator's call).** In `custodian.mjs`, pass the ledger owner `s.lease.owner` to the Shield verifier. That is what the guest reads, and the custodian already requires the policy owner to be its beneficial owner. The other option is to have the guest bind the beneficial owner, but the guest cannot read that from its quorum today. Then drop `todo`.

### F3: one Shield image serves every domain, and a Shield-direct front kills every domain without a package (reported, not changed)

- **The shape.** `build-domain.sh` installs one `plat/front` per image, and the manager pins one CPU image (`ENCLAVE_SHIELD_DIRECT=1` states that image is Shield-direct).
- **What a Shield-direct front does without a package.** On an m3 domain with no `HOST_DATA` (every Shield domain), it always runs `shieldDirectOwner`. That requires the vsock 9446 package frame, and with no frame it dies.
- **What the manager carries.** It serves the package only for owner-committed spawns (`server.mjs`: V1/V5, public, no secrets).
- **The consequence.** Enabling the direct image on a host would end:
  - every legacy public deployment;
  - every legacy relay-secret deployment (refused by design in this build);
  - the host's own readiness witness (`shield-readiness-v1`), which the S4b selected-verifier market depends on.

  The S4b host would then give up those leases. This fails closed, but it is a feature-parity and availability break for existing hosts. Production is not affected today: the direct image is not built or pinned.
- **Options (manager admission or guest; coordinator's files):**
  - (a) pin two CPU images and select per spawn by the presence of `bootstrap`;
  - (b) give the witness and legacy public spawns a package (the witness has no owner, so this is a design change);
  - (c) let the Shield-direct front serve a public, secret-less domain with no owner names when no package frame is offered. This is no relay fallback: a withheld package only loses names, which the host could also deny by stopping the domain. Secret domains must keep failing closed.

  I recommend (a) or (c). I did not edit `shield_direct*`, `main.go` or the manager.

### Notes (not defects)

- The S4b host's `direct` set (`shield-startup.mjs`) and the manager's `bootstrap` admission (`server.mjs`) are both V1/V5, public-only. When the 9445 custody-authorization transport and `supports.custodyV2` land, both must admit V6/V7 custody spawns. Until then the host refuses custody-v2 on Shield, which is correct, as the evidence file's limits state.
- `hostData()` on a vTPM image makes a full VBS report (about 2 s, and busy-locked) just to learn the format at front start. It is harmless, since any error also yields `hdErr`.
- Protections in the test suite that I relied on and did not weaken:
  - `measured-config-changed`, `custody-config-changed`, `owner-changed-during-egress`;
  - `wrong-monitor-tier`, `missing-runtime-scan`, `custodians-refuse`;
  - the source oracle;
  - the relay-origin assertion.

## Files changed by this review

| File | Change |
| --- | --- |
| `windows/node/shield-startup.mjs` | F1 fix: a pre-claim refusal of a non-measured `configText` for Shield-direct managers. |
| `test/windows-shield-startup.test.mjs` | The F1 regression test. |
| `test/shield-custody.test.mjs` | A `ledgerOwner` rig option (default unchanged) and the F2 `todo` reproduction. |

## Hardware and activation gates (unchanged by this review)

1. The measured Shield-direct image, repinned.
2. The OpenHCL volatile-input proof.
3. The vsock 9445 custody-authorization transport, `supports.custodyV2`, and V6/V7 admission on the host and manager.
4. The custodian daemon adapter and routes via `code-approve`.
5. An owner policy with the Shield acknowledgement.
6. A real fTPM/IDKS session, and a release to a live partition.
7. Resolution of F2 and F3 before any host enables `ENCLAVE_SHIELD_DIRECT=1`.
