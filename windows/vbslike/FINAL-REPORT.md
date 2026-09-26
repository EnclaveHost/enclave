# The NucBox VBS-like deployment: final report (DRAFT)

For Steven. Drafted by enclave-b4 for enclave-87 on 2026-09-26 from DEPLOYMENT.md (`525c3812`) and the evidence branches it
cites; nothing here is new. `⟨E13⟩`, `⟨E14⟩` and `⟨v43⟩` are results still to come (the 12-hour soak, the reboot, and
v43's install). The report is final once they are filled in.

## In short
Your NucBox (`nucbox-k11`) serves apps in production on the custom type-1 path: each app runs in its own Hyper-V
partition, and the box serves only you (its operator) and the owners who have delegated to it. It is never offered to
the market, and it never takes secrets. A test app ("test 1", hello-world 1.0.4) was first served at 01:29Z (E9; paused twice
for canaries, E10 and E11), and has been served on v42 since 03:37Z with a publicly trusted certificate held inside its
partition (E12), apart from brief re-attach gaps (about 10 s each) and two node restarts (about 37 s each) (E13). **What this is not:** proof that the partition is isolated from
the NucBox's own host. The partition's report is signed by our launcher, not by hardware, so the boundary is stated
honestly as **T0-hv, host not excluded**. It is working serving, not proven isolated hosting.

## What runs where
| Piece | What runs now | Where |
|---|---|---|
| The box | nucbox-k11, Secure Boot ON; the legacy engine task stays Disabled (never deleted, never re-signed) | your NucBox |
| The guest image (IGVM) | v42: `0891c740…` (guest `298924ae`), in package v42 `f813a88c…`, which enclave-bf reproduced end to end | the manager's verified copy on the box |
| The manager | v42's, started 03:34Z; it launches one partition per app and keeps the records (`/vms`) | box task `EnclaveHvManager` |
| The node | main `f1461271` since 06:03Z: claims only owner-only work, renews leases, relays each partition's certificate request | box task `EnclaveHvNode` |
| The relay | attach ON (flip A, 00:55Z) and owner-only serving (B) live on nan since 02:56Z, with your operator key `0x389c…` as the only hv-node operator | nan (api.enclave.host) |
| The tray app | EnclaveTray (sha256 `3614819d…`), in your srbat session, with the CPU and GPU sliders (both 100% since 01:38Z) | srbat's logon (HKCU Run) |

## What was tested, and who checked it
| Test | Result | Evidence | Checked independently by |
|---|---|---|---|
| Install (host prerequisites, node, manager) | PASS: the host prerequisites set (E1); every step `ok` on the installing runs (E2's second run, after its first stopped safely on a script defect that was fixed; E7); the current manager and IGVM from the v42 install (E12); the current node from its -NodeOnly install; both confirmed on the box at 07:37Z | ws `~/enclave-bench/nucbox-m3/` (`m3-run-output-20260926T003332Z.txt`, `m3-TIMELINE.txt`); `~/enclave-bench/hvnode-install-run2-20260926T004854Z.txt`, `hvnode-install-4ef0e862-20260926T012649Z.txt`; the v42 install `~/enclave-bench/v42-install/v42-install-20260926T032841Z.txt` (`8cc58c73…`) with `stop.txt` and `start.txt`; node `f1461271`: branch `evidence/nucbox-test2-delegation` `8dcc2604` (`node-installs/`) | enclave-b4's read-only box read: ws `~/enclave-bench/done-audit-b4/` (SHA256SUMS `0933666a…`) |
| R4: the app from outside, with a verified chain on the partition's own key | PASS, 3 of 3 (E12, 03:38Z): HTTP 200 "Hello World!", ZeroSSL certificate for `31136008.app.enclave.host`, the served key = the manager's key for the partition | ws `~/enclave-bench/v42-install/r4-x-verified.txt` | enclave-bf's outside acceptance, item 2 (E15, on the earlier node `07fc4f55`): ws `~/enclave-bench/b-outside-acceptance-20260926/RESPONSES.txt` (`553cf7e6…`); on the CURRENT node `f1461271`, enclave-b4's read-only G2 run at 06:43:52Z (verified ZeroSSL chain, the served key = the manager's `4d80b956…`, verdict monitor-signed): ws `~/enclave-bench/reboot-go-v42/g2/20260926T064344Z/` (SHA256SUMS `62fb3134…`), cited by the reboot sheet `f2862f91` |
| Owner-only | PASS: the box attached as owner-only serving only you (E12); from outside, a delegated owner's app that requires the SNP tier was refused, test 1 was served, a stranger's restart was refused, the box was never eligible (E15, 5 of 5) | as above; E15's `ERRATUM.txt` (`15840022…`) | enclave-bf (E15); enclave-e3 re-read the relay settings at 07:37Z (E21: `env-reread-20260926T073751Z.txt`, `152ff96c…`, committed on `security/attested-release` `fe0b7fd5`) |
| TEST2: a delegated owner | PASS: with a signed delegation, the delegated owner's own partition app (ID2 `0x958ae6e9…`) was claimed and served on its own key with a publicly trusted certificate (Let's Encrypt), 04:58:53–05:01:53Z; a REMOVED delegation is refused while its lease is still live (E18); an EXPIRED one was already refused by the first probe after its expiry (3.1 s later; the bound is set by the probe cadence, not measured), before any re-attach (E19). Part (a) was skipped: E15 had already proven it. TEST2 also found one defect (E16: an old row blocked the scan), fixed in `317b3152` before the positive step | ws `~/enclave-bench/test2/`; branch `evidence/nucbox-test2-delegation` `8dcc2604`; the node log copied with hashes on `evidence/done-audit-d1` `4c619cb8` (SHA256SUMS `6c2eeeb1…`) | enclave-5d's own row log for E19 (`row.log` `155b3128…`, on `evidence/done-audit-5d` `ebef33d1`) |
| TEST2-mini: TEST2 again on the current node `f1461271`, whose delegation add/remove handling changed and is so far proven by tests only (enclave-87's order) | **planned; not yet run**: a delegation ADDED re-attaches with no gap, and the delegated owner's app is served on its own key; the zero id is refused; the delegation REMOVED ends the tunnel first and the owner is no longer served, with ONE expected, bounded gap for test 1 (about 10 s by design, at most 60 s). Runs after the reboot acceptance and before the v43 canary (d1 runs it; 5d's procedure `windows/test2-mini-5d` `d34f32dd`, `TEST2-MINI.md`, under bf's review) | ⟨TEST2-mini⟩ | ⟨TEST2-mini⟩ |
| The tray app | PASS: moving the CPU slider to 20% reached the node, and back to 100% (E8) | `evidence/done-audit-5d` `ebef33d1` (SHA256SUMS `9d6738a6…`) | enclave-b4's box read at 07:37Z (`done-audit-b4/tray-pre.txt`) covers the tray being installed and running on the current node (the exe, its logon entry, the caps, its access to the node's token), not the slider-to-node path, which rests on E8 alone |
| The 12-hour soak (04:01Z → 16:01Z): test 1 sampled from outside every 5 min. The node was replaced twice in the window (so `f1461271` carries about 9 h 57 min of it), and the 5-min samples cannot see the ~10 s re-attach gaps (15 attaches) or the two ~37 s node restarts | ⟨E13⟩ | ws `~/enclave-bench/nucbox-soak/` (`summary-final.txt`) | ⟨E13⟩ |
| The reboot: the box restarts and test 1 comes back by itself, on a new key, with a new certificate, and the tray's program and settings intact (it runs again at srbat's next logon) | ⟨E14⟩ | ws `~/enclave-bench/reboot-v42-<stamp>/` (SHA256SUMS ⟨E14⟩); the procedure `windows/reboot-go-sheet` `f2862f91` (enclave-bf GO) | ⟨E14⟩ |
| v43 (the front on its own user, the runtime's W^X measured at every attestation, a seccomp filter on the app runtime) | dev boot PASS (E20); ⟨v43: the manager-path canary and the install⟩ | branch `evidence/nucbox-devboot-49500527` `fecc47ae` | enclave-53's check (E20); ⟨v43⟩ |
| v44, the follow-on (v43 plus the runtime's seccomp filter stated in each attestation, `d4d17c9f…`, 71 rules) | dev boot PASS (E22); not installed, its canary follows v43's | branch `evidence/nucbox-devboot-afa9633c` `626a924f` | — |

## What is NOT claimed
- **Isolation from the NucBox's host.** The boundary is T0-hv with the host NOT excluded. The partition's report is
  signed by our launcher; "monitor-signed" is the name of that verdict, not a hardware signature. Capturing a hardware
  report (B1) is provider-blocked, and the host-memory experiment (B2) is parked.
- **"The key is inside the partition" beyond what the host says.** It means exactly this: the key the app serves equals the
  key the manager recorded for the partition. That is the host's statement on T0-hv.
- **That the apps cannot see each other.** The neighbour probe came back INCONCLUSIVE every time it ran (v42, v43, v44:
  the targets were absent from the probe's view, which is not proof of a denial). Making it conclusive is B3, which is
  parked.
- **Leaks during the soak.** The soak measures availability and stability only; checking for leaks was ruled out of its
  scope.
- **Reaching the app by its public name.** Today it is reachable only through nan's owner-only splice
  (`api.enclave.host/t/nucbox-k11/x/…`). The public hostname needs B on us-west (step 1b), which waits for you.
- **That an app cannot reach the launcher's report signer.** On v42 a domain can plausibly dial it (U5; its fix P1 is
  paused). The app runtime's seccomp filter, which refuses those connections, is in v43's image (E20: every filtered
  vsock connection refused), not yet installed.
- **The relay's refusal of secrets to this box** is proven by tests only; no live request has exercised it.
- **On v42, that the runtime's W^X is measured, and that only the front can have its key attested.** Both are fixed in
  v43 (not yet installed): today the check is a snapshot taken before the app compiles, and a runtime that had already
  been compromised (an escape is needed first) could obtain reports for keys of its choosing.

## What we need from you
1. **The us-west ssh master**, so e3 can put B on us-west (step 1b). Until then the app is not reachable by its public
   hostname.
2. **Your next srbat logon after the reboot.** The box has no automatic logon, so the tray starts only when you sign in.
   The reboot already checks the tray's program, your slider settings and its access to the node; the rest (its logon
   entry and the running tray) is confirmed by one re-run of the tray check after you sign in.
3. **OPTIONAL: a delegation, if you want your own apps on the NucBox.** If you want your own apps (owned by your wallet,
   not the NucBox operator `0x389c…`) served on the NucBox, sign one `enclave-host-delegation-v1` message for the box
   with your Trezor (90 days by default); see DEPLOYMENT §4. Without it, the NucBox serves only operator-owned
   deployments. The message comes from `node scripts/host-delegation.mjs text --owner <your wallet> --operator 0x389c…
   --box nucbox-k11 [--days 90]`, is checked with its `verify`, and the signed file goes into the node's
   `hvnode\state\delegations\`; the relay refuses an expiry beyond 180 days. There is no revocation list: you stop it by
   letting it expire, by dropping your app's `isolation.require`, or by transferring or cancelling the deployment, and the
   operator can delete the file.
