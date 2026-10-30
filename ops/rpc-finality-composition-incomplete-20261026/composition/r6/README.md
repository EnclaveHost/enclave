# r6: r5 (frozen) + ONLY the computed generator order (same candidate c4de37a3; nothing run)
`tools/depgraph.py` -> `DEPGRAPH.json`: static import-to-bundle graph of all 13 generators (entries scanned transitively from git
objects; generated outputs are graph nodes) cross-checked with every committed manifest's esbuild inputs. No cycle, no unresolved import.
`jobs/r6-build-validate.sh`: r5's runner with the executed order host-admission, windows-lease-runtime, metal-lease-gas, network-runtime,
host-service-packages, mcp, platform-api; before any generator runs it recomputes the graph from the candidate, requires it equal to
DEPGRAPH.json, and refuses an order that violates any edge. All r5 guards, pins, native inputs and the no-skip rule are unchanged.
