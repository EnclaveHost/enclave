"""Let a supervisor.js with app-funded lease gas claim a capacity audit's job on the host's own gas.

python3 -I metal/audit-host-gas-patch.py SUPERVISOR_JS

With app-funded leases configured a host signs claim, renew and release for the app's reserve to pay and never spends
its own ETH. A capacity audit's job (docs/design/paid-capacity-verification.md) has no reserve: its owner is the audit
budget's payer and its USDC comes from EnclaveAvailability.fundJob, so every lease-gas host refused the claim and the
audit ended "claim deadline expired" (metal0, 2026-11-20 and each day after). The audit pays the host, so the host
pays that lease's gas: for a deployment the availability contract itself says it funded (fundedJob(id), read from the
host's own RPC, the contract's ledger being this host's ledger), claim, renew and release take the operator-paid path.
Every other deployment takes exactly the path it took before, and an unreadable answer is "not an audit job".

The same anchors exist in main's supervisor.js and in metal0's running generation, so one patch serves both; each
anchor must match exactly once or nothing is written.
"""
import sys

HELPERS = r'''// ---- a capacity audit's job is claimed on this host's own gas ---------------------------------------------------------
// The one lease the app does not pay for: a job the availability contract funded from the audit budget (fundJob marks
// it; the policy's executor, payer authorization, job cap and daily cap are enforced there). It has no lease-gas
// reserve and it pays this host for the audit, so its claim, renew and release are this key's own transactions.
// Granted only on the contract's own answer for THIS ledger; unreadable, another ledger, or over the day's bound: not
// granted, and the sponsored path then refuses in words as it does for any app without a reserve.
const CAPACITY_AUDIT_CONTRACT = (process.env.CAPACITY_AUDIT_CONTRACT ?? "0x87c7266543ff5839b2c20226BD9B3cd511A23641").trim();
const CAPACITY_AUDIT_HOST_PAID_PER_DAY = Math.max(0, Number(process.env.CAPACITY_AUDIT_HOST_PAID_PER_DAY ?? 4) || 0);
const AUDIT_FUNDER_ABI = [
  { type: "function", name: "fundedJob", stateMutability: "view", inputs: [{ type: "bytes32" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "ledger", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
];
const _hostPaidLeases = new Map();   // deployment id -> when granted (ms)
const _notAuditJob = new Map();      // deployment id -> when last answered "no" (ms); asked again after ten minutes
const hostPaidLease = (id) => _hostPaidLeases.has(String(id || "").toLowerCase());
async function auditLeaseOnHostGas(id, { read = (functionName, args) => chainClient.readContract({ address: getAddress(CAPACITY_AUDIT_CONTRACT), abi: AUDIT_FUNDER_ABI, functionName, args }),
  ledger = DEPLOYMENTS_ADDRESS, active = leaseGasActive(), now = Date.now() } = {}) {
  const key = String(id || "").toLowerCase();
  if (!active || !CAPACITY_AUDIT_CONTRACT || !/^0x[0-9a-f]{64}$/.test(key)) return false;
  if (_hostPaidLeases.has(key)) return true;
  if (now - (_notAuditJob.get(key) ?? -Infinity) < 600_000) return false;
  try {
    if (String(await read("ledger", [])).toLowerCase() !== String(ledger).toLowerCase()) throw new Error("the audit contract pays on another ledger");
    if ((await read("fundedJob", [key])) !== true) { _notAuditJob.set(key, now); return false; }
  } catch (e) {
    console.warn(`[lease-gas] ${key} is not taken for an audit job: ${e.shortMessage || e.message}`);
    return false;
  }
  for (const [k, at] of _hostPaidLeases) if (now - at > 86_400_000 && !deployments.has(k)) _hostPaidLeases.delete(k);
  const today = [..._hostPaidLeases.values()].filter((at) => now - at < 86_400_000).length;
  if (today >= CAPACITY_AUDIT_HOST_PAID_PER_DAY) {
    console.warn(`[lease-gas] audit job ${key}: ${today} audit lease(s) already paid by this host in 24 h (bound ${CAPACITY_AUDIT_HOST_PAID_PER_DAY}); not this one`);
    return false;
  }
  _hostPaidLeases.set(key, now);
  console.log(`[lease-gas] ${key} is a capacity audit's job (funded by ${CAPACITY_AUDIT_CONTRACT}): its lease is paid by this host`);
  return true;
}
'''

PATCHES = [
    ('function leaseGasError(fn, id, e) {', HELPERS + 'function leaseGasError(fn, id, e) {'),
    ('if (!leaseGasActive()) return sendClaimTx(', 'if (!leaseGasActive() || hostPaidLease(args[0])) return sendClaimTx('),
    ('if (leaseGasActive() && !lapsed && !(await leaseGasRenewDue(rec))) continue;',
     'const hostPaid = await auditLeaseOnHostGas(rec.id);   // an audit job renews on the ordinary margin, on this key\'s gas\n'
     '    if (leaseGasActive() && !hostPaid && !lapsed && !(await leaseGasRenewDue(rec))) continue;'),
    ('  if (releaseHold(d.id)) return releaseHold(d.id);\n  let rcpt;',
     '  if (releaseHold(d.id)) return releaseHold(d.id);\n  await auditLeaseOnHostGas(d.id);\n  let rcpt;'),
    ('if (opMine && !leaseLive && rec.status === "running") {\n        try {',
     'if (opMine && !leaseLive && rec.status === "running") {\n        try {\n          await auditLeaseOnHostGas(rec.id);'),
    ('Object.assign(it, lease, { decidedAt: row.block });',
     'Object.assign(it, lease, { decidedAt: row.block });\n  if (await auditLeaseOnHostGas(id)) it.hostPaid = true;   // persisted with the intent: a restart sends it the same way'),
    ('if (leaseGasActive()) return sponsoredRelease(it);', 'if (leaseGasActive() && !it.hostPaid) return sponsoredRelease(it);'),
]


def patch(path):
    s = open(path).read()
    if 'function auditLeaseOnHostGas(' in s:
        raise SystemExit('%s already pays an audit job\'s lease gas' % path)
    for old, _new in PATCHES:
        if s.count(old) != 1:
            raise SystemExit('anchor not found exactly once in %s: %r' % (path, old[:70]))
    for old, new in PATCHES:
        s = s.replace(old, new)
    open(path, 'w').write(s)


if __name__ == '__main__':
    patch(sys.argv[1])
