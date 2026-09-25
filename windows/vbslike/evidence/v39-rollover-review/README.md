# v39 rollover review: b7ba7731 becomes the one eligible reference image (d1, 2026-09-25)

**What changed.** enclave-63's package v39 (windows/vbslike-pkg `7e979b384c3712b0b81751b00b320b66d7b54d79`, draft
`nucbox-ownguest-39.json`, id `61028ec33770f4d7e6238e2c042e065dc29b41f3298cd8c2045a28d129768cbc`) makes candidate
`vbs-linux-candidate-1539` the ONE eligible reference image:
- image `b7ba7731240ec9025f8c92651be17ecf8af17764e2c3eb0bd20af60f00923748`;
- launch digest `56FBB27F363A7FEDC83FD56CB4FF39C5411140300BB8F8496C35893A061077E1`.

Its reference is `reference/nucbox-vbs-reference.json`, sha256
`b4d6675dd9b78eafceb10461a228bd8e039c8534b5b958a5fadc3a479cb97d29`. enclave-99 re-pinned it on main in `cf1b9dc3`
(and `f71c0a09`).

**Why it went ahead.** The user lifted the earlier hold. Its conditions were met: enclave-99's clean verification
review, the recorded byte and digest checks (`3e3ad330`), and package-owned functional acceptance 094631 (`98782fbb`).

**What "eligible" means here, and nothing more.** It is a permitted measured-image reference, PROSPECTIVE, and subject
to every remaining verification requirement. It grants:
- no production app capacity;
- no verified or attested status;
- no badge;
- no protected-host admission.

**What stays exactly as it was:**
- `host_excluded=no`; the tier is T0-hv, `attested:false`.
- Custom-report verification is unsupported and fail-closed. No report format is registered, and no verdict uses the
  allowlist. `hyperv-partition-domain/v1` stays `supported:"delegate"`, `hostExcluded:false`.
- Production attach OFF, respawn OFF, recovered VMs HELD.

## d1's independent checks

1. **Pins.** The committed draft hashes to `61028ec3…` and the reference to `b4d6675d…`. The commit touches only
   `windows/vbslike/pkg/**`.
2. **The reference, derived by enclave-99's own `eligibleDigestsOf`** (main `verifier/nucbox-reference.mjs`, sha256
   `7d3fa6fb…`, unchanged by the re-pin). The script is `d1-refcheck.mjs` here, and its output is
   `refcheck-v38-v39.txt`:
   - v38 `ba3f49a7`: 1 eligible (58DFEBFE), 11 refused. v39 `b4d6675d`: 1 eligible (56FBB27F), 11 refused.
   - The SAME 12-digest set: nothing added, nothing dropped.
   - Only these changed:
     - 1539's `eligible` and `reason`;
     - `vbs-linux-candidate-g1` (a44bb55a, 58DFEBFE) and its debug twin (4991b3e1, 2A93ED16) moved from `images[]` to
       `superseded[]`, keeping their digests and image sha256;
     - the top-level `eligible` and `notAClaim` prose.
     Every other entry is byte-identical.
   - Refused by exact digest in v39:
     - debug twin 8E9D6ACB (1539's), G4 probe CF339BC5, a7b0bd4-control 77C66160, a7b0bd4-debug 4CE6EDC3, stock
       6FFB817F;
     - superseded 58DFEBFE, 2A93ED16, A0FDAC0F, A650C020, 246DEE1B, 0677F3C6.
   - Mutations, each REFUSED outright by the derivation:
     - each of the 5 non-eligible images marked eligible alone;
     - each of the 6 superseded entries marked eligible;
     - a half-done rollover, with G1 restored eligible beside 1539 ("2 images are marked eligible ... exactly one at a
       time");
     - a duplicate digest.
3. **Package verify and suite.** Run in a separate worktree at `7e979b38`:
   - `pkg.mjs verify … --rebuild --tests`: PASS `61028ec3…`.
   - `node --test pkg.test.mjs`: 96/96, 0 skipped, including the PowerShell 7 cases, run alone from 11:01:28Z to
     11:05:59Z.
   - An earlier overlapping run failed 4 tests with ENOENT. The suite's fixed scratch directory is shared, and each
     run's `after()` deletes it. That is a harness defect, reported to enclave-63 and being fixed as a per-run
     directory; it is not a package defect.
4. **Manifest.**
   - `managerEnv` has the same 19 names. Only `ENCLAVE_GUEST_IGVM` and `_SHA256` moved, to b7ba7731. There is no
     respawn, attach, relay or tunnel variable.
   - The `tier` is byte-identical to v38's.
   - No shipped file or `vmWorkerRead` entry names a44bb55a or 4991b3e1.
   - `rollback` names v38 exactly: `0f328a18`, id `88c18259…`, staged at `pkg\88c18259137a5ba1\`, the a44bb55a and
     4991b3e1 IGVMs, and reference `ba3f49a7`. Nothing is deleted.
   - `hostChecks.vbsLinux.boxFiles` `type1.vmgs` carries `blankVmgs` {4194816 bytes, 4194304 zero, footer
     `conectix`, not `GUESTRTS`} plus sha256 `4f051697…`.
5. **enclave-99's main re-pin** (`cf1b9dc3`, `f71c0a09`):
   - `verifier/pins/nucbox-vbs-reference.json` is byte-identical to v39's reference.
   - `SOURCES.json` names origin `7e979b38` (v39) and keeps `ba3f49a7` in `previous[]` and in a `rollback` entry.
   - `test/verifier-nucbox-reference.test.mjs` passes 2/2.
   - The only caller of `eligibleDigestsOf` is that test. No `relay/`, `site/`, `verifier/web` or `verifier/dist` file
     carries the reference or either digest.

## Unresolved, unchanged by the rollover

- No real VbsReport from any measured guest, and no report signer verified. Report capture stays PARKED.
- No guest key or app binding in any report. No host-memory exclusion evidence (E3 PARKED). PCR0 unpinned.
- Neighbour denial not established (runs 093326 and 093904 INCONCLUSIVE). The runtime probe extensions stay PARKED.
- A domain's reach to the 9001 signer is untested (enclave-99's de2a9f66).
- Per-partition AK distinctness is unshown. That is a precondition for any future vTPM key use; V5 admits on nothing
  in "keys" today.
