#!/usr/bin/env python3
"""plan_linux.py -- LOCAL ONLY (pwsh 7 on Linux; NOT Windows). Runs the UNCHANGED r3 migrate-local-config.ps1 (stage copy, pinned) on
the fixture's dummy files with the reviewed r3 test driver's mocks (config-persistence-r3/test/test_persistence.py, imported
read-only, bytecode off) and writes stage/expected.json: the planned/after hashes the native driver must reproduce, and the
effective ENCF_* environment of each launcher before migration, after migration + r6-style rewrite, and after a rewrite WITHOUT
migration (the loss the native cmd.exe check must also see). Also asserts the local semantics (exit 1 on any mismatch)."""
import hashlib, importlib.util, json, pathlib, re, shutil, sys, tempfile
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent; PKG = HERE.parent; S = PKG / 'stage'
R3T = PKG.parent / 'config-persistence-r3/test/test_persistence.py'
H = lambda b: hashlib.sha256(b).hexdigest()


def r3harness():
    sp = importlib.util.spec_from_file_location('r3t', R3T); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    m.MIG = S / 'migrate-local-config.ps1'; return m


def case(kind):
    d = pathlib.Path(tempfile.mkdtemp(prefix='cnf-'))
    src = {'run-node.cmd': 'run-node.cmd' if kind != 'plain' else 'run-node.plain.cmd', 'run-shield.cmd': 'run-shield.cmd' if kind != 'plain' else 'run-shield.plain.cmd',
           'node-config.cmd': 'node-config.cmd', 'shield-config.cmd': 'shield-config.cmd', 'node-config.local.cmd': 'node-config.local.cmd'}
    for dst, s in src.items(): shutil.copyfile(S / s, d / dst)
    return d


def evaluate(d, launcher):
    """the ENCF_* lines `set ENCF_` prints, for the subset these dummy files use (raises on anything else)"""
    env, out = {}, None
    def run(f):
        nonlocal out
        for raw in (d / f).read_bytes().decode('ascii').split('\r\n'):
            l = raw.strip()
            if not l or l.lower() == '@echo off' or l.lower().startswith('rem '): continue
            if l == 'set ENCF_': out = {k: v for k, v in sorted(env.items()) if k.startswith('ENCF_')}; continue
            if l.lower() == 'exit /b 0': return
            one(l)
    def one(c):
        m = re.match(r'(?i)^if not defined (\w+) (.*)$', c)
        if m:
            if m.group(1).upper() not in env: one(m.group(2))
            return
        m = re.match(r'(?i)^if exist "%~dp0([^"]+)" call "%~dp0([^"]+)"$', c)
        if m:
            if (d / m.group(1)).exists(): run(m.group(2))
            return
        m = re.match(r'(?i)^call "%~dp0([^"]+)"$', c)
        if m: run(m.group(1)); return
        m = re.match(r'(?i)^set "(\w+)=(.*)"$', c) or re.match(r'(?i)^set (\w+)=(.*)$', c)
        if m: env[m.group(1).upper()] = m.group(2); return
        raise ValueError('unsupported: ' + c)
    run(launcher); return out


def main():
    h = r3harness(); exp = {'migrateSha256': H((S / 'migrate-local-config.ps1').read_bytes())}
    pins = {n: json.loads((S / f'pins-{n}.json').read_text()) for n in ('main', 'plain', 'badpin')}
    env = {'MOCK_EXISTING_OWNER': 'S-1-5-18'}
    # MAIN: plan -> execute -> r6-style rewrite
    d = case('main'); node0, shield0 = evaluate(d, 'run-node.cmd'), evaluate(d, 'run-shield.cmd')
    _, plan = h.migrate(d, pins['main'], env=env); assert plan['plan']['refused'] == [], plan['plan']['refused']
    hk = plan['plan']['hooks']
    _, res = h.migrate(d, pins['main'], 'execute', plan['planSha'], env=env); assert res['result'] == 'MIGRATED', res
    shutil.copyfile(S / 'run-node.rewritten.cmd', d / 'run-node.cmd'); shutil.copyfile(S / 'run-shield.rewritten.cmd', d / 'run-shield.cmd')
    node1, shield1 = evaluate(d, 'run-node.cmd'), evaluate(d, 'run-shield.cmd')
    assert node1 == node0 and shield1 == shield0, (node0, node1, shield0, shield1)
    exp['main'] = {'nodeLocalBefore': hk['node-config.local.cmd']['before'], 'nodeLocalAfter': hk['node-config.local.cmd']['after'],
                   'shieldLocalAfter': hk['shield-config.local.cmd']['after'], 'shieldLocalCreate': hk['shield-config.local.cmd']['create'],
                   'nodeAppend': [a['name'] for a in hk['node-config.local.cmd']['append']], 'shieldAppend': [a['name'] for a in hk['shield-config.local.cmd']['append']],
                   'nodeLocalAfterBytesSha256': H((d / 'node-config.local.cmd').read_bytes()), 'shieldLocalAfterBytesSha256': H((d / 'shield-config.local.cmd').read_bytes()),
                   'effectiveNode': node0, 'effectiveShield': shield0}
    assert exp['main']['nodeLocalAfter'] == exp['main']['nodeLocalAfterBytesSha256'] and exp['main']['shieldLocalAfter'] == exp['main']['shieldLocalAfterBytesSha256']
    # the re-plan after migration: nothing left to move
    _, plan2 = h.migrate(d, dict(pins['main'], files=dict(pins['main']['files'], **{'run-node.cmd': H((d / 'run-node.cmd').read_bytes()), 'run-shield.cmd': H((d / 'run-shield.cmd').read_bytes()),
                         'node-config.local.cmd': exp['main']['nodeLocalAfter'], 'shield-config.local.cmd': exp['main']['shieldLocalAfter']}), sources={'run-node.cmd': [], 'run-shield.cmd': []}), env=env)
    assert plan2['plan']['refused'] == [] and all(x['before'] == x['after'] for x in plan2['plan']['hooks'].values()), plan2
    shutil.rmtree(d)
    # CONTROL: the rewrite WITHOUT migration loses the moved settings
    d = case('main'); shutil.copyfile(S / 'run-node.rewritten.cmd', d / 'run-node.cmd'); shutil.copyfile(S / 'run-shield.rewritten.cmd', d / 'run-shield.cmd')
    lostN = sorted(set(node0) - set(k for k, v in evaluate(d, 'run-node.cmd').items() if node0.get(k) == v))
    lostS = sorted(set(shield0) - set(k for k, v in evaluate(d, 'run-shield.cmd').items() if shield0.get(k) == v))
    exp['controlRewriteWithoutMigration'] = {'nodeLostOrChanged': lostN, 'shieldLostOrChanged': lostS}
    assert lostN == ['ENCF_GATEWAYS', 'ENCF_OWNERSHIP', 'ENCF_PINS_FILE', 'ENCF_SLOTS', 'ENCF_STARTUP'] and lostS == ['ENCF_SHIELD_DEBUG'], (lostN, lostS)
    shutil.rmtree(d)
    # PLAIN: nothing to move; the Shield hook stays absent
    d = case('plain'); _, plan = h.migrate(d, pins['plain'], env=env)
    assert plan['plan']['refused'] == [] and all(x['before'] == x['after'] for x in plan['plan']['hooks'].values()), plan
    exp['plain'] = {'nodeLocal': plan['plan']['hooks']['node-config.local.cmd']['before'], 'shieldLocal': plan['plan']['hooks']['shield-config.local.cmd']['after']}
    assert exp['plain']['shieldLocal'] == 'absent'; shutil.rmtree(d)
    # BAD PIN: refused
    d = case('main'); _, plan = h.migrate(d, pins['badpin'], env=env)
    assert any('differ from the pinned' in x for x in plan['plan']['refused']), plan['plan']['refused']
    exp['badpin'] = {'refusedContains': 'differ from the pinned'}; shutil.rmtree(d)
    (S / 'expected.json').write_text(json.dumps(exp, indent=1) + '\n')
    print(json.dumps(exp, indent=1)); print('PLAN-LINUX PASS')


if __name__ == '__main__':
    main()
