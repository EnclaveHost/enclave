# Root review of graph selection

Claude reached its eight-turn limit (exit1) after writing code, fixtures and report. Root reviewed the finished diff and ran all68offline fixtures successfully, no skips. This is not a successful Claude-run exit claim.

Root also read cached wasmtime source at `/home/steven/.cache/nan-wasmtime-src/crates/wasi-nn/src/registry/in_memory.rs`: `load` computes `path.file_name()` and inserts the loaded graph with that name. This agrees with the production profile and probe query contract. Exact binary reproduction of the installed runtime remains unproven. The new query will be verified through actual attested execution, not treated as working from source alone.

Numeric query behavior, security gates and resource limits are unchanged. Missing/wrong graph is refused before launch; a NotFound response without a serial capacity-decline line is now a distinct failure. Serial remains untrusted diagnostic evidence and cannot establish success. No probe/image/measurement changes.
