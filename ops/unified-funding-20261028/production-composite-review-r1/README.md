# production-composite-release-r1 (source only)

`build-composite.mjs` builds an **additive, immutable** frontend release. It takes the exact 1126 files / 74403175 bytes of the live release `bafybeifidlc…lwlzcm`, read from a root-provided local copy, and adds exactly the 5 reviewed funding-r2 addon files. It derives a **new** CID with the repository's own `importDirectory` / `writeCar` / `readCar` / `walkFiles`.

**Status: written only. Nothing here has been run.** Not the build, not the tests, not any hash of these files. No real composite exists yet, and no CID or CAR hash is claimed. This tool does not stage, activate, restart, or change any Caddyfile. It doesn't deploy, touch the network, or touch any wallet, key, or session.

## Files
- `build-composite.mjs`: the builder (CLI + `buildComposite(opts)`). It uses only Node built-ins.
- `test/build-composite.test.mjs`: offline `node:test` tests on small synthetic trees in `os.tmpdir()`. They also read the real `tree-us-west.json` to confirm the canonical inventory hash, and skip that check if the file is absent.

## Root lane
```
cd production-composite-release-r1
node --test test/                 # needs the pinned enclave/scripts/site-release/{unixfs,car}.mjs at the path in the test
sha256sum build-composite.mjs ../production-site-addon-r2/artifact-disabled-r1/MANIFEST.json   # review; MANIFEST sha -> flag below
node build-composite.mjs \
  --base-tree /ABS/ROOT-COPY/site \
  --inventory /home/steven/Documents/Codex/2026-10-23/it/work/restore-queued-20261028/live-site-public/tree-us-west.json \
  --addon /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/production-site-addon-r2/artifact-disabled-r1 \
  --addon-pins /home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/production-site-addon-r2/pins-disabled-reviewed-r1.json \
  --site-release-dir /home/steven/Documents/Codex/2026-10-18/wo/work/enclave/scripts/site-release \
  --base-cid bafybeifidlcmnobifev33hflaicusmzjpcqgwutobbzilaoc6tgylwlzcm \
  --expect-files 1126 --expect-bytes 74403175 \
  --expect-inventory-sha256 9269fe1f19b3d4e32aa109717c8e187ddfd4300294ef1d52e52bfc65642fa372 \
  --expect-addon-manifest-sha256 <reviewed sha256 of artifact-disabled-r1/MANIFEST.json> \
  --base-source-commit 48a812d22 --base-source-dirty true \
  --out /ABS/NEW-DIR-ON-THE-HOME-FS
```
Every flag is required. Nothing has a default, nothing is discovered, nothing is downloaded, and unknown flags or options are refused. No option disables a check, including in tests.

The base copy must be a plain copy whose files each have link count 1. Use `cp -r` / `cp -a`, or `rsync` without `--link-dest`. Use the exact `…/<oldCID>/site` content.

## Checks, all before the first write
1. **Pinned code.** `unixfs.mjs` and `car.mjs` must hash to `9f6a1581…` and `41ef4092…` (the pins in `additive-release-approach.json`; hard-coded, not overridable). The pinned bytes themselves are executed via `data:` URLs, so nothing can change between hashing and import. The one relative import in `car.mjs` (`from "./unixfs.mjs";`) is pointed at those same pinned bytes. That is the only rewrite, it must match exactly once, and it is recorded as `carExecutedSha256`.
2. **Paths.** All inputs are absolute and normalized, with no symlink on any ancestor (and `realpath` equals the path). `--out` must not exist. Its parent must have no symlink ancestors and be on the same filesystem (`st_dev`) as the addon working tree. `--out` must not be inside the base tree, the addon, or the site-release dir, and the base and addon must not contain each other.
3. **Inventory.** It must have `claimedReleaseCID == --base-cid`. Each file must be exactly `{path,bytes,sha256}`, with no duplicates and every parent directory listed. The count and bytes must equal the flags, both summed and as stated. The Python-canonical sha256 (byte-identical to `capture-tree.py`'s `json.dumps(sort_keys, compact, ensure_ascii)`) must equal the flag and the stated `inventorySha256`.
4. **Base tree.** A metadata walk comes first, capped by the expected file count, directory count, and bytes. It refuses symlinks, special files, hard links (`nlink != 1`), nested mounts, and unrepresentable names. The tree must match the inventory exactly: every file and directory, no extra entries (including empty directories), no missing ones, same sizes. Then every file is read with `O_NOFOLLOW` at its exact size, on the same inode, unchanged while read, and its sha256 is checked. Finally `importDirectory(base).cid` must equal `--base-cid`, which is the repository's own release identity check (`release.mjs` verify), and its rows must equal the inventory.
5. **Addon.** The artifact dir must hold exactly `ADDITIONS.json`, `ADDITIONS.sha256`, `MANIFEST.json`, `site-additions/`. `MANIFEST.json` must hash to the flag, be schema `enclave-funding-addon-manifest-r2` in `build` mode, and list exactly 5 additions with safe path segments. `ADDITIONS.json` and `ADDITIONS.sha256` must equal the manifest exactly, in the builder's format. The reviewed pins file (`reviewed: true`) must equal the manifest's `pins`, `esbuildVersion`, and every `inputs` hash. Every `moduleClosure` entry must be pinned. `site-additions/` must be exactly the 5 files and their directories, sizes and hashes verified, with the same refusals as the base.
6. **Collisions.** An addition may not equal an existing file or directory, compared case-insensitively. No ancestor of an addition may be an existing file or another addition. An existing directory may only be reused with its exact case.
7. **Limits.** Base plus additions must total 100 MiB or less. The composite must be exactly base count + 5.

## Writes (only under the new `--out`)
```
OUT/site/**                   exact 1126 base files + 5 additions (bytes only; modes 0644/0755, permissions are not copied)
OUT/site.car                  CARv1 of the new CID (writeCar)
OUT/site-root.block           root dag-pb block
OUT/composite-provenance.json sidecar, written LAST, outside the CID payload
OUT/NOT-QUALIFIED.txt         only on a failure after the first write (with the error)
```
After staging, the builder:
- re-walks the staged tree for exact paths and directories.
- runs `importDirectory(OUT/site)`, whose rows must equal base + additions, and requires every old file's UnixFS file CID to be **identical** to its CID in the base DAG. The new CID must differ from the base.
- runs `writeCar`, reads the CAR back from disk and checks its sha256, then runs `readCar(bytes, {expectRoot})` and an explicit `walkFiles`. Rows, block count, and the root block must all equal the import.
- re-verifies the base tree against the inventory to show it did not change underneath the build. The tool never writes to it.

**Qualification rule:** `OUT` is a candidate only if `composite-provenance.json` exists and `NOT-QUALIFIED.txt` does not. Any other state is **NOT QUALIFIED**, including a crash or kill that left neither file. Nothing is ever deleted or overwritten, even on failure. Remove a failed `OUT` yourself after review.

## Provenance sidecar (`composite-provenance.json`)
The sidecar records:
- **base:** CID, tree path, and source `48a812d22` / `dirty: true`. The source comes from your flags and is labeled as base-only.
- **inventory:** file sha256, canonical sha256, counts, and the capture time and root.
- **addon:** manifest sha256, schema/version/mode, esbuild version, pins, all input hashes, module closure, the `ADDITIONS.sha256` hash, and the reviewed pins file and its hash.
- **tool:** its own sha256, the Node version, and the pinned site-release identity.
- **composite:** new CID, files, bytes, directories, CAR sha256/bytes/blocks, and the root block sha256.
- **files:** each addition `{path,bytes,sha256,cid}`, and each old file `{path,bytes,sha256,cid}` as preservation proof.

Nothing in the payload references the sidecar or the new CID; the payload is fixed before the CID exists. The sidecar contains no hash of itself. The CLI prints the sidecar's sha256.

The inherited `.well-known/enclave-site-release.json` and any other ledger stay byte-for-byte. They are **base** metadata, not this build's provenance. `OUT` is not a `release.mjs` release dir: there is no `release.json`. Do not run `prepareRelease`, `deriveRelease`, or `verify` on it.

## Tests (offline)
The tests cover:
- the canonical hash against literal Python output, plus the real inventory's `9269fe1f…`
- the happy path: preservation of every base file's sha256 and UnixFS CID, the kept empty directory, independent re-derivation from the staged tree and the CAR, the sidecar contents, no new CID in the payload, the base unchanged, a deterministic re-run
- a tampered CAR
- required and unknown options, the 100 MiB cap, non-normalized paths
- out existing / inside the base / inside the addon
- symlinks in the base, in the addon, and on an input ancestor
- hard links
- base tamper (same size), unlisted file or directory, missing file
- stale or mismatched index identity: wrong CID, wrong canonical hash, wrong count, a self-consistent index naming another CID, an index listing a file the tree lacks
- addon collisions: exact, case-only, file-as-directory
- addon tamper, extra file, extra top-level entry, manifest, `ADDITIONS.json`, unreviewed pins, input pin mismatch
- a post-write failure (a directory pushed over the HAMT threshold) leaving `NOT-QUALIFIED.txt` and no sidecar or CAR

## Notes / limits for review
- **Not covered by tests:** special files such as FIFOs (they can't be created without exec; the walk refuses them, and opens use `O_NONBLOCK`) and kill-mid-run.
- **Memory:** peak is roughly 2–3× the tree size (about 75 MB). That is the base DAG (freed before the composite import), the composite DAG during `writeCar`, then the CAR bytes plus zero-copy `readCar` views. It should be well under 768 MiB.
- **Node:** use ≥ 20 (`node:test` `t.after`, bigint stats, `data:` ESM imports of `node:` built-ins).
- **Out of scope for later, reviewed steps** (see `additive-release-approach.json`): staging under `/opt/enclave-site/<newCID>/`, any CID re-check on the edges, and all activation.
