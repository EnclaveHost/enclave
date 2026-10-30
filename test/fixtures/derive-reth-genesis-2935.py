"""TEST FIXTURE derivation: the canonical-trie reth --dev genesis (chain id 8453) WITH the EIP-2935 block-hash history
contract, as Base mainnet has had since Isthmus.

Usage: python3 -I derive-reth-genesis-2935.py <reth-dev-8453-genesis.json (sha256 cc045d9d...)> <out.json>

Helios answers a block it never adopted as a head (its head source skipped it) through its EIP-2935 history provider:
the untrusted block's hash must equal the slot the history contract holds, proven at the latest verified head. Without
the contract on the test chain that path can only fail, which Base does not do. Adds exactly one alloc entry: the
contract's code (alloy-eips 2.5.0 eip2935::HISTORY_STORAGE_CODE, at HISTORY_STORAGE_ADDRESS) with nonce 1, as the
EIP's deployment leaves it. Nothing else changes.
"""

import hashlib
import json
import sys

SOURCE_SHA256 = 'cc045d9d317d08dc6971e923b3939365acdfd58d5484c65afc1f5e450ee5b5af'
ADDRESS = '0x0000F90827F1C53a10cb7A02335B175320002935'
CODE = ('0x3373fffffffffffffffffffffffffffffffffffffffe14604657602036036042575f35600143038111604257611fff81430311604257'
        '611fff9006545f5260205ff35b5f5ffd5b5f35611fff60014303065500')

raw = open(sys.argv[1], 'rb').read()
if hashlib.sha256(raw).hexdigest() != SOURCE_SHA256:
    sys.exit('not the pinned reth dev genesis')
g = json.loads(raw)
if any(k.lower().removeprefix('0x') == ADDRESS.lower()[2:] for k in g['alloc']):
    sys.exit('the history contract is already present')
g['alloc'][ADDRESS] = {'balance': '0x0', 'nonce': '0x1', 'code': CODE}
with open(sys.argv[2], 'w') as f:
    json.dump(g, f, indent=1, sort_keys=True)
    f.write('\n')
print(hashlib.sha256(open(sys.argv[2], 'rb').read()).hexdigest())
