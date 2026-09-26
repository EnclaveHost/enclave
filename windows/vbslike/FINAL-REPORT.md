# The NucBox VBS-like deployment: final report (DRAFT)

For Steven. Drafted by enclave-b4 for enclave-87 on 2026-09-26 from DEPLOYMENT.md (`525c3812`) and the evidence branches it
cites; nothing here is new. `⟨E13⟩`, `⟨E14⟩` and `⟨v43⟩` are results still to come (the 12-hour soak, the reboot, and
v43's install). The report is final once they are filled in.

## In short
Your NucBox (`nucbox-k11`) serves apps in production on the custom type-1 path: each app runs in its own Hyper-V
partition, and the box serves only you (its operator) and the owners who have delegated to it. It is never offered to
the market, and it never takes secrets. A test app ("test 1", hello-world 1.0.4) has been served since 01:00Z with a
publicly trusted certificate held inside its partition. **What this is not:** proof that the partition is isolated from
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
| Install (node, manager, host prerequisites) | PASS: every install step `ok` (E2, E7); the current node and manager confirmed on the box at 07:37Z | ws `~/enclave-bench/hvnode-install-20260926T004644Z.txt`, `hvnode-install-4ef0e862-20260926T012649Z.txt`; node `f1461271`'s install: branch `evidence/nucbox-test2-delegation` `8dcc2604` (`node-installs/`) | enclave-b4's read-only box read: ws `~/enclave-bench/done-audit-b4/` (SHA256SUMS `0933666a…`) |
| R4: the app from outside, with a verified chain on the partition's own key | PASS, 3 of 3 (E12, 03:38Z): HTTP 200 "Hello World!", ZeroSSL certificate for `31136008.app.enclave.host`, the served key = the manager's key for the partition | ws `~/enclave-bench/v42-install/r4-x-verified.txt` | enclave-bf's outside acceptance, item 2 (E15): ws `~/enclave-bench/b-outside-acceptance-20260926/RESPONSES.txt` (`553cf7e6…`) |
| Owner-only | PASS: the box attached as owner-only serving only you (E12); from outside, a delegated owner's app that requires the SNP tier was refused, test 1 was served, a stranger's restart was refused, the box was never eligible (E15, 5 of 5) | as above; E15's `ERRATUM.txt` (`15840022…`) | enclave-bf (E15); enclave-e3 re-read the relay settings at 07:37Z (E21: `env-reread-20260926T073751Z.txt`, `152ff96c…`) |
| TEST2: a delegated owner | PASS: a REMOVED delegation is refused while its lease is still live (E18); an EXPIRED one stops being served within about 3 s of its expiry, before any re-attach (E19). Part (a) was skipped: E15 had already proven it. TEST2 also found one defect (E16: an old row blocked the scan), fixed in `317b3152` | ws `~/enclave-bench/test2/`; branch `evidence/nucbox-test2-delegation` `8dcc2604`; the node log copied with hashes on `evidence/done-audit-d1` `4c619cb8` (SHA256SUMS `6c2eeeb1…`) | enclave-5d's own row log for E19 (`row.log` `155b3128…`, on `evidence/done-audit-5d` `ebef33d1`) |
| TEST2-mini | ⟨TEST2-mini: not in DEPLOYMENT.md `525c3812` or the evidence branches; its owner to supply the result and evidence⟩ | ⟨…⟩ | ⟨…⟩ |
| The tray app | PASS: moving the CPU slider to 20% reached the node, and back to 100% (E8) | `evidence/done-audit-5d` `ebef33d1` (SHA256SUMS `9d6738a6…`) | enclave-b4's box read at 07:37Z (`done-audit-b4/tray-pre.txt`) |
| The 12-hour soak (04:01Z → 16:01Z): test 1 sampled from outside every 5 min | ⟨E13⟩ | ws `~/enclave-bench/nucbox-soak/` (`summary-final.txt`) | ⟨E13⟩ |
| The reboot: the box restarts and test 1 comes back by itself, on a new key, with a new certificate and the tray intact | ⟨E14⟩ | ws `~/enclave-bench/reboot-v42-<stamp>/` (SHA256SUMS ⟨E14⟩); the procedure `windows/reboot-go-sheet` `f2862f91` (enclave-bf GO) | ⟨E14⟩ |
| v43 (the front on its own user, the runtime's W^X measured at every attestation) | dev boot PASS (E20); ⟨v43: the manager-path canary and the install⟩ | branch `evidence/nucbox-devboot-49500527` `fecc47ae` | enclave-53's check (E20); ⟨v43⟩ |
| v44, the follow-on (v43 plus a seccomp filter on the app runtime, stated in each attestation) | dev boot PASS (E22); not installed, its canary follows v43's | branch `evidence/nucbox-devboot-afa9633c` `626a924f` | — |

## What is NOT claimed
- **Isolation from the NucBox's host.** The boundary is T0-hv with the host NOT excluded. The partition's report is
  signed by our launcher; "monitor-signed" is the name of that verdict, not a hardware signature. Capturing a hardware
  report (B1) is provider-blocked, and the host-memory experiment (B2) is parked.
- **"The key is inside the partition" beyond what the host says.** It means exactly this: the key the app serves equals the
  key the manager recorded for the partition. That is the host's statement on T0-hv.
- **That the apps cannot see each other.** The neighbour probe came back INCONCLUSIVE on every canary (the targets were
  absent from the probe's view, which is not proof of a denial). Making it conclusive is B3, which is parked.
- **Leaks during the soak.** The soak measures availability and stability only; checking for leaks was ruled out of its
  scope.
- **Reaching the app by its public name.** Today it is reachable only through nan's owner-only splice
  (`api.enclave.host/t/nucbox-k11/x/…`). The public hostname needs B on us-west (step 1b), which waits for you.
- **The relay's refusal of secrets to this box** is proven by tests only; no live request has exercised it.
- **On v42, that the runtime's W^X is measured, and that only the front can have its key attested.** Both are fixed in
  v43 (not yet installed): today the check is a snapshot taken before the app compiles, and a compromised runtime could
  obtain reports for keys of its choosing.

## What we need from you
1. **The us-west ssh master**, so e3 can put B on us-west (step 1b). Until then the app is not reachable by its public
   hostname.
2. **Your next srbat logon after the reboot.** The box has no automatic logon, so the tray starts only when you sign in.
   The reboot already checks the tray's program, your slider settings and its access to the node; the rest (its logon
   entry and the running tray) is confirmed by one re-run of the tray check after you sign in.
