# The installed client's explicit activation on the Pixel 10 (2026-09-24 05:20-05:30)

**Not production.** This is the first real-device run of the 0.3.0 activation path (client/DESIGN.md "Activation"). The
host evidence (canaries, a fake VM) is separate: see test/pvm-client-activation.test.mjs. Nothing here counts it.

## What ran

- **Launcher.** The accepted 0.3.0 artifact, `pvm-client.mjs` `fad5ba229c5dbbb339aa6d3d505e31c6a07eaaabadbe2431533cf882fb0f6aa4`
  (commit 0f4c79fd), copied into a lab install directory OUTSIDE the repository, with fresh state (`cli-state.d`, here).
- **Next-version artifact.** Version 0.3.1, `ed82869d033964081b2dcb45dd9ae8b238db79693f3ff10cf1cdfef510bde84c`, 137343
  bytes, labelled on its first line as a LAB NEXT-VERSION TEST ARTIFACT.
  - It was derived deterministically from the base by client/tools/lab-next.mjs: the first line and the version
    constant, nothing else.
  - The verifier session reproduced it independently. Apart from its first line, it is byte-identical to a source rebuild
    of 0f4c79fd at CLIENT_VERSION 0.3.1 (`ad8ff60b…`).
- **Manifests.**
  - `manifest-0.3.1.json`: the lab release key signs; the lab policy key countersigns.
  - `manifest-0.3.1-rotated.json`: the same artifact, countersigned by the SUCCESSOR policy key.
  - Both were delivered over an untrusted HTTP carrier.
- **Lab keys**, made for this run, stay outside the repository. Only their public halves are here:
  - policy `4dcf7da8…`, release `10f4b942…`, successor policy `f7ed6ce7…`.
- **The tampered bytes** (`tampered.json`): the signed bytes plus one appended comment line, `4dfaa327…`, 137406 bytes,
  written in place over the active file.
- **VM.** Build rt14 (code hash `433dd3df…`), serving the lab streaming probe. It served 104 s after launch.

## Result

`check.txt` is the run's own checker output, kept as produced: **FAIL (1)**.
- The failing check, "after activation every answered run was 0.3.1", expected 9 result lines. The run has 10:
  - I had not counted the two policy refusals (`retired-5`, `rollback`), which also answer with a result line.
  - All 10 carry clientVersion 0.3.1, none 0.3.0.
- The checker now derives the count from its own list of runs.
- `check-corrected.txt` is that checker on the same results: **PASS, 43 checks**. The same 43 checks, one reworded.
- `l1.log` was normalized for trailing blanks before the corrected check, and `run.log` too (a summary line cut at 400
  characters ended in a space). The original check ran on the raw capture; the checker does not read `run.log`.

| step | outcome |
|---|---|
| 0.3.0, policy 1, stream | complete, 24 tokens, clientVersion 0.3.0 |
| update (from the carrier) | staged: exactly the signed record (version, sha256, size, content-addressed file, sourceCommit) |
| stream, staged but not active | complete, clientVersion **0.3.0**: staging runs nothing |
| activate | ok, 0.3.1 `ed82869d…`, generation +1; active == staged |
| stream, whole | complete / 200, clientVersion **0.3.1** |
| a marker planted on the launcher | still delegated: complete, 0.3.1 |
| policy 2 | complete, 0.3.1, serial 2 committed before anything was sent |
| rotation: policy 3 names the successor, policy 4 signed by it | both complete, 0.3.1; the state holds serial 4 under the successor key, and the release key, staged and active are kept |
| a policy under the retired key | refused by 0.3.1, nothing sent |
| the active file tampered in place (same inode) | refused at launch: `{expected: ed82869d…, found: 4dfaa327…}`; the only output line, nothing ran; `staged` exits 1 |
| repair with the same artifact over the wrong file | refused: "already exists with bytes other than its name says"; left untouched |
| repair with the original manifest (removed file) | refused: countersigned by the retired policy key |
| repair with the successor-countersigned manifest | idempotent (`already`), re-published (a new inode), bytes match; stream complete, 0.3.1 |
| the active file missing | refused at launch, found: missing; repaired the same way; stream complete, 0.3.1 |
| serial 3 under the successor key, at the end | refused by 0.3.1 as a rollback |

- **No floor moved.** The state is generation 7 after the rotation and at every snapshot afterwards: tamper, the two
  refused repairs, the repairs, missing, rollback. Every snapshot is in `state-*.json`, `staged-*.json` and
  `install-*.txt` (inodes).
- **No fallback.** After activation every answered run was 0.3.1. The two launch refusals printed only their refusal.
- **The VM served exactly the released requests:** 9 streams and 1 whole answer. No request or token appears in the
  clear in the VM capture (pvm-rt's notes decoded), the hub, or either carrier's log.

## What rests on the device, and what does not

- **On the device.**
  - The activated 0.3.1 bytes, handed over from memory by the 0.3.0 launcher, verified the Pixel's real AVF and ABI/2
    evidence themselves, under a policy they had committed first.
  - They sealed each request to the attested app key and received the streamed answer, and they committed a policy-key
    rotation.
  - The refusals and repairs above happened against that real setup.
- **Stream authenticity.** It rests on the client's own FIN verification (`complete: true`) and on the VM's served-count
  cross-check.
  - The installed CLI never writes session secrets, so there are no offline-reopenable stream traces from this run. The
    verifier session records this as a limit.
- **Not observable here.** The start check's own output and environment are captured inside the launcher, so the device
  shows only that it passed. That environment, the swap races between verification and execution, and one hop across a
  concurrent activation are host evidence (canaries and real next builds, fake VM), not device evidence.
- **Device measurements** (this run, this phone, printed apart in the check files; not claims): 24-token streams took
  2.65-3.28 s with first tokens at 0.96-1.60 s, alike for 0.3.0 and 0.3.1.
- **Unchanged limits.**
  - The first install and the root of code trust are out of band: the launcher's bytes, the node binary.
  - Whole-machine power loss is untested.
  - The extension cannot activate.
  - There is no unattended activation, no production key, no deployment, and no firmware or host-security change.
