# Witness RPC access: bounded bridge r2 + composed base-finality-proof-stage/r14-witness (offline qualification PASS; no live/SSH/restart/commit)

## 1. witness-rpc-access-stage/r2: bridge bounds fixed
- **Stage:** `SHA256SUMS` `5d6395bc1e92f266164736b5a870db753f04c7f6e24c197399e906e81df7b645`. The parent `646e6db1` is unchanged.
- **Receipt:** `logs/claude-witness-r2-2.out`: `PASS witness-rpc-access Ran 12`, rc 0, shared queue 512, `unshare -Urn`. The earlier attempt `-1` (rc 0, before the README) is kept.
- **The change:** only `bridge/witness_rpc_bridge.py` was replaced, now **`cb9765418d30d238ded384c6908462516d153161f17631f28c7247905198fc9d`**. It is a small socket server, not `http.server`:
  - **Admission:** ≤ 2 admitted connections. An extra one gets 503 and is closed before any of its bytes is read.
  - **Request deadline:** ONE absolute deadline for request line + headers + body (15 s → 408).
  - **Exchange deadline:** ONE absolute deadline for the whole IPC exchange plus the streamed relay (900 s).
  - **Strict parse:** headers ≤ 8 KiB (431); exactly one ASCII-decimal Content-Length ≤ 1 MiB (else 400/411/413); Transfer-Encoding refused; POST only.
  - **Streamed response:** 64 KiB pieces in a close-delimited body, so memory is O(chunk), not O(response).
  - **JSON-end scanner:** a C-regex scanner finds the end of the first JSON value; trailing bytes are dropped.
  - **Cuts:** over 256 MiB or past the deadline, the connection is closed mid-body (invalid JSON), never answered with a fabricated result.
- **Unchanged:** the allowlists.
- **`debug_dbGet`:** its 33-byte `0x63‖code_hash` restriction is enforced by the **pinned node** (reth `debug.rs:1027-1059`), not by the bridge.
- **The caps are bounds, not measurements on a real witness.**
- **Behavioural tests:**
  - a 20 MB value streamed byte-exact with a tracemalloc peak < 4 MiB;
  - oversized response cut;
  - trickle cut at the absolute deadline (< 3 s for 1 s);
  - a slow-header client gets 408 while a concurrent client gets 503 unread, then recovery;
  - 12 malformed or oversized framing cases with nothing reaching the node;
  - refused methods;
  - IPC guards;
  - loopback-only;
  - scanner splits;
  - the wrapper argv diff (real `_start`);
  - units.

## 2. base-finality-proof-stage/r14-witness: composition on the authoritative 80cea888
- **Stage:** `SHA256SUMS` **`1ba2d51a47d0576cada1e0e24b885234e39c6c53f4e6af5e8c9e5ee5e921793b`**.
- **Untouched:** `r13-manifest-final` (80cea888) still verifies; no existing receipt changed.
- **Composition:** exactly the existing pattern, `COMPOSITION-r14.tsv` + `integration-r14/<file>-r14.patch`:
  - 6 edits = base + patch;
  - 3 new = the witness r2 bytes;
  - the other 106 files are byte-identical to the base.
- **Kept as history:** `README.md`, `COMPOSITION.tsv` and `METADATA-REVISION.json` are r13's records; `README-r14.md` describes r14.

| File | r14 sha | Change |
|---|---|---|
| `wrapper/chain_service.py` | `9607b831c8941d1108022a500cf1ae328367b84a110e38b00fdd18476ff4656a` | both ELs: `--ipcdisable` → `--ipcpath <node tmp>/witness-el.ipc --ipc.permissions 0600`; HTTP unchanged |
| `src/finality_state.py` | `608565123278e1d877abffe02fc762aba3fccee6c89e249f3ee6d808b618704e` | `WRAPPER_SHA256` |
| `recovery/forward_sync.py` | `bc29f8cb992e1ffd15db62c64d7d07ccd2398fed3ec064d878bcb2f05f9dd109` | wrapper pin |
| `producer/base_launch.py` | `5e567c93676a7f7fd48040a7f90ffae860f454a0a69efd8f3f1445a5b87b224b` | `WRAPPER_SHA256`, `FINALITY_STATE_SHA256` |
| `src/reproof.py` | `344451545b9decfa11d259d92ab4249bb58499871df471e195446b8b0640a2e3` | `FINALITY_STATE`, `PRODUCER` |
| `install/MANIFEST.json` | `4691319085be89adcbc293ecf9e4e3c6c59209e0501412df32767a4123ba23c1` | 5 re-pins; **stage = `base-finality-proof-stage/r14-witness`**; +3 entries (64 files / 14 trees / 32 bundle entries) |
| `witness/witness_rpc_bridge.py` (new) | `cb976541…` | `/opt/enclave-rpc/witness/witness_rpc_bridge.py` 0755 |
| `units/enclave-witness-bridge-base.service` (new) | `e4bdc947…` | unit, opt-in |
| `units/enclave-witness-bridge-l1.service` (new) | `dd82cd45…` | unit, opt-in |

- **Unchanged:** bundle-origin, the installer, admin and activation controls, the L1 proof/trust/bootstrap code, and the public HTTP surfaces. No superseded sha remains in any executable file.

## 3. Qualification (`jobs/root-finality-r14-witness-tests.sh`, shared queue 1024, `unshare -Urn`, sequential)
- **Receipt:** `logs/claude-r14-witness-1.out` (sha `cd64992f…`, `.rc` 0). It ends with `## r13 SHA256SUMS 1ba2d51a…` and `## finality-r13 rc=0`.
  - The installer is unchanged, so its labels stay; the sums bind them to r14, as for r13-manifest-final.
  - Peak 236 MiB; host minimum 16952 MiB.
- **Proofs in the job:**
  - the r14 composition (patches, new = witness bytes, 106 identical);
  - r13-manifest-final = r13-final except `MANIFEST.stage`;
  - pin + manifest closure (64/14);
  - reader pins;
  - bundle assembly + closure (32);
  - r14 manifest additions.
- **RE-RUN, because their bytes changed:**

| Suite | Tests |
|---|---|
| capture-r10 | 3 |
| runtime-pin | 10 |
| tool | 34 |
| integration | 17 |
| reproof | 17 |
| ops-installer | 18 |
| forward-sync-r2 | 6 |
| reanchor-recovery | 25 |
| r3-regression | 28 |
| r62-isolated | 2 |
| forward-sync | 8 |
| wiring-bootstrap-wiring | 22 |
| wiring-r3-regression | 28 |
| **wrapper-pruned**, the wrapper stage's own frozen job on a private copy carrying the r14 wrapper byte | 34 + 15 + baseline blocker + mutants |
| **witness-r2** | 12 |

- **REUSED only for byte-identical code**, via pinned receipts: parser-recovery 8, parser-first 8, capture-closure 14 and cold-proof (root's 0918 run dir); ops-readiness 27, sampler 93 and JS 20 (as r13).

## 4. Canary inputs (`logs/r14-witness-handoff-pins.json`; the frozen canary stages are not modified)
- **Cold / original-game canary composed-stage pins:**
  - stage r14-witness, stageSha256sums `1ba2d51a…`, manifest `46913190…`, **finalityState `60856512…`** (new);
  - unchanged: bundleOrigin `4121a5f6…`, captureModule `8da369de…`, finalityCore `686cbc22…`, a1Read `da9a9e9c…`, a1RecheckRead `78df2211…`.
- **Systemd canary FINAL-PINS:**
  - **wrapper `9607b831…`, finality_state `60856512…`** (new);
  - unchanged: holder_gate `dd680061…`, drop-in `2df07889…`, reproof unit `b36ee8d8…`.
- **Live witness recipe:** `witness-rpc-live-canary-stage` (`SHA256SUMS` `1b239cba…`):
  - **(A)** a disposable-fixture sandbox canary for the bridge under the shipped unit's sandbox. It is NOT a node test.
  - **(B)** real-node steps: socket metadata `600 <user> socket`, starting the opt-in bridge, allowlisted vs refused calls, loopback-only listener, runner endpoints.

## Remaining gates
1. **Root review** of r14 and its qualification receipt; root may re-run the job.
2. **Re-run against r14:** the cold/original-game canary and the systemd sandbox canary, with the r14 pins (`finality_state` and wrapper changed).
3. **Live:** the fixture sandbox canary (A), then, after install, the real Base socket at first r14 start (B1).
4. **L1 EL:** the IPC socket needs a **root-coordinated restart of `enclave-l1-el.service`** on r14. Not done; it affects Helios/A1, readiness and the download's L1.
5. **Not yet measured:** the actual witness run (`debug_executePayload` sizes and durations; ranges above 52,500,000; inside L1 receipt retention).
6. **Unchanged finding:** the always-on loopback `opp2p_*` controls on 19545.
