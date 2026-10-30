# writer-integrated-stage/r3 provenance (prepared by Claude 1602; NOT run)

**Chain:** r9 `296a5833` → two-anchor r1 `f22d554c` → r2 `20d0d76a` → r3 `5f141c3f` → cold-recovery r2 `e903c224`
→ history r3 `a4dd62c3` (SUMS `320b80b8…`) → **history r4 `571b5c84`** (SUMS `9fa22972…`) → driver r1 (SUMS `05c3dc7d…`) **`cff4690a08772e24b46447e0b927732754c65c9d`**
→ **`patches/writer-integrated-r3-vs-cold-recovery-r4-plus-driver-r1.patch`** → **`8a616194b085df620bc882eed87d682dad4e6b9f`**.

**What the r3 patch contains:**
- **integrated r2's patch** (SUMS `748cad34…`; applied 3-way onto r4 + driver with no conflicts), giving tree `87260ca7`;
- **witness placement r2's patch** (SUMS `07084e7a…`; 3-way; one test conflict resolved by combining both sides);
- **root 1600 fixes:** the Buffer return, plus test 5 cleanup, the replaced provider and step-error asserts;
- **review 1596 L1/L2**;
- **placement test/fixture moved to policy v2.**

**`release.git`:** a bare repo; branch `integrated-r3-source` = commit `a560f978cbed44bde2546afac7dcc896dcf14b79`, tree `8a616194…`, parent tree `87260ca7…` (integrated r2 on r4).
- It is a scratch commit chain from `/tmp/w9`, with the author SteveDeFacto.
- Source only: no generated files are rebuilt. Root's `check` builds the generated release.

**Reproduction:** verified in a fresh clone from `e903c224`. `/tmp/w5`, `/tmp/w6`, `/tmp/w7` and `/tmp/w8` (da's) were not modified; `/tmp/w7` was only cloned from.

**Executed by me:** sha256, scratch git, `bash -n` on the job, Python text edits. No `node` or tests.

| file | base (cff4690a) sha256 | r3 sha256 |
|---|---|---|
| relay/derived-reader-driver-wiring.mjs | (new) | cd457c107bf96d3d298c7bcd9d43bc5a766ce91f649b54e0a7f0dfa13e294c5f |
| relay/derived-reader-runtime.mjs | cd62be18feb74c39f6654e429d4a46dcea3fb33b12e482f15e537b70621cf717 | ec5010cdcd29890c437b5acef8f2000a99ae2d11f526972b74e1335e86b26c9a |
| relay/derived-writer-authority.mjs | 0e98e1b26995e10df9e38b9b31be40a8ac703b72dcd8ffb7c9b1d2e1e5839316 | e98bae6aaa3d365c513d9d7f1ef6358194f1e4d1870ee95355b7c88b98452a6c |
| network/derived-reader/provider.mjs | 1cf1da3453f6ff2f9674ba22e1db296f8b4ee501228cebeac6bd91f6f5549351 | 30a68f9f1d736b49f6e37c0e02505d0b7b118759bf8353b7f102497b04873a25 |
| metal/guest/platform-api-role.mjs | 2b76ee6770b8abb6e76c3be27c4b41ae275fa8a111f349c6c2317dd5a42d5272 | 4f2bf3bd8671d19c08bd0fd16627350ecbd947cf1a9cb35e8ee5d4d118515d46 |
| metal/guest/measured-control.mjs | 6f6b466ca9fa9f9e17997c4e1a11c3015312d2d08b9c1437afacbbdb5236c05e | a6fd2d5b01393fa731930d3e6c2e7fa3bb73e550a95c8aa709e799b5dedab020 |
| test/derived-reader-driver-integration.test.mjs | (new) | 099c76563fc8745f3a63feb96ef02b3b3864fb7e7659fef341716a97efb44f9e |
| test/witness-placement.test.mjs | (new) | 395af4c0f5a813247911774fc172958c290c3f79c5b4e9fd72f9c77a4b5ef978 |
| test/fixtures/witness-placement-policy.json | (new) | 862d65dac2b21d9830e75f5d4e9a802063f0b245d84484cd8a98b0f2cca7cba4 |

**Unchanged:** the driver `relay/derived-reader-driver.mjs` (`689ff934…`), `network/derived-reader/native.mjs` (its `Buffer.isBuffer` check), the history r4 files, the template `metal/derived-reader-config.v3.json` (`49ccf144…`) and `metal/derived-reader-image.json`.

## Expected counts
**slice = 208:**

| suite | tests |
|---|---|
| driver-integration | 10 |
| witness-placement | 5 |
| driver | 10 |
| backward-history | 16 |
| writer-history | 9 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

**check:** + the r2 check set; the bundle input check adds `measured-control.mjs` and `chain-authority.mjs`.
