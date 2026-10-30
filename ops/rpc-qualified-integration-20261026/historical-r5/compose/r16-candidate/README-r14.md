# base-finality-proof-stage/r14-witness: r13-manifest-final + private witness RPC access (PREPARED; qualification = jobs/root-finality-r14-witness-tests.sh)

**r14 = the authoritative `r13-manifest-final`** (`SHA256SUMS` 80cea888; root original-game canary PASS 0946) **+ `witness-rpc-access-stage/r2`** (5d6395bc).
- **Edits:** 6 files, each = base + `integration-r14/<file>-r14.patch`.
- **New files:** 3, each = the witness r2 byte.
- **Everything else** is byte-identical to the base. The job proves this; see `COMPOSITION-r14.tsv`.
- **Kept, NOT a description of r14:** `README.md`, `COMPOSITION.tsv` and `METADATA-REVISION.json` are r13's historical records.

| File | r14 sha | Why |
|---|---|---|
| `wrapper/chain_service.py` | 9607b831 | both ELs: `--ipcdisable` → private `--ipcpath <node tmp>/witness-el.ipc --ipc.permissions 0600`; HTTP stays `eth,net,web3` |
| `src/finality_state.py` | 60856512 | wrapper pin |
| `recovery/forward_sync.py` | bc29f8cb | wrapper pin |
| `producer/base_launch.py` | 5e567c93 | wrapper + finality_state pins |
| `src/reproof.py` | 34445154 | finality_state + producer pins |
| `install/MANIFEST.json` | 46913190 | 5 re-pins, `stage` = `base-finality-proof-stage/r14-witness`, + 3 entries (64 files / 14 trees / 32 bundle entries) |
| `witness/witness_rpc_bridge.py` | cb976541 | the bounded loopback bridge (new) |
| `units/enclave-witness-bridge-{base,l1}.service` | e4bdc947 / dd82cd45 | opt-in, no [Install], node user, loopback-only (new) |

**Installer:** unchanged. Its qualification lines remain `## finality-r13 rc=0` / `## r13 SHA256SUMS <this stage's sums>`; the sums bind them to r14.

**Qualification job:**
```
./jobs/q-exit-status.sh r14-witness-1 1024 unshare -Urn bash base-finality-proof-stage/r14-witness/jobs/root-finality-r14-witness-tests.sh
```
