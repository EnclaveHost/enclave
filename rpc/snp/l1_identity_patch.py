"""Apply the EIP-4444 L1 identity rule to a guest chain_service.py in place.

python3 -I l1_identity_patch.py CHAIN_SERVICE_PY

The reviewed guest's l1_ready() requires block 0 to be mainnet's genesis. reth with
pre-merge history expired (as on the production L1 disk, earliest block 26150000)
answers block 0 with JSON-RPC error 4444, so Base could never start. This accepts the
genesis hash or exactly that error. The EL stays pinned to mainnet by chainId 1 and by
l1_ready()'s pairing of the EL head with the head payload of a beacon node checked
against mainnet's genesis_validators_root and spec. That is the rule
rpc/base_coverage/coverage_gate.py applied, and its review accepted, for verdict r4.
Any other answer to block 0 still refuses. The build re-pins identity.json afterwards.
"""
import sys

OLD = ("    assert rpc(18645, 'eth_getBlockByNumber', ['0x0', False])['hash'] == "
       "'0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3', 'wrong EL genesis'\n")
NEW = """    # reth with EIP-4444 pre-merge expiry answers block 0 with error 4444; the EL is then pinned to mainnet by
    # chainId 1 and by the head payload pairing below (as base_coverage/coverage_gate.py, verdict r4).
    body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'eth_getBlockByNumber', 'params': ['0x0', False]}).encode()
    req = urllib.request.Request('http://127.0.0.1:18645', body, {'Content-Type': 'application/json'})
    with urllib.request.urlopen(req, timeout=10) as r:
        genesis = json.load(r)
    assert (genesis.get('result') or {}).get('hash') == '0xd4e56740f876aef8c010b86a40d5f56745a118d0906a34e69aec8c0db1cb8fa3' \\
        or ('result' not in genesis and (genesis.get('error') or {}).get('code') == 4444), 'wrong EL genesis'
"""


def patch(path):
    s = open(path).read()
    if s.count(OLD) != 1:
        raise SystemExit('l1_ready genesis check not found exactly once in ' + path)
    open(path, 'w').write(s.replace(OLD, NEW))


if __name__ == '__main__':
    patch(sys.argv[1])
