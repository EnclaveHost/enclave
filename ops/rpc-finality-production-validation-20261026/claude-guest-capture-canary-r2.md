# Guest capture canary r2 (PREPARED; nothing executed by Claude; ready for root review)
**Stage:** `guest-capture-canary-stage/r2/`, `SHA256SUMS` sha256 **`6d31a186815125ac5ffc9f76ca8080e6407dc4430c76a1f4ada656ae6d2e09b8`**.
- **Untouched:** r1 is frozen (its manifest verifies); 50cf r9, da0, and every production path.
- **Not done:** no tests, builds, queue jobs, SSH writes or commits.

## Root command (from work/rpc-production-final-20261025)
```
python3 -u ../claude-test-queue.py --mib 512 --log guest-capture-canary-stage/r2/logs/root-guest-capture-canary.guard -- bash guest-capture-canary-stage/r2/jobs/root-guest-capture-canary.sh
```
**No input needs to be supplied:** the defaults are the existing pinned files.

## Bootstrap anchor: the existing authentic checkpoint, used unchanged
| File (`outputs/rpc-production-final-20261025/`) | sha256 |
|---|---|
| `l1-authority-live-1941/checkpoint.json` | `2e8502e68864abb49a230a69612bd7c98c94775d8dd81f956a0185d53652ac33` |
| `l1-caught-up/fresh-finality-provenance-1941.json` | `c862982520d65e81041f24162f29dd9d71839161ece6b06e559f9af822c1974d` |

- **Contents:** root `0xb5d8034017f25328b5ae1455d3efe12de0a49d3e759f63129bcb0296e7847094`, slot 15511008 (epoch 484719; boundary time 2026-10-25T19:21:59Z), recordedAt 2026-10-25T19:38:24Z.
- **Provenance:** five HTTP 200 observations, all agreeing. The sources are own Lighthouse and 4 independent providers: sigp, beaconcha.in, ethstaker, chainsafe.
- **Override:** `CHECKPOINT_FILE` / `PROVENANCE_FILE` can be overridden only by files with identical hashes. No operator attestation is used or requested, and no external RPC is contacted.

**Checks:**
1. **Host:** the pinned hashes, then the pinned `l1_authority.py` (`f4a5160b`) `load_checkpoint` rules: schema, epoch boundary, age ≤ 604800 s (7 days), ≥ 2 sources, not own-only.
2. **Guest, provenance:** every record source has its own HTTP 200 observation (same ref and observedAt) naming this root and epoch. There must be ≥ 2 distinct agreeing hosts, not only our own beacon. The record is installed **byte-identical** as the Helios checkpoint.
3. **Guest, own CL:**
   - the root's header is **canonical**, at slot ∈ (boundary − 32, boundary];
   - **no canonical block** lies between it and the boundary, so it is the boundary block or the last block before skipped slots;
   - current finalized slot ≥ the record slot.
   - The current finalized root is **not** required to match.
4. **Guest, own EL:** holds that block's execution payload (hash and number).
5. **Forward progress (driver):** after the real capture, Helios's finalized block must be **above** the checkpoint payload number and must equal our own EL's block hash at that number. Only then does `verify()` run. Failure is FAIL.
6. **Unchanged from r1:**
   - **Runtime and bundle:** runtime identities, the 18550 recheck, the private 0700 dir, every bundle byte checked, the gate files at the module's `HERE/a1gate`, the Helios pin and `ldd` (INCOMPATIBLE is reported honestly).
   - **Run:** `l1_authority.py check`; the transient scope with MemoryMax=512M, MemorySwapMax=0, CPUQuota=100% and `timeout -k 30 1500`; the owned listener proof.
   - **Safety:** production MainPIDs compared before and after; the host 16 GiB floor watchdog stops only this scope; private captures stay local (0700); `PUBLIC-RECEIPT.json` now includes `forwardProgress`.

## Owned cleanup (hardened)
An `EXIT` trap (also on INT/TERM, with exit 130/143) runs on success, failure and interrupt once the guest staging dir exists:
1. stop only `enclave-a1-canary-<ID>.scope`;
2. fetch diagnostics (staging listing, PIDs before/after, a tar of `out/`, `result.tar`) **before** removal;
3. run `guest/cleanup.sh <ID>`. It removes only `/var/lib/enclave-rpc/canary-<ID>` and `/run/enclave-canary-<ID>`, plus `/var/lib/enclave-rpc` **only if this run created it and it is empty**. Never a shared production path.

A cleanup failure prints the manual command.

## Pass criteria
- capture ok;
- forward progress ok;
- `verify()` ok;
- owned listener proven;
- 18550 released;
- production PIDs unchanged;
- no floor breach.

Anything else is FAIL or SETUP. This qualifies the guest runtime and capture closure only; it is not production install, activation or proof serving.

## Limits
- **Unproven until run:** Helios's loader closure on glibc 2.39, its sync time from a checkpoint about 12 h old (`helios_timeout` 900 s), and the 512M bound. Root's earlier live Helios/A1 run verified this record, but on the host, not this guest.
- **Age window:** the record must stay ≤ 7 days old (`maxCheckpointAgeSec`), so it is usable until about 2026-11-01T19:21Z. Helios's strict cap is 14 days.

Custody v2 stays REFUSED; production is unqualified.
