# writer-integrated-stage/r2 provenance (prepared; NOT run by Claude)

**Chain:** r9 `release.git` `296a5833` (tree `90e4cdaa`) → two-anchor r1 `f22d554c` → r2 `20d0d76a` → r3 `5f141c3f` → cold-recovery r2 `e903c224` (SUMS `73fae0c1…`)
→ **history r3** `writer-cold-recovery-stage/r3` (SUMS `320b80b8…`, patch `dbe2d1a6…`) → **`a4dd62c303e2742dadc2b5fdf9d6d0023e5cd91a`**
→ **driver r1** (SUMS `05c3dc7d…`; two new files) → **`d9ff6a9148fd5a984a35b905ad293edb199cea3c`**
→ **`patches/writer-integrated-r2-vs-cold-recovery-r3-plus-driver-r1.patch`** → **`a01a3e95f42b965eddd1d45c968be0c6b0e0e1a7`**.

- The r2 patch = the integrated r1 patch (`486e658c…`; `--3way`, no conflicts) + the r2 rollup-config pin gate and tests.
- Integrated r1 (SUMS `47498c7c…`) is preserved and superseded.
- Reproduced in a fresh clone from `e903c224`. Scratch `/tmp/w7`; `/tmp/w5` and `/tmp/w6` untouched.
- Executed: `bash -n`, sha256, git trees and one `node --check` (syntax parse of the integration test). No tests, builds or commits.

| file | base (d9ff6a91) sha256 | r2 sha256 |
|---|---|---|
| relay/derived-reader-driver-wiring.mjs | (new) | 8f454e858b877495f0ef0f5abdb0725bf43f037303f6027f06799e0d01631c88 |
| relay/derived-reader-runtime.mjs | cd62be18feb74c39f6654e429d4a46dcea3fb33b12e482f15e537b70621cf717 | ec5010cdcd29890c437b5acef8f2000a99ae2d11f526972b74e1335e86b26c9a |
| relay/derived-writer-authority.mjs | 0e98e1b26995e10df9e38b9b31be40a8ac703b72dcd8ffb7c9b1d2e1e5839316 | 3af33cd618d663b272864b63f92832963450504c0206c119cf4d6f90d54aefcf |
| network/derived-reader/provider.mjs | dcf0f177433a1af378fd00166b46eb517c58a5330fa1b0c32e6108896fd7fcb6 | 923dd29d8ea567bb81025e04a7e643fb9c1f7fb10b0518f6a61528051fbcae7f |
| metal/guest/platform-api-role.mjs | 2b76ee6770b8abb6e76c3be27c4b41ae275fa8a111f349c6c2317dd5a42d5272 | fb40bef08126425ca044939f2acb413af99aceec888d58ba7ef3b83402894ae2 |
| test/derived-reader-driver-integration.test.mjs | (new) | a1c84ed3579ecd3b011f29318e98a44a84071ae0ed362077db85cf60a8bd650c |

**Unchanged:** the driver module and its suite (`689ff934…`, `d35dec97…`); history r3 files; `metal/derived-reader-config.v3.json` (`49ccf144…`); `metal/derived-reader-image.json`; vendored schedule reader (`694f1297…`).

## Expected counts
- **slice = 199:**

| suite | tests |
|---|---|
| driver-integration | 9 |
| driver | 10 |
| backward-history | 13 |
| writer-history | 9 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 suites | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

- **check:** + the r1 check set, with the guest-bundle input check extended by `metal/guest/platform-api-role.mjs`.
- **Pending:** the witness transport placement (root 1583; placement r2 not frozen) and the producer output bound (root 1589).
