# Measurement prediction: lab validation

What the relay's predictor (`relay/measurement-predict.mjs`) is checked against: real M4a per-app guests, whose launch
measurement, AppID and runtime the relay must predict from the chain and pinned domain releases alone. The contract is
`../attested-release.md`, section "Measurements: predicted".

`validate.mjs` re-derives everything a verdict rests on, and takes nothing from guestd:
- each canary report's AMD signature (the VCEK from AMD KDS, then ASK, then the pinned ARK, using `relay/snp-verify.mjs` primitives);
- the deployment, from HOST_DATA in that signed report;
- the catalog version, from that deployment's `appRef` in the ledger contract on Base;
- the expected guest, from the predictor itself, run with the real toolchain commit, two agreeing RPCs, a third-party
  trustless gateway and the pinned releases.

It then checks each refusal:
- a changed release file, and a changed runtime;
- another app's bundle, and guestd's stale derivation record;
- a missing or unpinned sev-snp-measure, an unreachable gateway, an absent toolchain commit, no admitted release;
- a full queue.

`evidence/` holds the canaries' attestation documents exactly as guestd saved them, plus guestd's instance names
(`guests.json`). The documents are public: a report, a P-256 public transport key, the runtime identity.

## Runs

| run | where | predictor | result |
|---|---|---|---|
| `run-1-warden-host.txt` | warden-host (the build host), clean-room venv, the local checkout's object store | 1ed256cc | PASS |
| `run-2-warden-host.txt` | warden-host, as run 1, with d1's review fixes | 57fa2d6f | PASS, 30 checks |
| `run-3-container.txt` | a fresh `python:3.11-slim` container: Debian 13, Go 1.24.7 and Node 22.20.0 from their upstream tarballs, sev-snp-measure 0.0.13 from PyPI, gzip 1.13, cpio 2.15; the repository cloned from GitHub | 57fa2d6f | PASS, 30 checks |

Environment difference between the runs:
- The lab host has Arch-built Go 1.27, Python 3.14 and its own gzip.
- The container shares nothing with the host except the two domain releases, mounted read-only and pinned by id.
- Both reproduce the same three measurements. So the prediction does not depend on the build host's tools, as far as
  these versions go.

The container ran on the same physical machine. A run on a second machine is still open. The first place the
predictor is installed (nan) is that second machine: its known-answer test must pass there before it serves anything.

The sev-snp-measure digest differs between installations, because the entry script names its own venv's interpreter.
Pin the digest of the installation the relay actually runs.

Mean prediction time is about 12 to 26 s cold per catalog version (two admitted releases) and about 0.2 s cached.

## Rerunning

```
# the two domain releases with known answers (ids 5c3561f9… and 6f14ce75…), anywhere readable
node docs/security/measurement-prediction/validate.mjs --repo <git clone holding 0181bce3> \
  --commit 0181bce3aac5fa03dfaf2928d834ecd04d2a4a73 \
  --release 5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2=<release-0181bce3> \
  --release 6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb=<release-6757d139> \
  --admit 5c3561f9…,6f14ce75… --sev-snp-measure <venv>/bin/sev-snp-measure --work <private dir>
```

## Not yet

The domain releases are not PUBLISHED. The run-3 container still received them from the build host, pinned by id.
Until a release is published (bytes plus id, with the licence obligations for the kernel, the firmware and the runtime's
shared libraries), an outside verifier can check a release against its id but cannot fetch one independently.
