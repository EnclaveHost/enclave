# The installed client's activation on the Pixel 10, repeated with raw evidence capture (2026-09-24 12:51:19Z-13:00:10Z)

**Not production.** This is a bounded repeat of results/pvm-cpu-client-activation, which is kept as it was, with its
failed `check.txt`. The repeat has the same sequence and the same bytes. It adds one thing: the relay's lab carrier
recorded every attestation exchange as received, so the verifier session can re-verify each chain offline through its
pinned adapter. The client did not change and no repair path was added. Times here are UTC.

## What ran

- **Launcher.** The accepted 0.3.0, `fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4` (0f4c79fd), in a new
  lab install directory outside the repository, with fresh state (`cli-state.d`).
- **Activated artifact.** The same LAB NEXT-VERSION TEST ARTIFACT 0.3.1,
  `ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c`, 137343 bytes (client/tools/lab-next.mjs; reproduced
  by the verifier session).
- **Tampered bytes.** The same derivation, `4dfaa327…`.
- **Lab keys.** New keys, made for this run outside the repository: policy `23e45eef…`, release `9429870b…`, successor
  policy `db0e7832…`. Only their public halves are here. The manifests and policies are signed with them.
- **VM.** rt14 (code hash `433dd3df…`), serving 105 s after launch.
- **Capture** (d12e78c9's carrier, local-hub `--record-evidence`), in `evidence/`:
  - `evidence-NNN.request`: the client's exact `EVIDENCE <nonce>` line.
  - `evidence-NNN.json`: the VM's envelope, byte for byte as it passed the carrier. Nothing is parsed, stripped or
    reordered.
  - `evidence-NNN.meta.json`: the UTC time it went to the VM and the time it was answered, and the byte counts.
  - `exchanges.jsonl`: one row per CLI call, naming which exchanges it made.
  - `capture.json`: the run's UTC start and end, and the ordered map from exchange to run label.
  - Session secrets and sealed traffic were not recorded.

## Result

`check.txt` is the run's own checker output, kept as produced: **FAIL (1)**, 47 checks.
- The failing check compares each exchange with its run and with the state committed before it.
- It failed on all 10 exchanges for ONE reason: every `stateAfter` recorded in `capture.json` and `exchanges.jsonl` is
  null. That is a defect in my run script, not the client or the device.
  - The script piped `pvm-client state` into `python3 -`, whose program came from a heredoc.
  - The heredoc took stdin, so the script read nothing and recorded nulls.
  - The script now passes the state through a file, and fails loudly if it cannot read it. That fix was tested on the
    host; it applies to future runs only.
- This run was NOT repeated a third time. It was one bounded repeat, and the missing per-exchange state copy is not
  filled in after the fact.

`check-corrected.txt` holds 49 checks, with that one check split into three so a failure names its cause:
1. **ok.** Each of the 10 envelopes is the one its run verified: the nonce, app and app-key prefixes in the run's own
   result.
2. **ok.** Each exchange ran under the state its run committed BEFORE its evidence request. That state is the run's own
   `stateGen` in the generation log `cli-state.d/<gen>.json`: the serial it reports; no active record before
   activation, and 0.3.1 after.
3. **FAIL.** The per-exchange state copy in `exchanges.jsonl` agrees with the generation log. It is null, for the reason
   above.
- So the correlation between each exchange and its policy, keys and active record rests on the client's own `stateGen`
  and the generation log. It does not rest on the carrier-side copy, which is missing.
- `l1.log` and `run.log` were normalized for trailing blanks before the corrected check. The original ran on the raw
  files.

Everything else matches the first run, and all of it passed.
- **The artifacts.** Two manifests, one countersigned by the original policy key and one by its successor.
- **Staging ran nothing.** Staged but not active, the answer was still 0.3.0.
- **Activation.** `activate` added exactly one generation. Every later answered run was 0.3.1, complete against the
  real VM:
  - a stream and a whole answer;
  - a marker planted on the launcher;
  - policy 2;
  - a policy-key rotation committed by 0.3.1, after which the retired key was refused.
- **Tampered in place.** Refused at launch, with `{expected, found}`. The same artifact could not overwrite the wrong
  file, and the retired key's manifest could not repair it. The successor's manifest re-published it, and 0.3.1 ran
  again.
- **Missing.** Refused and repaired the same way.
- **Rollback.** A final rollback was refused. The state stayed at generation 7 through every failure.
- **The VM served exactly the released requests:** 9 streams and 1 whole answer. No request or token appears in the
  clear in any log, and no private key anywhere.
- **Capture:**
  - 10 envelopes, each answering its request's nonce;
  - UTC times inside the run;
  - the exchanges mapped in arrival order to base-stream, staged-not-active, active-stream, active-whole,
    planted-marker, active-policy-2, rotate-3, successor-4, repaired-stream and repaired-2-stream;
  - the refusals (retired-5, rollback, tampered, missing) made no exchange.

## Scope and limits

- **For the verifier session.** Re-verifying the recorded chains offline, through its pinned adapter under the policy
  committed before each exchange, is its independent step. This run supplies the raw envelopes; it does not perform or
  claim that re-verification.
- **Stream authenticity.** As before, it rests on the client's own FIN verification (`complete: true`), the VM's served
  count, and the per-nonce match. There are no stream secrets, so there is no offline stream replay.
- **Not device evidence.** The start check's environment, the swap races and one hop are host evidence.
- **Device measurements** (this run, this phone; not claims): 24-token streams took 2.76-3.05 s with first tokens at
  1.08-1.33 s, alike for 0.3.0 and 0.3.1.
- **Unchanged limits.**
  - The first install and the root of code trust are out of band: the launcher's bytes, the node binary.
  - Whole-machine power loss is untested.
  - The extension cannot activate.
  - There is no unattended activation, no production key or logging, no deployment, and no firmware or security change
    or reboot.
