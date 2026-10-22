# Cold-host SEV-SNP collateral: result

Checkout: `/home/steven/Documents/Codex/2026-10-18/wo/work/enclave` (uncommitted).
- **Not done:** no commits, pushes, SSH sessions, private configs, production or chain writes, root or hardware
  operations, or test VMs.
- **No live KDS request:** AMD KDS was only simulated.
- **Other workstreams' files** are untouched.
- **`isolation/m2/vcek-prep.mjs` is unchanged.** Its report-driven harness role in `test-m2.sh` needs no change,
  and the new tool stands alone, so editing it wasn't justified.

## Files (all new)

- `isolation/m2/host-collateral.mjs`: library and CLI (`prepare`, `inventory`).
- `test/host-collateral.test.mjs`
- `docs/network/cold-host-collateral.md`

## What it does

1. **Explicit chip statement.** The operator gives product line, CHIP_ID (128 hex, or Turin's 8-byte KDS hardware
   ID) and the **reported** TCB, as exact named SPL fields or 8 raw bytes in report byte order. Alternatively,
   `--kds-url` accepts a canonical KDS VCEK URL, refused unless it is byte-identical to what the verifier would
   request. An all-zero (masked) chip ID, an unknown product, and a wrong or extra TCB field are refused.
2. **VCEK source.** Either an operator-supplied file (offline) or an explicit `--fetch-vcek` from AMD KDS.
3. **Verification before install,** reusing existing code (no new certificate path):
   - `verifier/snp.mjs` `checkChain`/`parseAmdChain`: VCEK→ASK→ARK; ARK pinned by SHA-256 (`relay/snp-verify.mjs`
     `AMD_ARK_SHA256`); subject CNs; RSA-4096 ASK and ARK; validity windows at an explicit time.
   - `checkCrl`: an ARK-signed CRL with the ASK not revoked; policy `required` by default, `stale-ok` or `none` only
     explicitly.
   - `vcekMatchesReport`: the VCEK names the stated chip and TCB; its key must be EC P-384.
   - `checkMinTcb`: the **caller's** floor (`--min-tcb`, required). It is never derived from the observed TCB.
   - **Chain trust:** the chain defaults to the repository's pinned copy. A supplied or downloaded chain must carry
     the same ASK unless `--allow-ask-rotation` is given explicitly.
4. **Bounded KDS fetch:**
   - 10 s timeout per attempt, 4 attempts;
   - retries only on 429 or 5xx, honoring `Retry-After` capped at 30 s, otherwise exponential backoff of 2 s, 4 s,
     8 s; a 404 is final;
   - streamed byte caps: VCEK 16 KiB, chain 32 KiB, CRL 256 KiB;
   - redirects refused.
5. **Install:**
   - `--out` must be absolute and must not exist; this is checked before any request, then reserved by exclusive
     `mkdir`.
   - Files are written to `.staging` with `wx` flags and fsync, then renamed; `collateral.json` goes last.
   - Any failure removes everything this run created. Refused collateral never creates the directory, because
     inputs are verified first.
6. **Reproducible metadata:** `collateral.json` holds the statement, the KDS URL, the floor and its hash, the
   VCEK hash/serial/validity, the chain/ASK/ARK hashes, the CRL hash and window or the explicit policy `none`, the
   checks performed and `checkedAt`. It contains no host path; with `--at`, same inputs give byte-identical output.
7. **Read-only inventory:** `inventory` reads only `/proc/cpuinfo` (product line via `snpProductHint`), the
   `kvm_amd` `sev_snp` parameter and whether `/dev/sev` exists.
   - **Labeled remaining step:** CHIP_ID and TCB need SEV firmware ioctls (`SEV_GET_ID2`, `SNP_PLATFORM_STATUS`) on
     `/dev/sev` as root. The doc gives virtee `snphost` commands (`show identifier`, `show tcb`, `show vcek-url`) as
     an external, operator-reviewed tool, with an instruction to confirm them against `--help`.
   - Neither the inventory command nor these steps were run on local hardware.

## Tests

Run: `node --test test/host-collateral.test.mjs`. Result: **5 tests, 5 pass, 0 fail, 0 skipped.**

**Fixtures.** The tests use real AMD material already in the repository:
- the KDS-issued Genoa VCEK `genoa-2026-09/vcek-kds-amd.der`, for the Cloud Provider production chip `1af1aa6c…`;
- the Turin VCEK `turin-m4a-app-2026-10-17/vcek-kds-amd.der`, for warden-host chip `fa11afcf54ae9c53`;
- the pinned chains `test/fixtures/amd/*-cert_chain.pem`;
- the ARK-signed CRLs: Genoa's has 1 revocation, and Turin's is current until 2026-11-09.

The chip statements are read out of the real reports those VCEKs belong to, then supplied as explicit input.

1. **Statement forms.** The exact KDS URLs recorded in `SOURCES.json` are reproduced and parsed back. Six
   non-canonical URL variants are refused, along with a bad chip length, a masked chip, an unknown product and wrong
   TCB fields.
2. **Real collateral.**
   - Both products verify.
   - Refused cases:
     - **Chip and TCB:** wrong chip (Genoa, and the first 8 bytes on Turin); wrong TCB (snp, microcode).
     - **Product and chain:** wrong product (a Genoa VCEK stated as Turin); another product's pinned chain; a
       self-made OpenSSL `ARK-Genoa` root (OpenSSL generation confirmed working, so this case really ran); a missing
       ARK.
     - **Malformed or oversized input:** malformed and truncated VCEK DER; an oversize VCEK or chain; a bogus PEM.
     - **Floor:** above the stated TCB; no floor for the product; a malformed or absent floor.
     - **CRL:** stale under `required`; another product's CRL; a missing or malformed CRL.
     - **Time:** a time before the VCEK's issue; an implicit clock.
   - Accepted cases: a floor equal to the stated TCB; `stale-ok` within an explicit window; `crl-policy none`; Turin
     ignoring CHIP_ID bytes beyond the first 8, as AMD's VCEK does.
3. **Simulated KDS:**
   - 429 with `Retry-After` 7, then 503, then success: sleeps are [7000, 2000].
   - `Retry-After` 3600 is capped to 30000.
   - A 404 is final after 1 request.
   - A hang times out, with attempts bounded at 2.
   - Oversize answers fail at once, both with a declared content-length and when streamed without one.
   - Repeated 503 exhausts the attempts.
   - A missing byte cap is refused.
4. **Prepare:**
   - An offline Turin install produces exactly the expected 5 files, with the pinned ARK hash recorded. A second
     install into a new directory is **byte-identical** for every file.
   - The simulated-KDS Genoa install requests exactly the recorded VCEK URL, then the chain, then the CRL.
   - An existing destination is refused with 0 requests and its sentinel file untouched.
   - A relative `--out` is refused.
   - A KDS answer with another chip's VCEK, a KDS 404, offline without a CRL, a missing VCEK or chain file, an
     oversize file, and a downloaded fake-root chain each leave no directory behind.
   - An injected failure on the third rename removes the partial install.
5. **CLI:**
   - Offline prepare from `--product/--chip-id/--tcb` and from `--kds-url` both succeed, with identical
     `collateral.json`.
   - Five argument errors and the existing-destination case are refused, with no output directory created.
   - Inventory parsing is checked for Turin, Genoa, Milan, Intel, and processors that disagree.

**Mutation checks.** Each defense was disabled in turn, the test file was rerun, and the module was restored and
confirmed with `diff`:

| Disabled defense | Failing tests |
| --- | --- |
| VCEK chip/TCB match | 1 |
| Minimum-TCB floor | 1 |
| CRL check | 2 |
| Destination pre-check (the `mkdir` reservation remains) | 1 |
| Downloaded-ASK equality | 0 |

**Gap:** the ASK-equality guard is not exercised. Its refusal branch needs a second genuinely AMD-signed ASK, and
any self-made or edited ASK already fails the pinned-ARK signature check. I did not add a root override to make it
testable.

## Activation gates

1. **Hardware extraction:** CHIP_ID and the reported TCB must come from the SEV firmware as root, using a reviewed
   external tool (for example virtee `snphost`; confirm its subcommands). This repository does not implement or
   test the ioctls.
2. **Live proof:** on a real cold host:
   1. extract the chip ID and TCB;
   2. `prepare` with a live KDS fetch, or carried files;
   3. start guestd with `-vcek`, `-chain` and `-min-tcb` from the new directory;
   4. boot one guest;
   5. confirm guestd's attested verdict names the same chip and TCB.

   None of this has been done; the tests certify no hardware.
3. **TCB floor policy:** the operator must choose it from AMD security bulletins. The test floors are fixture
   values, not recommendations.
4. **CRL freshness:** AMD CRLs carry a `nextUpdate` a few weeks out, so carried offline bundles go stale and are
   refused under the default policy.
5. **ASK rotation:** a genuine AMD ASK change needs review, then `--allow-ask-rotation` or an updated repository
   chain. That path has no positive test.
6. **Integration:** `docs/network/cold-host.md` (owned by another stream) still says collateral for a cold host is
   not automated. It should link to `docs/network/cold-host-collateral.md` when that stream updates it.
