# writer-integrated-stage/r1 provenance (prepared; NOT run by Claude)

**Chain of bases:**
1. r9 `release.git` `296a5833` (tree `90e4cdaa`);
2. two-anchor r1 → `f22d554c`;
3. r2 → `20d0d76a`;
4. r3 → `5f141c3f`;
5. **cold-recovery r2** → `e903c224` (SUMS `73fae0c1…`);
6. **+ driver r1** (`writer-driver-stage/r1`, SUMS `05c3dc7d…`; its patch adds two new files and applies cleanly on cold-recovery r2) → **`177184a6f10fb76b35f867190bdfc6616ece1777`**;
7. **+ `patches/writer-integrated-r1-vs-cold-recovery-r2-plus-driver-r1.patch`** (sha256 `486e658c2b7d0537f93cd920f2b18c1b36d1aa3d83218dca21911d3c717fb28a`) → **`f473e41dfffa13a943a94caf2ee0a92786374e12`**.

- **Reproduction:** re-applying all six patches to a fresh `git archive` of r9 reproduces every tree.
- **Scope:** prepared in scratch `/tmp/w5`. Frozen stages and their scratch dirs are untouched; KVM original source is changed only in this staged composition.
- **Not done:** tests, builds, `node` runs, network actions or commits. **Executed:** only `bash -n` on the job, sha256 sums and scratch git trees.

| file | base (177184a6) | r1 |
|---|---|---|
| relay/derived-reader-driver-wiring.mjs | (new) | 515d09f97b54daea245734e2d9972f480aa59fefa8efe727bde59d22ae401ac1 |
| relay/derived-reader-runtime.mjs | cd62be18feb74c39f6654e429d4a46dcea3fb33b12e482f15e537b70621cf717 | ec5010cdcd29890c437b5acef8f2000a99ae2d11f526972b74e1335e86b26c9a |
| relay/derived-writer-authority.mjs | 3b040fb1af35d7e7defccf0d68aab9ce6ee93316bdc8538b1a5b53a025be59fa | 406da9d42cda31b7bef66dacbbd2166764fca3d010caab307d5d4bff092a3c3f |
| network/derived-reader/provider.mjs (KVM area, staged) | 76a72d05d27cac83b08ffc9e9b0771d3d5b2fae21ca4f4ba7a5d071e9041abce | 4d712093d62b8f7b27cb8266810f83fc1c214b32b92f0402f8a325e14b6244a4 |
| test/derived-reader-driver-integration.test.mjs | (new) | d79e867693611916f249d690447a0983609fb95bad7c2bda7802cb181568ff8b |

**Unchanged:**
- the driver module and its suite (driver r1 bytes: `689ff934…`, `d35dec97…`);
- the backward-history module;
- the vendored schedule reader (`694f1297…`).

## Expected counts
| suite | tests |
|---|---|
| driver-integration | 8 |
| driver | 10 |
| backward-history | 10 |
| writer-history | 6 |
| two-anchor | 13 / 12 / 12 |
| KVM r3 suites | 22 / 6 / 5 / 10 / 8 / 14 |
| writer | 23 |
| composition | 6 |
| replica | 8 |
| enrollment | 19 |

- **The `slice` total is 192.**
- **`check`** adds the r3 check set unchanged, including the rebuilt reader runtime bundle carrying the new exports.
