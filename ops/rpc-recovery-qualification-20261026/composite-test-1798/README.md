# Actual composite checker fixtures and a narrow test correction

The actual r5 run passed all four process-guard tests and eleven of twelve database lifecycle tests. Test 9 errored in its own final close of a deliberately disconnected FUSE file with ENOTCONN. Its session receipt records CLEANUP-INCOMPLETE as required, no live children, no remaining mount and no leftovers. Both peer and mount checks passed. The overall r5 suite FAILED; it is not a qualifying pass.

The new r6 corrects only the fixture's close handling: accept ENOTCONN in that deliberate-disconnection case and verify the descriptor is closed, while retaining all cleanup assertions. Runtime and admission guard bytes are unchanged. This source checkpoint contains no r6 PASS claim; an actual fresh run and separately archived receipt are required. Production stays disabled and all original-data protections remain.

Structural fixture qualification is not full-data integrity, chain/state validity, synchronization, finality or completed production RPC replacement.
