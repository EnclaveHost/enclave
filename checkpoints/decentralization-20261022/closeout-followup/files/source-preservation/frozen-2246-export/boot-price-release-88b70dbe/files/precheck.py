"""PRE-BUILD checks for the boot-price release (read-only; no build). Prepared 2026-10-23; root runs it via build-price.sh.
   python3 precheck.py <H repo> <APPROVED-COMMIT.txt> <patch out>   -> prints one JSON line {commit, delta, gsup, tests, patch...}
APPROVED-COMMIT.txt, written by ROOT after reviewing the commit, is exactly three lines:
   commit <40 hex>
   gsup REVIEWED | gsup UNCHANGED        (REVIEWED only if root reviewed a metal/guest/gsup.mjs change in this commit)
   tests <space-separated test/ paths>   (the exact test files the commit adds or changes; NONE for none)
Refuses unless: the commit is a SINGLE-parent child of 9f6d37bd; its delta is EXACTLY supervisor.js + the named tests (+ gsup.mjs
iff REVIEWED, and then gsup must actually change); the builder file is unchanged; the source patch (parent-anchored, never the
whole tree) carries no rewritten provider literal (full context, else zero context; refuses if a changed line carries it)."""
import json, re, subprocess, sys, tempfile
from pathlib import Path
PARENT = '9f6d37bd858ad44be1171b6415353910214c2fa5'
GSUP, SUP, BUILDER = 'metal/guest/gsup.mjs', 'supervisor.js', 'metal/overlay-control-image.py'
OLD = bytes.fromhex('54696e666f696c')

class Refused(Exception): pass

def git(repo, *a):
    return subprocess.run(['git', '-C', str(repo), *a], capture_output=True, check=True, timeout=120,
                          env={'GIT_OPTIONAL_LOCKS': '0', 'PATH': '/usr/bin:/bin'}).stdout

def parse_approval(text):
    lines = text.splitlines()
    if len(lines) != 3 or not text.endswith('\n'): raise Refused('APPROVED-COMMIT.txt must be exactly three lines: commit / gsup / tests')
    m = re.fullmatch(r'commit ([0-9a-f]{40})', lines[0])
    if not m: raise Refused('line 1 must be "commit <40 hex>"')
    g = re.fullmatch(r'gsup (REVIEWED|UNCHANGED)', lines[1])
    if not g: raise Refused('line 2 must be "gsup REVIEWED" or "gsup UNCHANGED"')
    t = re.fullmatch(r'tests (NONE|test/[A-Za-z0-9._/-]+(?: test/[A-Za-z0-9._/-]+)*)', lines[2])
    if not t: raise Refused('line 3 must be "tests NONE" or "tests test/<path> ..."')
    tests = [] if t.group(1) == 'NONE' else t.group(1).split(' ')
    if len(set(tests)) != len(tests) or any('..' in p for p in tests): raise Refused('duplicate or relative test paths')
    return m.group(1), g.group(1) == 'REVIEWED', sorted(tests)

def has_old(b): return OLD in b or OLD.lower() in b

def format_patch(repo, commit, *extra):
    """git format-patch PARENT..commit with hunk-header function context OFF (git would otherwise copy an arbitrary nearby source
    line into every '@@ ... @@' header, which can be the very line the patch must not carry)."""
    with tempfile.NamedTemporaryFile('w', suffix='.gitattributes') as attrs:
        attrs.write('* diff=nofunc\n'); attrs.flush()
        return git(repo, '-c', f'core.attributesFile={attrs.name}', '-c', 'diff.nofunc.xfuncname=^NOFUNC-NEVER-MATCHES$',
                   'format-patch', '--stdout', '--no-renames', *extra, f'{PARENT}..{commit}')

def check(repo, approval_text):
    commit, gsup, tests = parse_approval(approval_text)
    try: kind = git(repo, 'cat-file', '-t', commit).decode().strip()
    except subprocess.CalledProcessError: raise Refused(f'{commit} is not in H\'s repo')
    if kind != 'commit': raise Refused(f'{commit} is not a commit')
    parents = git(repo, 'rev-list', '--parents', '-n', '1', commit).decode().split()[1:]
    if parents != [PARENT]: raise Refused(f'{commit} parents {[p[:9] for p in parents]} are not exactly 9f6d37bd')
    delta = sorted(git(repo, 'diff', '--no-renames', '--name-only', PARENT, commit).decode().split())
    want = sorted([SUP] + tests + ([GSUP] if gsup else []))
    if delta != want: raise Refused(f'delta {delta} is not exactly {want}')
    if git(repo, 'show', f'{PARENT}:{BUILDER}') != git(repo, 'show', f'{commit}:{BUILDER}'): raise Refused('the builder changed')
    diff = git(repo, 'diff', '--no-renames', PARENT, commit, '--', SUP, *([GSUP] if gsup else []))
    if any(has_old(l) for l in diff.splitlines() if l[:1] in (b'+', b'-') and not l.startswith((b'+++', b'---'))):
        raise Refused('a changed line carries the rewritten provider literal: root review')
    patch = format_patch(repo, commit)
    form = 'full context'
    if has_old(patch):
        patch = format_patch(repo, commit, '-U0'); form = 'zero context (apply with --unidiff-zero)'
        if has_old(patch): raise Refused('the source patch carries the rewritten provider literal even at zero context')
    return {'commit': commit, 'parent': PARENT, 'gsupReviewed': gsup, 'tests': tests, 'delta': delta,
            'imageFiles': sorted(['/app/supervisor.js'] + (['/opt/metal/gsup.mjs'] if gsup else []))}, patch, form

if __name__ == '__main__':
    try:
        rec, patch, form = check(Path(sys.argv[1]), Path(sys.argv[2]).read_text())
    except Refused as e: print('REFUSED:', e); sys.exit(2)
    out = Path(sys.argv[3]); out.write_bytes(patch)
    import hashlib; rec.update(patch={'file': out.name, 'form': form, 'sha256': hashlib.sha256(patch).hexdigest()})
    print('PRECHECK-PASS ' + json.dumps(rec, sort_keys=True))
