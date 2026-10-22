> Root update, 2026-10-22 23:58 UTC: the move is COMPLETE. Cron is running on nucbox (native host evidence in nucbox-after.json; three agreeing RPCs at block52962071 in placement-confirmed.json). Ten reserves were funded before the move. The historical Unaffordable observations below are superseded; both Linux and Windows used the app reserve. No further Cron deposit is needed for this recovery. Image-generator remains queued until its same-operator claim cooldown expires2026-10-23T00:21:17Z. Dashboard reported a saved host preference; the ledger envelope has no placement field, so this is not evidence of an on-chain pin. Below is the original source-only investigation, not current live status.

# Cron (0x38f368d6…, v1.0.3): why it is on metal0, and how to move it to nucbox (read-only, 2026-10-22)

Source and local evidence only. No live reads, network, signing, transactions, edits or tests. Requirements were read
(`effective-goal-requirements.txt` md5 8ef611cc). Admin and owner controls are kept, and no bypass is proposed. Root does
the live inspection.

## 1. Facts from source and evidence

**Cron's row (last recorded: `cron-startup-20261021/chain.json`, block 52901065).**
- Owner `0x0b2d…eE61` (the admin EOA), `appRef` `catalog://0xf1897f06…/3` (1.0.3: memMb 128, cpuGflops 1), `cpuMilli` 10,
  rate 0.
- Envelope: `{"isolation":{"cpuTee":false,"gpuTee":false},"configCid":"bafkreigf7…"}`. It has **no `isolation.require`
  and no `placement` pin**. The config is a CID override with 6 secret references.
- Root must re-read the current row: the envelope or runner may have changed since 10-21.

**Why it is on metal0** (source mechanism; the live attribution is root's):
1. **Either host may claim it.** On a host with `ISOLATION_BACKEND` set, `parseDepOptions` sets
   `opts.isolation = iso.require ?? ISOLATION_BACKEND` (`work/enclave/supervisor.js:2204`). An envelope with no `require`
   is claimable by metal0's SNP tier AND by nucbox's Hyper-V tier. Placement is first-come.
2. **metal0 can claim it now.**
   - On the SNP tier, a CID-config, secret-bearing deployment is claimable only once release-listed (supervisor.js:2625,
     2753–2760).
   - Root added cron to `SECRETS_RELEASE_DEPLOYMENTS` at 23:30 (`relay-release-live/deployment-result-r2.json` "added"),
     and the release-status fix went live. Both removed metal0's "release list could not be read" refusal (seen for cron
     in `queued-diagnosis.json`).
3. **nucbox cannot claim it right now.** nucbox's own claim of cron got **422 Unaffordable** at both relays
   (`relay-release-live/nucbox-queued-state.json` 23:35:45). Windows leases are app-funded and never use the host's ETH.
   Cron's reserve held 216033940371 wei vs a claim quote of about 2.29e12 (`public-health/reserves-preflight*.json`).
   - So cron ran wherever a claim could be paid. INFERENCE: metal0's lease was paid by a route nucbox's is not
     (operator-paid on Linux, or the reserve was funded meanwhile). Root should check metal0's lease-gas mode and cron's
     current reserve.

**What cron reserves on metal0.**
- On the SNP per-app tier every catalog version's guest gets **1 vCPU = `cpuPercent: 100`**, plus `memMiB =
  max(128, memMb)`. This is `enclave-isolation-policy/1` (`isolationPolicyFor`, supervisor.js:2411–2418), independent
  of the deployment's `cpuMilli` 10.
- The guest-pool reservation is `cpuPct 100`, `memMiB = max(perGuest.floorMiB, 128 + perGuest.runtimeMiB) +
  unitOverheadMiB` (`guestReservationFor`, supervisor.js:3236–3240).
- The image generator `z-image-turbo-q4km-sd` needs **`cpuPercent 800`, 8 vCPUs, memory at least 6144 − 384 MiB**
  (supervisor.js:2430, 2465).
- So moving cron frees exactly 100%: 700% + 100% = 800%, which fits on CPU. Memory must fit too: root should read
  guestd's pool `free.memMiB` and the host floor (`guestPoolRefusal`, supervisor.js:3301–).

## 2. Supported ways to move it (all need the OWNER key, the admin EOA)

**A. `enclave move <id> <nucbox-name>`** (`work/enclave/cli/enclave.mjs:1580–1660`, legacy relay mode). This is the
supported migration, but it is a steer, not a lock.
- It does an owner-authenticated `DELETE /v1/deployments/<id>?evacuate=1` on metal0 (supervisor.js:7981–8029, scope
  `api.restart`). metal0 stops the app and releases the lease (`proveAndRelease`).
- metal0 then **stands down from re-claiming for `MOVE_HOLDOFF_MS`**: default 120 s (`MOVE_HOLDOFF_SEC`, supervisor.js:7914),
  persisted across restarts.
- The CLI then repeats `POST /v1/claim-hint` to nucbox (Windows agent.mjs:647) and reports where it landed.
- Unless nucbox claims within that window, metal0 may take it back.
- **Independent mode** (`cmdMoveIndependent`, cli:5481–5570, session scopes `api.restart` + `api.placement`) refuses
  when the target host is run by the SAME operator as the source (a late release could end the target's new lease).
  nucbox's operator was `0x1A01…94e0` (10-21 row); root must confirm metal0's operator differs.
- Either mode needs nucbox to be able to PAY the claim (cron's reserve must cover the claim quote). Today it cannot, so
  **a move now would leave cron queued and let metal0 re-claim it after 120 s**.

**B. Owner `setConfig` adding `"placement":{"hostId":"<nucbox registry id>"}`.** This is the durable lock: metal0 can
never take it.
- Both runtimes refuse a pinned-away row: Linux `placementRefusal` at claim, renew and audit (supervisor.js:2121, 10504,
  10872 → `retireForPlacement` stops then releases, 11493, 11856). Windows uses `chain.mjs placementRefusal` and
  `host.mjs:693/1391/2088`.
- On its next audit pass metal0 stops cron and releases it, and its sweep never claims it again. nucbox claims it once
  affordable. "fallback is disabled": while nucbox is down, cron stays queued.
- **No CLI command writes `placement`.** `enclave config set` changes only the app config and WAF (cli:3454–), and a
  session may not `setConfig` a wallet-held deployment. So this is a raw owner `setConfig(id, envelope)` transaction
  (owner gas, not the app reserve) carrying the FULL current envelope plus `placement`, which root must sign.
- nucbox's registry id was `0x2fcef48d6ad6919a6264074592b13855968b9f7be52c463764609a68af41447a` (runner of the 10-21
  row while cron ran on minipc; confirm live).
- Changing the envelope string is an owner config edit everywhere. The version and secrets are unchanged.

## 3. Windows "exited i32 status 1"

- `cron-startup-20261021/CRON-STARTUP-RESULT.txt`: cron 0.1.3 prints `[cron]` and exits 1 ONLY on configuration load
  (a missing or short secret, `unknown field wasi` from the catalog default config, or template URLs). This was
  reproduced in real wasm.
- On minipc every launch had all 6 secrets first. The 10-21 queued state was the manager restart storm plus the early-boot
  partition death plus the give-up policy, not that error. The message text matched another host's format (AVF/VSOCK).
- **Fixed?** The cause on minipc was host-side and was repaired (manager `8107f272`, 10-21 12:13).
  - The tested cron-only respawn opt-in (`ENCLAVE_ISOLATION_RESPAWN_IDS += 0x38f368d6…`, with no global delay) was
    prepared, but its live activation is **unverified** here.
  - nucbox's `node-config.local.cmd` was `405db912` at 23:03 (`node-pair-runner/runs/identify-…2304z.json`); root can
    check whether it lists cron.
- **Risk for a move:** nucbox still runs the OLD control pair (`host.mjs 9634cb40` / `chain.mjs 86c81124`), and `2afa` is
  not activated. A cron lease there gets ONE renewal attempt per 285-s window: the adapter's 10-22 expiry mode.

## 4. Safe next steps (root; read-only first)

1. **Read (no writes):**
   - cron's current row: runner, `leaseUntil`, envelope;
   - cron's reserve balance against the claim quote;
   - metal0's lease-gas mode and operator address;
   - metal0's guest-pool free CPU/memory with and without cron's 100%;
   - nucbox's capacity and the `ENCLAVE_ISOLATION_RESPAWN_IDS` presence;
   - the image generator's exact version needs.
2. **Fund cron's reserve** above the claim quote (the funding batch in progress). Without it nucbox cannot hold cron.
3. **Then choose:**
   - **A** (`enclave move 0x38f368d6… <nucbox name>`, owner key), for a quick, reversible steer. Run it only when nothing
     else would claim during the 120 s stand-down.
   - **B** (an owner-signed `setConfig` with the `placement` pin), so metal0 can never re-claim. Accepting "no fallback"
     needs the owner's decision.
   - B plus A gives the fastest deterministic hand-off.
4. **After cron lands on nucbox**, confirm metal0's guest pool shows 800% free, then deploy or hint the image generator
   to metal0.
5. **Prefer activating 2afa (renewal keeper) on nucbox before or soon after the move**, so cron's lease does not depend
   on one in-pass renewal attempt.

## 5. Not established here

- Any live state (all of it is as of the cited receipts).
- metal0's operator, its lease-gas mode and how it paid cron's claim.
- Whether cron's envelope changed after 10-21.
- Exact memory fit for the image generator.
- Nothing was executed or signed.
