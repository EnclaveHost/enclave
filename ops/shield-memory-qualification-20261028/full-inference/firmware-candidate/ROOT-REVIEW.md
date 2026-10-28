# Root review, 2026-10-28

The hand-written patch dry-run passed with zero fuzz. The original helper correctly bounds accepted high RAM, but the claimed duplicate protection was too broad: two identical 512MiB heads fit the 2GiB budget. Root added a monotonically increasing accepted-end guard; overlapping or out-of-order high heads are deferred. This prevents repeated acceptance of those ordinary high heads; it does not sanitize arbitrary malicious overlapping HOB maps or the unchanged special-purpose/sub-4GiB behavior. Tests include a short duplicate and out-of-order range. The original Claude patch is retained for review only. Added the missing stddef include to the C test.

Original PeiHobLib allocation returns NULL in RELEASE after failure; successful append advances PHIT and never moves existing HOBs. DEBUG can assert on allocation exhaustion before fallback. That is fail-closed, not successful fallback. No changes to blob verifier, SNP validation, production firmware, allowlists or admission floors.

The provided build recipe is not executed verbatim: its grep for sevsecret also matches original comments and would reject the actual original tree. Root uses an isolated source copy, excludes stale Conf/BuildEnv.sh, sets new WORKSPACE/EDK_TOOLS_PATH/CONF_PATH, and makes original firmware workspace and production paths read-only within the build unit. Unpatched and patched builds will be compared, not assumed reproducible. Existing originals are not modified.

Qualification still pending: offline tests/builds, actual boot with split path, negative blob tests, fresh attestation and full inference. Test HOB walk is a model, not execution of edk2's complete PEI services.

## Actual results through 06:34 UTC

5,282 range/model assertions pass under ASan/UBSan. The exact prepared source passed again before compilation. Unpatched RELEASE rebuilt as 2bcca0a2..., different from installed142589cc...; candidate RELEASE5c4840cd..., DEBUG0598d551.... The build is a new platform pin, not a reproducible reconstruction of the installed binary. Original firmware remains unchanged.

Candidate DEBUG4GiB boot of the unchanged724MiB image reaches DOM init and logs successful kernel/initrd/cmdline hash checks. Candidate RELEASE8GiB split-path boot reaches DOM init and reports7734MiB usable RAM. Both intentionally omit GPU rings/model/pad disks; subsequent invalid-rings shutdown is expected, and not an inference result.

The historical substitution-QEMU initially failed dynamic linking before guest execution (libnfs16 absent). This was an infrastructure failure, not a rejection test. A privately extracted library from the locally cached signed Arch package was verified and supplied only to test-QEMU processes; system/production libraries are unchanged. Matching test-QEMU DEBUG control then passed; missing table and substituted initrd produced explicit verifier refusal. Remaining RELEASE negative receipts are collected separately.

Broader negative kernel/cmdline/malformed-table cases listed in Claude review have NOT been run. Existing BlobVerifierLib behavior for unknown GUIDs is a pre-existing limitation, not fixed by this memory patch. Production firmware acceptance remains unchanged. Full inference measurements and independently verified fresh quotes remain pending.

RELEASE control passed on the same test-QEMU and missing-table fell through to the boot manager. RELEASE substituted initrd timed out silently, so its strict result remains INCONCLUSIVE/accepted=false. Source mismatch calls CpuDeadLoop with DEBUG output compiled out; this is consistent with the hang but not a positive runtime refusal diagnosis. Do not change this verdict or count it as production qualification. Isolated full A/B will instead use the DEBUG build that produced explicit rejection diagnostics, with both arms on exactly the same new firmware; production release acceptance remains pending.
