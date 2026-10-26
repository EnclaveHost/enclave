# witness-producer-service-stage/r3: producer OUTPUT BOUND (root 1589). PREPARED by Claude; nothing built, run or installed

Report: `logs/claude-witness-r2-finish-1593.md`.
- **Preserved:** r1 is frozen and unchanged (`producer/witness_producer.py` `b61a981d…`).
- **Placement:** placement r2 (`SHA256SUMS` `07084e7a…`) is independent. Its forward targets `127.0.0.1:18747`, where production should run **this** producer.

**r3 vs r1 (only these):** `producer/witness_producer.py`.
- **Disk bound while generating:**
  - the fetcher runs under `/usr/bin/prlimit --fsize=<request cap> --core=0`, plus r1's `--as`/`--cpu`;
  - RLIMIT_FSIZE is per file, for every regular file the child writes: a write past the cap fails with EFBIG, or kills a non-Python child with SIGXFSZ, reported as 502 "file bound";
  - the pinned upstream fetcher writes only the output and two KB config files (`configs/L{1,2}/<chainId>.json`, cwd-relative). It uses no on-disk store (`fetcher.rs` l.91-104, 390-462, 870).
- **Bounded stderr:** a pipe drained into the last 4 KiB; the log and errors carry the last 300 bytes. It is never a file.
- **Exact cleanup:** the output, `.partial` and `configs/L{1,2}/<digits>.json` (plus those dirs), then the run dir. An unexpected leftover is kept and logged, never deleted.
- **Everything else is r1's:**
  - request schema;
  - pins (ELF `36604b9c…`, source `69812507…`, bridge `cb976541…`);
  - loopback endpoints, single flight, deadline/disconnect kill, memory floor;
  - no cache, fallback or public RPC.
- **The unit:** r1's `systemd/enclave-witness-producer.service.template`, unchanged (`IPAddressAllow=localhost` matches the placement: ingress from the local forward proxy, egress to loopback nodes).

**Tests:** `tests/test_witness_producer_r3.py` (10), every fetch a real child under the real `prlimit`:
1. past-cap EFBIG (sizes ≤ cap at every observed write; 502; nothing left);
2. a SIGXFSZ kill (rc −25; 502; cleaned);
3. fsize == the request cap and core 0, read inside the child; the argv mapping;
4. exactly the cap is served, cap − 1 is not;
5. a 50 MB stderr flood gives a tail ≤ 300 chars ending at the marker;
6. a failing child reports only the bounded tail;
7. the upstream `configs/` files are removed;
8. an unknown leftover is kept and logged;
9. malformed requests run no child, and the deadline kills;
10. r1 is unchanged and the pins are carried over.

`jobs/tests.sh`: queue 512, `unshare -Urn`.

**Measured remaining:** real witness sizes vs the caps, with `--fsize` = cap leaving no room for a larger legitimate witness (set `maxWitnessBytes` from measurement); the real fetcher's behaviour under `--fsize` (SIGXFSZ, so 502); the r1/r2 measured lists.
