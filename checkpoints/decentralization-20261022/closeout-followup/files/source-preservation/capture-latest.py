"""Preserve authored closeout sources; never copy live run directories or secrets."""
from pathlib import Path
import datetime
import hashlib
import json
import subprocess

root = Path(__file__).resolve().parents[3]
base = root / 'work/resume-after-checkpoint-20261022'
repo = root / 'work/source-checkpoint-20261022/main-repo'
dest = repo / 'checkpoints/decentralization-20261022/closeout-followup'
prior = repo / 'checkpoints/decentralization-20261022/closeout-drafts/files'
# The renewal mutation harness keeps its originals only in memory. Do not copy
# temporarily weakened runtime files into a recovery checkpoint while it runs.
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        argv = (proc / 'cmdline').read_bytes().split(b'\0')
        if argv and Path(argv[0].decode()).name.startswith('python') and any(b'mutants-renew.py' in arg for arg in argv[1:]):
            raise SystemExit('NOT CAPTURED: renewal mutation harness is active; wait for its restore and verified completion')
    except (OSError, UnicodeError):
        continue
paths = set()
for directory in ('controller-bounds-validation', 'postgres-init-stage', 'production-final'):
    for p in (base / directory).rglob('*'):
        rel = p.relative_to(base / directory)
        if any(x in ('logs', 'runs', '__pycache__', 'secrets') for x in rel.parts):
            continue
        if p.is_file() and not p.is_symlink() and not p.name.startswith('logs-') and p.suffix not in ('.out', '.log'):
            paths.add(p)
for p in (base / 'production-run').rglob('*'):
    if any(x in ('runs', 'secrets', '__pycache__') for x in p.relative_to(base / 'production-run').parts):
        continue
    if p.is_file() and not p.is_symlink() and p.suffix in ('.py', '.sh'):
        paths.add(p)
for directory in ('src', 'tools', 'base', 'patches'):
    for p in (base / 'measured-composition' / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts:
            paths.add(p)
for p in (base / 'measured-composition').glob('*.json'):
    paths.add(p)
for directory in ('measured-image-build/tools', 'measured-image-build/public', 'measured-image-build/stub/bin', 'storage-activation-next'):
    for p in (base / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and p.name != 'published-ls-tree.txt' and '__pycache__' not in p.parts:
            paths.add(p)
paths.add(base / 'measured-composition/out/c/INPUT-MANIFEST.json')
# Preserve reviewed native-discovery work without copying generated TLS keys,
# raw logs, dependency trees, or the withdrawn deployment bundle.
native = base / 'native-control-discovery'
for pattern in ('*.patch', '*.txt', '*.sh', '*.py'):
    paths.update(p for p in native.glob(pattern) if p.is_file() and not p.is_symlink())
for relative in (
    'repo/relay/native-discovery.mjs',
    'repo/test/native-discovery.test.mjs',
    'repo/docs/design/nan-retirement.md',
    'draft-6e46c06d/test/native-control-substitution.test.mjs',
):
    paths.add(native / relative)
for p in (native / 'stubs').rglob('*'):
    if p.is_file() and not p.is_symlink():
        paths.add(p)
paths.add(base / 'native-control-discovery-root-review.txt')
# Read-only public catalog/admission evidence and reproducible probe sources.
for p in (base / 'storage-public-read').iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.mjs', '.json'):
        paths.add(p)
# These are unfinished source drafts, not deployment artifacts or private test output.
for name in ('native-control-attested-task.txt', 'native-control-attested-review-task.txt',
             'direct-hardware-task.txt', 'direct-hardware-review-task.txt', 'storage-client-interop-task.txt'):
    paths.add(base / name)
for directory in ('direct-hardware-canary/canary', 'direct-hardware-canary/test',
                  'direct-hardware-canary/tools', 'direct-hardware-canary/bin'):
    for p in (base / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts:
            paths.add(p)
for directory in ('direct-hardware-canary', 'native-control-attested', 'storage-client-interop'):
    for p in (base / directory).iterdir():
        if p.is_file() and not p.is_symlink() and p.suffix in ('.txt', '.md', '.py', '.sh', '.mjs', '.patch', '.sha256'):
            paths.add(p)
for relative in ('metal/guest/gsup.mjs', 'metal/guest/measured-control.mjs', 'relay/native-discovery.mjs',
                 'test/native-discovery.test.mjs', 'test/native-control-attested.test.mjs', 'network/native-control-routes.mjs', 'scripts/native-control-certificate.mjs'):
    paths.add(base / 'native-control-attested/repo' / relative)
for name in ('FROZEN-PINS.json', 'PLANNED-EFFECTS.json', 'RESULT.json', 'SOURCES-tree.json', 'SOURCES.json'):
    paths.add(base / 'direct-hardware-canary' / name)
# Capture all implementation changes against the published candidate, including
# newly committed worker files and regenerated checked-in runtime bundles.
active = base / 'native-control-attested/repo'
changed = subprocess.check_output(['git', '-C', str(active), 'diff', '--name-only',
    'eaea7e4630ee1d82b3599b872a24075691510211'], text=True).splitlines()
changed += subprocess.check_output(['git', '-C', str(active), 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
for name in changed:
    rel = Path(name)
    p = active / rel
    if rel.parts[0] not in ('metal', 'network', 'relay', 'scripts', 'test', 'docs'):
        continue
    if p.is_file() and not p.is_symlink() and p.suffix in ('.mjs', '.js', '.json', '.md', '.py', '.sh', '.txt'):
        paths.add(p)
for p in (base / 'native-chip-review').glob('*.md'):
    paths.add(p)
paths.add(base / 'native-chip-semantics-review-task.txt')
for name in ('native-control-chip-integration-task.txt', 'storage-lease16-interop-task.txt', 'native-issuer-recovery-task.txt'):
    paths.add(base / name)
paths.add(base / 'direct-hardware-canary/ROOT-LAUNCH-REVIEW.json')
for p in (base / 'public-validation').rglob('*'):
    if p.is_file() and not p.is_symlink():
        paths.add(p)
for p in (base / 'native-issuer-recovery').glob('*.md'):
    paths.add(p)
for name in ('native-issuer-implementation-task.txt', 'platform-forwarding-pin-task.txt', 'storage-lease16-format-review-task.txt'):
    paths.add(base / name)
for name in ('RESULT.json', 'RESULT-lease16.json', 'RESULT-lease16.v1.json'):
    paths.add(base / 'storage-client-interop' / name)
for p in (base / 'source-preservation').glob('review-*.py'):
    paths.add(p)
# Keep active issuer changes recoverable without copying its private fixtures or dependencies.
issuer = base / 'native-issuer-implementation/repo'
issuer_names = subprocess.check_output(['git', '-C', str(issuer), 'diff', '--name-only', '8e77ff1eca24be3c02e281dc9f431af597165adf'], text=True).splitlines()
issuer_names += subprocess.check_output(['git', '-C', str(issuer), 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
for name in issuer_names:
    rel = Path(name)
    p = issuer / rel
    if rel.parts[0] in ('metal', 'network', 'relay', 'scripts', 'test', 'docs') and p.is_file() and not p.is_symlink() and p.suffix in ('.mjs', '.js', '.json', '.md', '.py', '.sh', '.txt'):
        paths.add(p)
for directory in ('native-issuer-implementation', 'native-storage-names'):
    for p in (base / directory).iterdir():
        if p.is_file() and not p.is_symlink() and p.suffix in ('.md', '.txt', '.py', '.sh', '.patch'):
            paths.add(p)
for name in ('native-issuer-review-task.txt', 'native-storage-names-task.txt'):
    paths.add(base / name)
# Only bounded public diagnostics, never raw SSH output or private live configuration.
for p in (base / 'public-health').iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.py', '.mjs', '.json'):
        paths.add(p)

# Further source-only workstreams; private fixtures and raw logs remain excluded.
for directory, subdir, baseline in (('adapter-admission-review', 'candidate', '32fecf5'), ('native-front-abort', 'repo', 'ca3118202359da8ce84f5b917fcc5ed85b2c6730')):
    top = base / directory
    if not top.exists():
        continue
    for p in top.iterdir():
        if p.is_file() and not p.is_symlink() and p.suffix in ('.md', '.txt', '.py', '.sh', '.patch'):
            paths.add(p)
    tree = top / subdir
    if (tree / '.git').exists():
        changed = subprocess.check_output(['git', '-C', str(tree), 'diff', '--name-only', baseline], text=True).splitlines()
        changed += subprocess.check_output(['git', '-C', str(tree), 'ls-files', '--others', '--exclude-standard'], text=True).splitlines()
        for name in changed:
            rel = Path(name)
            p = tree / rel
            if rel.parts[0] in ('metal', 'network', 'relay', 'scripts', 'test', 'docs', 'windows') and p.is_file() and not p.is_symlink() and p.suffix in ('.mjs', '.js', '.json', '.md', '.py', '.sh', '.txt'):
                paths.add(p)
for name in ('adapter-admission-task.txt', 'adapter-admission-review-task.txt', 'native-front-abort-task.txt', 'native-issuer-second-review-task.txt', 'adapter-renewal-task.txt', 'adapter-activation-review-task.txt'):
    paths.add(base / name)
for p in (base / 'public-health').glob('ROOT-*.txt'):
    paths.add(p)

for p in (base / 'adapter-activation-review').glob('*.md'):
    paths.add(p)
for name in ('adapter-renewal-review-task.txt', 'native-request-abort-review-task.txt'):
    paths.add(base / name)
request_review = base / 'native-request-abort-review'
if request_review.exists():
    for pattern in ('*.md', '*.txt', '*.sha256', '*.sh', '*.patch'):
        paths.update(p for p in request_review.glob(pattern) if p.is_file() and not p.is_symlink())
    for relative in ('snapshot/metal/guest/native-certificate.mjs', 'snapshot/test/native-certificate-request-abort.test.mjs'):
        p = request_review / relative
        if p.is_file() and not p.is_symlink():
            paths.add(p)
for name in ('node-restart-final-task.txt', 'native-handoff-final-task.txt',
             'node-restart-two-file-task.txt', 'node-restart-budget-review-task.txt',
             'platform-api-admin-final-task.txt', 'platform-api-admin-status-task.txt',
             'node-readiness-review-task.txt', 'node-return-window-task.txt', 'native-final-image-task.txt',
             'adapter-renewal-finalize-task.txt', 'node-pair-runner-task.txt', 'native-final-canary-task.txt'):
    paths.add(base / name)
paths.add(base / 'native-final-build/build.sh')
paths.add(base / 'native-issuer-implementation/MANIFEST.json')
for directory in ('native-issuer-implementation/jobs', 'node-restart-final', 'native-handoff-final', 'platform-api-admin-final', 'node-pair-runner'):
    for p in (base / directory).rglob('*'):
        rel = p.relative_to(base / directory)
        if any(part in ('logs', 'runs', 'tmp', 'secrets', 'node_modules', '.git', '__pycache__', 'mutants') for part in rel.parts):
            continue
        if directory in ('native-handoff-final', 'platform-api-admin-final') and rel.parts and (rel.parts[0].startswith(('base-', 'mutant-')) or rel.parts[0] in ('repo', 'fixtures')):
            continue  # existing Git base trees are already preserved; collect only authored review/job files here
        if p.is_file() and not p.is_symlink() and p.suffix in ('.md', '.txt', '.py', '.sh', '.ps1', '.mjs', '.patch', '.sha256'):
            paths.add(p)
for directory in ('native-final-image/tools', 'native-final-image/public', 'native-final-image/stub/bin'):
    for p in (base / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and p.name != 'published-ls-tree.txt':
            paths.add(p)
for name in ('RESULT.md', 'PINS.sha256'):
    p = base / 'native-final-image' / name
    if p.is_file():
        paths.add(p)
paths.add(base / 'node-restart-final/helper/provenance.json')
# The runner's explicit public params examples (every live identity null or a placeholder); its generated
# mutant copies (mutants/) and run receipts (runs/) are excluded above.
for name in ('params.identify.example.json', 'params.apply.example.json'):
    paths.add(base / 'node-pair-runner' / name)
# The native final canary's AUTHORED launcher, verifier, tests, tools and stub ssh/scp/sftp, its frozen pins (tree.sha256 is
# the pinned source list of FROZEN-PINS.json) and root's launch review. Never its staged source tree (tree/), run
# directories (runs/), raw or redirected logs (rawlogs/, logs/, public/) or dependency copies.
canary = base / 'native-final-canary'
for directory in ('canary', 'test', 'tools', 'bin'):
    for p in (canary / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts:
            paths.add(p)
for p in canary.iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.md', '.json', '.sha256'):
        paths.add(p)
# The canary's sanitized public verdict (hashes, booleans and limits only), outside the work tree.
outputs = [root / 'outputs/decentralization-audit/native-control-hardware-canary-20261022.json']
paths.add(base / 'adapter-admission-review/ROOT-FAILED-REGRESSION-STOP.json')
# The relay release-status fix (live as installed-lineage 48cf67ee): its reviewed notes, final patches, the exact
# installed-lineage module, the bounded runner and the new test. Never its candidate/base trees, tmp/, logs/ or stubs/.
release_review = base / 'relay-release-list-review'
for name in ('RESULT.md', 'INITIAL.md', 'ROOT-REVIEW.md', 'ROOT-LIVE-EVIDENCE.md', 'relay-release-status-lookup.patch',
             'relay-release-status-lookup.installed.diff', 'secrets-release.mjs.installed-lineage', 'job-tests.sh',
             'candidate/test/secrets-release-status-lookup.test.mjs'):
    paths.add(release_review / name)
# Root's relay reads: the AUTHORED probe/deploy scripts and their sanitized public JSON (public ids, booleans, timings, RPC
# host names). Never the raw installed copies (installed-api-relay.js, installed-secrets-release.mjs), guard logs or config.
release_live = base / 'relay-release-live'
for p in release_live.iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.py', '.json'):
        paths.add(p)
paths.add(base / 'native-production-next/RESULT.md')
paths.add(Path(__file__).resolve())
# Mutation tests temporarily edit the issuer's working tree. Preserve their saved
# unmutated inputs, never an intentionally disabled security check.
issuer_mutation_active = False
for proc in Path('/proc').iterdir():
    if not proc.name.isdigit():
        continue
    try:
        cmd = (proc / 'cmdline').read_bytes()
        cwd = (proc / 'cwd').resolve()
        if cwd == base / 'native-issuer-implementation' and b'python3' in cmd and b'jobs/mutants-' in cmd:
            issuer_mutation_active = True
    except (OSError, PermissionError):
        continue
assert not (base / 'outputs').exists(), 'a work directory named outputs would collide with the stored outputs/ prefix'
paths.update(outputs)
entries = []
unchanged = []
for p in sorted(paths):
    saved = p.with_name(p.name + '.mutant-orig')
    actual = saved if issuer_mutation_active and p.is_relative_to(issuer) and saved.is_file() else p
    data = actual.read_bytes()
    limit = 32_000_000 if p.name.endswith('.bundle.mjs') else 5_000_000
    assert len(data) < limit, p
    data.decode('utf-8')
    rel = p.relative_to(base) if p.is_relative_to(base) else Path('outputs') / p.relative_to(root / 'outputs')
    old = prior / rel
    if old.is_file() and old.read_bytes() == data:
        unchanged.append(str(old.relative_to(repo)))
        continue
    out = dest / 'files' / rel
    out.parent.mkdir(parents=True, exist_ok=True)
    if out.exists():
        out.chmod(0o644)
    out.write_bytes(data)
    out.chmod(0o644 | (p.stat().st_mode & 0o111))
    entries.append({'source': str(p.relative_to(root)), 'stored': str(out.relative_to(dest)),
                    'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                    **({'capturedFromUnmutatedBackup': str(actual.relative_to(root))} if actual != p else {})})
manifest = {'capturedAt': datetime.datetime.now(datetime.timezone.utc).isoformat(),
            'status': 'Recovery checkpoint; drafts and ongoing validation, not a release or activation',
            'entries': entries, 'unchangedAlreadyPreserved': unchanged,
            'exclusions': ['credentials and private configuration', 'live run directories and raw transcripts',
                           'generated images/binaries and dependency caches', 'copied base trees preserved earlier']}
(dest / 'MANIFEST.json').write_text(json.dumps(manifest, indent=2) + '\n')
print(json.dumps({'files': len(entries), 'bytes': sum(e['bytes'] for e in entries),
                  'unchanged': len(unchanged), 'capturedAt': manifest['capturedAt']}))
