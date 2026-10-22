# Post-cutover acceptance audit (local relay on minipc): READ-ONLY, root runs it

Run this only after root has finished the migration (`20-activate.ps1 -Reviewed` exit 0) and says the cutover is complete.
Nothing here writes, starts, stops, signs or spends. No key, environment, database or journal content is read. It
collects public facts only:
- unit metadata;
- process, listener and VM state;
- file sha256;
- `/v1/info`;
- the relay log's `[relay] <status> <tx hash>` lines;
- public chain data.

## Why a separate verdict

The stage's own steps don't fail on everything that matters. `20-activate.ps1` prints VMs that are no longer running but
does not fail on them, and `30-verify.ps1` prints status without judging it. `accept.mjs` judges every requirement against
the pinned `expectations.json`:

| expectation | source |
| --- | --- |
| the 9 VM ids | root's fresh preflight `10-preflight-2026-10-21T073732…out` |
| the 80 control hashes | plan `local-relay-20261021`: the bundle "after" `d2e363c5` plus 79 unchanged |
| the settings | after `2324904b` |
| the operator | `0x1A01194c…` |
| the relays | moved payee `0x51ff183d…`, eu-central fallback `0xC5D88d2D…` |
| the deployments | the 9 affected app ids |
| the RPCs | the 3 RPCs, quorum 2 |
| the audit code | the main modules the chain audit was tested with |

## Order (root, from the workstation; each step read-only)

```bash
cd work/windows-local-relay-postcutover
# 1. the REQUIRED cutover marker: the first Base block at or after the time 20-activate.ps1 printed ACTIVATED
#    (from its log, the minipc clock; the chain's own timestamps decide). Optionally pass the activation's start time.
node find-cutover-block.mjs --activated-at <ISO ACTIVATED time> [--activate-started-at <ISO 20-activate start>] --out cutover.json
# 2. host facts (one JSON each)
bash collect-minipc.sh minipc  > minipc.json
bash collect-source.sh us-west > source.json
# 3. the chain audit: LeaseGasPaid for the 9 apps from the cutover block to the agreed head
node audit-chain.mjs --cutover cutover.json --minipc minipc.json --out chain.json   # exit 0 LOCAL_VERIFIED, 3 pending, 1 FAILED
# 4. the verdict
node accept.mjs --cutover cutover.json --minipc minipc.json --source source.json --chain chain.json   # exit 0 ACCEPTED, 3 PENDING, 1 FAILED
```

The output files are create-only (`--out` refuses to overwrite).

## What the chain audit proves, and what it does not

- **The window.** It starts at the marker block, and that block's quorum-agreed timestamp must not be before
  `activatedAt`. Earlier us-west payments by the SAME payee key (then on DigitalOcean) can never count. A test shows that
  a window opened earlier fails.
- **Discovery is an untrusted hint.** Logs come from each provider, in chunks of 500 blocks. Absence is never proven.
- **Each event for the 9 apps is verified through the quorum.** This uses main's `verifyLeaseReceipt`, as in
  `audit-paid-leases.mjs`:
  - the canonical lease call and a successful receipt;
  - the reviewed reserve and executor code at that block, and the operator's delegation;
  - the charge within the signed maximum, and the ledger state;
  - the sender is the relay key itself.
- **Local routing.** A moved-payee payment must also appear as `[relay] success <hash>` in minipc's own relay log
  (collected in `minipc.json`). Otherwise the audit FAILS: the key would have been used elsewhere.
- **Candidates.** Candidates come from log discovery AND from minipc's relay log, so one failing discovery provider
  cannot hide a payment.
- **When the quorum does not agree on a payment,** the same verification runs against EACH provider alone, and the
  per-provider results are recorded:
  - a quorum of identical results verifies it;
  - otherwise it is UNVERIFIED: proof not observed, which is NOT a failure;
  - it FAILS only when every answering provider reports the same definite defect.
- **Statuses:**
  - `LOCAL_VERIFIED`: at least one locally routed moved-payee payment, nothing unverified, and no failure;
  - `PARTIAL` / `UNVERIFIED_ONLY`: some payments not yet verified by the quorum. PENDING: re-run;
  - `FALLBACK_ONLY`: only eu-central so far. PENDING;
  - `NO_EVENTS_YET`: nothing in the window yet. PENDING: this is neither failure nor success;
  - `FAILED`: anything else, i.e. another payee, another operator, a verification error, or a moved payment absent
    from minipc's log.

Renewals arrive on the apps' own schedules (renew window 300 s, min extension 600 s), so a PENDING right after the
cutover is expected. Re-run steps 2 to 4 later with new `--out` names.

## One-command live run (what was used, read-only, through the queue)

`bash live-run.sh <settingsSwappedAt>` runs the marker, both collectors, the chain audit and the verdict into a new
`evidence/live-<stamp>/` directory. `evidence/union-summary.json` combines the runs: each listed payment was
quorum-verified in at least one run. The union is reported as such, never as a single-run verdict.

## accept.mjs checks

| check | requirement |
| --- | --- |
| freshness | every document is newer than `activatedAt` |
| `vms` | exactly the 9 ids are running: none lost, none extra |
| agent | one agent and one loop, healthy, app-funded, operator `0x1A01194c…`; the loop started after the activation began (when `activateStartedAt` is given) |
| `control` | 80/80 hashes match |
| `settings` | after `2324904b`, the record `1665c218`, and still called |
| relay | task `Running`, one process, a listener on 8549, `/v1/info` is the moved payee for chain 8453 and the reviewed reserve and executor |
| source | masked and inactive (`/dev/null` link); no process and no :8549 listener; neither local nor the https front answers as the payee; the stop receipt says masked |
| `chain` | as above |

## Code provenance

`audit-chain.mjs` imports main's `client/lease-executor-authority.mjs`, `client/lease-executor-client.mjs` and
`network/lease-gas-owner.mjs` at run time. Every report records their sha256. If they differ from
`expectations.auditCode` (the versions the tests passed with), the audit refuses unless given
`--accept-code-drift yes` after review.
