# The installed client's activation on the Pixel 10, run 3: raw evidence AND per-exchange state (2026-09-24 13:10:52Z-13:19:48Z)

**Not production.** This run exists to close the verifier session's finding F3 on run 2
(results/pvm-cpu-client-activation-2): there, every per-exchange state snapshot was recorded as null. Runs 1 and 2 are
kept exactly as they were, with their failed `check.txt` files. The client and the bytes did not change. The capture
tooling did: `75a8ffca` (cpu/activation-capture.sh, cpu/preflight-activation-capture.sh), committed and pushed BEFORE
this run, which ran from that revision. Times are UTC.

## Why run 2's snapshots were null, and why the first fix was not enough

- **Run 2.** The script piped `pvm-client state` into `python3 -` whose program came from a heredoc. The heredoc IS
  python's stdin, so the state was lost, and python recorded nulls.
- **The ae209496 fix.** It passed the state through a file. But when python raised, the shell went on, so a failure was
  still swallowed.
- **Caught by preflight.** The user asked for a preflight of exactly this path, and it caught that. Run against
  ae209496's code, the preflight FAILS 6 cases: exit 0, and the next command ran.
- **The capture now.** It is one sourced file, used by both this run and the preflight:
  - python refuses anything but a complete snapshot: an integer gen, the serial, 64-hex policy and release keys, and a
    valid active record;
  - every step checks its own exit;
  - any failure calls `capture_fail`, which logs and exits the run with 3.

## Preflight (`preflight.txt`; run by this run's script before anything touched the phone)

- **Valid state:** exit 0, the next command runs, and the recorded row equals `pvm-client state` field for field.
- **A failing client command:** its own code is relayed and the run goes on. That is a call result, not a capture
  failure.
- **Every capture failure stops the shell with exit 3.** The next command never runs and no row is written. The cases:
  - malformed state output;
  - a missing state (`state` exits non-zero);
  - an incomplete state;
  - a null gen;
  - `state` exiting non-zero with valid-looking output;
  - an unwritable exchanges.jsonl.
- Result: **PASS**.

## What ran

- **Launcher.** The accepted 0.3.0, `fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4` (0f4c79fd).
- **Activated artifact.** The same LAB NEXT-VERSION TEST ARTIFACT 0.3.1,
  `ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c`.
- **Tampered bytes.** `4dfaa327…`.
- **Lab keys.** New keys made for this run, outside the repository: policy `c4f8eb4a…`, release `78a14de1…`, successor
  policy `b1fc1169…`. Only their public halves are here.
- **State.** New isolated state and install directory.
- **VM.** rt14 (code hash `433dd3df…`), serving 110 s after launch.

## Result: `check.txt` PASS, 51 checks (as produced; identical after normalizing trailing blanks in l1.log and run.log)

- **F3's requirement.** `exchanges.jsonl` has 20 rows, one per client call, with 0 null snapshots. Each row's snapshot
  equals the generation it names in `cli-state.d`, and the last is the final generation 7. `capture.json` maps the 10
  exchanges in arrival order, with 0 null `stateAfter`. The progression is exactly the designed one:

  | calls | generation | serial | policy key | active |
  |---|---|---|---|---|
  | base-stream | 2 | 1 | original | none |
  | update, staged-not-active | 3 | 1 | original | none |
  | activate, active-stream, active-whole, planted-marker | 4 | 1 | original | 0.3.1 |
  | active-policy-2 | 5 | 2 | original | 0.3.1 |
  | rotate-3 | 6 | 3 | original, naming the successor | 0.3.1 |
  | successor-4, then every refusal, repair and the rollback attempt | 7 | 4 | successor | 0.3.1 |

- **Capture.**
  - 10 raw v2 envelopes, each answering its request's nonce: sha256 prefixes 2640963b633cb173 aede1c4f92ca9df2
    bd8960c3dc6f39c2 c5f5fb7b89de205c 8d33d22a335d0aa2 4a90a3f4df0b5108 10cba785ea027f49 81c82b5795a85dc1 ff90a1dc3cf0f52a
    c709a10d80f006d3;
  - UTC times inside the run and inside each call;
  - each envelope is the one its run verified (nonce, app, app key), under the state its run committed first.
- **Everything runs 1 and 2 showed passed again.**
  - Staging ran nothing.
  - Activation added exactly one generation.
  - Every later answered run was 0.3.1, complete against the real VM: a stream and a whole answer, a planted marker,
    policy 2, and a policy-key rotation it committed, after which the retired key was refused.
  - Tampered in place, then missing: refused at launch with `{expected, found}`. The same artifact could not overwrite
    the wrong file, and the retired key's manifest could not repair it. The successor's manifest did.
  - A final rollback was refused, and generation 7 held through every failure.
  - The VM served exactly the released requests: 9 streams and 1 whole answer.
  - No plaintext in any log, and no private key anywhere.

## Scope and limits (unchanged)

- **For the verifier session.** Offline re-verification of the 10 chains, and closing F3, are its steps. This run
  supplies the material.
- **Stream authenticity.** It rests on the client's FIN verification (`complete: true`), the VM's served count and the
  per-nonce match. There are no stream secrets, so there is no offline stream replay.
- **Host-only evidence.** The start-check environment, the swap races and one hop.
- **Device measurements** (not claims): 24-token streams took 2.66-3.05 s with first tokens at 1.02-1.31 s.
- **Out-of-band root and power loss.** The first install and the root of code trust are out of band: the launcher's
  bytes, the node binary. Whole-machine power loss is untested. The extension cannot activate.
- **Not done.** No client change, no production key or logging, no deployment, no firmware or host-security change, and
  no reboot.
