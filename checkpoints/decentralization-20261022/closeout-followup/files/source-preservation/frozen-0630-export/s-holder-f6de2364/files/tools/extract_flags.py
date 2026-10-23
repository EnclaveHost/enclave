#!/usr/bin/env python3
"""Build holder/FLAGS.json: for every flag holder.py renders, the clap definition (file:line) in the PINNED sources and
that file's sha256. Inputs: base/base 5476069f (v1.5.1) and base/reth 7134be3b trees (read-only)."""
import hashlib, json, re, sys
from pathlib import Path
BASE, RETH = Path(sys.argv[1]), Path(sys.argv[2])
# flag -> (tree, relative file, how): 'long' = long = "<flag>"; 'field' = #[arg(long ...)] on `pub <field>:`
WANT = {
  '--chain': (BASE, 'bin/base/src/cli.rs', 'long'),
  '--datadir': (RETH, 'crates/node/core/src/args/datadir_args.rs', 'field:datadir'),
  '--datadir.static-files': (RETH, 'crates/node/core/src/args/datadir_args.rs', 'long'),
  '--http': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'field:http'),
  '--http.addr': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'long'),
  '--http.port': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'long'),
  '--http.api': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'long'),
  '--rpc.max-connections': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'long'),
  '--rpc.eth-proof-window': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'long'),
  '--ipcdisable': (RETH, 'crates/node/core/src/args/rpc_server.rs', 'field:ipcdisable'),
  '--minimal': (RETH, 'crates/node/core/src/args/pruning.rs', 'field:minimal'),
  '--full': (RETH, 'crates/node/core/src/args/pruning.rs', 'field:full'),
  '--addr': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--port': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--discovery.addr': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--discovery.port': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--discovery.v5.addr': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--discovery.v5.port': (RETH, 'crates/node/core/src/args/network.rs', 'long'),
  '--rpc.addr': (BASE, 'crates/consensus/cli/src/rpc.rs', 'long-embedded'),
  '--rpc.port': (BASE, 'crates/consensus/cli/src/rpc.rs', 'long-embedded'),
  '--p2p.listen.ip': (BASE, 'crates/consensus/cli/src/p2p.rs', 'long'),
  '--p2p.listen.tcp': (BASE, 'crates/consensus/cli/src/p2p.rs', 'long'),
  '--p2p.listen.udp': (BASE, 'crates/consensus/cli/src/p2p.rs', 'long'),
  '--l1-eth-rpc': (BASE, 'crates/consensus/cli/src/l1.rs', 'field:l1_eth_rpc'),
  '--l1-beacon': (BASE, 'crates/consensus/cli/src/l1.rs', 'field:l1_beacon'),
  '--l1.rpc-timeout-ms': (BASE, 'crates/consensus/cli/src/l1.rs', 'long'),
  '--upgrade-signal.mode': (BASE, 'crates/utilities/upgrade-signal/src/config/args.rs', 'long'),
  '--rpc.forwarding-endpoint': (BASE, 'crates/execution/cli/src/standard_node.rs', 'long'),
}
ENV = {'BASE_NODE_L1_TRUST_RPC': (BASE, 'crates/consensus/cli/src/l1.rs')}
out = {'format': 'enclave-base-holder-flags/v1',
       'sources': {'base/base': '5476069f1eb74a56bccb56fdefd4b4bb0e3cda42 (v1.5.1)', 'base/reth': '7134be3b51cf9d9504f988bff3266a23085f0bd9 (base-v2.5.2.8)'},
       'release': {'tag': 'v1.5.1', 'asset': 'base-v1.5.1-x86_64-unknown-linux-gnu.tar.gz',
                   'tarballSha256': '6779c45dbc6041205cc4e52bc2cd9d40746a5a4366a309899bf6533fccebe2b7',
                   'digestSource': 'GitHub release API asset digest (evidence/upstream-20261023T043317Z/base-releases.json)',
                   'signature': 'base-v1.5.1-x86_64-unknown-linux-gnu.tar.gz.asc (not verified: release key not established)'},
       'executed': False, 'flags': {}, 'env': {}}
for flag, (tree, rel, how) in WANT.items():
    p = tree / rel; text = p.read_text().splitlines()
    name = flag[2:]
    hit = None
    emb = next((n for n, l in enumerate(text, 1) if 'pub struct EmbeddedRpcArgs' in l), 0)
    for i, l in enumerate(text, 1):
        if how == 'long' and re.search(r'long\s*=\s*"%s"' % re.escape(name), l): hit = i; break
        if how == 'long-embedded' and i > emb and re.search(r'long\s*=\s*"%s"' % re.escape(name), l): hit = i; break
        if how.startswith('field:') and re.search(r'pub %s\s*:' % how[6:], l):
            back = '\n'.join(text[max(0, i - 8):i])
            if re.search(r'#\[arg\([^]]*\blong\b', back): hit = i; break
        if how == 'test-literal' and '"%s"' % flag in l: hit = i; break
    if not hit: sys.exit(f'NOT FOUND {flag} in {rel}')
    out['flags'][flag] = {'file': f"{'base/base' if tree == BASE else 'base/reth'}:{rel}:{hit}", 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(), 'kind': how}
for k, (tree, rel) in ENV.items():
    p = tree / rel; i = next(n for n, l in enumerate(p.read_text().splitlines(), 1) if k in l)
    out['env'][k] = {'file': f'base/base:{rel}:{i}', 'sha256': hashlib.sha256(p.read_bytes()).hexdigest(),
                     'why': 'l1_trust_rpc is a bool arg with default true (SetTrue): only the env value can make it false'}
print(json.dumps(out, indent=1, sort_keys=True))
