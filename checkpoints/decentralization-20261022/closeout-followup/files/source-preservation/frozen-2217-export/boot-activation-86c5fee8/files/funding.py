# PHASE 3c (ROOT EXECUTES, read-only; MANDATORY before ANY activation restart - activate.py runs it again right before its write):
#   python3 work/custody-boot-activation-20261023/funding.py [--rpc https://A --rpc https://B]
# boot-funding.mjs reads, at one block both RPCs agree on: the registry code (schema 4), the operator's EIP-7702 delegation and its
# executor's code, the metal0 row, nonce/latest/pending on both RPCs, the balance, fees, two gas estimates and the L1/operator fee
# bounds for setProofKey(metal0, 0xff..ff) - the worst-case nonzero test key, fee estimation ONLY. boot_funding_problems() then
# requires the REVIEWED boot decision to be exactly setProofKey (no full register() fallback for this cutover), nothing in flight,
# delegation/registry unchanged and the worst case at viem's default fees <= balance with 25% headroom. No key, no transaction.
import argparse, json, sys
from common import *
ap = argparse.ArgumentParser(); ap.add_argument('--rpc', action='append'); a = ap.parse_args()
rpcs = a.rpc or RPCS[:2]; assert len(rpcs) == 2, 'exactly two --rpc'
f, probs = boot_funding(rpcs, REVIEWED['commit'], EVIDENCE/'boot-funding.json')
v = {'at': utc(), 'ok': not probs, 'problems': probs}
if f: v.update(block=f['block'], action=f['action'], balanceWei=f['operator']['balanceWei'], setProofKeyWorstCaseWei=f['setProofKey']['worstCaseWei'],
               nonce=f['operator']['nonceAtBlock'], pending=f['operator']['pending'])
(EVIDENCE/'boot-funding-verdict.json').write_text(json.dumps(v, indent=2) + '\n'); print(json.dumps(v, indent=2))
if probs: sys.exit(1)
