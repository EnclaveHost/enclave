# offline-b3sum-bundle-stage/r3: bounded concatenated xz streams (source only)

**Status: PREPARED, NOT RUN.**
- No test, build, network, queue, package execution, VM or live action by me. The only local checks were `ast.parse` (no bytecode) and `bash -n`.
- r1 (`405fe0a8…`) and r2 (`8118e2ca…`) are unchanged; both SHA256SUMS still verify.

**Stage:** `offline-b3sum-bundle-stage/r3/`, **SHA256SUMS sha256 `d3445788c816d66e2ba62a8a2a5e311ef159946062e8d720880656c41894abfc`**. Files are read-only:

| file | sha256 |
|---|---|
| `b3bundle.py` | `a88de8fb0d85fd3c72bc7b0e92f183fa80152a53c229c25570310249b95f71aa` |
| `test/test_b3bundle.py` | `f09a2a45695c6bc66181d16273e3e7e47940f6a8fe8f6c0873e1579812098180` (34 tests) |
| `jobs/root-b3bundle-tests.sh` | `5e6f23a742ba2517441e48e349d9ffb566164b3923506fbc6c06bc308524a310` |
| `jobs/root-b3bundle-fetch.sh` | `52c464aa1757587c49be1fea3a8a612a6db3a1b41d062a6015221d4828261a2f` (r2 logic; only the stage paths changed) |
| `README.md` | `dc46dd9a69c248a1fb38f3d78bfdf6b846a9b38d5f1ba551f03f5ad5b97ca39c` |

## Cause
- **Root 1516:** the real fetch verified the signature and the compressed digest. Then r2's `bounded_unxz` refused `d.unused_data`, because it decoded a single stream only.
- **Root 1517:** the signed `Packages.xz` (15,037,908 bytes) is a data stream (73,379,142 decoded bytes) followed by a valid 32-byte empty xz stream. The concatenated output's sha256 `687ffc96…a99a` equals the signed `Packages` entry.
- **Conclusion:** a valid multi-stream `.xz` file; r2's refusal was a decoder limitation, not tampering.

## Change (only `bounded_unxz` + constants; the rest of `b3bundle.py` is r2 except the `/r3` format strings)
- **Start:** the file must start with the xz magic.
- **Each stream:** it must start with the magic and gets its **own** `LZMADecompressor(FORMAT_XZ, memlimit=XZ_MEMLIMIT=256 MiB)`. It must reach `eof`, and the consumed length is derived from `unused_data`.
- **Stream padding:** after each stream, zero bytes are accepted only in a **multiple of 4** (xz spec §2.2). Leading padding and any other byte refuse.
- **Total cap:** each decoder's `max_length` is the remaining budget + 1, and the **total** over all streams must be ≤ `CAP_PKGS` (512 MiB).
- **Stream count:** `MAX_XZ_STREAMS` = 8, empty streams included.
- **Refusals, all rc 8:**
  - a truncated stream (`not eof`);
  - an `LZMAError` (corrupt data, bad footer or index CRC, memlimit);
  - non-xz data after a stream;
  - invalid padding;
  - too many streams;
  - a total over the cap.
- **Trailing data is never ignored.**
- **Unchanged checks:**
  - the `Packages.xz` size and sha256 are checked before decompression;
  - the decompressed size and sha256 must equal the signed `Packages` entry when listed;
  - the stanza, `.deb` size and sha256, signature, S1–S4 and transport checks are as in r2.
- **Memory:** in the official layout only one stream is non-empty, so it is returned without a join copy. Several non-empty streams are joined, transiently ≤ 2 × cap, still under the 1536 MiB lane.
- **Format bump:** the receipt and qualification formats are now `/r3`, so qualify needs a fresh r3 fetch.

## Regressions (6 new; 34 total = r2's 28 + 6; prepared, NOT run)
1. **Actual empty second stream:**
   - the exact 32 bytes `fd377a58…04595a` from root 1517's log after a data stream decode to the data;
   - the digest checks and stanza selection still work;
   - valid variants pass: 4 zero bytes of padding, 8 zeros then the empty stream, padding on both sides, and the empty stream first;
   - an empty-only file decodes to empty output.
2. **Two non-empty streams:** the output is the concatenation, including mixed CRC64/CRC32 checks, padding and a trailing empty stream.
3. **Invalid or truncated second stream:** each of the following refuses with rc 8:
   - the second stream missing its last 4 bytes, header only, or magic only;
   - a bad footer magic or a flipped index CRC;
   - `GARBAGE!` after the first stream or after the empty stream;
   - a truncated non-empty second stream;
   - a first stream missing its last byte;
   - empty input, or garbage before the first stream.
4. **Invalid padding:** 1, 3 or 5 zero bytes, 2 zeros before a stream, 4 zeros then non-zero bytes, leading padding, and 7 zeros of trailing padding all refuse.
5. **Bomb across streams:**
   - two 3 MiB streams under a 4 MiB cap refuse, and a 3+0+3+3 MiB layout under 8 MiB refuses;
   - exactly 6 MiB under a 6 MiB cap passes;
   - with `XZ_MEMLIMIT` patched to 4 MiB, a preset-0 then a preset-6 stream (decoder about 9 MiB) refuses, so the memlimit applies to the **second** decoder.
6. **Excessive streams:** 8 streams pass; 9 streams, or 1000 empty streams, refuse.

The r2 single-stream bomb and truncation tests stay.

## Root commands
1. **Tests** (offline). PASS only with exactly `Ran 34`, a bare `OK` and rc 0:
   ```
   jobs/q-exit-status.sh root-b3bundle-r3-tests 256 unshare -Urn bash offline-b3sum-bundle-stage/r3/jobs/root-b3bundle-tests.sh
   ```
2. **Fresh signed chain** (network; main lane 1536 MiB; 16 GiB floor). The admission and fixed pins are the same as r2: keyring `guest-trust-1492/ubuntu-archive-keyring.gpg`, sha `80a36b0a6de2f69f49d2df75ef473ccde121e9e190b9ea01d20a4f63778d5c31`.
   ```
   jobs/q-exit-status.sh root-b3bundle-fetch 1536 bash offline-b3sum-bundle-stage/r3/jobs/root-b3bundle-fetch.sh \
       <SUITE as in root 1516> universe 1.2.0-1 https <NEW abs OUT_DIR> <root-derived PRIMARY_FPR> [...]
   ```
   Use the same suite as root 1516; the 1517 log does not name it. The component `universe` and version `1.2.0-1` come from 1517's candidate stanza. The expected `.deb` from root 1517 is sha256 `e6e6b98b5e22750160dbb804a2e7d8fb61daa0d6940002c45c222cf676701b7b`, size 387898, Filename `pool/universe/r/rust-b3sum/b3sum_1.2.0-1_amd64.deb`. The fetch verifies these against the signed stanza itself; nothing is hard-coded.
3. **Guest qualify:** per the README, with the new r3 receipt pin.

## Open points
- **Real run:** the real r3 chain has not run. Root's fetch is the evidence.
- **Memory:** peak RSS is unmeasured; the guard's `peakTreeRssMiB` will show it.
- **Stream limit:** `MAX_XZ_STREAMS` = 8 is a policy bound, not a format limit. A future index with more streams would fail closed with rc 8.
