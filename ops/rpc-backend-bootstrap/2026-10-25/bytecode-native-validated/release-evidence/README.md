# Actual release result, 2026-10-25 22:23 UTC

Fresh optimized executable SHA-256 42d692d432fb7a1303d47a592f5439c8a9439fd84e8622277be646779c03ba6d, 1,227,952 bytes. Actual guarded build exit 0, peak696MiB, minimum host available21909MiB. The exact immutable native source already passed13 tests and5 assertion controls in the debug test profile. This is not an independent reproducibility result.

The executable also launched on the actual Ubuntu RPC guest, refused missing arguments and a nonexistent database, and did not create a database directory. It remains in a private root-owned smoke directory; no production executable, service or database changed. This is an ABI/refusal smoke, not a real snapshot scan. Native database validation, original anchor state authentication and all production cutover gates remain pending. The conservative padding rule is unchanged; OPEN_GAPS remains enforced.
