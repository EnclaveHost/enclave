# witness-producer-service-stage/r1 (PREPARED by Claude; nothing built, run, tested or contacted). Report: `logs/claude-witness-producer-service-r1.md`

**What it is:** the missing in-guest **witness producer service** for the integrated derived-reader driver. It answers the driver's `createWitnessTransport` pull: POST `enclave-derived-witness-request/v1` → 200 `application/octet-stream` witness bytes, at most the cap.

**It is an adapter only:**
- the witness comes **only** from the existing root-built upstream capture `witness_fetch` (combined-r1, ELF `36604b9c…`, source `69812507…`), with the existing runner's argv mapping;
- the HTTP framing is the qualified r14 bridge's (`cb976541…`, sha-pinned compile + exec);
- the endpoints are our own nodes on 127.0.0.1 (the r14 bridges for the ELs, plus the beacon and Base node loopback ports).

**Rules:**
- **No trust in the request, no cache, no fallback:** any failure is a non-200 answer without bytes.
- **The native harness decides:** the bytes are untrusted, and only the pinned native accepts or refuses them against the trusted input.
- **No public RPC:** the config allows `127.0.0.1` only, the fetcher re-checks it, and the unit's `IPAddressDeny=any`/`IPAddressAllow=localhost` enforces it.

**Files:**
- `producer/witness_producer.py`: the service;
- `systemd/enclave-witness-producer.service.template`: opt-in, unprivileged; `@MEMORY_MAX@` is required;
- `config/witness-producer.template.json`: the REQUIRED fields refuse as shipped;
- `tests/test_witness_producer.py` (12);
- `jobs/tests.sh`: root, `unshare -Urn`, queue 512.

**Bounds:**
- single flight, refused unread when busy;
- the bridge's absolute header deadline and 1 MiB request cap;
- exact request and trusted keys, range ≤ `maxBlocks`, cap ≤ `maxWitnessBytes`;
- the MemAvailable floor;
- `prlimit --as/--cpu` plus a hard deadline, and a process-group SIGKILL on deadline or client disconnect;
- the output must be `0 < n ≤ cap`;
- an audit line (request sha, witness sha, bytes, seconds) with no content.
