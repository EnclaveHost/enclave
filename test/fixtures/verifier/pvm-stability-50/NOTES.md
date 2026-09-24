# Target 9 on the Pixel 10: 50 consecutive mixed turns through the installed client 0.4.1 (2026-09-24 16:23:40Z-16:31:35Z)

**Not production.** This is product acceptance target 9 (PVM-CPU.md, "Product acceptance target": 50 consecutive mixed
turns with no engine error), run once, bounded, on the existing lab setup. Codex directed it under Steven's standing
validation scope, not as a fresh Steven approval. Times are UTC.

## What ran

- **Client.** The installed client 0.4.1, `58f0edddb0f7db85df7edf9e56bbab043194a19a8d4e5d903ef31a5b5705abc4` (c1341ee3), in a
  lab install directory outside the repository, with fresh isolated state (`cli-state.d`).
- **Keys and policy.** Lab keys were made for this run outside the repository: policy `c94c8bdb…`, release `b8250fc5…`.
  There is one signed policy, serial 1, whose deployment table names one lab deployment
  (`0x` + sha256 of "lab: pixel10 pvm-cpu stability") for the stream probe's app.
- **VM.** rt14 (code hash `433dd3df…`), serving the lab stream probe: a fixed prompt, then greedy (argmax) decoding of
  `steps` tokens. The VM served 105 s after launch.
- **Tooling.** Frozen and pushed before the run at f0f7fc27 (cpu/app-stability-run.sh, cpu/activation-capture.sh,
  cpu/preflight-activation-capture.sh, runtime/conformance/check-app-stability.py). The capture preflight passed first
  (`preflight.txt`), including a timeout case.
- **Turns.** 50, cycling ten shapes: stream and whole answers of 8 to 128 tokens; 30 selected by deployment, 20 by app;
  35 streams, 15 whole answers, 2040 tokens in all.
  - Every turn fetched fresh evidence over its own nonce. The relay carrier recorded all 50 raw envelopes as received
    (`evidence/`).
  - A turn was killed after 180 s if it did not end. None came close.
- **Stop rule.** The run would have stopped at the first turn that was not a valid completed answer, with no restart. It
  did not stop.
- **After the turns.** The script read the VM's capture and then stopped the lab app, which ends the VM.

## Result

`check.txt` is the run's own checker output, kept as produced: **FAIL (1)**.
- The failing check required "one attach, no detach". The one detach, at 16:31:34.686Z, is the script's planned stop:
  - turn 50 ended at 16:31:28.849Z;
  - the script logged the app stop at 16:31:34Z;
  - the hub itself ended 49 ms after the detach.
  It is not a reconnect.
- The checker now counts only detaches before the last turn ended, so a reconnect still fails the check.
- `check-corrected.txt`, on the same results (with trailing blanks in l1.log normalized), is **PASS**. The same checks,
  one reworded: "0 mid-run; 1 after it: the scripted stop".

What the checks establish, each re-derived from the raw client output, not taken from the run's own summary:
- **50 of 50 attempted turns were valid completed answers**, consecutive from turn 1:
  - each stream complete with exactly its tokens and the VM's done line;
  - each whole answer 200 with exactly its tokens;
  - all answered by 0.4.1;
  - every deployment selection bound to the table's app.
- **The same answer every time.** Each turn's tokens are the first `steps` of one 128-token greedy sequence.
- **Evidence.**
  - Exactly one envelope per turn, v2, answering the nonce its request carried.
  - Each is the envelope its turn verified, under the state committed before it: the per-call snapshot equals the
    generation log, serial 1.
  - One VM boot throughout: one transport key and one app key, with no reconnect during the turns.
- **The VM served exactly the answered requests:** 35 streams to FIN and 15 whole answers.
- **No leak.** No request or token appears in the clear in any log, and no private key anywhere.

## Observations (this run, this phone; not checks)

- **Thermal.** Status 0 at every sample (51, one before each turn plus one at the end). The battery ran 31.5-35.8 C.
- **Host load average.** 2.1-3.8. The host was shared with other sessions' light work; no isolation workload competed.
  The isolation session was told first and cleared the run.
- **Per-turn time**, client wall clock, including a fresh evidence exchange each turn:

  | shape | first token (median) | whole turn (median) | whole turn (max) |
  |---|---|---|---|
  | stream 8 | 1155 ms | 1616 ms | 1958 ms |
  | stream 24 | 1247 ms | 3330 ms | 3554 ms |
  | stream 64 | 1219 ms | 7040 ms | 7607 ms |
  | stream 128 | 1166 ms | 12653 ms | 14358 ms |
  | whole 64 | - | 7149 ms | 7965 ms |

  The full table is in `check.txt`.

## What this does and does not show

- **Shows.** Target 9's criterion, 50 consecutive mixed turns with no engine error, met once on this phone:
  - through the installed client;
  - with fresh attestation on every turn, verified by the client itself;
  - with deployment selection from the signed table;
  - with deterministic answers.
- **Does not show.**
  - The chat workload: these are the stream probe's fixed prompt and 8-128 token decodes, not ≤512-token prompts.
  - Sustained thermal behaviour: the phone stayed at status 0 over 8 minutes. Target 2 is separate and still fails.
  - Cold start: targets 3 and 5.
  - More than one run.
- **Limits, unchanged.**
  - The evidence names no deployment and no instance: the client proves "a genuine instance of the app the signed
    policy expects for D", not D's instance. See RELAY-SERVING.md.
  - Stream authenticity is the client's FIN verification plus the VM's served count; the CLI writes no session
    secrets.
  - The first install and the launcher's bytes are the out-of-band root, and whole-machine power loss is untested.
  - No production keys, deployment, firmware or host change, reboot, or TPU work.
