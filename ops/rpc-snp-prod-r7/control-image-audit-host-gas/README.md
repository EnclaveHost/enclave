# metal0 control image 708ee9f: a capacity audit's job is claimed on the host's own gas

Status: **active on metal0 since 2026-11-24 07:15:37Z**; see "The run" and "The first audit job".

## Why

With app-funded lease gas a host signs claim, renew and release for the app's reserve to pay and never spends its own
ETH. A capacity audit's job has no reserve: its owner is the audit budget's payer and its USDC comes from
`EnclaveAvailability.fundJob`. metal0 refused the claim of every audit job ("the app's owner has not enabled a
lease-gas reserve; this host's ETH is never used instead") and each ended `claim deadline expired`: 2026-11-20, 21, 22
and 23, one a day.

## What changes (main 0463fe8e2, with tests)

`metal/audit-host-gas-patch.py`, applied to main's `supervisor.js` and to metal0's generation:

- `auditLeaseOnHostGas(id)`: a deployment is an audit job when the availability contract
  (`CAPACITY_AUDIT_CONTRACT`, default the live `0x87c72665…3641`) answers `fundedJob(id)` true and its `ledger()` is
  this host's ledger. Asked at the claim, at each renewal and when a release is opened. An unreadable answer is "not
  an audit job", and the sponsored path then refuses as it does for any app without a reserve.
- for such a deployment claim, renew and release are the operator key's own transactions; a release intent records
  that (`hostPaid`), so a restart sends it the same way.
- at most `CAPACITY_AUDIT_HOST_PAID_PER_DAY` (4) such leases in 24 hours.
- every other deployment takes exactly the path it took before.

The contract enforces who may fund a job (the policy's executor, the payer's signed authorization, a job cap and a
daily cap), so the host's exposure is the gas of at most four leases a day.

## The image

`/home/steven/enclave-prod/dist-snpvm-708ee9f`

| | 3dd10e9 (before) | 708ee9f |
|---|---|---|
| initramfs sha256 | f408f6d13c24dc1edecaea2a7a5b1808f15110d173a539a5d544788a6e3520b0 | 50ae1dd79f3133953bec8e39eebaa2f5f7e8150d298097351711ad4710494207 |
| launch measurement | 2dd2450afd724c0f95df1c48e40cea08077bfc7ce607b254991b35f1964221b294b7cf0bc842bcbb43530ffd8aadb1b1 | 62897c2420978d1ca29c09f52bff229ebff0b4f859fefb905ace281fbb5fba839d9b45574c8ffeb9dfc2524ac191a477 |

Built in `~/.cache/metal0-gen/repo` (commit 708ee9f = 3dd10e9 plus the patch) with the running image as the base.
Compared entry by entry (29,065 each): `/app/supervisor.js` (77b40c9b… to 249ba086…) and the image's own manifest;
nothing added or removed; kernel and command line the same files. The measurement command reproduces 3dd10e9's
accepted value and gives the new one.

## The run (2026-11-24, UTC)

A first `control-image.sh apply` at 06:13 stopped before changing anything: the relay's VM was not reachable at the
address its connection wrapper defaults to (the VM has another address since its start four days before). Run again
with `CVM_IP` set to the address the Hyper-V host reports:

- 07:15:24 operator key 9.27e-4 ETH, lease in hand 25 minutes; the relay's allowlist got the measurement (46 listed,
  previous file kept as `linux-leasegas-measurements.env.before-snpvm-708ee9f`), relay restarted.
- 07:15:37 `enclave-metal.service` restarted on the image (config kept as `config.json.before-snpvm-708ee9f`);
  07:15:57 accepted on `62897c24…`, admitted, registered.
- the supervisor adopted VM `svc5c9c7e782de8357` (not restarted, the process is 46 hours old):
  `adopted: app=enclave-rpc:1.4.3 … cpuShare=0.5`, lease until 07:41; the app answers 200.
- the script then exited 1 on its last check although the adoption line was there: `grep -q` closed the pipe early
  under `pipefail`. Corrected in the script here; the second run passed every check.

The capacity audit's own list of host measurements (`~/enclave-prod/capacity-audit/config.json`) has `62897c24…`
since 06:13 and its witness issues receipts for metal0 on the new image.

## The first audit job (2026-11-24, UTC)

- 09:47:55 the audit service created a job (0.0099 USDC reserved); 09:49:03 the host acceptor accepted it.
- metal0: `[lease-gas] 0x3a5a64ad… is a capacity audit's job (funded by 0x87c72665…3641): its lease is paid by this
  host`, then the claim landed (`adopted: app=capacity-work:1.0.0 … lease until 09:56:38`). The claim was this
  key's own transaction. A renewal was refused by the ledger (`unfunded`: the job is funded for its 450 seconds only).
- the job's guest was refused by guestd four times for a reason of the host's own, a stale VCEK
  (`docs/operations/metal0-perapp-vcek-stale-20261124.md`); the supervisor gave the lease back, released at block
  61618605 by a transaction of this key.
- the audit recorded the job as failed (`the guest did not answer over TLS within its lease`).

So the change does what it was made for, claim and release on the host's gas, and the audit then failed for a fault
it exists to find. Operator key: 9.256e-4 ETH after the rollout's registration, not read again after the job.

Rollback of the image: `control-image.sh rollback`.
