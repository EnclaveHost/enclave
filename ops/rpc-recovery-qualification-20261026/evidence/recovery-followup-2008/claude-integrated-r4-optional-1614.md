# 1614: integrated r4 (root 1612 optional-witnessUrl fix) + integrated r5 (the same on history r5) — FROZEN, NOT run

**No pass is claimed.**
- **What I ran:** sha256, git in my own uniquely named scratch, `bash -n` on the jobs, and Python text edits.
- **What I did not run:** `node`, tests, builds, network, live or USB.
- **Preserved:** integrated r1, r2 and r3, history r4 and r5, and placement r2 all still pass their SUMS checks.
- **Scratch:** `/tmp/claude-int-r4-1614`, `/tmp/claude-int-r4-1614-verify` and `/tmp/claude-int-r5-1614`, all new and mine. No other agent's scratch was touched.

## The bug (root 1612, confirmed in source)
- **Where:** `metal/guest/measured-control.mjs` `derivedReaderEndpoints` called `only(raw, ['format', …endpoints, 'witnessUrl'], …)`.
- **Why it broke:** `only()` refuses unknown keys **and requires every allowed key**. The "optional" `witnessUrl` was therefore mandatory, so every config without it was refused. That broke placement test 3, composition and enrollment.
- **Integrated r3 is frozen as FAILED** and superseded.

## The fix (local; `only()` unchanged)
```js
const witnessPresent = Object.hasOwn(raw, 'witnessUrl');
only(raw, ['format', ...DERIVED_READER_ENDPOINTS, ...(witnessPresent ? ['witnessUrl'] : [])], 'platformApi.derivedReader');
...
if (witnessPresent) { if (!witnessForwardUrl(raw.witnessUrl, ownBackendLiteral)) bad(...); out.witnessUrl = raw.witnessUrl; }
```
- **Absent:** exactly the previous required set (`format` + the 3 endpoints) and the exact previous output bytes and key order.
- **Present:** always validated, **including `undefined`/`null`**, which r3's `!== undefined` would have skipped once allowed.
- **Unchanged:** unknown keys and missing required keys are refused as before.
- **Unaffected:** the role (`composeDerivedReader`) only sees canonicalised values; `only()`'s other callers are untouched.

**Placement test 3 is kept,** with assertions added (the count is unchanged at 5):
- absent gives the exact previous bytes (`JSON.stringify` equality);
- `witnessUrl: undefined` → `/witnessUrl must be/`;
- `witness` → `/unknown field(s): witness$/`;
- `witnessUrl` + `extra` → unknown `extra`;
- missing `baseUrl`, with or without `witnessUrl` → `/is missing: baseUrl$/`.

## Stages
| stage | SUMS sha256 | source tree | `release.git` commit | patch | job | `slice` |
|---|---|---|---|---|---|---|
| **integrated r4** (on history r4) | **`f5192215e666ad0acd2e514d13d04d2c4de706a5050340b86750615b6524f208`** | `59a64a8d6e10d1e9556cfbd132ad339164083793` | `a8165f25…` (`integrated-r4-source`) | `287b8541…` | `c061d39e…` | **208** |
| **integrated r5** (on **history r5**) | **`91497408f07f9e350cceadae847725c760e1126882a734aa3068d29f763725ea`** | `939d8d08acf6b30d97b79cc842edc82e8919c472` | `d0717984…` (`integrated-r5-source`) | `287b8541…` (identical bytes) | `5faad44b…` | **211** |

**Integrated r4:**
- the r3 tree plus **2 files**: `measured-control.mjs` and `test/witness-placement.test.mjs`;
- `patches/INFO-integrated-r4-vs-r3-delta.patch` shows the delta;
- the job patch is verified from a fresh `cff4690a`.

**Integrated r5:**
- **Why it exists:** history r5 (`e9fa8b37…`, tree `97c8a15a`) became FROZEN at 12:59, **after** r4 was frozen. I did not mutate r4.
- **What it touches:** history r5 changes only `backward-history.mjs` and its test, which are disjoint from the driver and integration files.
- **The chain:** … r4 → r5 `97c8a15a` → driver `1119db5b` → the **byte-identical** integration patch → `939d8d08`.

**Root jobs** (derived from the r3 job by explicit replacements; they verify every frozen input, compose from r9 asserting every tree, and cross-check `release.git`):
```
bash jobs/q-exit-status.sh wint-r4-slice 512 unshare -Urnm bash writer-integrated-stage/r4/jobs/root-writer-integrated-r4.sh slice
bash jobs/q-exit-status.sh wint-r5-slice 512 unshare -Urnm bash writer-integrated-stage/r5/jobs/root-writer-integrated-r5.sh slice
```
Then `check` with 2560.

**Counts:**

| suite | r4 | r5 |
|---|---|---|
| driver-integration | 10 | 10 |
| witness-placement | 5 | 5 |
| driver | 10 | 10 |
| backward-history | **16** | **19** |
| writer-history | 9 | 9 |
| two-anchor | 13 / 12 / 12 | 13 / 12 / 12 |
| KVM r3 | 65 | 65 |
| writer | 23 | 23 |
| composition | 6 | 6 |
| replica | 8 | 8 |
| enrollment | 19 | 19 |
| **slice total** | **208** | **211** |

**Recommendation:** root's history r4 run passed 183 but found the retained-budget gap, and r5 must land before production. Qualify **r5** as the production candidate. r4 isolates the 1612 fix on the already-PASSed history r4 if root wants to separate a failure. Both carry the same integration bytes.

## Risks (honest)
- **History r5's 3 new tests (19) have never run.** A failure there belongs to the r5 author (6d), not to this integration.
- **Root 1612's other suites were not re-run:** composition and enrollment failed only through the mandatory key, and enrollment was stopped by root (1613). The fix targets exactly that, but only root's run qualifies it.
- **Unchanged pending activation items** (from 1596/1602):
  - producer r3 qualification;
  - the QEMU forward path;
  - rollup-config bytes and pin;
  - a template with `driver` v2 + `history` v2;
  - the signed rotation;
  - KVM review;
  - measurements.

  Admin controls are unchanged, and default-disabled holds by construction.
