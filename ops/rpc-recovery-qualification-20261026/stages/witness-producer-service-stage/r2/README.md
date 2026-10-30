# witness-producer-service-stage/r2: witness PLACEMENT (PREPARED by Claude; nothing built, run, booted, installed or forwarded)

Reports: `logs/claude-witness-placement-r2.md` (layout, patch) and `logs/claude-witness-r2-finish-1593.md` (completion).

**Placement:** the measured reader and native run in the **SNP platform-api guest**; the nodes and the fetcher run in the **separate RPC VM**. They are joined only by the **existing host-link forward pattern** (`rpc-backend-bootstrap/provision_vm.py`), with one more entry:
- **RPC VM:**
  - the producer: the frozen r1 bytes, unchanged, by path, on `127.0.0.1:18747`, with its fetcher using only loopback node ports there;
  - `systemd/enclave-witness-forward.socket`: `ListenStream=10.0.2.15:28747`, exact peer `10.0.2.2/32`;
  - `systemd/enclave-witness-forward.service`: `systemd-socket-proxyd --connections-max=2 127.0.0.1:18747`, with `IPAddressAllow=10.0.2.2/32 127.0.0.1/32`.
  - Neither unit has an `[Install]` section.
- **Host:** `hostfwd=tcp:127.0.0.1:28747-10.0.2.15:28747` plus a manifest forward (`proposal/witness-route.json`). This needs a root-coordinated RPC VM restart.
- **SNP guest:** HOST_DATA `platformApi.derivedReader.witnessUrl` = `http://10.0.2.2:28747/witness` **and** the admin-signed `driver.witness.url` must be equal. The bytes stay untrusted native input.

**`patches/witness-placement-r2-vs-writer-integrated-r1.patch`:** applies on frozen writer-integrated r1's result tree `f473e41d` → **`58c9b92e2f4c311c63d4fe11d226d40f7b8a2f20`** (`patches/RESULT-TREE.txt`, per-file `patches/RESULT-FILES.sha256`). Changes:
- the wiring's `witnessUrl()` accepts own-backend literals only, via the existing `checkOwnBackend`;
- `bindWitnessUrl` runs before any transport or driver;
- the relay strips the bound `witnessUrl` and passes it;
- the `measured-control` canonicaliser takes an optional `witnessUrl` (absent = identical bytes);
- role compose writes only the bound value and treats a template carrying one as tamper;
- 2 lines of the r1 integration test change;
- new `test/witness-placement.test.mjs` (5 tests) and its fixture.

**Root tests:**
- `jobs/tests.sh`: the forward chain (6), under `unshare -Urn`.
- **The node tests in the merged composition:** `node --test test/witness-placement.test.mjs` (5) and `test/derived-reader-driver-integration.test.mjs` (8). Use the integrated job's read-only `node_modules` binding, plus `ip addr add 10.0.2.2/32 dev lo` in its namespace.
- **The bundle:** `relay/derived-reader-runtime.bundle.mjs` must be rebuilt, as for r1.

**Not addressed here:** r1's output bound (root 1589). It is corrected in `witness-producer-service-stage/r3`. Production must use r3's producer at `127.0.0.1:18747`; this placement is independent of which reviewed producer is behind the forward.
