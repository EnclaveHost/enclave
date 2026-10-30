# Separate corrected L1 client trial r2

R1 actually refused before bootstrap mutation because systemd reports unused implicit slices as loaded/inactive. Exact independent readonly observation confirms all three slices have no FragmentPath, DropInPaths, ControlGroup, InvocationID or transient definition; all proposed client services absent, ROOT/EXEC/mount/module absent. Original R1 COW/uploads/source/result retained, no unchanged retry.

This separate r2 uses fresh unit/slice/runtime/upload/COW names and nonce. Both bootstrap and create_slice admit ONLY inactive implicit slices with no configuration, cgroup, invocation or transient state; configured or active slices still refuse. All existing service caps, physical floors, client hardening, original-image locks, bytecode pins, memory limits, proof/history/custody behavior and cleanup ordering unchanged. Combined programs regenerated and Python AST parsed, not native-qualified. One fresh matching root admission required.

A bounded startup is not production readiness. No Base or production consumer activation is authorized by this runner.
