# Pinned host-local relay: root activation steps (nothing here was executed)

Every step is root's. Production stays on its current artifacts until step 4's canary passes. No signature, broadcast,
port opening, firewall change or live probe was made by this workstream.

1. **Compose (source).**
   - Recheck `BASE.txt` against main. Then `git apply pinned-relay.patch`, CAS on the four before-hashes; the four
     test files are new.
   - Worker 5a's gsup/measured-control/public-config hunks are independent (INTERFACE.md).
2. **Rebuild once (generated):**
   - `node scripts/build-windows-lease-runtime.mjs`, then `--check`;
   - `node scripts/build-metal-lease-gas.mjs`, then `--check`;
   - the platform-api bundle;
   - the lease-relay host package, then re-pin `work/eu-relay-host-role-migration` (warden-common.sh PKG_PIN/BUNDLE_SHA,
     template `relay.package`) and rerun its tests (queue 256).
3. **Test on the composed main** (queue):
   - `node --test test/lease-pinned-relay-config.test.mjs` and `node test/lease-pinned-relay.test.mjs` (512);
   - this workspace's `run-regression.sh` suite list (768, one job).
4. **Linux canary.**
   - Build the measured control image from the composed main.
   - Its bound `leaseGas` (host config, or the HOST_DATA direct config in the checked form) ADDS:

     ```
     "pinnedRelays": [{ "origin": "http://10.0.2.2:8549", "payee": "0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a",
                        "operator": "0xC9D0835Cd8eBc7eaE84304d9DB0A76253EebE6aB" }]
     ```

     It keeps `relays: ["https://134.209.248.172"]`.
   - Before the EU move nothing listens on warden's 127.0.0.1:8549, so the pinned entry fails at connect and the DO
     relay serves as today.
   - Verify the following, then keep the image or roll back to the current measurement:
     - the supervisor logs "app-funded leases ON … 1 relay(s)";
     - every claim/renew lands (via the DO relay);
     - no operator ETH is used.
5. **EU move** (`work/eu-relay-host-role-migration/PLAN.md`): stage A (warden-stage), the section 2b Linux preflight,
   then stage C.
   - The supervisor log then shows "landed … via http://10.0.2.2:8549".
   - Acceptance: the read-only audit, with quorum-verified `LeaseGasPaid` to `0xC5D8…`.
6. **Later, separately reviewed:**
   - drop the DO entry from `relays`;
   - the Windows fallback: the LAN listener templates, the rebuilt Windows lease runtime and a
     `lease-gas-config.cmd` with `ENCLAVE_LEASE_GAS_PINNED_RELAYS=http://192.168.8.249:8549,…`, checked by
     `lease-gas-config-check.mjs --expect-pinned`.

**Rollback.**
- Remove `pinnedRelays` from the bound config. The transit, the guest env and the digest are then byte-identical to
  today's, so it is the old measurement's behaviour.
- Or boot the previous image. The EU move has its own rollback (PLAN.md, the stale-journal rule).
