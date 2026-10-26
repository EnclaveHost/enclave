# Acceptance-side integration recipe for the r17 owner (the wrapper and readiness must use the patched verifier). Not applied here.

**Bundle:** `020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e`, i.e. sha256 of `bundle/MANIFEST.json`.

## What r16 does today (read from `historical-origin-segments-stage/r5/compose/r16-candidate`, unchanged)

**How the modules are loaded:**
- The wrapper (`wrapper/chain_service.py:330-352`) and readiness (`readiness/readiness_sampler.py:356-384`) load `ANCHORED_COVERAGE_LIB/{anchored_origin,segments,anchored_acceptance}.py`.
- Each file is opened with `O_NOFOLLOW`, sha-checked against `ANCHORED_COVERAGE_PINS`, and exec'd with `__file__` = the installed path.
- `ANCHORED_COVERAGE_LIB` is `/opt/enclave-rpc/lib/anchored-coverage` (the wrapper's `ROOT / 'lib' / 'anchored-coverage'`).

**What the acceptance path actually calls:**
- `anchored_acceptance.verify_anchored_evidence`, which uses `SG.plan_matches_anchored`, `SG.validate_plan` and the **pure** `SG.aggregate`.
- It uses `AO.PINS['receipt'][1]` and `SG.GATE[1]` only as **sha values**.
- It never opens a PINS/GATE path and never runs node.

**Consequence:** r16's workstation `/home/...` strings are not dereferenced on the acceptance path, but they ship in the installed bytes. Only the capture CLI dereferences them, and that is what this bundle fixes.

## r17 change (exact; the pin cascade belongs to the wrapper/readiness owner)
1. **Install the bundle tree verbatim:** `/opt/enclave-rpc/historical-capture/020cc8bf…/`, root-owned, dirs 0755, files 0644 except `bin/*` and `vendor/coverage/kzgcheck` (0755).
   - Every file and sha is in `bundle/MANIFEST.json`.
   - Verify it with `bin/historical-capture verify`.
   - Use `install_verified.py` `trees` semantics: the whole tree, with `treeSha256`.
2. **Point both consumers at the bundle lib:** `ANCHORED_COVERAGE_LIB = '/opt/enclave-rpc/historical-capture/020cc8bf8045cf48441349065c039171fc303783b2fa05dd5fa8f5a45296e22e/lib'`.
   - Then the patched `AO.ROOT` resolves to the bundle root, and **every PINS/GATE path exists and is sha-pinned**: `vendor/coverage/{origin_extract.py,coverage_gate.py,kzgcheck}`, `vendor/anchor-bootstrap.mjs`, `vendor/node_modules/@noble/hashes/*`, `receipt/a1-evidence.json`.
   - No runtime path names `/home`.
3. **Replace `ANCHORED_COVERAGE_PINS`** in both files:

   | File | r16 sha | r17 sha |
   |---|---|---|
   | `anchored_origin.py` | ed1a547d4d8aea112cae66479c64cd9e556b531063ef361c9b156c6d2948ddfa | **d088592d0398d017ce5101f0f9bf09849735be2fe0fb1c63ef710623be08d199** (= r4/r5 + `patches/anchored_origin.py.patch`) |
   | `segments.py` | 8764f5cc55cc42307eadbe71695bb986ca5fa86c07db671553d50d0635c51aa1 | **5a88a2e2894b5abb398e614db0251b313e5a6e15bbafc9d1055ec9707f602b56** (= r4/r5 + `patches/segments.py.patch`) |
   | `anchored_acceptance.py` | cb68413866d0534822bdfc37702e253acfe04abad30d98e34b2231595518138d | unchanged |

   `ANCHORED_A1_SHA256` stays b9a90847 and `KZGCHECK_SHA256` stays 00b3eeb9.
4. **Drop the r16 `lib/anchored-coverage/*` install entries,** or keep them unreferenced. Do not keep two verifier copies in use.
5. **Re-pin the composition:** the overlay pins, install `MANIFEST`, and the tests that patch `ANCHORED_COVERAGE_LIB` (r4/r5 `test_r3_integration`) go to r17. The readiness suite (93), ops-readiness suite (27) and wrapper job must be re-run by root on r17.

## Transitive closure
| Path | What it needs |
|---|---|
| **Acceptance** (wrapper/readiness) | `anchored_acceptance.py` → `anchored_origin.py`, `segments.py`. Python stdlib only; no node, no gate import, no network. Evidence files come from the capture run (`anchored-origin.json`, `plan.json`, `segment-*/{segment.json,gate-report.json}`, plus the acceptance receipt) |
| **Capture** (`bin/historical-capture`, `bin/guest-capture.sh`) | everything above, plus `bind_anchor.mjs` → `anchor-bootstrap.mjs` (no imports) + `@noble/hashes` 1.8.0 `sha3.js` → `_u64.js`, `utils.js` → (self-ref `@noble/hashes/crypto`, `exports` node condition) `cryptoNode.js` → `node:crypto` (and `package.json`, needed for the self-reference); `origin_extract.py` (stdlib) + base 9c44836d; `coverage_gate.py` (stdlib + urllib) + kzgcheck 00b3eeb9; node ≥18; python ≥3.11 |

**Recipe to reproduce the closure:** `python3 -IB tools/build_bundle.py --out NEW --patches-out P`.
- It reads only sha-pinned inputs and fails on any unexpected `require()` or any `/home` string in the shipped text.
- The root offline job checks that the result is byte-identical to `bundle/`.
