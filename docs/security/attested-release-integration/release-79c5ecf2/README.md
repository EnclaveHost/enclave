# rs-4: release 79c5ecf2 into the relay's predictor (before the S4 tree switch)

Status 2026-09-25: staged on nan and checked; the env step is for review and then execution (by enclave-63, under Codex's
authorization of the reviewed rollout). The release stays OFF throughout.

Release 79c5ecf2 (image aa6c985c, init linked against musl) supersedes a4f22748 for the next guestd tree (iso-aa6c985c).
The tree switch refuses until the relay predicts AND admits 79c5ecf2 for every canary, because a guest on an unpredicted
release gets no certificate from the 4c gate and no release. So this step comes first.

## Staged on nan (done, 21:21-21:22Z)
The release is in `/opt/enclave-predict/rel-79c5ecf24eb4/`, its own versioned directory. The live staging `829c09adb176`
is untouched.
- The release is under `release/`, verified against its id: `release 79c5ecf2… verified 15 files`.
- The directory is root-owned and read-only to the relay.
- It was staged by `../../measurement-prediction/stage/stage-release.sh` at d3ed78aa (`nan-stage.txt`).

The sandboxed check ran in the api-relay's own sandbox: a transient unit with DynamicUser, ProtectSystem=strict,
ProtectHome, PrivateTmp, NoNewPrivileges, MemoryMax=1536M and TasksMax=512.
- It used the DEPLOYED predictor, /opt/nan-relay/measurement-predict.mjs, sha256 4aab8ff1… (aeb345e6).
- Its env was the staging's predict.env with the two new lines.
- Results:
  - the known-answer test PASSED;
  - api-mcp-adapter (catalog 0x5bca36b5…/0) under 79c5ecf2 gives AppID 94c04c0e… and measurement **20319b02…**, which
    is 5d's value and mine;
  - the installed set is 5c3561f9, 6f14ce75, a4f22748 and 79c5ecf2;
  - the admitted set is 79c5ecf2 alone.

## The change: exactly two lines of /etc/nan-relay/api-relay.env, then one api-relay restart
| line | before (`predict-lines.before.env`, sha256 b3f4a67a…) | after (`predict-lines.env`, sha256 6f816b31…) |
|---|---|---|
| `SECRETS_RELEASE_PREDICT_RELEASES` | 5c3561f9, 6f14ce75, a4f22748 (in 829c09adb176/releases) | the same three, plus `79c5ecf2…=/opt/enclave-predict/rel-79c5ecf24eb4/release` |
| `SECRETS_RELEASE_DOMAIN_RELEASES` | a4f22748… | 79c5ecf2… |

Why these two lines:
- a4f22748 stays INSTALLED. Any guest on it stays certifiable, and a tree-switch rollback keeps working for certificates.
- It is no longer ADMITTED for the release. The release is OFF anyway.
- 5c3561f9 and 6f14ce75 stay for the live canaries and for the known-answer test.

## Scripts
- **`rs-4.sh apply|rollback`**, run locally with 63's `relay-slice-20260925/lib.sh`. It records the api-relay's invocation,
  then feeds `rs-4-remote.sh` to nan as root with the two reviewed hashes.
- **`rs-4-remote.sh`**, which runs on nan and refuses before its first write unless:
  - both line files match their reviewed sha256 and the staging's check passed;
  - the env file is 0600 root and newline-terminated;
  - each of the two keys appears exactly once and equals the FROM line (so it cannot run twice);
  - no release setting is on;
  - every release the TO lines install verifies against its id;
  - the api-relay is active.

  It then:
  - backs the env file up (0600);
  - builds the new file line-wise: exactly 2 lines are replaced, and every other byte and the line count stay the same;
  - checks that the diff is exactly those 2 lines and the file is 0600 root;
  - moves the file into place and runs ONE `systemctl restart enclave-api-relay`;
  - checks: a new invocation, NRestarts 0, MemoryMax 1536M.

  It prints no env value.
- **`rs-4-accept.sh apply|rollback`** checks:
  - the api-relay was restarted by rs-4 (new invocation, 0 restarts), and the KAT PASSED in that invocation's journal
    (cold: it waits up to 15 min);
  - `ADMIT=79c5ecf2 ../accept.sh` passes: each canary's own chip-attested measurement is predicted, AND 79c5ecf2 is
    predicted and admitted for it, which is the tree switch's precondition. The release is still 503, and 404/422 hold;
  - for every canary, the installed set is exactly the four releases and only 79c5ecf2 is admitted;
  - MemoryPeak < 1536M;
  - /enclaves answers 200;
  - the canaries' public TLS is unchanged, with their S0 keys;
  - metal-iso0 is serving and eligible.

## Evidence that the change does what it says (before touching nan's env)
- `local-relay-test.txt`: production's api-relay.js (aeb345e6), started cold with the two new lines, then accept.sh.
  - With ADMIT=79c5ecf2: all 3 canaries ok, with 79c5ecf2 predicted for them (0x0ddbd824 → 2317370d…; the other two →
    6de87365…) and admitted. Release 503, 404, 422.
  - The negative control, ADMIT=a4f22748 (installed, not admitted): all 3 FAIL. The predicate is not vacuous.
- `remote-dryrun.txt`: `rs-4-remote.sh` as root in a container, with nan's real line files and the four verified
  releases (`remote-dryrun-harness.sh`, `remote-dryrun-systemctl-shim.sh`).
  - apply replaces exactly lines 5-6, the file stays 0600 root, and there is 1 restart.
  - apply again: refused.
  - rollback: the env is byte-identical to the original.
  - Refused before any write: release ON, tampered lines, a 0644 env, relay down, a duplicate key.
  - 2 restarts in total.

## Order
1. rs-4 apply, then rs-4-accept apply.
2. The tree switch (s4t-run.sh; its v2 pre-check needs step 1 and runs on a warm cache).

## Rollback
- **The code or tree side:** if the tree switch rolls back to iso-17e182a8, run `rs-4.sh rollback` and then
  `rs-4-accept.sh rollback` before any release turn-on. That restores DOMAIN_RELEASES = a4f22748 and removes 79c5ecf2 from
  the installed set, and the result is byte-identical to today's env (dry-run proven).
- **The relay side:** the same `rs-4.sh rollback`. The `.bak-rs4-apply-<stamp>` copy on nan is the whole file as it was.
- **Nothing on any node depends on this until the 4c supervisor with the certificate gate ships.** The live supervisor
  never asks the relay.
