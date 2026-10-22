#!/usr/bin/env python3
"""LOCAL ONLY tests of package/root-hs2-parallel.py: the transport's ps() and subprocess.run (scp) are replaced by
recorders, so nothing can reach minipc. Facts are root's real read-only 01:50Z live read (live-read.json). These are mock
tests of the Python driver and package invariants, NOT native Windows verification of the helper."""
import copy, importlib.util, io, json, os, pathlib, re, sys, tempfile, time, contextlib

HERE = pathlib.Path(__file__).resolve().parent
PKG = pathlib.Path(os.environ.get('HS2_PKG', HERE / 'package'))  # HS2_PKG=<root original> for the negative control
W = next(p for p in HERE.parents if p.name == 'work')
LIVE = json.loads((W / 'hs2-parallel-txt-package-20261022/live-read.json').read_text())['facts']
results = []
def check(name, cond):
    results.append((name, bool(cond))); print(('PASS ' if cond else 'FAIL ') + name)

sp = importlib.util.spec_from_file_location('drv', PKG / 'root-hs2-parallel.py'); d = importlib.util.module_from_spec(sp); sp.loader.exec_module(d)
m, man = d.verify_local()
d.verify_local = lambda: (m, man)  # main() re-imports the transport; keep the recorder-patched module
tmp = pathlib.Path(tempfile.mkdtemp(prefix='hs2drv-')); d.OUT = tmp / 'runs'
calls, scps = [], []
def fake_ps_factory(responses):
    def ps(text, secs=150):
        calls.append((text, secs))
        for key, resp in responses:
            if key(text): return copy.deepcopy(resp(text) if callable(resp) else resp)
        raise AssertionError('unexpected remote text')
    return ps
class R: returncode = 0; stdout = ''; stderr = ''
def fake_run(argv, **kw):
    scps.append(argv); return R()
d.subprocess.run = fake_run
is_facts = lambda t: "Get-ScheduledTask -TaskPath '\\Enclave\\'" in t and 'helpers=' in t
is_health = lambda t: 'health.ps1' in t and 'checks=' in t
HEALTHY = {'exit': 0, 'checks': ['PASS gate']}
def run(argv):
    time.sleep(1.1)  # receipts are named per UTC second and created O_EXCL
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        try: rc = d.main(argv)
        except SystemExit as e: rc = ('exit', str(e))
    return rc, buf.getvalue()

# ---- package / helper-manifest invariants (Python mirror of hs2-upgrade.ps1 lines 131-145 + G4 maker rules)
B = PKG / 'bundle'
RelOk = re.compile(r'^((bin|packages|windows)/[A-Za-z0-9._-]+|STAGE-SHA256SUMS|ACTIVATION-WINDOWS\.txt)$'); Sh = re.compile(r'^[0-9a-f]{64}$')
check('manifest has every helper-required field', all(k in man for k in ('format', 'label', 'id', 'scripts', 'replace', 'add', 'unchanged', 'config', 'receipt')) and man['format'] == 'enclave-hs2-upgrade/v1' and man['label'] == 'hs2')
check('every replace/unchanged path passes the helper RelOk regex', all(RelOk.match(x['path']) for x in man['replace'] + man['unchanged']))
check('replace pins are hex and old != new', all(Sh.match(x['old']) and Sh.match(x['new']) and x['old'] != x['new'] for x in man['replace']))
touched = {x['path'] for x in man['replace']}
check('stop/start/health/common are never replaced', not touched & {'windows/stop.ps1', 'windows/start.ps1', 'windows/health.ps1', 'windows/common.ps1'})
check('script pins equal the unchanged installed scripts', all({u['path']: u['sha'] for u in man['unchanged']}[k] == v for k, v in man['scripts'].items()))
check('bundle files are the pinned new shas', all(d.sha(B / 'files' / x['path']) == x['new'] for x in man['replace']) and d.sha(B / 'config/host-services.json') == man['config']['new'])
check('old pins == root live read (all 23 files, config, receipt)', {**{x['path']: x['old'] for x in man['replace']}, **{u['path']: u['sha'] for u in man['unchanged']}} == LIVE['files'] and man['config']['old'] == LIVE['config'] and man['receipt']['old'] == LIVE['receipt'])
sums = dict(reversed(l.split('  ', 1)) for l in (B / 'files/STAGE-SHA256SUMS').read_text().splitlines())
pinned = {**{x['path']: x['new'] for x in man['replace']}, **{u['path']: u['sha'] for u in man['unchanged']}}
check('STAGE-SHA256SUMS agrees with every installed program pin after upgrade', all(pinned[k] == v for k, v in sums.items() if RelOk.match(k)) and {k for k in sums if RelOk.match(k)} | {'STAGE-SHA256SUMS'} == set(pinned))
check('non-program stage entries unchanged vs G4 sums', all(l in (W / 'challenge-host-tls-20261021/g4/upgrade-bundle-g4/files/STAGE-SHA256SUMS').read_text().splitlines() for l in (B / 'files/STAGE-SHA256SUMS').read_text().splitlines() if not RelOk.match(l.split('  ', 1)[1])))
dirs = {str(pathlib.PurePosixPath(k).parent) for k in d.BUNDLE_FILES}
check('every bundle file lands in a dir MKSTAGE creates', dirs <= {'.', 'config', 'files', 'files/bin', 'files/packages'} and all(s in d.MKSTAGE for s in ('bundle\\config', 'bundle\\files\\bin', 'bundle\\files\\packages')))
check('BUNDLE_FILES == every file under bundle/', d.BUNDLE_FILES == {str(p.relative_to(B)): d.sha(p) for p in B.rglob('*') if p.is_file()})

# ---- selfcheck: local only
calls.clear(); scps.clear(); m.ps = fake_ps_factory([])
rc, out = run(['--selfcheck'])
j = json.loads(out)
check('selfcheck exit 0, 0 remote calls, 0 scp, nothing written', rc == 0 and not calls and not scps and not d.OUT.exists())
check('selfcheck encoded lengths <= 7900 and no placeholder left', all(v <= 7900 for v in j['encodedLengths'].values()) and not any(j['placeholdersLeft'].values()))
check('selfcheck texts use the hs2up-txt- staging prefix', 'hs2up-txt-' in d.MKSTAGE.replace('DX', d.STAGING + r'\hs2up-txt-0123456789ab'))

# ---- default preflight: read-only texts only
MUT = re.compile(r'New-Item|Remove-Item|Copy-Item|Move-Item|Set-|Start-ScheduledTask|Stop-|Register-|Unregister-|WriteAll|::Replace|::Move|Rename-|Out-File|Add-Content|Disable-|Enable-')
calls.clear(); m.ps = fake_ps_factory([(is_facts, {**LIVE}), (is_health, HEALTHY)])
rc, out = run([])
pre_files = sorted(d.OUT.glob('preflight-*.json'))
check('default preflight passes on root live facts (exit 0) with exactly FACTS + HEALTH', rc == 0 and len(calls) == 2 and is_facts(calls[0][0]) and is_health(calls[1][0]))
check('preflight texts contain no mutating cmdlet', not any(MUT.search(t) for t, _ in calls))
pre = json.loads(pre_files[-1].read_text()); check('preflight receipt bound to manifest', pre.get('manifest') == d.MSHA and pre['gates']['upgrade'] == [])
PRE = pre_files[-1]

# ---- gate negatives
base = {'facts': {**LIVE}, 'health': HEALTHY}
def mutated(fn): e = copy.deepcopy(base); fn(e['facts']); return d.gate(e, man, 'upgrade')
check('gate refuses a different task XML', any('task XML' in b for b in mutated(lambda f: f.update(taskXmlSha='0' * 64))))
check('gate refuses changed receipt', mutated(lambda f: f.update(receipt='1' * 64)))
check('gate refuses changed config', mutated(lambda f: f.update(config='2' * 64)))
check('gate refuses one drifted unchanged file', mutated(lambda f: f['files'].update({'packages/service-tls.mjs': '3' * 64})))
check('gate refuses already-upgraded runner', mutated(lambda f: f['files'].update({'bin/host-services-runner.mjs': man['replace'][1]['new']})))
check('gate refuses active.lock', mutated(lambda f: f.update(lock='20261022000000-abcdef01')))
check('gate refuses a running helper', mutated(lambda f: f.update(helpers=1)))
check('gate refuses stopped task', mutated(lambda f: f.update(taskState='Ready')))
check('gate refuses low memory', mutated(lambda f: f.update(freeMiB=1000)))
e = copy.deepcopy(base); e['health'] = {'exit': 2}; check('gate refuses unhealthy', d.gate(e, man, 'upgrade'))

# ---- stale / foreign evidence refused before any remote call
def write_pre(name, **kw):
    p = tmp / name; o = {**pre, **kw}; o = {k: v for k, v in o.items() if v is not None}; p.write_text(json.dumps(o)); return p
ts = lambda off: time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(time.time() + off))
for label, p in (('stale 1900 s', write_pre('old.json', at=ts(-1900))), ('future-dated', write_pre('fut.json', at=ts(+600))),
                 ('root-original manifest 9a732f15', write_pre('foreign.json', manifest='9a732f1501c65cbe5eb9e04bfe7b41706f5c0ffa7406015ad025ad3c00dcc569')),
                 ('G4-style receipt without manifest', write_pre('g4.json', manifest=None))):
    calls.clear(); rc, _ = run(['--stage', '--preflight', str(p)])
    check(f'--stage refuses {label} preflight with 0 remote calls', isinstance(rc, tuple) and not calls)
failpre = write_pre('fail.json', gates={'upgrade': ['x']}); calls.clear(); rc, _ = run(['--stage', '--preflight', str(failpre)])
check('--stage refuses a failing preflight with 0 remote calls', isinstance(rc, tuple) and not calls)

# ---- stage: new unique hs2up-txt- dir, every file uploaded and verified
STAGE_RE = re.compile(r'^C:\\ProgramData\\Enclave\\staging\\hs2up-txt-[0-9a-f]{12}$')
want = {'hs2-upgrade.ps1': d.HELPER[1], **{'bundle\\' + k.replace('/', '\\'): h for k, h in d.BUNDLE_FILES.items()}}
def mk(t): return {'created': re.search(r"\$d='([^']+)'", t).group(1)}
calls.clear(); scps.clear()
m.ps = fake_ps_factory([(lambda t: 'stage exists' in t, mk), (lambda t: 'ParseFile' in t, {'files': want, 'count': len(want), 'parseErrors': []})])
rc, out = run(['--stage', '--preflight', str(PRE)])
st_files = sorted(d.OUT.glob('stage-*.json')); st = json.loads(st_files[-1].read_text())
check('stage ok, unique hs2up-txt- dir, manifest-bound receipt', rc == 0 and st['ok'] and STAGE_RE.match(st['stage']) and st.get('manifest') == d.MSHA)
dest = [a[-1] for a in scps]
check('stage uploads helper + 7 bundle files into that dir only', len(scps) == 8 and all(x.startswith('minipc:/' + st['stage'].replace('\\', '/') + '/') for x in dest))
check('stage texts contain no installation write (only New-Item under staging)', all(not re.search(r'Program Files|host-services\\hs2', t) or 'ParseFile' in t for t, _ in calls))
calls.clear(); m.ps = fake_ps_factory([(lambda t: 'stage exists' in t, mk), (lambda t: 'ParseFile' in t, {'files': {**want, 'hs2-upgrade.ps1': '0' * 64}, 'count': 8, 'parseErrors': []})])
rc, _ = run(['--stage', '--preflight', str(PRE)]); check('stage with a drifted staged file is not ok (rc 4)', rc == 4)
ST = st_files[-1]

# ---- execute: pins, fresh-gate, attempt record, post evidence
calls.clear(); rc, _ = run(['--execute', '--stage-receipt', str(ST), '--preflight', str(PRE), '--manifest-sha', '0' * 64, '--helper-sha', d.HELPER[1]])
check('execute refuses wrong --manifest-sha with 0 remote calls', isinstance(rc, tuple) and not calls)
calls.clear(); m.ps = fake_ps_factory([(is_facts, {**LIVE, 'taskXmlSha': 'f' * 64}), (is_health, HEALTHY)])
rc, _ = run(['--execute', '--stage-receipt', str(ST), '--preflight', str(PRE), '--manifest-sha', d.MSHA, '--helper-sha', d.HELPER[1]])
check('execute refuses changed task XML on the fresh read; no attempt, no helper', rc == 4 and not list(d.OUT.glob('attempt-*')) and not any('-Mode' in t for t, _ in calls))
RID = '20261022020000-0123abcd'
upgraded = {**LIVE, 'files': {**LIVE['files'], **{x['path']: x['new'] for x in man['replace']}}, 'config': man['config']['new'], 'receipt': 'e' * 64,
            'journal': {'journal': {'manifest': d.MSHA, 'phase': 'complete', 'receiptNew': 'e' * 64}, 'revert-journal': None}}
state = {'n': 0}
def facts_seq(t):
    state['n'] += 1; return LIVE if state['n'] == 1 else upgraded
calls.clear(); m.ps = fake_ps_factory([(lambda t: '-Mode Upgrade' in t, {'started': True, 'exit': 0, 'result': json.dumps({'ok': True, 'exit': 0, 'runId': RID}), 'other': ''}),
                                       (is_facts, facts_seq), (is_health, HEALTHY)])
rc, out = run(['--execute', '--stage-receipt', str(ST), '--preflight', str(PRE), '--manifest-sha', d.MSHA, '--helper-sha', d.HELPER[1]])
att = json.loads((d.OUT / 'attempt-upgrade.json').read_text())
helper_text = [t for t, _ in calls if '-Mode Upgrade' in t][0]
check('execute: attempt recorded, helper run once from the staged dir with exact pins, post verified (rc 0)', rc == 0 and att.get('manifest') == d.MSHA and helper_text.count('-Mode Upgrade') == 1 and st['stage'] in helper_text and d.MSHA in helper_text and d.HELPER[1] in helper_text)
check('execute helper budget 2400 s and health wait 600', [s for t, s in calls if '-Mode Upgrade' in t] == [2400] and '-HealthWaitSeconds 600 -StopTimeoutSeconds 120' in helper_text)
calls.clear(); rc, _ = run(['--execute', '--stage-receipt', str(ST), '--preflight', str(PRE), '--manifest-sha', d.MSHA, '--helper-sha', d.HELPER[1]])
check('second execute refused by the existing attempt record; helper not run again', rc == 4 and not any('-Mode' in t for t, _ in calls))
check('upgraded gate refuses if task XML changed after upgrade', any('task XML' in b for b in d.gate({'facts': {**upgraded, 'taskXmlSha': '0' * 64}, 'health': HEALTHY}, man, 'upgraded', RID)))
check('revert gate passes only for this manifest\'s completed run', d.gate({'facts': upgraded, 'health': HEALTHY}, man, 'revert', RID) == []
      and d.gate({'facts': {**upgraded, 'journal': {'journal': {**upgraded['journal']['journal'], 'manifest': '9a732f1501c65cbe5eb9e04bfe7b41706f5c0ffa7406015ad025ad3c00dcc569'}}}, 'health': HEALTHY}, man, 'revert', RID))

fails = [n for n, ok in results if not ok]
print(json.dumps({'pass': len(results) - len(fails), 'fail': len(fails), 'failed': fails}))
sys.exit(1 if fails else 0)
