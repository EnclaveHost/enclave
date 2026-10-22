# Lease16 interop: closes i6's authority gap. Written before execution.

## The gap

i6 (interop.py, 42/42 PASS) delivered a fixture **lease17** fact. Production uses the EXISTING ledger 16d, i.e. a
**lease16** fact; ledger 17 is neither required nor authorized.

## This run (interop16.py, derived; i6's interop.py is unchanged)

- **Same isolation, backend and inputs as i6:**
  - private network + PID namespaces, uid 1000;
  - harness-block c2e (c2-enclave source, schema 28) with 30 real RHP4 hosts;
  - an own PostgreSQL 18.6 cluster;
  - the exact 0.1.8 (d1ddecfe) and final 00e9cde0 artifacts.
- **Authority (no ledger-17 element):** the exact fixture form of placement_e2e.py (fad23623) `lease16()`.
  - Fields: chainId 8453, ledger 16d 0xb1783b61… (an identifier, never contacted), a fixture deployment, claimBlock and
    claimLogIndex.
  - Delivered as production does: through the reserved `$ENCLAVE_WRITER_AUTHORITY` / `$ENCLAVE_INSTANCE_ISOLATION`
    names (vbs = the Shield front constant), never in the owner config.
- **Expected fence generation:** `16<<48 | claimBlock<<16 | logIndex` (sia-s3 fencing.rs:26-27,56).
  - The FenceToken's first 8 bytes are that generation, big-endian (sia_storage fence.rs:27-30).
  - So indexd's `accounts.fence` column is compared byte-exactly.

## Phases

| phase | what happens |
|---|---|
| L | 0.1.8 writes ONE object |
| C | the FIRST C2 enrollment under lease16 claim 52515800/3: healthz authority/ballot, DB fence generation + cas_mode; read the legacy object; a new PUT; a same-claim restart (higher ballot counter) |
| S | the later claim 52520000/0 takes over (DB fence = generation 2); the claim-1 instance answers 503; a new stale claim-1 instance never becomes ready and changes nothing |
| O | 0.1.8 is refused on the enrolled account; indexd is unchanged |

Packing and multipart are not repeated (i6 passed them).

## Command

```
python3 ../../claude-test-queue.py --mib 1536 --log logs/run-l1.guard.log -- bash run-ns16.sh l1 > logs/run-l1.out 2>&1
```
