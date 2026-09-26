# metal-iso0 node image N1 (the guest-certificate retry): plan

enclave-63, 2026-09-26, for enclave-87. This is a plan only: nothing has been built, installed or changed.
Facts were read at about 06:45Z from the git history, the live unit and the live image manifest.

## 0. What runs today

- **Node image.** `config.iso.json` sets `dist` to `/home/steven/Projects/enclave/metal/dist-iso-f6cbd75a`.
  - Measurement: 02f6e313… (4 vCPU).
  - Overlay commit: f6cbd75a, which is 87e881a2 (gsup release opt-in) plus b3109929 (-ffile-prefix-map).
  - Pinned inputs: base supervisor image `…@sha256:2f8e84f8…`, wasm-manager image `…@sha256:46024085…`, OVMF 142589cc, min-tcb fe90824f.
- **Launcher (host code, not measured).** metal-578be084's `metal/enclave-metal.mjs`, sha256 4620da5d.
  - It is selected by the drop-in `enclave-metal-iso.service.d/10-launcher.conf`, which sets `WorkingDirectory` only.
- **How an image is made.** Pinned base containers, plus 8 overlay files taken from the build commit, plus the `metal/` build inputs (gsup, build-image.mjs).
  - The 8 overlay files are: supervisor.js, supervisor-transport.mjs, control-client.mjs, supervisor-splice.mjs, supervisor-guestcert.mjs, m2/judge.mjs, contract/runtime.mjs and relay/snp-verify.mjs.
- **Why not main.** The image can't be built from `main`.
  - The isolation line forked from main at ae25c406. Main is 204 commits ahead of that point.
  - Main has no `isolation/m4/guestd/supervisor-transport.mjs`, and its `relay/snp-verify.mjs` differs.
  - The live image, and N1, are built from the isolation line.

## 1. What N1 picks up

The build commit is **2492e683** (`origin/isolation/guestcert-retry-e63`). It contains b3109929, 87e881a2 (as 10aa91f6) and the launcher merge 578be084.

| overlay file | live f6cbd75a | N1 2492e683 | |
|---|---|---|---|
| supervisor.js | c5a2d534 | 82bba076 | **the only change** |
| the other 7 | = | = | byte-equal blobs |

supervisor.js changes by +64/−8 lines, with no new import or require. That comes from three commits:

- **2c4c8cc9:** a guest that guestd still reports as STARTING is retried after 20 s and is not counted as a failure. The pass loop wakes at the first back-off that falls due. Reviewed by bf (GO).
- **e0b0c07b:** once the 30 short tries are spent, a guest still starting stays on the doubling back-off, so there is no 20 s / 300 s cycling. Reviewed by bf (GO).
- **2492e683:** the back-off and its counts are keyed to the INSTANCE. A relaunched guest never inherits its predecessor's back-off. This adds `guestCertSkip`, `guestCertFailure`, a relaunch test and 2 mutants; the test file passes 9/9. Reviewed by 5d (GO); 87 made it required.

Other inputs:

- **`metal/`:** only `enclave-metal.mjs` differs from f6cbd75a, and it equals the live launcher (4620da5d). So there is no launcher swap: the drop-in stays.
- **gsup** is byte-equal to the live image's.
- **Also in the commit but not in the image:** the cli, `isolation/restore/*` and the tests.

What N1 does **not** pick up:

- **Main-only overlay changes, 5 commits:**
  - NucBox hv-node M4, bab1e36b.
  - The relay predictor, aeb345e6. It is relay-side and already live on the relay.
  - M2 Windows, 2aeaab8d.
  - The verifier, 7c694c41 and 6fa38f6d.
  None of these is needed by the SNP node. They are the isolation line's merge debt, handled separately.
- **The node half of the 0c087de8 chain.** That is judge.mjs (+108: the per-release LEGACY_WX_RELEASES table), supervisor-guestcert.mjs (+8: names the prediction's release to the judge) and a 3-line log change in supervisor.js. See §4.

## 2. Path independence

- **b3109929 is IN.** 2492e683 carries it through merge 90027a66, and so does the live image.
- It is **not on main**.
- Proof at build time follows the 4c-c pattern: two builds from two clean worktrees at DIFFERENT paths must match.
  - initramfs, vmlinuz and cmdline must be byte-equal.
  - The two manifest predictions must be equal.
  - A hand `sev-snp-measure` must equal the manifest.
  - A cpio (newc) comparison against f6cbd75a's initramfs must show only `/app/supervisor.js` and `opt/metal/manifest.json` differing.
- A reviewer (bf or 5d) reproduces the measurement from their own path. A same-path rebuild proves nothing about path inputs.

## 3. Build, swap, acceptance, rollback

**Build (inert).**
- Idle class, and only while warden-host is quiet: no peer host step, and no first launch in progress.
- The command is the same as `build-cc.sh`, with C=2492e683, the same SUP, WASM, TCB and OVMF pins, and `--supervisor-overlay` pointing at the build worktree.
- Output goes to **`~/enclave-prod/dist-iso-2492e683`**, not the shared checkout, to avoid the `git clean -fdx` hazard. The second build goes to a scratch path.

**N1-a, the relay allowlist.**
- Add N1's measurement to `METAL_ALLOWED_MEASUREMENTS` in `/etc/nan-relay/api-relay.env`.
- Keep f6cbd75a's measurement beside it for the rollback and the soak.
- This is one api-relay restart, done in e3's window through the nan ssh master, with a check that the env line lists both.

**N1-b, the swap (detached, one node restart).**

Preflight: every check fails closed.
- `node_on_4cc`: the live node is 02f6e313 on launcher 578be084 / 4620da5d.
- The 3 canaries are running on their **e7 keys** (1868e492, afedf53d, 39223442), checked with lib-e7.
- `noncanary_empty`. If one of Steven's apps is running by then, it needs a window and an fl-check re-run after the restart.
- No rollout unit is active and no m2-lb unit exists.
- **MemAvailable gate:** MemAvailable − 6144 (the node CVM re-takes its 6 GiB) ≥ 16384 (guestd's floor) + guestd's `pool.host.pendingMiB`.
- Memory PSI avg60 is 0.
- `/v1/expected-guest` still lists 5db18199 admitted for each canary.

The change:
- Back up `config.iso.json` (0600, to `$EV/secret`).
- Replace it atomically with `dist` set to the new path; nothing else changes.
- Restart `enclave-metal-iso.service`.

Post-checks: any failure rolls back.
- The node's attested measurement is N1's, and it runs from metal-578be084 with launcher 4620da5d.
- Both opt-in lines appear, each anchored to its own prefix: `^[enclave-metal] … OPTED IN` and `^[gsup] … OPTED IN`.
- There are ≥ 3 "adopted guest" lines and 0 release lines, and no guest was stopped (guestd owns the guests; the node restart does not touch them).
- Availability is unchanged: 64/16, free 60160/1300.
- The relay row is serving and eligible.
- `public_ok` passes on the e7 keys.
- For each canary, the certificate pass logs "already serves a valid certificate … nothing issued until …". That means no new CSR at the restart.
- Then the 10-min gate.

**Retry acceptance: what the canaries must show.**
- One owner restart of hookbin (0ddbd824) after the gate, using the e7 scripts re-pointed at the new image. The proofs are unchanged.
- The node journal for 0x0ddbd824 must show:
  - the "starting" answer retried at **20 s** (`retry in 20s`), and **no** `retry in 300s` for a starting guest;
  - `certificate for 0ddbd824.app.enclave.host installed in guest <new>` within **≤ 45 s** of the serial's `DOM serving`.
- The baseline on the live image (e7): 0ddbd824 took 1 retry line and about 90 s. 395bed3e and 4e62e60d each took 2 lines and about 7 min.
- The instance-keying half, a replacement arriving while the old instance is in back-off, does not occur naturally on a relaunch: the old entry is a success entry. It is covered by the unit test and its 2 mutants. I will state that, not claim it was measured.

**Rollback.**
- Restore the backup `config.iso.json` (dist-iso-f6cbd75a) and restart the node. The old measurement is still allowlisted, the launcher and drop-in are untouched, and the guests are unaffected.
- Keep dist-iso-f6cbd75a and its allowlist entry through a 72 h soak. Remove N1's allowlist entry only after a node rollback.

## 4. With or separately from the next chain rev: **SEPARATELY, N1 first**

- **N1 has no coupling.** It changes only *when* the node asks for a certificate. What is judged and issued is unchanged, and the judge and supervisor-guestcert are byte-equal to the live ones.
- **The coupling runs the other way.** The node half of the 0c087de8 chain is not deployed today: the live node judges with the pre-chain judge (13fb51ed). That judge accepts the legacy self-test for any release and ignores the runtime counts. It is safe today because:
  - guestd judges every guest with the per-release judge (iso-0c087de8) before reporting it running;
  - the node certifies only relay-predicted releases (`requirePrediction`), which since rs-10 are 5db18199 plus the two KAT releases.
  But judge.mjs's own rule pairs a relay retirement with the table on *every* consumer tree, the node image included. So **the next chain rev must ship with its own node image N2**, carrying the next-rev judge.mjs and supervisor-guestcert.mjs (release naming). That is a coupling of the chain rev to N2, not of N1.
- **Recommendation: do not fold 0c087de8's node half into N1.** The next rev replaces that judge again, so folding it in means two judge swaps instead of one. Two separate node restarts also keep each rollback to a single variable.
- **If you want the node-side consumer rule met before the next rev,** N1′ is 2492e683 merged with I's 3 node files. It must first pass against the live 5db18199 canaries (expect `runtime-covered`) and a KAT legacy release (expect `runtime-unmeasured`).

## Open items

- `config.iso.json` and dist-iso-f6cbd75a still live in the shared checkout, which is the git-clean hazard. N1 puts its dist under `~/enclave-prod`. Moving the config needs an ExecStart change, which is a separate step.
- N1-a needs the nan ssh master, and a relay window with e3.
- The swap must not overlap one of Steven's first launches or a peer's host step.
