#!/usr/bin/env python3
"""compose_r13.py COLD_STAGE (--cold-only | --wiring WIRING_STAGE) [--out DIR] [--dry-run-unapproved]
(workstation; PREPARED by 50cf; composes, never tests/installs/activates).
INPUT GATES: the cold stage must be FROZEN (SHA256SUMS verifies) AND carry root's ACTUAL PASS of its own job for EXACTLY those sums
(a logs/**/RESULT line 'PASS cold-proof-tests ... stage-sums <sha>', ROOT-READY). --wiring (da0's production-bootstrap-wiring-stage) is
REFUSED until that stage is frozen with its own composition record and root PASS; the composer is then extended to its declared format
(never guessed). --cold-only composes the cold readers alone (root prefers ONE final composition WITH the wiring). --dry-run-unapproved
skips ONLY the cold PASS gate and may write ONLY under /tmp (static self-validation of this composer; never a stage).
Composes base-finality-proof-stage/r13 = the root-QUALIFIED r12-final (SHA256SUMS 9de0d8d7..., run 0738 PASS) + ONLY the two cold-proof
reader files of a FROZEN cold-proof stage (6d24), with the complete pin cascade:
  readers -> capture/a1_capture.py (_RECHECK + MODULES) -> harness/a2a4.py (RECHECK_INPUT_PINS + A1_CAPTURE_SHA256) and
  harness-first/a2a4.py (reader pins) -> src/finality_state.py HARNESS_SHA256, producer RECOVERY_A2A4/A2A4_SOURCE/FINALITY_STATE,
  recovery/forward_sync.py HARNESS -> src/reproof.py FINALITY_STATE/PRODUCER -> install/MANIFEST.json + bundle-origin.json (reader origins =
  the frozen cold stage) -> installer qualification strings r13 -> COMPOSITION.tsv, integration-r13/*.patch, SHA256SUMS, the r13 job.
REFUSES unless: r12-final verifies and is the qualified sha; the cold stage has SHA256SUMS that verify and list the readers; the two a1-read
copies are identical; every edit replaces exactly the expected number of pins; afterwards NO old pin remains outside historical records;
every non-bundle MANIFEST sha equals its file. Nothing in r12-final, the cold stage or source/ is written. Policy, the own-EL port, the
runtime dirs, reproof retention and activation mechanism are unchanged (only pins move)."""
import hashlib, json, os, pathlib, re, shutil, subprocess, sys, tarfile, io

HERE = pathlib.Path(__file__).resolve().parent; B = HERE.parent; P = B.parent
R12F = B / 'r12-final'; R12F_SUMS = '9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e'
R12F_PASS = (P / 'logs/root-finality-r12-final-0738.out', P / 'logs/root-finality-r12-final-0738.rc')
OLD = {'read': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8', 'recheck': '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715'}
READERS = {'bundle/a1-capture/l1-anchor-a1/a1-read.mjs': ('src/l1-anchor-a1/a1-read.mjs', 'read'),
           'bundle/a1-capture/a1-original-game-prepared/a1-read.mjs': ('src/a1-original-game-prepared/a1-read.mjs', 'read'),
           'bundle/a1-capture/a1-original-game-prepared/a1-recheck-read.mjs': ('src/a1-original-game-prepared/a1-recheck-read.mjs', 'recheck')}
CASCADE = ['capture/a1_capture.py', 'harness/a2a4.py', 'harness-first/a2a4.py', 'src/finality_state.py', 'producer/base_launch.py',
           'recovery/forward_sync.py', 'src/reproof.py']
DROP = {'logs', 'bundle', 'COMPOSITION.tsv', 'SHA256SUMS', 'README.md', 'jobs/root-finality-r12-final.sh'}
h = lambda b: hashlib.sha256(b).hexdigest(); hf = lambda p: h(pathlib.Path(p).read_bytes())


def refuse(m):
    sys.exit(f'REFUSED: {m}')


def verify_sums(d):
    s = d / 'SHA256SUMS'
    if not s.is_file():
        refuse(f'{d} has no SHA256SUMS: not frozen')
    listed = {}
    for l in s.read_text().splitlines():
        want, rel = l.split(None, 1); rel = rel.lstrip('*'); rel = rel[2:] if rel.startswith('./') else rel
        if hf(d / rel) != want:
            refuse(f'{d}/{rel} differs from its SHA256SUMS')
        listed[rel] = want
    return h(s.read_bytes()), listed


def sub(path, pairs):
    t = path.read_text()
    for a, b, n in pairs:
        if t.count(a) != n:
            refuse(f'{path}: expected {n}x {a[:70]!r}, found {t.count(a)}')
        t = t.replace(a, b)
    path.write_text(t)


def main(argv):
    cold, out, dry = pathlib.Path(argv[1]).resolve(), pathlib.Path(argv[2]).resolve(), argv[3]
    if out.exists():
        refuse(f'{out} exists (a frozen stage is never rewritten)')
    sums12, _ = verify_sums(R12F)
    if sums12 != R12F_SUMS:
        refuse('r12-final is not the qualified 9de0d8d7...')
    if R12F_PASS[1].read_text().strip() != '0' or '## finality-r12-final rc=0' not in R12F_PASS[0].read_text():
        refuse('no r12-final qualification PASS receipt')
    cold_sums, listed = verify_sums(cold)
    passes = [p for p in (cold / 'logs').rglob('RESULT') if p.is_file() and any(l.startswith('PASS cold-proof-tests') and l.rstrip().endswith(f'stage-sums {cold_sums}')
                                                                                for l in p.read_text(errors='replace').splitlines())]
    if not passes and not dry:
        refuse(f'no root ACTUAL PASS of the cold stage job for its SHA256SUMS {cold_sums[:12]}... (ROOT-READY required; never assumed)')
    cold_pass = str(passes[0]) if passes else None
    for src, _k in READERS.values():
        if src not in listed:
            refuse(f'cold stage SHA256SUMS does not list {src}')
    new = {'read': hf(cold / 'src/l1-anchor-a1/a1-read.mjs'), 'recheck': hf(cold / 'src/a1-original-game-prepared/a1-recheck-read.mjs')}
    if hf(cold / 'src/a1-original-game-prepared/a1-read.mjs') != new['read']:
        refuse('the two a1-read.mjs copies differ')
    if set(new.values()) & set(OLD.values()):
        refuse('a cold reader equals the old reader (nothing to compose)')
    # ---- copy r12-final (tar, no logs/bundle) -------------------------------------------------------------------------------
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode='w') as tf:
        for p in sorted(R12F.rglob('*')):
            rel = p.relative_to(R12F).as_posix()
            if rel.split('/')[0] in DROP or rel in DROP or '__pycache__' in rel or not p.is_file():
                continue
            tf.add(p, arcname=rel)
    out.mkdir(parents=True); buf.seek(0)
    with tarfile.open(fileobj=buf) as tf:
        tf.extractall(out, filter='data')
    old = {f: hf(out / f) for f in CASCADE}; edits = {}
    # ---- the cascade, in order ----------------------------------------------------------------------------------------------
    sub(out / 'capture/a1_capture.py', [(OLD['read'], new['read'], 2), (OLD['recheck'], new['recheck'], 1)])
    cap = hf(out / 'capture/a1_capture.py')
    sub(out / 'harness/a2a4.py', [(OLD['read'], new['read'], 1), (OLD['recheck'], new['recheck'], 1), (f"A1_CAPTURE_SHA256 = '{old['capture/a1_capture.py']}'", f"A1_CAPTURE_SHA256 = '{cap}'", 1)])
    sub(out / 'harness-first/a2a4.py', [(OLD['read'], new['read'], 1), (OLD['recheck'], new['recheck'], 1)])
    hr, hfst = hf(out / 'harness/a2a4.py'), hf(out / 'harness-first/a2a4.py')
    sub(out / 'src/finality_state.py', [(old['harness/a2a4.py'], hr, 1)])
    fs = hf(out / 'src/finality_state.py')
    sub(out / 'producer/base_launch.py', [(old['harness/a2a4.py'], hr, 1), (old['harness-first/a2a4.py'], hfst, 1), (old['src/finality_state.py'], fs, 1)])
    sub(out / 'recovery/forward_sync.py', [(old['harness/a2a4.py'], hr, 1)])
    pr = hf(out / 'producer/base_launch.py')
    sub(out / 'src/reproof.py', [(old['src/finality_state.py'], fs, 1), (old['producer/base_launch.py'], pr, 1)])
    now = {f: hf(out / f) for f in CASCADE}
    bo = json.loads((out / 'bundle-origin.json').read_text())['entries']; pairs = []
    for k, (src, kind) in READERS.items():
        pairs.append((json.dumps(bo[k]['origin']), json.dumps(str(cold / src)), 1))
    pairs += [(f'"{OLD["read"]}"', f'"{new["read"]}"', 2), (f'"{OLD["recheck"]}"', f'"{new["recheck"]}"', 1)]
    sub(out / 'bundle-origin.json', pairs)
    mp = [(f'"{OLD["read"]}"', f'"{new["read"]}"', 2), (f'"{OLD["recheck"]}"', f'"{new["recheck"]}"', 1)] + [(f'"{old[f]}"', f'"{now[f]}"', 1) for f in CASCADE]
    sub(out / 'install/MANIFEST.json', mp)
    sub(out / 'install/install_verified.py', [("'## finality-r12-final rc=0' and '## r12-final SHA256SUMS <sha>'", "'## finality-r13 rc=0' and '## r13 SHA256SUMS <sha>'", 1),
        ("'## finality-r12-final rc=0' not in o or f'## r12-final SHA256SUMS {sums_sha}' not in o:   # r12-final: only its own run qualifies it",
         "'## finality-r13 rc=0' not in o or f'## r13 SHA256SUMS {sums_sha}' not in o:   # r13: only its own run qualifies it", 1),
        ('(rc 0, "## finality-r12-final rc=0", "## r12-final SHA256SUMS <this sha>")', '(rc 0, "## finality-r13 rc=0", "## r13 SHA256SUMS <this sha>")', 1)])
    sub(out / 'tests/test_ops_installer.py', [("q.write_text('## finality-r12-final rc=0\\n## r12-final SHA256SUMS abc\\n')", "q.write_text('## finality-r13 rc=0\\n## r13 SHA256SUMS abc\\n')", 1),
        ("'## finality-r5 rc=0\\n## r12-final SHA256SUMS abc\\n'", "'## finality-r5 rc=0\\n## r13 SHA256SUMS abc\\n'", 1),
        ("'## finality-r12 rc=0\\n## r12 SHA256SUMS abc\\n'):   # r12-final: no earlier run qualifies it",
         "'## finality-r12 rc=0\\n## r12 SHA256SUMS abc\\n', '## finality-r12-final rc=0\\n## r12-final SHA256SUMS abc\\n'):   # r13: no earlier run qualifies it", 1)])
    sub(out / 'install/MISSING.md', [('# r12-final: what genuinely awaits', '# r13: what genuinely awaits', 1)])
    (out / 'CANARY-R3-RECIPE.md').write_text((out / 'CANARY-R3-RECIPE.md').read_text().rstrip('\n') + f'\n\n**r13 (HISTORICAL above):** canary r3 used r10/r12-final bytes. r13 changes the two A1 readers (cold-proof timeout + end freshness) and therefore the capture module (`{cap[:12]}`) and the whole pin cascade: the NEW cold-proof canary (6d24 `canary/`) must run against r13 bytes (`logs/claude-r13-canary-handoff.json`) after root\'s r13 qualification passes.\n')
    # ---- invariants -----------------------------------------------------------------------------------------------------------
    m = json.loads((out / 'install/MANIFEST.json').read_text())
    for e in m['files']:
        if not e['src'].startswith('bundle/') and hf(out / e['src']) != e['sha256']:
            refuse(f'manifest {e["src"]} != its file')
    for k, (src, kind) in READERS.items():
        if [e['sha256'] for e in m['files'] if e['src'] == k] != [new[kind]] or json.loads((out / 'bundle-origin.json').read_text())['entries'][k]['sha256'] != new[kind]:
            refuse(f'reader {k} not re-pinned')
    olds = list(OLD.values()) + [old[f] for f in CASCADE]
    for p in out.rglob('*'):
        rel = p.relative_to(out).as_posix()
        if p.is_file() and not rel.startswith('integration') and rel != 'CANARY-R3-RECIPE.md':
            t = p.read_bytes()
            for o in olds:
                if o.encode() in t:
                    refuse(f'old pin {o[:12]} remains in {rel}')
    for f, flag in (('src/finality_state.py', 'FINALITY_PROTOTYPE_REVIEWED = False'), ('producer/base_launch.py', 'FINALITY_PROOF_REVIEWED = False'),
                    ('harness/a2a4.py', 'A1_CAPTURE_REVIEWED = False'), ('wrapper/chain_service.py', 'LAUNCH_PRODUCER_REVIEWED = False'),
                    ('harness/a2a4.py', 'RETH_ENV_PASS = ()')):
        if not re.search(r'^' + re.escape(flag), (out / f).read_text(), re.M):
            refuse(f'{f}: {flag} is not the source line (review flags stay False)')
    # ---- patches, README, job, COMPOSITION, SHA256SUMS ---------------------------------------------------------------------
    edited = CASCADE + ['bundle-origin.json', 'install/MANIFEST.json', 'install/install_verified.py', 'tests/test_ops_installer.py', 'install/MISSING.md', 'CANARY-R3-RECIPE.md']
    (out / 'integration-r13').mkdir()
    for f in edited:
        d = subprocess.run(['diff', '-u', str(R12F / f), str(out / f)], capture_output=True, text=True).stdout
        if not d:
            refuse(f'{f} unchanged')
        (out / 'integration-r13' / (f.replace('/', '_') + '-r13.patch')).write_text(d)
    (out / 'README.md').write_text(f'''# base-finality-proof-stage/r13: THE final production composition (PREPARED; qualification PENDING; NOT installed; NOT activated)

= root-qualified r12-final (SHA256SUMS {R12F_SUMS[:12]}..., run 0738 PASS) + ONLY the two cold-proof A1 readers of the frozen
{cold.relative_to(P)} (SHA256SUMS {cold_sums[:12]}...: per-class proof deadline, whole monotonic read budget, end-of-read freshness),
with the full pin cascade (capture {cap[:12]}, harness {hr[:12]}, first harness {hfst[:12]}, tool {fs[:12]}, producer {pr[:12]},
forward_sync {now["recovery/forward_sync.py"][:12]}, reproof {now["src/reproof.py"][:12]}) and r13 installer qualification strings.
A1 argument/proof/finality policy, own EL 127.0.0.1:18645, runtime dirs, reproof crash retention and the activation mechanism are unchanged.
Composed by r13-compose/compose_r13.py; COMPOSITION.tsv + integration-r13/*.patch are the trace. ONE root job: jobs/root-finality-r13-tests.sh.
''')
    job = make_job(out, cold, cold_sums)
    (out / 'jobs').mkdir(exist_ok=True); (out / 'jobs/root-finality-r13-tests.sh').write_text(job); os.chmod(out / 'jobs/root-finality-r13-tests.sh', 0o755)
    rows = []
    for p in sorted(x for x in out.rglob('*') if x.is_file()):
        rel = p.relative_to(out).as_posix()
        if rel in ('COMPOSITION.tsv', 'SHA256SUMS'):
            continue
        if rel in edited:
            rows.append((rel, hf(p), 'edit', 'r12-final', rel, rel.replace('/', '_') + '-r13'))
        elif (R12F / rel).is_file() and (R12F / rel).read_bytes() == p.read_bytes():
            rows.append((rel, hf(p), 'copy', 'r12-final', rel, '-'))
        else:
            rows.append((rel, hf(p), 'new', 'r13', '-', '-'))
    (out / 'COMPOSITION.tsv').write_text('path\tsha256\tkind\torigin\tsrc\tpatch\n' + ''.join('\t'.join(r) + '\n' for r in rows))
    lines = [f'{hf(p)}  ./{p.relative_to(out).as_posix()}' for p in sorted(out.rglob('*'), key=lambda x: x.relative_to(out).as_posix().encode())
             if p.is_file() and p.name != 'SHA256SUMS']
    (out / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    s13 = hf(out / 'SHA256SUMS')
    core = [e['sha256'] for e in m['files'] if e['dest'] == '/opt/enclave-rpc/finality/src/finality-core.mjs']
    handoff = {'note': 'r13 canary handoff (50cf). VALID ONLY after root\'s r13 qualification (jobs/root-finality-r13-tests.sh) prints ## finality-r13 rc=0 '
                       'with ## r13 SHA256SUMS == stageSha256sums. 6d24 copies these into its own canary pins; nothing here activates anything.',
               'stage': os.path.relpath(out, P), 'stageSha256sums': s13, 'manifest': hf(out / 'install/MANIFEST.json'),
               'bundleOrigin': hf(out / 'bundle-origin.json'), 'captureModule': cap, 'finalityState': fs, 'finalityCore': core[0] if len(core) == 1 else None,
               'a1Read': new['read'], 'a1RecheckRead': new['recheck'], 'coldStage': str(cold.relative_to(P)), 'coldStageSha256sums': cold_sums,
               'harness': hr, 'harnessFirst': hfst, 'producer': pr, 'forwardSync': now['recovery/forward_sync.py'], 'reproof': now['src/reproof.py'],
               'coldPassReceipt': cold_pass, 'dryRunUnapproved': dry}
    if not dry:
        (P / 'logs/claude-r13-canary-handoff.json').write_text(json.dumps(handoff, indent=1) + '\n')
    print(json.dumps({'ok': True, 'r13': str(out), 'SHA256SUMS': s13, 'rows': len(rows), 'handoff': handoff}, indent=1))
    return 0


def make_job(out, cold, cold_sums):
    t = (R12F / 'jobs/root-finality-r12-final.sh').read_text()
    cj = (cold / 'jobs/root-cold-proof-tests.sh').read_text()
    m = re.search(r'echo "(PASS cold-proof-tests[^"$]*?) ', cj); rcl = re.search(r'echo "(## cold-proof-tests[^"$]*?rc=)\$rc"', cj)
    if not m or not rcl or f'S=$P/{cold.relative_to(P)};' not in cj:
        refuse('the cold stage job does not have the expected PASS/rc lines or does not test THIS stage (never guessed)')
    ncold, rcline = m.group(1), rcl.group(1)
    def rep(a, b, n=1):
        nonlocal t
        if t.count(a) != n:
            refuse(f'job template: expected {n}x {a[:70]!r}, found {t.count(a)}')
        t = t.replace(a, b)
    head, body = t.split('set -uo pipefail\n', 1)
    head = f'''#!/bin/bash
# base-finality-proof-stage/r13: THE final production composition = root-qualified r12-final + the frozen cold-proof readers
# ({cold.relative_to(P)}, SHA256SUMS {cold_sums[:12]}...) with the full pin cascade. ONE queued job (PREPARED; NOT run by Claude):
#   ST={out}
#   python3 -u {P}/../claude-test-queue.py --mib 768 --log $ST/logs/root-finality-r13-tests.guard -- unshare -rn bash $ST/jobs/root-finality-r13-tests.sh > $ST/logs/root-finality-r13-tests.out 2>&1; echo $? > $ST/logs/root-finality-r13-tests.rc
# RE-RUNS everything whose bytes changed (capture, both harnesses, tool, producer, forward_sync, reproof, readers, installer):
#   capture-r10 3, runtime-pin 10, tool 34, integration 17, reproof 17, ops-installer 18, parser-recovery 8, parser-first 8, forward-sync-r2 6,
#   capture-closure 14 (closure copy: r13 module + cold readers re-pinned), reanchor-recovery 25, r3-regression 28, r62-isolated 2,
#   forward-sync 8, the cold stage's own frozen reader job (transport + pinned A1 policy suites, on exactly the readers r13 pins); plus bundle assembly + FULL closure, all compositions,
#   identity vs r12-final, the pin cascade, reader-pin consistency, manifest closure.
# REUSED (byte-identical since r10, proven here): ops-readiness 27, sampler 93, recovery-existing 34, JS core 20. HISTORY: r12-final 0738 PASS
#   (superseded: its capture/harness/... bytes changed) and every earlier pinned failure. A pass is QUALIFICATION only; then the NEW cold
#   canary on these bytes (logs/claude-r13-canary-handoff.json); nothing is installed or activated.
'''
    t = head + 'set -uo pipefail\n' + body
    rep('ST=$B/r12-final; R12=$B/r12;', f'ST=$B/r13; R12F=$B/r12-final; COLD={cold}; R12=$B/r12;')
    rep('OUT=$ST/logs/root-finality-r12-final-', 'OUT=$ST/logs/root-finality-r13-tests-')
    rep('echo "## finality-r12-final rc=9"', 'echo "## finality-r13 rc=9"')
    rep('|| die "r12-final files differ from SHA256SUMS"', f'|| die "r13 files differ from SHA256SUMS"\npin $R12F/SHA256SUMS {R12F_SUMS}; (cd $R12F && sha256sum -c --quiet SHA256SUMS) || die "r12-final changed"\n'
        f'pin $COLD/SHA256SUMS {cold_sums}; (cd $COLD && sha256sum -c --quiet SHA256SUMS) || die "cold-proof stage changed"')
    rep('origin() { case "$1" in r12)', 'origin() { case "$1" in r12-final) echo "$R12F/$2";; r12)')
    rep('comp $R12 integration-r12; comp $ST integration-r12-final', 'comp $R12 integration-r12; comp $R12F integration-r12-final; comp $ST integration-r13')
    i = t.index("/usr/bin/python3 -I - $ST $R10 $R11 $R12 <<'PYD'"); j = t.index('PYD\n', t.index("<<'PYD'") + 10) + 4
    t = t[:i] + """/usr/bin/python3 -I - $ST $R12F <<'PYD' || die "r12-final identity"
import pathlib, sys
S, R = map(pathlib.Path, sys.argv[1:3]); rows = [l.split('\\t') for l in (S / 'COMPOSITION.tsv').read_text().splitlines()[1:]]
changed = {r[0] for r in rows if not (r[2] == 'copy' and r[3] == 'r12-final')}
bad = [r[0] for r in rows if r[0] not in changed and (S / r[0]).read_bytes() != (R / r[0]).read_bytes()]; assert not bad, bad
sums = {l.split(None, 1)[1].lstrip('*')[2:] for l in (R / 'SHA256SUMS').read_text().splitlines()}
assert not sums - {r[0] for r in rows} - {'jobs/root-finality-r12-final.sh', 'COMPOSITION.tsv', 'README.md'}
print('r13 = r12-final except', sorted(changed))
PYD
for d in readiness wrapper; do diff -rq $R10/$d $ST/$d > /dev/null || die "$d differs from r10 (reused receipts)"; done
for f in tests/test_ops_readiness.py src/finality-core.mjs; do cmp -s $R10/$f $ST/$f || die "$f differs from r10 (reused receipts)"; done
""" + t[j:]
    lines = t.split('\n'); keep = []
    for l in lines:
        if l.startswith('cmp -s $F2/src/reproof.py') or l.startswith('cmp -s $CF/tests/test_capture_r10.py'):
            continue
        if l.startswith('receipt ') and ('/r10-ops-followup-r2/' in l or '/r10-capture-fixture-fix/' in l or '/r10/logs/' in l):
            continue
        keep.append(l)
    t = '\n'.join(keep)
    pass_pin = hf(R12F_PASS[0])
    rep('echo "HISTORY r10 0702 rc 1,', f'pin {R12F_PASS[0]} {pass_pin}\necho "HISTORY r12-final 0738 PASS (superseded: changed bytes);')
    i = t.index('/usr/bin/python3 -I $ST/tools/assemble_bundle.py')
    t = t[:i] + """/usr/bin/python3 -I - $ST <<'PYR' || die "reader pin consistency"
import hashlib, json, pathlib, re, sys
S = pathlib.Path(sys.argv[1]); bo = json.loads((S / 'bundle-origin.json').read_text())['entries']; m = json.loads((S / 'install/MANIFEST.json').read_text())
rd, rr = bo['bundle/a1-capture/l1-anchor-a1/a1-read.mjs']['sha256'], bo['bundle/a1-capture/a1-original-game-prepared/a1-recheck-read.mjs']['sha256']
assert bo['bundle/a1-capture/a1-original-game-prepared/a1-read.mjs']['sha256'] == rd
for f in ('capture/a1_capture.py', 'harness/a2a4.py', 'harness-first/a2a4.py'):
    t = (S / f).read_text(); assert f"'a1-read.mjs': '{rd}'" in t and f"'a1-recheck-read.mjs': '{rr}'" in t, f
for k in bo:
    if k.endswith(('a1-read.mjs', 'a1-recheck-read.mjs')):
        assert [e['sha256'] for e in m['files'] if e['src'] == k] == [bo[k]['sha256']], k
assert re.search(r"'elUrl'|el_url", (S / 'capture/a1_capture.py').read_text()) and '18645' in (S / 'install/config-templates/l1-authority.json').read_text()
print('reader pins consistent:', rd[:12], rr[:12], '(capture, both harnesses, MANIFEST, bundle-origin); own EL 18645 template kept')
PYR
""" + t[i:]
    rep('for s in ops-installer:test_ops_installer.py:18:600; do', 'for s in capture-r10:test_capture_r10.py:3:1800 runtime-pin:test_runtime_pin.py:10:600 tool:test_finality_state.py:34:1200 integration:test_finality_integration.py:17:3000 reproof:test_reproof.py:17:3600 ops-installer:test_ops_installer.py:18:600; do')
    i = t.index('(cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp FORWARD_SYNC_SRC=$SC/recovery')
    t = t[:i] + """for v in recovery:harness first:harness-first; do IFS=: read -r name dir <<< "$v"
  (cd $SC && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp HARNESS=$SC/$dir/a2a4.py HARNESS_DEPS=$SC/$dir timeout 300 /usr/bin/python3 -I -B tests/parser/test_pinned_checkpoints.py -v < /dev/null) > $OUT/parser-$name.txt 2>&1; check parser-$name 8 $?; done
CL=$OUT/closure; tcopy $CC $CL; cp $ST/capture/a1_capture.py $CL/src/a1_capture.py || die "closure copy"
/usr/bin/python3 -I - $CL $ST <<'PYC' || die "closure re-pin"
import hashlib, json, pathlib, sys
C, S = map(pathlib.Path, sys.argv[1:3]); h = lambda p: hashlib.sha256(p.read_bytes()).hexdigest()
bo13 = json.loads((S / 'bundle-origin.json').read_text())['entries']; m = json.loads((C / 'install/MANIFEST.json').read_text()); n = 0
for e in m['files']:
    if e['src'] == 'a1_capture.py':
        e['sha256'] = h(C / 'src/a1_capture.py'); n += 1
    for d in ('l1-anchor-a1', 'a1-original-game-prepared'):
        k = f'bundle/a1-capture/{e["src"]}'
        if e['src'].startswith(d + '/') and e['src'].endswith(('a1-read.mjs', 'a1-recheck-read.mjs')) and k in bo13:
            e['sha256'] = bo13[k]['sha256']; n += 1
assert n == 4, n
(C / 'install/MANIFEST.json').write_text(json.dumps(m, indent=1) + '\\n')
cb = C / 'bundle-origin.json'; o = json.loads(cb.read_text()); k = 0
for rel, v in o.items():
    if rel.endswith(('a1-read.mjs', 'a1-recheck-read.mjs')) and f'bundle/a1-capture/{rel}' in bo13:
        new = bo13[f'bundle/a1-capture/{rel}']
        if isinstance(v, dict):
            v['origin'], v['sha256'] = new['origin'], new['sha256']
        else:
            o[rel] = new['origin']
        k += 1
assert k == 3, k
cb.write_text(json.dumps(o, indent=1) + '\\n'); print('closure copy re-pinned: r13 module + 3 cold readers (manifest + origins), nothing else')
PYC
(cd $CL && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp timeout 600 /usr/bin/python3 -I -B tests/test_capture_closure.py -v < /dev/null) > $OUT/capture-closure.txt 2>&1; check capture-closure 14 $?
""" + t[i:]
    rep('(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src', '(cd $C && "${RE[@]}" timeout 3600 /usr/bin/python3 -E -s -B -u tests/test_r3_launcher.py < /dev/null) > $OUT/r3-regression.txt 2>&1; check r3-regression 28 $?\n(cd $C && "${RE[@]}" FINALITY_SRC=$ST/src')
    i = t.index('(cd "$ST" && sha256sum -c --quiet SHA256SUMS) || fail "r12-final files CHANGED during the run"')
    t = t[:i] + f"""# cold-proof readers: the cold stage's OWN frozen job (pinned by its SHA256SUMS), verbatim; it overlays EXACTLY the reader bytes r13 pins
for k in l1-anchor-a1/a1-read.mjs a1-original-game-prepared/a1-read.mjs a1-original-game-prepared/a1-recheck-read.mjs; do
  cmp -s $COLD/src/$k $ST/bundle/a1-capture/$k || fail "r13 bundle reader $k is not the cold stage's tested byte"; done
bash $COLD/jobs/root-cold-proof-tests.sh > $OUT/cold-proof.txt 2>&1; r=$?
if [ $r = 0 ] && grep -q "^{ncold} .*stage-sums {cold_sums}$" $OUT/cold-proof.txt && grep -qx "{rcline}0" $OUT/cold-proof.txt; then echo "PASS cold-proof (cold stage job: $(grep '^{ncold}' $OUT/cold-proof.txt | cut -c1-120))"
else fail "cold-proof: rc $r (see $OUT/cold-proof.txt)"; fi
""" + t[i:]
    rep('|| fail "r12-final files CHANGED during the run"', '|| fail "r13 files CHANGED during the run"')
    rep('echo "## r12-final SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r12-final rc=$rc"', 'echo "## r13 SHA256SUMS $(sha256sum < $ST/SHA256SUMS | cut -c1-64)"; echo "## finality-r13 rc=$rc"')
    if 'r12-final rc' in t or 'finality-r12-final' in t.replace('root-finality-r12-final-0738', '').replace('jobs/root-finality-r12-final.sh', ''):
        refuse('job template still names r12-final qualification lines')
    return t


if __name__ == '__main__':
    import argparse
    ap = argparse.ArgumentParser(); ap.add_argument('cold'); g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--cold-only', action='store_true'); g.add_argument('--wiring'); ap.add_argument('--out'); ap.add_argument('--dry-run-unapproved', action='store_true')
    a = ap.parse_args()
    if a.wiring:
        refuse(f'--wiring {a.wiring}: the wiring stage format is not frozen/declared yet; this composer is extended only to its frozen COMPOSITION record (never guessed)')
    final = pathlib.Path(a.out).resolve() if a.out else B / 'r13'
    if a.dry_run_unapproved and not str(final).startswith('/tmp/'):
        refuse('--dry-run-unapproved writes only under /tmp')
    if final.exists():
        refuse(f'{final} exists (a frozen stage is never rewritten)')
    tmp = final.with_name(f'.{final.name}.partial-{os.getpid()}')
    try:
        rc = main([sys.argv[0], a.cold, str(tmp), a.dry_run_unapproved])
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True); raise
    if rc == 0:
        tmp.rename(final); print(f'renamed to {final}')
    sys.exit(rc)
