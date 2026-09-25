# Installing release a4f22748: what goes where, the 4d flags, the pins, the rollback

For enclave-63's guarded rollout scripts (rows 4-10 of GUEST-POOL-ROLLOUT.md). This is a description, not a script.

**Gate.** Nothing here runs until:
- the image diff 0181bce3..17e182a8 is signed off:
  - enclave-d1 signed off 0181bce3..aff21c73 (should-fix: d1a38994) and approved d1a38994;
  - enclave-e3 (for enclave-99) approved every commit through d1a38994, with one medium fail-open, fixed in ecf02384;
  - d1 and e3 approved ecf02384 (release 0839ac3a, installed inert, superseded);
  - 77cf2d78 (dominit: the app's stdio is /dev/null; Codex's decision) awaits enclave-d1's and enclave-e3's review;
- enclave-99 reviews the scripts;
- Codex gives the go.

The release stays OFF throughout.

Ids:
- New release: `a4f227482df4830ab69b52e38dc5d6e2abea9e5c5fb71f5469f0c30e6b1cb784`, image commit
  `17e182a8ba192152a83feee4f79d63f8628094e8`.
- Live release: `5c3561f91bc76a7aab5830071d1093162c5833872884c938574673f491dd87f2`, commit
  `0181bce3aac5fa03dfaf2928d834ecd04d2a4a73`.
- Known-answer release: `6f14ce7537082bd2a68d96ead6a133af4a5134e97e9b43ebc210a3cb957c1adb`, 6757d139.

## A fact the scripts must respect: guestd never reads a release directory
guestd builds every guest image from its `-isolation` SOURCE TREE:
- `m4/build-app-guest.sh` runs `app-image-template.sh`;
- that builds the front from `m2/` with the host's Go and the init from `dominit.c` with gcc, composes the runtime set,
  and copies the guest modules;
- the kernel and cmdline come from `m1/domain.env` (`/boot/vmlinuz-linux`), and the firmware from guestd's `-ovmf`.

So a guest runs release a4f22748's image only because that build reproduces the release on this host. Two builds did.
Phase 2 showed guestd's build equal to the relay's prediction for the lab release. Step 1d below checks it again on
the installed tree.

A host kernel or toolchain change (`/boot/vmlinuz-linux`, Go, gcc, glibc) moves every new guest's measurement away
from the release. That fails CLOSED: the relay refuses the release and the guest does not serve. It is never a
silent acceptance. Re-run 1d after any host package upgrade.

## 1. INSTALL on warden-host (inert)
**a. The release, as a reference copy.**
- `~/enclave-prod/release-17e182a8/` is `cp -a ~/enclave-bench/prod-release-17e182a8/release-17e182a8`.
- Then `python3 ~/enclave-prod/iso-17e182a8/isolation/m4/release-manifest.py verify ~/enclave-prod/release-17e182a8
  --expect a4f22748…` must print `verified 15 files`.
- Keep every copy OWNER-WRITABLE. The manifest pins contents, not modes. `expected-measurement.sh` snapshots the
  release with `cp -a`, so a read-only copy yields a read-only snapshot. The measurement then fails before it is
  printed (assembling writes into it), and the cleanup cannot remove the snapshot. Found by enclave-e3 on the
  artifact, which I had made read-only; it has been owner-writable since 2026-09-25 19:27Z, and the existing
  `release-*` dirs are too.
- No process on warden-host reads it. It is the copy that verifiers and `expected-measurement.sh --pin` use, and the
  source for nan's copy (3a).

**b. The new tree.**
- `~/enclave-prod/iso-17e182a8/` is a clean checkout detached at 17e182a8…, in the same form as `iso-03be27d6` (a git
  worktree of `~/Projects/enclave`).
- Checks:
  - `git -C … rev-parse HEAD` = `17e182a8ba192152a83feee4f79d63f8628094e8`;
  - `git -C … status --porcelain --ignored` prints nothing: no `isolation/m2/release/labpins/`, no built binaries.
- At 4d, guestd reads from `<tree>/isolation`:
  - `m4/build-app-guest.sh` and what it calls (`app-image-template.sh`, `assemble-app-image.sh`, `runtime-set.sh`,
    `pack-initrd.sh`, `release-manifest.py`);
  - `m1/domain.env`;
  - `m2/run-domain.sh`, which boots EVERY guest, legacy ones included;
  - `m2/fwd`, which guestd builds into `<root>/bin/fwd` at start;
  - `m2/client.mjs` + `judge.mjs` + `../relay/snp-verify.mjs`, its judge (node builtins only, no node_modules);
  - `../test/fixtures/amd/Turin-cert_chain.pem`, the default `-chain`.
- The judge, fwd and snp-verify are byte-unchanged since 0181bce3.

**c. The guestd binary.**
- `~/enclave-prod/bin/guestd.<commit>`, built from the reviewed host-side commit with
  `cd isolation/m4/guestd && go build -trimpath`.
- That commit is the merge carrying enclave-63's host-memory floor (d67b0020 + 1b5375c9) once enclave-99 approves
  them. guestd is host-side and not measured, so this choice does not touch a4f22748.
- Keep `guestd.c42612c0` (live) and every `guestd.prev-*`.

**d. Reproduction on the installed tree** (the check that makes 1b meaningful).
- From `~/enclave-prod/iso-17e182a8`, with the unit's environment (GOFLAGS and ISOLATION_LAB_FRONT unset), run
  `sh isolation/m4/domain-release.sh $(mktemp -d)/r`.
- It must print `release a4f22748…`. Then remove the temporary directory.
- This is guestd's own template build, from the installed tree, with this host's tools.

**Inert.** 1a-1c create paths that nothing references: the unit's ExecStart is unchanged and nothing restarts. 1d
builds files in a temporary directory only. Checks before and after:
- `systemctl --user show enclave-guestd -p MainPID -p ExecStart` is unchanged;
- the `m2-gd*` unit list is unchanged (the fatal diff).

## 2. 4d: guestd's flags
ExecStart is the new binary, with the live flags unchanged except:
- `-isolation ~/enclave-prod/iso-17e182a8/isolation` (was `iso-03be27d6`);
- `-release`;
- `-legacy-isolation ~/enclave-prod/iso-03be27d6/isolation`: the live tree at 0181bce3, untouched;
- `-instance-prefix gd`: the default, written out;
- NO `-ticket-port` / `-egress-port`. The defaults 9444/9443 are the production front's compiled `TicketPort` /
  `EgressPort`. A lab port on the production guestd would strand every release guest.
- Keep `-root`, `-listen`, `-data-listen`, `-auth-key`, `-gateway`, `-guest-mem-mib 65536` and `-guest-cpus 16`, plus
  `-guest-host-floor-mib 16384`: Codex chose it for this pool at its next coordinated guestd rollout, and 4d is that
  rollout (enclave-63).

Preflight (enclave-d1's conditions):
- vsock ports 9443 and 9444 are free. Bind-probe them with `isolation/m2/lab-release/portprobe`; this host has no
  vsock_diag, so `ss --vsock` shows nothing either way.
- No lab is running: no `m2-lb*` units, and no process whose `/proc/PID/exe` is under `~/enclave-bench/lab-release`.
- MemAvailable as in S2.

What 4d changes while the live supervisor (c42612c0, ISOLATION_RELEASE unset) runs:
- `/health` `supports.release` and `supports.legacyImage` become true. `config`, `secrets` and `egress` STAY false, so
  the supervisor's claim gate is unchanged.
- The supervisor never sends `release:true`. So every deployment guest is built from `-legacy-isolation`, which is
  0181bce3's image, exactly as today.
- Only the boot script (`run-domain.sh`) comes from the new tree. Its one change is that guestd chooses the CID (band
  131072-196607). The CID is not a launch-measurement input; the kernel, firmware, cmdline and vCPUs are unchanged.
- The adopted canaries keep running: their units are separate, and guestd adopts them from its records.
- A deployment the supervisor ever marks `release:true` (only after rows 7-8) is built from the new tree, which is
  a4f22748's image.

**Pre-4d hardware check: RAN, PASS (2026-09-25 19:22Z, `isolation/m2/lab-release/evidence/legacy-2026-09-25/`).**
A legacy hookbin guest came up with the LIVE canary's AppID and VCEK-signed measurement (be6b8644…), and served.
Re-run `run-legacy-check.sh` if run-domain.sh, guestd or the host's tools change before 4d. The check as designed:
the legacy path, 0181bce3's image booted by 17e182a8's `run-domain.sh`, had never run on hardware. Before 4d, launch ONE non-release deployment guest from a LAB guestd with:
- `-instance-prefix lb`, the lab ports, `-release`, `-legacy-isolation ~/enclave-prod/iso-03be27d6/isolation`, and its
  own root;
- the lab conditions: the fatal `m2-gd*` diff, MemAvailable ≥ 44 GiB, and the exe sweep.

It passes if the guest's measurement equals the 0181bce3 prediction (expected-measurement.sh --pin 5c3561f9…) and it
serves.

## 3. PINS: each ADDED beside the old, never replacing it
**The relay on nan (enclave-99):**
- Copy the release to nan and verify it with `--expect a4f22748…`.
- `SECRETS_RELEASE_PREDICT_RELEASES` += `a4f22748…=<nan dir>`, beside `5c3561f9…=…` and `6f14ce75…=…`. The known-answer
  test needs those two, so they stay installed.
- `SECRETS_RELEASE_DOMAIN_RELEASES` += `a4f22748…`, beside the ids already admitted.
- `SECRETS_RELEASE_PREDICT_COMMIT` stays at 0181bce3…. The toolchain it runs (`expected-measurement.sh`,
  `assemble-app-image.sh`, `release-manifest.py`, `hash-table.py`, `appbundle.c`, `pack-initrd.sh`, `runtime-set.sh`,
  `m1/`) is byte-identical at 17e182a8. Phase 2's prediction of the new-front lab release ran on that toolchain.
- The response key file is S3b's seed, keyId 06212e5df9c3779a, exactly the key pinned in a4f22748's front.

**Trusted clients (row 6):** I found NO list of admitted domain-release ids in `site/`, `cli/` or `verifier/` on main.
The only references to 5c3561f9 or 6f14ce75 there are fixture hashes of `release.json` files. Where a client pins a
release is therefore still open for the row-6 owner. Whatever it is, the rule is 5c3561f9 AND a4f22748, never one in
place of the other.

## 4. ROLLBACK: always back to 5c3561f9 only
Kept installed at every step:
- `~/enclave-prod/release-0181bce3` (5c3561f9) and `release-6757d139` (6f14ce75);
- `~/enclave-prod/iso-03be27d6` (0181bce3);
- `~/enclave-prod/bin/guestd.c42612c0` and every `guestd.prev-*`;
- on nan, the 5c3561f9 and 6f14ce75 release dirs.

- **After 1 (install).** Nothing is live. To abandon, remove `release-17e182a8`, `iso-17e182a8` (`git worktree
  remove`) and the new `bin/guestd.*`.
- **After 2 (4d).**
  - Restore the previous ExecStart (`guestd.c42612c0 -isolation ~/enclave-prod/iso-03be27d6/isolation …`, no
    `-release` and no `-legacy-isolation`), then daemon-reload and restart.
  - While the supervisor sets no release, every guest launched under 4d is a 0181bce3 image, and the old guestd adopts
    it unchanged.
  - A release guest (possible only after rows 7-8) must be DELETED before this rollback: the old guestd has no ticket
    or egress service, so it could not be re-released. It relaunches on the old guestd as a 0181bce3 image, which
    serves no config app, exactly as today.
- **Relay.**
  - Turning the release OFF returns every release request to refused: fails closed.
  - Removing a4f22748 from `SECRETS_RELEASE_DOMAIN_RELEASES` refuses new releases to that image. Guests already
    released keep their config in memory until they are relaunched.
  - Never remove 5c3561f9 or 6f14ce75: the known-answer test needs them.
- **Clients.** a4f22748 may stay pinned. It admits nothing while no guest runs it.
