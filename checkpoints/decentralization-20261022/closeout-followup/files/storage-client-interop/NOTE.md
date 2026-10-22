# U1 interop: feasibility, sources and commands. Written BEFORE any execution.

Goal (U1): the exact final privacy-fixed sia-s3 wasm `00e9cde0` makes its FIRST fenced (C2) boot on an account whose
objects were written by the exact live 0.1.8 wasm. This is the production T1 step: N=1, the single existing indexer.
The test proves byte-exact backward reads, enrollment (fence + CAS mode set in indexd's own database), and that 0.1.8
is refused after enrollment. All of it runs against a real indexd at schema v28 with real RHP4 hosts on loopback.

## Exact inputs (all local; nothing rebuilt)

| role | bytes | source |
|---|---|---|
| final client | sia-s3.wasm sha256 00e9cde0929dc7b8… (4,555,871 B) | storage-wasm-validation/artifacts/candidate-00e9cde0.wasm |
| legacy writer | live 0.1.8 wasm sha256 d1ddecfe7c3e1d06… (3,522,040 B) | adapter-retained/bafybeib7at4…qrqu.bin; it re-hashes to the catalog CID of sia-s3 0.1.8 (index 7, public catalog read in cron-startup-20261021/storage-network/chain-storage.json) |
| backend | harness-block c2e cac66513… | storage-sdk-regressions/out/c2e-a. indexd compiled in-process from the c2-enclave tree (`go version -m`: go.sia.tech/indexd => storage-funding-test-fix/snapshots/c2-enclave; inventory 2e8faf80 = the 2c0e5b06 source) |
| Sia | real coreutils RHP4/SiaMux hosts + synthetic V2 chain, in the harness | rtu/ (indexd testutils copy) |
| PostgreSQL | 18.6 from work/storage-host-role/pg18/root (own extraction); a NEW cluster in this run dir | never the shared fixture env or port 55432 |
| runtime | /usr/sbin/wasmtime 49.0.3 (`wasmtime run -S inherit-network`, `ENCLAVE_PORTS`, `ENCLAVE_EGRESS`) | as e2e.py |
| egress | storage-wasm-validation/egress_socks5.py 77fad264 (copied; every component dial goes through it) | as e2e.py |

## Scope, stated exactly

- The backend is REAL indexd code (c2-enclave source, schema v28) with real PostgreSQL and real RHP4 hosts and sector
  files. The chain is a synthetic test network.
- It is NOT the 2c0e5b06 binary itself. A mainnet-network binary cannot join the harness's test chain, so the backend
  is that source compiled into the harness. The 2c0e5b06 binary's own schema 28 is already proven by role28-1.
- The writer authority is the e2e fixture lease17 fact (the front binding is a separate gate).
- No mocks anywhere in the data path.

## Isolation and cleanup

One queue job (1024 MiB; prior runs with 3 indexers and 2 instances peaked at 1175-1350 MiB, and this run uses 1 indexer
and 1 instance at a time). It runs:

`unshare -rn --pid --fork --kill-child --mount-proc` (private network namespace, loopback only, so no public Sia,
RPC or live storage is reachable; private PID namespace, so EVERY process dies when the driver exits), then
`unshare -U --map-user=1000` (PostgreSQL refuses root).

- All files live in runs/<id>/.
- At the end, the driver deletes the sector files and the PostgreSQL data and keeps the logs.
- No Docker, no shared fixture, no global cleanup.

## Phases (interop.py)

1. **L, legacy writer:** 0.1.8 writes into buckets ipfs/git/jot/machines:
   - small objects, packed by its compactor;
   - an overwrite and a delete;
   - a 12 MiB object and a 48 MiB two-slab object;
   - a completed multipart object, and an OPEN multipart upload (one part).
   Then it is stopped. DB evidence: no fence, cas_mode false.
2. **C, enrollment:** 00e9cde0 boots fenced on the same app key.
   - Checks: ready; fence installed and cas_mode true in indexd's DB; membership record admitted at epoch 1.
   - Every 0.1.8 key reads back byte-exact (whole and ranged); listings are exact (deleted key absent).
   - The open 0.1.8 upload is listed, and it is completed by the candidate.
   - New PUT, overwrite and DELETE by the candidate read back; a restart (new instance) still reads all of it.
3. **O, old client after enrollment:** 0.1.8 restarted on the enrolled account.
   - Its PUT and DELETE must be refused.
   - Then the candidate (later generation) shows nothing changed.

## Commands

```
cd work/resume-after-checkpoint-20261022/storage-client-interop
python3 ../../claude-test-queue.py --mib 1024 --log logs/run-1.guard.log -- bash run-ns.sh i1 > logs/run-1.out 2>&1
```
