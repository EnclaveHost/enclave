#!/usr/bin/env python3
"""compose_r13.py v4 COLD_STAGE (--cold-only | --wiring WIRING --wiring-qualification Q.json) --wrapper WRAPPER --wrapper-qualification Q.json
  [--out DIR] [--dry-run-unapproved]   (workstation; PREPARED by 50cf; composes only). Supersedes ../v3 (kept frozen with its 0837 test failure log) and ../v2.
v4 = v3 + alias_nodes() factored out so the SAME code serves compose() and its regression tests (no behavior change).
v3: (1) QUALIFICATION IS EXTERNAL (root-supplied JSON, never inside the frozen input -> no self-hash cycle; INPUT-CONTRACT.md);
(2) the root-qualified wrapper-pruned-identity overlay is applied FIRST, then the wiring, then the cold readers LAST; every overlay
replaces only the CURRENT exact base (two overlays on one path refuse); cross-overlay BASE pins are propagated by the engine.
r13 = root-QUALIFIED r12-final + (optional) da0's root-QUALIFIED wiring overlay, applied FIRST, + the frozen root-PASSED cold-proof
readers, re-pinned LAST by a generic pin-graph engine:
  - every 64-hex reference from a non-record file to another tracked file (or to a reader) is DISCOVERED; the edges into the set of
    nodes that will change must EQUAL the declared spec (BASE_EDGES for r12-final, plus the wiring contract's pinEdges for files it
    adds/replaces). An undeclared edge (e.g. a helper silently pinning a harness) or a missing declared edge REFUSES;
  - changes propagate to a fixpoint (each changed file's old sha -> new sha in every pinning file, registries included); a cycle refuses;
  - registries (install/MANIFEST.json, bundle-origin.json) are then validated STRUCTURALLY (every non-bundle entry == its file);
  - nothing outside historical records may still name any superseded sha.
Wiring overlay rules (WIRING-INPUT-CONTRACT.md): exact base (replace only where r12-final's bytes equal the declared baseSha256; add
only absent paths), declared shas == bytes == the wiring SHA256SUMS, root qualification receipt bound to the wiring SHA256SUMS, no
stale pin (an overlay file naming the BASE sha of another replaced file), manifest/bundle-origin deltas by dest/key with exact bases,
no silent overwrite of an overlapping change. --dry-run-unapproved skips ONLY the cold/wiring qualification gates and writes only /tmp."""
import argparse, hashlib, io, json, os, pathlib, re, shlex, shutil, subprocess, sys, tarfile

HERE = pathlib.Path(__file__).resolve().parent; B = HERE.parents[1]; P = B.parent
R12F = B / 'r12-final'; R12F_SUMS = '9de0d8d7664516fac691f6cd8dc1d984c00e79ba175c406b6cda9ec97037bd7e'
R12F_PASS = (P / 'logs/root-finality-r12-final-0738.out', P / 'logs/root-finality-r12-final-0738.rc')
OLD = {'read': 'a501a3ec56ebd56e6bf1fc43c0c3725da57d013addac5f1efb13a99e598e0ab8', 'recheck': '41b83975e96fc816bd5743e56626dd309aa7f0ee03c6efb9912788eb184a7715'}
RNODE = {'read': 'READER:a1-read.mjs', 'recheck': 'READER:a1-recheck-read.mjs'}
READERS = {'bundle/a1-capture/l1-anchor-a1/a1-read.mjs': ('src/l1-anchor-a1/a1-read.mjs', 'read'),
           'bundle/a1-capture/a1-original-game-prepared/a1-read.mjs': ('src/a1-original-game-prepared/a1-read.mjs', 'read'),
           'bundle/a1-capture/a1-original-game-prepared/a1-recheck-read.mjs': ('src/a1-original-game-prepared/a1-recheck-read.mjs', 'recheck')}
WRAPPER = 'wrapper/chain_service.py'; WRAPPER_BASE = '4fc3b970e4ec062eeb66ef90c5bd1b14149a9bdcff135e7720708e7c544df8ae'
# discovered in r12-final (scan 2026-10-26): every edge INTO the nodes the cold readers or the wrapper overlay can change
BASE_EDGES = {'capture/a1_capture.py': {RNODE['read']: 2, RNODE['recheck']: 1},
              'harness/a2a4.py': {RNODE['read']: 1, RNODE['recheck']: 1, 'capture/a1_capture.py': 1},
              'harness-first/a2a4.py': {RNODE['read']: 1, RNODE['recheck']: 1},
              'src/finality_state.py': {'harness/a2a4.py': 1, WRAPPER: 1},
              'producer/base_launch.py': {'harness/a2a4.py': 1, 'harness-first/a2a4.py': 1, 'src/finality_state.py': 1, WRAPPER: 1},
              'recovery/forward_sync.py': {'harness/a2a4.py': 1, WRAPPER: 1},
              'src/reproof.py': {'src/finality_state.py': 1, 'producer/base_launch.py': 1}}
REGISTRIES = ('install/MANIFEST.json', 'bundle-origin.json')
RECORD_FILES = {'COMPOSITION.tsv', 'SHA256SUMS', 'CANARY-R3-RECIPE.md'}
DROP = {'logs', 'bundle', 'COMPOSITION.tsv', 'SHA256SUMS', 'README.md', 'jobs/root-finality-r12-final.sh'}
STRINGS = [('install/install_verified.py', "'## finality-r12-final rc=0' and '## r12-final SHA256SUMS <sha>'", "'## finality-r13 rc=0' and '## r13 SHA256SUMS <sha>'"),
           ('install/install_verified.py', "'## finality-r12-final rc=0' not in o or f'## r12-final SHA256SUMS {sums_sha}' not in o:   # r12-final: only its own run qualifies it",
            "'## finality-r13 rc=0' not in o or f'## r13 SHA256SUMS {sums_sha}' not in o:   # r13: only its own run qualifies it"),
           ('install/install_verified.py', '(rc 0, "## finality-r12-final rc=0", "## r12-final SHA256SUMS <this sha>")', '(rc 0, "## finality-r13 rc=0", "## r13 SHA256SUMS <this sha>")'),
           ('tests/test_ops_installer.py', "q.write_text('## finality-r12-final rc=0\\n## r12-final SHA256SUMS abc\\n')", "q.write_text('## finality-r13 rc=0\\n## r13 SHA256SUMS abc\\n')"),
           ('tests/test_ops_installer.py', "'## finality-r5 rc=0\\n## r12-final SHA256SUMS abc\\n'", "'## finality-r5 rc=0\\n## r13 SHA256SUMS abc\\n'"),
           ('tests/test_ops_installer.py', "'## finality-r12 rc=0\\n## r12 SHA256SUMS abc\\n'):   # r12-final: no earlier run qualifies it",
            "'## finality-r12 rc=0\\n## r12 SHA256SUMS abc\\n', '## finality-r12-final rc=0\\n## r12-final SHA256SUMS abc\\n'):   # r13: no earlier run qualifies it"),
           ('install/MISSING.md', '# r12-final: what genuinely awaits', '# r13: what genuinely awaits')]
FLAGS = (('src/finality_state.py', 'FINALITY_PROTOTYPE_REVIEWED = False'), ('producer/base_launch.py', 'FINALITY_PROOF_REVIEWED = False'),
         ('harness/a2a4.py', 'A1_CAPTURE_REVIEWED = False'), ('wrapper/chain_service.py', 'LAUNCH_PRODUCER_REVIEWED = False'), ('harness/a2a4.py', 'RETH_ENV_PASS = ()'))
HEX = re.compile(rb'[0-9a-f]{64}')
h = lambda b: hashlib.sha256(b).hexdigest(); hf = lambda p: h(pathlib.Path(p).read_bytes())


class Refused(SystemExit):
    pass


def refuse(m):
    raise Refused(f'REFUSED: {m}')


def is_record(rel):
    return rel in RECORD_FILES or rel.split('/')[0].startswith('integration')


def safe_rel(rel):
    p = pathlib.PurePosixPath(rel)
    if p.is_absolute() or '..' in p.parts or not rel or is_record(rel) or rel.split('/')[0] in ('logs', 'bundle') or rel in REGISTRIES:
        refuse(f'unsafe or reserved path {rel!r}')
    return rel


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


def tree(t):
    return {p.relative_to(t).as_posix(): p for p in sorted(t.rglob('*')) if p.is_file()}


# ---- the pin-graph engine (pure functions over a directory; unit-tested in tests/test_compose_engine.py) --------------------------
def discover(t, extra_nodes):
    """-> ({(file, node): count}, {sha: node}) over every non-record file; node = a tracked file path or an extra (reader) node"""
    files = tree(t); nodes = {h(p.read_bytes()): r for r, p in files.items() if not is_record(r)}; nodes.update(extra_nodes)
    edges = {}
    for r, p in files.items():
        if is_record(r):
            continue
        b = p.read_bytes()
        for s in set(HEX.findall(b)):
            n = nodes.get(s.decode())
            if n and n != r:
                edges[(r, n)] = edges.get((r, n), 0) + b.count(s)          # a node may be named by its base AND its overlay sha
    return edges, nodes


def closure(edges, seeds):
    """every node reachable BACKWARDS from the seed nodes (the files whose bytes will change), registries excluded"""
    out, frontier = set(seeds), set(seeds)
    while frontier:
        nxt = {f for (f, n) in edges if n in frontier and f not in out and f not in REGISTRIES}
        out |= nxt; frontier = nxt
    return out


def check_edges(edges, seeds, spec):
    """the discovered edges INTO the changing set must equal the declared spec exactly (registries are validated structurally)"""
    cl = closure(edges, seeds)
    got = {(f, n): c for (f, n), c in edges.items() if n in cl and f not in REGISTRIES}
    want = {(f, n): c for f, m in spec.items() for n, c in m.items() if n in cl}
    if got != want:
        extra = {k: v for k, v in got.items() if want.get(k) != v}; missing = {k: v for k, v in want.items() if got.get(k) != v}
        refuse(f'pin graph != declared spec: undeclared/changed {sorted(extra.items())[:6]}, missing {sorted(missing.items())[:6]}')
    return cl


def propagate(t, changed, limit=64):
    """old sha -> new sha in every non-record file until a fixpoint; -> the full {old: newest} map and per-file update counts"""
    changed = dict(changed); counts = {}
    for _ in range(limit):
        progress = False
        for r, p in tree(t).items():
            if is_record(r):
                continue
            b = p.read_bytes(); nb = b
            for o, n in changed.items():
                nb = nb.replace(o.encode(), n.encode())
            if nb != b:
                p.write_bytes(nb); counts[r] = counts.get(r, 0) + 1; progress = True
                if counts[r] > 16:
                    refuse(f'pin cycle through {r}')
                o2, n2 = h(b), h(nb)
                for k in [k for k, v in changed.items() if v == o2]:
                    changed[k] = n2
                changed[o2] = n2
        if not progress:
            return changed, counts
    refuse('pin propagation did not converge')


def residue(t, olds):
    for r, p in tree(t).items():
        if not is_record(r):
            b = p.read_bytes()
            for o in olds:
                if o.encode() in b:
                    refuse(f'superseded pin {o[:12]} remains in {r}')


# ---- external qualification (INPUT-CONTRACT.md 1): root-supplied, NOT in the frozen input ------------------------------------------
QKEYS = {'format', 'stage', 'stageSha256sums', 'receipts', 'binds'}
def load_qualification(qfile, stage, stage_sums, srcs):
    """binds a frozen input to root receipts. binds = 'stageSha256sums' (a receipt line contains the stage sums) or 'files' (a receipt
    holds `<sha>  <src>` for EVERY overlay src). Every receipt: exact sha + every declared exact line (+ optional rc file == '0')."""
    q = json.loads(pathlib.Path(qfile).read_text())
    if set(q) != QKEYS or q['format'] != 'enclave-r13-input-qualification/v1':
        refuse(f'{qfile}: not exactly {sorted(QKEYS)} (enclave-r13-input-qualification/v1)')
    if (P / q['stage']).resolve() != stage.resolve() or q['stageSha256sums'] != stage_sums:
        refuse(f'{qfile}: qualifies another stage or other SHA256SUMS ({q["stageSha256sums"][:12]} != {stage_sums[:12]})')
    texts = []
    for r in q['receipts']:
        rp = P / r['path']
        if not rp.is_file() or hf(rp) != r['sha256']:
            refuse(f'{qfile}: receipt {r["path"]} missing or not its declared sha')
        lines = rp.read_text(errors='replace').splitlines()
        miss = [l for l in r['lines'] if l not in lines]
        if not r['lines'] or miss:
            refuse(f'{qfile}: receipt {r["path"]} lacks the declared exact lines {miss[:3]}')
        if 'rc' in r and ((P / r['rc']).read_text().strip() != '0'):
            refuse(f'{qfile}: receipt rc {r["rc"]} is not 0')
        texts.append(lines)
    if q['binds'] == 'stageSha256sums':
        ok = any(stage_sums in l for ls in texts for l in ls)
    elif q['binds'] == 'files':
        ok = all(any(l == f'{s}  {src}' for ls in texts for l in ls) for src, s in srcs.items())
    else:
        ok = False
    if not ok:
        refuse(f'{qfile}: no receipt binds this exact input ({q["binds"]})')
    return q


# ---- the wiring overlay (contract: INPUT-CONTRACT.md 2) -------------------------------------------------------------------------
def load_wiring(wdir, dry):
    wsums, listed = verify_sums(wdir)
    cf = 'COMPOSITION-INPUT.json'
    if cf not in listed:
        refuse(f'{wdir} has no frozen {cf} (the declared wiring input)')
    c = json.loads((wdir / cf).read_text())
    if c.get('format') != 'enclave-r13-wiring-input/v1' or c.get('base') != {'stage': 'base-finality-proof-stage/r12-final', 'sha256sums': R12F_SUMS}:
        refuse('wiring input: wrong format or not based on the qualified r12-final')
    if 'qualification' in c:
        refuse('wiring input embeds qualification: it must be EXTERNAL (--wiring-qualification), never self-derived inside the frozen input')
    paths = set()
    for e in c.get('files', []):
        rel = safe_rel(e['path'])
        if rel in paths:
            refuse(f'wiring input names {rel} twice')
        paths.add(rel)
        if listed.get(e['src']) != e['sha256']:
            refuse(f'wiring {e["src"]}: declared sha is not its frozen byte')
        base = R12F / rel
        if e['action'] == 'replace':
            if not base.is_file() or hf(base) != e.get('baseSha256'):
                refuse(f'wiring replace {rel}: r12-final bytes are not the declared base (overlapping change)')
        elif e['action'] == 'add':
            if base.exists():
                refuse(f'wiring add {rel}: exists in r12-final (would overwrite)')
        else:
            refuse(f'wiring action {e["action"]!r}')
    for f, m in (c.get('pinEdges') or {}).items():
        if f not in paths:
            refuse(f'wiring pinEdges names {f}, which the overlay neither adds nor replaces')
    return c, wsums


def apply_wiring(out, wdir, c):
    based = {e['baseSha256']: e['path'] for e in c['files'] if e['action'] == 'replace'}
    for e in c['files']:                                                     # the CURRENT tree (after earlier overlays) must hold the exact base
        d = out / e['path']
        if e['action'] == 'replace' and (not d.is_file() or hf(d) != e['baseSha256']):
            refuse(f'overlay replace {e["path"]}: the current tree is not its declared base (an earlier overlay changed it: overlap)')
        if e['action'] == 'add' and d.exists():
            refuse(f'overlay add {e["path"]}: exists in the current tree (overlap)')
    for e in c['files']:
        d = out / e['path']; d.parent.mkdir(parents=True, exist_ok=True); shutil.copyfile(wdir / e['src'], d)
        os.chmod(d, os.stat(wdir / e['src']).st_mode & 0o755 | 0o644)
    for e in c['files']:                                                     # no overlay file may still name a replaced file's BASE sha
        b = (out / e['path']).read_bytes()
        for s, rel in based.items():
            if s.encode() in b:
                refuse(f'stale pin: wiring {e["path"]} names the r12-final sha of replaced {rel}')
    m = json.loads((out / 'install/MANIFEST.json').read_text()); dests = {x['dest'] for x in m['files']} | {x['dest'] for x in m['trees']}
    md = c.get('manifest') or {}
    for x in md.get('replace', []):
        hit = [i for i, y in enumerate(m['files']) if y['dest'] == x['entry']['dest']]
        if len(hit) != 1 or m['files'][hit[0]]['sha256'] != x['baseSha256']:
            refuse(f'manifest replace {x["entry"]["dest"]}: base entry is not the declared one')
        m['files'][hit[0]] = x['entry']
    for x in md.get('add', []):
        if x['dest'] in dests:
            refuse(f'manifest add {x["dest"]}: destination exists (would overwrite)')
        dests.add(x['dest']); m['files'].append(x)
    for x in md.get('addTrees', []):
        if x['dest'] in dests:
            refuse(f'manifest addTree {x["dest"]}: destination exists')
        dests.add(x['dest']); m['trees'].append(x)
    (out / 'install/MANIFEST.json').write_text(json.dumps(m, indent=1) + '\n')
    bo = json.loads((out / 'bundle-origin.json').read_text())
    for k, v in ((c.get('bundleOrigin') or {}).get('add') or {}).items():
        if k in bo['entries'] or not k.startswith('bundle/'):
            refuse(f'bundle-origin add {k}: exists or not a bundle path')
        if 'sha256' in v and hf(v['origin']) != v['sha256']:
            refuse(f'bundle-origin add {k}: origin is not the declared sha')
        bo['entries'][k] = v
    (out / 'bundle-origin.json').write_text(json.dumps(bo, indent=1) + '\n')
    for t, x, _ in STRINGS:                  # a wiring may harden the installer/its tests, but every r13-owned anchor must survive exactly once
        if any(e['path'] == t for e in c['files']) and (out / t).read_text().count(x) != 1:
            refuse(f'wiring replaces {t} without the exact r12-final qualification anchor {x[:50]!r} (r13 owns those strings)')
    return {e['baseSha256']: e['sha256'] for e in c['files'] if e['action'] == 'replace'}


def wrapper_contract(wrap):
    """wrapper-pruned-identity-stage (frozen; its README composition table): wrapper/chain_service.py 4fc3b970 -> overlay, plus its
    test-only file. Bytes = the stage SHA256SUMS; pins nothing in the changing set (the engine refuses otherwise)."""
    sums, listed = verify_sums(wrap)
    srcs = {'overlay/wrapper/chain_service.py': None, 'overlay/wrapper/test_l1_pruned_identity.py': None}
    for s in srcs:
        if s not in listed:
            refuse(f'wrapper stage SHA256SUMS does not list {s}')
        srcs[s] = listed[s]
    if listed.get('orig/chain_service.py') != WRAPPER_BASE:
        refuse('wrapper stage was not made against the r12-final wrapper 4fc3b970')
    c = {'files': [{'path': WRAPPER, 'src': 'overlay/wrapper/chain_service.py', 'action': 'replace', 'baseSha256': WRAPPER_BASE, 'sha256': srcs['overlay/wrapper/chain_service.py']},
                   {'path': 'wrapper/test_l1_pruned_identity.py', 'src': 'overlay/wrapper/test_l1_pruned_identity.py', 'action': 'add', 'sha256': srcs['overlay/wrapper/test_l1_pruned_identity.py']}],
         'pinEdges': {WRAPPER: {}}}
    return c, sums, srcs


def alias_nodes(contracts):
    """a file an overlay REPLACES is still named, by any file staged against the base, with its BASE sha: map that sha to the file
    (cross-overlay pins are then discovered as edges to that file, checked against the spec, and re-pinned by propagation)"""
    out = {}
    for c_ in contracts:
        for e in (c_ or {}).get('files', []):
            if e['action'] == 'replace':
                if out.get(e['baseSha256'], e['path']) != e['path']:
                    refuse(f'base sha {e["baseSha256"][:12]} aliased to two paths')
                out[e['baseSha256']] = e['path']
    return out


SUITE_KEYS = {'name', 'where', 'argv', 'env', 'timeout', 'kind', 'ran'}
def suite_lines(suites):
    out = []
    for s in suites:
        if set(s) != SUITE_KEYS or s['where'] not in ('stage', 'recovery') or s['kind'] != 'unittest' or type(s['ran']) is not int or not re.fullmatch(r'[a-z0-9-]+', s['name']):
            refuse(f'wiring suite {s.get("name")!r}: not {sorted(SUITE_KEYS)} (unittest, stage|recovery)')
        for a in list(s['argv']) + list(s['env'].values()) + list(s['env']):
            if not re.fullmatch(r'[A-Za-z0-9_./{}=:-]+', str(a)):
                refuse(f'wiring suite {s["name"]}: unsafe token {a!r}')
        sub = lambda x: str(x).replace('{SC}', '$SC').replace('{C}', '$C').replace('{OUT}', '$OUT').replace('{NODE}', '$NODE').replace('{DEPS}', '$DEPS').replace('{WK}', '$WK').replace('{FAKE}', '$FAKE')
        env = ' '.join(f'{k}={sub(v)}' for k, v in sorted(s['env'].items()))
        out.append(f'(cd ${"SC" if s["where"] == "stage" else "C"} && env -i PATH=/usr/bin:/bin TMPDIR=$OUT/tmp HOME=$OUT/tmp {env} timeout {int(s["timeout"])} '
                   f'{" ".join(sub(a) for a in s["argv"])} < /dev/null) > $OUT/{s["name"]}.txt 2>&1; check {s["name"]} {s["ran"]} $?\n')
    return ''.join(out)


def compose(cold, out, wdir, dry, wq=None, wrap=None, wrapq=None):
    sums12, _ = verify_sums(R12F)
    if sums12 != R12F_SUMS:
        refuse('r12-final is not the qualified 9de0d8d7...')
    if R12F_PASS[1].read_text().strip() != '0' or '## finality-r12-final rc=0' not in R12F_PASS[0].read_text():
        refuse('no r12-final qualification PASS receipt')
    cold_sums, listed = verify_sums(cold)
    for src, _k in READERS.values():
        if src not in listed:
            refuse(f'cold stage SHA256SUMS does not list {src}')
    passes = [p for p in (cold / 'logs').rglob('RESULT') if p.is_file() and any(l.startswith('PASS cold-proof-tests') and l.rstrip().endswith(f'stage-sums {cold_sums}')
                                                                                for l in p.read_text(errors='replace').splitlines())]
    if not passes and not dry:
        refuse(f'no root ACTUAL PASS of the cold stage job for its SHA256SUMS {cold_sums[:12]}...')
    new = {'read': hf(cold / 'src/l1-anchor-a1/a1-read.mjs'), 'recheck': hf(cold / 'src/a1-original-game-prepared/a1-recheck-read.mjs')}
    if hf(cold / 'src/a1-original-game-prepared/a1-read.mjs') != new['read'] or set(new.values()) & set(OLD.values()):
        refuse('cold readers: a1-read copies differ, or a reader equals the old one')
    wc = wsums = None
    if wdir:
        wc, wsums = load_wiring(wdir, dry)
        if wq:
            load_qualification(wq, wdir, wsums, {e['src']: e['sha256'] for e in wc['files']})
        elif not dry:
            refuse('--wiring needs --wiring-qualification (root-supplied, external)')
    if not wrap and not dry:
        refuse('--wrapper is required: r13 must not be frozen without the root-qualified pruned-identity wrapper (ROOT-INTEGRATION-0825)')
    rc_ = rsums = None
    if wrap:
        rc_, rsums, rsrcs = wrapper_contract(wrap)
        if wrapq:
            load_qualification(wrapq, wrap, rsums, rsrcs)
        elif not dry:
            refuse('--wrapper needs --wrapper-qualification (root-supplied, external)')
    # 1. copy r12-final
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
    # 2. the wiring overlay FIRST (exact bases; then its replaced files' base shas are seeds for the registries)
    spec = {f: dict(m) for f, m in BASE_EDGES.items()}; seeds_map = {}; wfiles = {}; rfiles = {}
    if rc_:                                                                   # 2a. the wrapper overlay FIRST
        seeds_map.update(apply_wiring(out, wrap, rc_)); rfiles = {e['path']: e['src'] for e in rc_['files']}; spec.update(rc_['pinEdges'])
    if wc:
        for f, m in (wc.get('pinEdges') or {}).items():
            lost = {n: c for n, c in BASE_EDGES.get(f, {}).items() if m.get(n) != c}
            if lost:                                                          # a reviewed base pin may not silently disappear or change count
                refuse(f'wiring pinEdges[{f}] drops/changes reviewed base pins {lost}')
            spec[f] = dict(m)                                                 # the wiring declares the COMPLETE edge set of each file it ships
        seeds_map.update(apply_wiring(out, wdir, wc)); wfiles = {e['path']: e['src'] for e in wc['files']}
    pre = {r: hf(p) for r, p in tree(out).items()}
    # 3. discover + check the pin graph, then propagate readers (+ wiring bases) to a fixpoint
    extra = {OLD['read']: RNODE['read'], OLD['recheck']: RNODE['recheck'], **alias_nodes((rc_, wc))}
    edges, nodes = discover(out, extra)
    seed_nodes = {RNODE['read'], RNODE['recheck']} | {nodes[n] for n in seeds_map.values() if n in nodes}
    cl = check_edges(edges, seed_nodes, spec)
    bo = json.loads((out / 'bundle-origin.json').read_text())['entries']; t = (out / 'bundle-origin.json').read_text()
    for k, (src, kind) in READERS.items():
        a, b = json.dumps(bo[k]['origin']), json.dumps(str(cold / src))
        if t.count(a) != 1:
            refuse(f'bundle-origin reader origin {k} not unique')
        t = t.replace(a, b)
    (out / 'bundle-origin.json').write_text(t)
    changed, counts = propagate(out, {OLD['read']: new['read'], OLD['recheck']: new['recheck'], **seeds_map})
    # 4. r13 strings + docs
    for f, a, b in STRINGS:
        x = (out / f).read_text()
        if x.count(a) != 1:
            refuse(f'{f}: expected 1x {a[:60]!r}')
        (out / f).write_text(x.replace(a, b))
    cap = hf(out / 'capture/a1_capture.py')
    (out / 'CANARY-R3-RECIPE.md').write_text((out / 'CANARY-R3-RECIPE.md').read_text().rstrip('\n') + f'\n\n**r13 (HISTORICAL above):** canary r3 used r10/r12-final bytes. r13 changes the A1 readers{" and the bootstrap wiring" if wc else ""}, hence capture `{cap[:12]}` and the pin cascade: the NEW canary must run on r13 bytes (logs/claude-r13-canary-handoff.json) after root\'s r13 qualification passes.\n')
    # 5. invariants
    finals = set(changed.values()); residue(out, [o for o, n in changed.items() if o != n and o not in finals])   # every superseded sha, incl. intermediates
    m = json.loads((out / 'install/MANIFEST.json').read_text())
    for e in m['files']:
        if not e['src'].startswith('bundle/') and (not (out / e['src']).is_file() or hf(out / e['src']) != e['sha256']):
            refuse(f'manifest {e["src"]} != its file')
    bo = json.loads((out / 'bundle-origin.json').read_text())['entries']
    for k, (src, kind) in READERS.items():
        if [e['sha256'] for e in m['files'] if e['src'] == k] != [new[kind]] or bo[k]['sha256'] != new[kind] or bo[k]['origin'] != str(cold / src):
            refuse(f'reader {k} not re-pinned')
    for e in m['files']:
        if e['src'].startswith('bundle/') and e['src'] not in bo:
            refuse(f'manifest bundle entry {e["src"]} has no bundle origin')
    for f, flag in FLAGS:
        if not re.search(r'^' + re.escape(flag), (out / f).read_text(), re.M):
            refuse(f'{f}: {flag} is not the source line (review flags stay False)')
    if not any(c.get('config') and '18645' in (out / c['src']).read_text() for c in m['files'] if c['src'].endswith('l1-authority.json')):
        refuse('the own-EL 127.0.0.1:18645 l1-authority template is gone')
    # 6. trace: patches, README, job, COMPOSITION, SHA256SUMS
    (out / 'integration-r13').mkdir(); rows = []; edited = []
    final = tree(out)
    for rel in sorted(final):
        p = final[rel]
        if rel in wfiles:
            org, src, base = 'wiring', wfiles[rel], wdir / wfiles[rel]
        elif rel in rfiles:
            org, src, base = 'wrapper', rfiles[rel], wrap / rfiles[rel]
        elif (R12F / rel).is_file():
            org, src, base = 'r12-final', rel, R12F / rel
        else:
            org, src, base = None, None, None
        if base is not None and base.read_bytes() == p.read_bytes():
            rows.append((rel, hf(p), 'copy', org, src, '-'))
        elif base is not None:
            d = subprocess.run(['diff', '-u', str(base), str(p)], capture_output=True, text=True).stdout
            name = rel.replace('/', '_') + '-r13'; (out / 'integration-r13' / f'{name}.patch').write_text(d); edited.append(rel)
            rows.append((rel, hf(p), 'edit', org, src, name))
        else:
            refuse(f'{rel}: no origin (neither wiring nor r12-final)')
    hr, hfst, fs, pr = (hf(out / f) for f in ('harness/a2a4.py', 'harness-first/a2a4.py', 'src/finality_state.py', 'producer/base_launch.py'))
    (out / 'README.md').write_text(f"""# base-finality-proof-stage/r13: THE final production composition (PREPARED; qualification PENDING; NOT installed; NOT activated)

= root-qualified r12-final ({R12F_SUMS[:12]}..., 0738 PASS){f" + da0 wiring {wdir.relative_to(P)} (SHA256SUMS {wsums[:12]}..., applied FIRST)" if wc else " (cold-only: NOT production-complete)"}
+ the frozen root-PASSED cold readers {pathlib.Path(os.path.relpath(cold, P))} ({cold_sums[:12]}...), re-pinned LAST by the pin-graph engine
(capture {cap[:12]}, harness {hr[:12]}, first harness {hfst[:12]}, tool {fs[:12]}, producer {pr[:12]}). Trace: COMPOSITION.tsv +
integration-r13/*.patch (composer r13-compose/v4/compose_r13.py). ONE root job: jobs/root-finality-r13-tests.sh. Policy, own EL 18645,
runtime dirs, reproof retention and activation mechanism unchanged.
""")
    job = make_job(out, cold, cold_sums, wdir, wsums, (wc or {}).get('suites', ()), wrap, rsums)
    (out / 'jobs').mkdir(exist_ok=True); (out / 'jobs/root-finality-r13-tests.sh').write_text(job); os.chmod(out / 'jobs/root-finality-r13-tests.sh', 0o755)
    for rel in ('README.md', 'jobs/root-finality-r13-tests.sh') + tuple(sorted(r.relative_to(out).as_posix() for r in (out / 'integration-r13').iterdir())):
        rows.append((rel, hf(out / rel), 'new', 'r13', '-', '-'))
    (out / 'COMPOSITION.tsv').write_text('path\tsha256\tkind\torigin\tsrc\tpatch\n' + ''.join('\t'.join(r) + '\n' for r in sorted(rows)))
    lines = [f'{hf(p)}  ./{r}' for r, p in sorted(tree(out).items(), key=lambda x: x[0].encode()) if r != 'SHA256SUMS']
    (out / 'SHA256SUMS').write_text('\n'.join(lines) + '\n')
    core = [e['sha256'] for e in m['files'] if e['dest'] == '/opt/enclave-rpc/finality/src/finality-core.mjs']
    handoff = {'note': "r13 canary handoff (50cf): VALID ONLY after root's r13 job prints ## finality-r13 rc=0 with ## r13 SHA256SUMS == stageSha256sums. Activates nothing.",
               'stage': os.path.relpath(out, P), 'stageSha256sums': hf(out / 'SHA256SUMS'), 'manifest': hf(out / 'install/MANIFEST.json'),
               'bundleOrigin': hf(out / 'bundle-origin.json'), 'captureModule': cap, 'finalityState': fs, 'finalityCore': core[0] if len(core) == 1 else None,
               'a1Read': new['read'], 'a1RecheckRead': new['recheck'], 'coldStage': os.path.relpath(cold, P), 'coldStageSha256sums': cold_sums,
               'wiringStage': os.path.relpath(wdir, P) if wdir else None, 'wiringSha256sums': wsums,
               'wrapperStage': os.path.relpath(wrap, P) if wrap else None, 'wrapperSha256sums': rsums, 'wrapper': hf(out / WRAPPER), 'harness': hr, 'harnessFirst': hfst, 'producer': pr,
               'forwardSync': hf(out / 'recovery/forward_sync.py'), 'reproof': hf(out / 'src/reproof.py'), 'productionComplete': bool(wc and rc_), 'dryRunUnapproved': dry,
               'pinUpdates': {r: n for r, n in sorted(counts.items())}, 'closure': sorted(cl)}
    if not dry:
        (P / 'logs/claude-r13-canary-handoff.json').write_text(json.dumps(handoff, indent=1) + '\n')
    return handoff


WRAP_JOB = """# pruned-identity wrapper: r13 holds EXACTLY the qualified overlay byte; its stage's OWN frozen jobs.sh reruns on a private copy
cmp -s $WRAP/overlay/wrapper/chain_service.py $ST/wrapper/chain_service.py || fail "r13 wrapper is not the qualified overlay byte"
WC=$OUT/wrapper-stage; tcopy $WRAP $WC; mkdir -p $WC/tmp
(cd $WC && env -i PATH=/usr/bin:/bin bash ./jobs.sh < /dev/null) > $OUT/wrapper-pruned.txt 2>&1; r=$?
if [ $r = 0 ] && grep -qx "rc=0" $OUT/wrapper-pruned.txt && grep -qx "BASELINE REPRODUCES BLOCKER" $OUT/wrapper-pruned.txt && grep -q "^Ran 49 tests in " $OUT/wrapper-pruned.txt \\
   && grep -qx "$(sha256sum < $ST/wrapper/chain_service.py | cut -c1-64)  overlay/wrapper/chain_service.py" $OUT/wrapper-pruned.txt; then echo "PASS wrapper-pruned (49 + baseline blocker + mutants, on the r13 wrapper byte)"
else fail "wrapper-pruned: rc $r (see $OUT/wrapper-pruned.txt)"; fi
"""


def make_job(out, cold, cold_sums, wiring=None, wsums=None, suites=(), wrap=None, rsums=None):
    t = (R12F / 'jobs/root-finality-r12-final.sh').read_text()
    cj = (cold / 'jobs/root-cold-proof-tests.sh').read_text()
    m = re.search(r'echo "(PASS cold-proof-tests[^"$]*?) ', cj); rcl = re.search(r'echo "(## cold-proof-tests[^"$]*?rc=)\$rc"', cj)
    if not m or not rcl or f'S=$P/{pathlib.Path(os.path.relpath(cold, P))};' not in cj:
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
# ({pathlib.Path(os.path.relpath(cold, P))}, SHA256SUMS {cold_sums[:12]}...) with the full pin cascade. ONE queued job (PREPARED; NOT run by Claude):
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
    rep('ST=$B/r12-final; R12=$B/r12;', f'ST=$B/r13; R12F=$B/r12-final; COLD={cold}; WIRE={wiring or ""}; WRAP={wrap or ""}; R12=$B/r12;')
    rep('OUT=$ST/logs/root-finality-r12-final-', 'OUT=$ST/logs/root-finality-r13-tests-')
    rep('echo "## finality-r12-final rc=9"', 'echo "## finality-r13 rc=9"')
    rep('|| die "r12-final files differ from SHA256SUMS"', f'|| die "r13 files differ from SHA256SUMS"\npin $R12F/SHA256SUMS {R12F_SUMS}; (cd $R12F && sha256sum -c --quiet SHA256SUMS) || die "r12-final changed"\n'
        f'pin $COLD/SHA256SUMS {cold_sums}; (cd $COLD && sha256sum -c --quiet SHA256SUMS) || die "cold-proof stage changed"'
        + (f'\npin $WIRE/SHA256SUMS {wsums}; (cd $WIRE && sha256sum -c --quiet SHA256SUMS) || die "wiring stage changed"' if wiring else '')
        + (f'\npin $WRAP/SHA256SUMS {rsums}; (cd $WRAP && sha256sum -c --quiet SHA256SUMS) || die "wrapper stage changed"' if wrap else ''))
    rep('origin() { case "$1" in r12)', 'origin() { case "$1" in wiring) echo "$WIRE/$3";; wrapper) echo "$WRAP/$3";; r12-final) echo "$R12F/$2";; r12)')
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
    t = t[:i] + suite_lines(suites) + (WRAP_JOB if wrap else '') + f"""# cold-proof readers: the cold stage's OWN frozen job (pinned by its SHA256SUMS), verbatim; it overlays EXACTLY the reader bytes r13 pins
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


def main(argv=None):
    ap = argparse.ArgumentParser(); ap.add_argument('cold'); g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--cold-only', action='store_true'); g.add_argument('--wiring'); ap.add_argument('--wiring-qualification')
    ap.add_argument('--wrapper'); ap.add_argument('--wrapper-qualification'); ap.add_argument('--out'); ap.add_argument('--dry-run-unapproved', action='store_true')
    a = ap.parse_args(argv)
    final = pathlib.Path(a.out).resolve() if a.out else B / 'r13'
    if a.dry_run_unapproved and not str(final).startswith('/tmp/'):
        refuse('--dry-run-unapproved writes only under /tmp')
    if final.exists():
        refuse(f'{final} exists (a frozen stage is never rewritten)')
    tmp = final.with_name(f'.{final.name}.partial-{os.getpid()}')
    try:
        hd = compose(pathlib.Path(a.cold).resolve(), tmp, pathlib.Path(a.wiring).resolve() if a.wiring else None, a.dry_run_unapproved,
                     a.wiring_qualification, pathlib.Path(a.wrapper).resolve() if a.wrapper else None, a.wrapper_qualification)
    except BaseException:
        shutil.rmtree(tmp, ignore_errors=True); raise
    tmp.rename(final); print(json.dumps({'ok': True, 'r13': str(final), 'handoff': hd}, indent=1)); return 0

if __name__ == '__main__':
    sys.exit(main())
