# Regenerates the hash-bearing parts of work/app-auth-release-migration-source-inventory.json from the files on disk.
import hashlib, json, os, sys
W = '/home/steven/Documents/Codex/2026-10-18/wo/work'
M = 'app-auth-release-migration'
def h(rel):
    p = os.path.join(W, rel); b = open(p, 'rb').read()
    return {'path': 'work/' + rel, 'sha256': hashlib.sha256(b).hexdigest(), 'bytes': len(b)}
inv = json.load(open(f'{W}/app-auth-release-migration-source-inventory.json'))
inv['generated'] = '2026-10-20'
comps = []
for c in inv['components']:
    if c['app'] == 'jot' and c['kind'].startswith('CANDIDATE'):
        c = {**h(f'{M}/scratch/apps/jot/target/wasm32-wasip2/release/jot.wasm'), 'app': 'jot',
             'kind': 'CANDIDATE: production profile + real model + EAB1/passkey patch (patches/jot-eab1.patch); supersedes b2d4adab..., 82f69b05...',
             'build': 'cd scratch/apps/jot && CARGO_BUILD_JOBS=1 CARGO_INCREMENTAL=0 cargo build --release --target wasm32-wasip2 --locked --offline'}
    elif c['app'] == 'eyesoff-ai' and c['kind'].startswith('STALE'):
        c = {'path': 'work/enclave-apps/eyesoff-ai/target/wasm32-wasip2/release/eyesoff_ai.wasm',
             'sha256': '66ecfcaa0e4ea8301d05a975df208592215e30b2ed38c94fa42dccc717a65ca4', 'bytes': 6882879, 'app': 'eyesoff-ai',
             'kind': 'PRODUCTION base, built and tested by ROOT (byte-identical clean rebuild, 42/42 checks); receipt outputs/app-auth-review/eyesoff-production-artifact.json. Not rebuilt here.'}
    comps.append(c)
eyes_cand = sys.argv[1] if len(sys.argv) > 1 else None
comps = [c for c in comps if not (c['app'] == 'eyesoff-ai' and c['kind'].startswith('CANDIDATE'))]
if eyes_cand:
    comps.append({**h(f'{M}/scratch/apps/eyesoff-ai/target/wasm32-wasip2/release/eyesoff_ai.wasm'), 'app': 'eyesoff-ai',
                  'kind': 'CANDIDATE: production profile + EAB1/passkey patch (patches/eyesoff-ai-eab1.patch)', 'note': eyes_cand})
inv['components'] = comps
files = ['candidate/eab1.rs', 'candidate/apply.py', 'candidate/make-patches.sh', 'patches/eyesoff-ai-eab1.patch', 'patches/jot-eab1.patch',
         'tools/eab1.mjs', 'PROTOCOL-EAB1.md', 'ACTIVATION-PLAN.md', 'activation/sso-until.json', 'activation/migration.example.json',
         'activation/depot-and-api-mcp-at-cutover.json', 'tests/migration-evm.e2e.test.mjs', 'tests/browser-migration.mjs',
         'tests/passkey-recovery.mjs', 'guard.sh']
inv['candidate'] = [h(f'{M}/{f}') for f in files]
inv['passkey'] = {
    'note': 'PROTOCOL-EAB1.md section 3a: passkey-only accounts prove through their ORIGINAL EnclaveCreditVault (book key vaultFactory); no contract change or deployment',
    'production_factory': {'factory': '0xa891e4396e3eb11f364554043bc18e86da834e91', 'implementation': '0xeca6644333d3a069001203ce5416914a4d830beb',
        'source': 'work/enclave contracts/EnclaveCreditVault.sol @ d36100ae', 'source_sha256': 'b978896920989146b8928d86e5e74c4aabb71e261b7261c3c29a24ce9f50934c',
        'compiler': 'solc 0.8.35, optimizer 200, no viaIR (deploy pipeline settings)', 'origin0': 'https://enclave.host', 'origin1': '', 'checked_block': 52856571},
    'files': [h(f'{M}/passkey/{f}') for f in ['recover/index.html', 'recover/recover.js', 'recover/recover-config.production.json',
        'production-factory.json', 'production-derivation.txt', 'fixtures/credit-vault-d36100ae.json', 'match-history.mjs', 'compile-d36100ae.mjs',
        'check-production-derivation.mjs', 'read-metadata.mjs', 'p256-probe.mjs', 'verify-production-factory.mjs']],
    'superseded': 'passkey/verify-production-factory.mjs compared against the foundry viaIR artifact (not the deploy settings); kept as a record, superseded by match-history.mjs',
}
tree = {}
for app, fs in [('eyesoff-ai', ['src/lib.rs', 'src/config.rs', 'src/sso.rs', 'src/chat.html', 'src/eab1.rs', 'src/wallet.rs', 'PLATFORM-sso.md']),
                ('jot', ['src/lib.rs', 'src/sso.rs', 'src/index.html', 'src/eab1.rs', 'src/wallet.rs', 'README.md'])]:
    for f in fs: tree[f'{app}/{f}'] = h(f'{M}/scratch/apps/{app}/{f}')['sha256']
inv['candidate_tree'] = tree
json.dump(inv, open(f'{W}/app-auth-release-migration-source-inventory.json', 'w'), indent=1)
open(f'{W}/app-auth-release-migration-source-inventory.json', 'a').write('\n')
print('inventory updated;', len(comps), 'components')
