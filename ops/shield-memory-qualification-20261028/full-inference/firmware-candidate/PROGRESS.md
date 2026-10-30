# Progress: SNP boot-memory acceptance candidate (source only)

Date: 2026-10-27. Status: **source written. Not dry-run patched, not compiled, not tested, not built, not booted,
not deployed.**

Files:
- `CHANGE.patch`: AmdSev.c (4 hunks) and PlatformPei.inf (1 hunk). It is LF and the targets are CRLF, so apply it per
  BUILD-RECIPE step 3.
- `src/OvmfPkg/PlatformPei/SnpBootWindow.h`: the new pure range helper. It is copied in and is not part of the patch.
- `tests/test_snp_boot_window.c`: an offline helper grid against a 128-bit reference, plus a HOB-walk model.
- `REVIEW.md`: the range math, HOB-iteration safety, tests, limitations, and the gates including the mandatory
  negative hash tests.
- `BUILD-RECIPE.md`: a separate `$W` workspace. It reads `fwbuild` but never writes to it. It does a base build (must
  reproduce `142589cc...`) and a cand build, both `-n 1`.

I edited, copied or ran nothing outside `firmware-candidate/`.
