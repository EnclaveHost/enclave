"""Teach a supervisor.js not to prove free leases, and to say when its operator key runs low on gas.

python3 -I metal/free-lease-proof-patch.py SUPERVISOR_JS

A proof-of-time checkpoint advances a deployment's provenUntil, and the ledger credits the runner rate x proven time. At
rate 0 (the owner's own host running the owner's app for free: Enclave RPC on metal0) the product is zero whatever the
watermark says, yet the supervisor posted one every PROOF_INTERVAL_SEC from the box's operator key: 151k gas, about
9e-7 ETH on Base, about 2.6e-4 ETH a day (2026-11-12). That key also pays the registration every start of the supervisor
needs, nothing refills it, and when it ran dry metal0 could not register after a restart and held no lease for 74
minutes. The Windows node already skips free leases (windows/node/host.mjs proveAll); this is the same rule for the
metal supervisor, plus the runway warning the other host agents have (windows/node/gas-runway.mjs).

The same anchors exist in main's supervisor.js (where this change is already applied) and in the copy metal0's control
image overlays (metal-deabf8f90 with metal/snpvm-supervisor-patch.py), so one patch serves both; each anchor must match
exactly once or nothing is written.
"""
import sys

PATCHES = [
    # 1. the shared runway measure
    ('import { planCheckpoints } from "./windows/node/verification-checkpoints.mjs";\n',
     'import { planCheckpoints } from "./windows/node/verification-checkpoints.mjs";\n'
     'import { gasRunway } from "./windows/node/gas-runway.mjs";\n'),

    # 2. the rule, and the operator key's gas watch
    ('let _proof = { at: 0, proved: 0, rejected: 0, lastError: null };\n',
     'let _proof = { at: 0, proved: 0, rejected: 0, lastError: null };\n'
     '\n'
     '// A checkpoint earns the runner its lease seconds: the ledger credits rate x proven time, and nothing else reads the\n'
     '// watermark of a lease that pays nothing. At rate 0 (a free self-hosted lease: the owner\'s own host runs the owner\'s app)\n'
     '// there is nothing to earn and nothing to meter, so proving it would spend this box\'s operator gas, every\n'
     '// PROOF_INTERVAL_SEC, to move a number that is multiplied by zero (metal0 and Enclave RPC, 2026-11-12: 151k gas each,\n'
     '// about 2.6e-4 ETH a day, from the key every start\'s registration needs). The Windows node follows the same rule\n'
     '// (windows/node/host.mjs proveAll). Skipped and said, once per deployment, not silently dropped. Only an exact zero is\n'
     '// free: an unknown rate is proven, and a lease that becomes paid (the audit mirrors d.rate every pass) is proven again.\n'
     'const _freeProofSaid = new Set();\n'
     'function freeLease(rec) {\n'
     '  if (rec.rate !== 0) { _freeProofSaid.delete(rec.id); return false; }\n'
     '  if (!_freeProofSaid.has(rec.id)) {\n'
     '    _freeProofSaid.add(rec.id);\n'
     '    console.log(`[proof] no checkpoints for ${rec.id}: a free lease (rate 0) has nothing to credit`);\n'
     '  }\n'
     '  return true;\n'
     '}\n'
     '\n'
     '// The operator key pays this box\'s own transactions: the registration every start needs (register / setProofKey), status\n'
     '// and price writes, and paid leases\' checkpoints. Nothing refills it, and an empty one does not fail loudly: checkpoints\n'
     '// stop landing and the next start stalls at registration with the claim loop locked (metal0, 2026-11-12: no lease for\n'
     '// 74 minutes). Measured the way the other host agents measure it (windows/node/gas-runway.mjs: the balance\'s fall over\n'
     '// the last hours), said hourly while low, and reported on the host record (operatorGas).\n'
     'const OPERATOR_GAS_CHECK_SEC = parseInt(process.env.OPERATOR_GAS_CHECK_SEC || "600", 10);\n'
     'let _gas = { at: 0, warnedAt: 0, samples: [], wei: null, hoursLeft: null, low: false };\n'
     'async function operatorGasTick() {\n'
     '  if (!CLAIM_READY) return;\n'
     '  if (Date.now() - _gas.at < OPERATOR_GAS_CHECK_SEC * 1000) return;\n'
     '  _gas.at = Date.now();\n'
     '  const address = claimSigner().account.address;\n'
     '  const wei = await chainClient.getBalance({ address });\n'
     '  const { renews, burnPerHour, hoursLeft, low } = gasRunway(_gas.samples, wei, _gas.at);\n'
     '  Object.assign(_gas, { wei, hoursLeft, low });\n'
     '  if (!low || _gas.at - _gas.warnedAt < 3600_000) return;\n'
     '  _gas.warnedAt = _gas.at;\n'
     '  console.warn(`[gas] operator key ${address} is low: ${(Number(wei) / 1e18).toFixed(6)} ETH`\n'
     '    + (hoursLeft !== null ? `, about ${Math.round(hoursLeft)} hours at the measured ${(burnPerHour / 1e18).toFixed(6)} ETH/h`\n'
     '                          : `, about ${renews} lease transactions\' worth`)\n'
     '    + `; once it is empty this box\'s registry writes and checkpoints stop and its next start cannot register`);\n'
     '}\n'),

    # 3. the steady clock: last in the filter, so it speaks only for a lease that would otherwise have been proven
    ('    && (!r._ledger || r._ledger.toLowerCase() === DEPLOYMENTS_ADDRESS.toLowerCase()));\n'
     '  if (!mine.length) return;\n',
     '    && (!r._ledger || r._ledger.toLowerCase() === DEPLOYMENTS_ADDRESS.toLowerCase())\n'
     '    && !freeLease(r));\n'
     '  if (!mine.length) return;\n'),

    # 4. the final period of a lease that is ending here
    ('  if (!rec.startedAt) return;\n'
     '  try {\n',
     '  if (!rec.startedAt) return;\n'
     '  if (freeLease(rec)) return;   // nothing to settle: release() returns the whole lease either way\n'
     '  try {\n'),

    # 5. on the renewal clock, beside the proofs
    ('    await stage("proof", proofTick);\n',
     '    await stage("proof", proofTick);\n'
     '    await stage("gas", operatorGasTick);          // self-throttled to OPERATOR_GAS_CHECK_SEC\n'),

    # 6. the host record
    ('    proved: _proof.proved, rejected: _proof.rejected, lastError: _proof.lastError } : null,\n',
     '    proved: _proof.proved, rejected: _proof.rejected, lastError: _proof.lastError } : null,\n'
     '  // the operator key\'s gas: what this box\'s own transactions are paid from (operatorGasTick)\n'
     '  operatorGas: _gas.wei === null ? null : {\n'
     '    wei: String(_gas.wei), hoursLeft: _gas.hoursLeft === null ? null : Math.round(_gas.hoursLeft), low: _gas.low,\n'
     '    checkedAt: new Date(_gas.at).toISOString() },\n'),
]


def patch(path):
    s = open(path).read()
    if 'function freeLease(' in s:
        raise SystemExit('%s already skips free leases' % path)
    for old, _new in PATCHES:
        if s.count(old) != 1:
            raise SystemExit('anchor not found exactly once in %s: %r' % (path, old[:70]))
    for old, new in PATCHES:
        s = s.replace(old, new)
    open(path, 'w').write(s)


if __name__ == '__main__':
    patch(sys.argv[1])
