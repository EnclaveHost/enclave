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
# The 0.0001 ETH x 10 queued-app reserve top-up (PROPOSAL + wallet handoff source): authored code, manifest, tests, RESULT and
# the PUBLIC proposal/evidence/call inventory/simulation/summary. Never state.json, journal/, request.json, local-url.txt
# (the page token), logs/ (raw runs and debug probes) or tmp/.
small = base / 'queued-funding-small'
for name in ('batch-topup-small.mjs', 'batch-plan-small.mjs', 'serve-small.mjs', 'serial-fetch.mjs', 'review-small.mjs', 'l1fee.mjs',
             'manifest.json', 'test/batch-plan-small.test.mjs', 'test/serial-fetch.test.mjs', 'run-tests.sh', 'run-serial-tests.sh', 'RESULT.md',
             'batch-proposal.json', 'batch-evidence.json', 'phase-a-reads.json', 'call-inventory.json', 'simulation.json', 'l1-fee.json', 'summary.json'):
    paths.add(small / name)
# The node-only activation window (node-pair-activate): SOURCE ONLY, never run natively. Its frozen df2e58f2 source copy,
# helper, tools, jobs, ssh/scp/sftp deny stubs and offline/queue runners; never logs/, tmp/, __pycache__ or mutant copies.
activate = base / 'node-activate-min'
for name in ('INITIAL.md', 'RESULT.md', 'offline.sh', 'q.sh'):
    paths.add(activate / name)
for directory in ('source', 'helper', 'tools', 'jobs', 'stub'):
    for p in (activate / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts and 'mutants' not in p.parts:
            paths.add(p)
# Root's funding confirmation (the read-only quorum receipt check of the 10 deposits) and its sanitized result (covered by the
# .json rule above); the queued-claim RPC diagnosis (source-only proposals); root's Cron placement status note. Never the
# Cron placement probe log, a wallet journal, page token or raw log.
paths.add(release_live / 'verify-funding.mjs')
paths.add(base / 'queued-rpc-diagnosis/RESULT.md')
paths.add(base / 'cron-placement/ROOT-STATUS.json')
# Root's completed Cron move (dashboard wallet flow): the read-only placement check, its 3-RPC confirmation and the public
# nucbox state after; and the worker's finished source-only placement analysis. Never its probe logs or public-before.json.
for name in ('verify-placement.mjs', 'placement-confirmed.json', 'nucbox-after.json', 'RESULT.md'):
    paths.add(base / 'cron-placement' / name)
# The Windows serving-first candidate (829a881c on 2afa6733): exactly its two control files, the changed test, the patch, the
# reports and its bounded test recipe (job runner + ssh/scp/sftp denial stubs). Never its dependency trees, logs, tmp/, the
# copied cutover/ test fixture or temporary base/mutant trees. Kept HERE, not in the normal tree: the checkpoint's
# windows/node/host.mjs (e41122d7) is an older lineage than the installed 9634cb40 this candidate builds on.
sf = base / 'windows-serving-first'
for name in ('candidate/windows/node/host.mjs', 'candidate/windows/node/chain.mjs', 'candidate/test/windows-node-lease-renewal-keeper.test.mjs',
             'windows-serving-first.patch', 'INITIAL.md', 'RESULT.md', 'job-tests.sh', 'stubs/ssh', 'stubs/scp', 'stubs/sftp'):
    paths.add(sf / name)
paths.add(base / 'serving-first-review/RESULT.md')
# Cold snapshot (A9) refresh plan; the EnclaveDNS artifact recovery (procedure + root-run-only script, NOT run) and root's
# live update; the read-only live DNS receipts (sanitized JSON + the authored reader). Never their .log files.
paths.add(base / 'cold-storage-refresh/RESULT.md')
for name in ('RESULT.md', 'reupload-exact.mjs', 'ROOT-LIVE-UPDATE.txt'):
    paths.add(base / 'dns-artifact-recovery' / name)
for name in ('inspect.py', 'inspect.json', 'http-pinned.json', 'state-0005.json'):
    paths.add(base / 'dns-live-recovery' / name)
# The whole-bucket Sia cold restore (e8f0997f on 54818ba): its one changed file, the patch, the plan and result, the source
# manifest, the bounded test runner and the two mutant diffs. Never the rest of its clone, its target dirs or raw logs.
wb = base / 'sia-whole-bucket-recovery'
for name in ('INITIAL.md', 'RESULT.md', 'SOURCE-MANIFEST.json', 'run-tests.sh', 'whole-bucket-restore.patch',
             'repo/sia-s3/src/recovery.rs', 'logs/m-etag.diff', 'logs/m-sha.diff'):
    paths.add(wb / name)
# Root's read-only Windows updater check: public release metadata, the installed updater it reviewed, the node's public
# deployment status and its result. (Root's archive copy script is under production-run/, collected above.)
for p in (base / 'node-updater-readonly').iterdir():
    if p.is_file() and not p.is_symlink() and p.suffix in ('.json', '.ps1'):
        paths.add(p)
# Root's second-device copy receipt (hashes, sizes and booleans only).
outputs.append(root / 'outputs/decentralization-audit/storage-cold-recovery-second-device-20261023.json')
# The root-run isolated whole-snapshot restore harness: its launcher, runner, example deny lists, offline tests, fake binary,
# stubs and result. Never its logs/.
harness = base / 'sia-whole-restore-harness'
for name in ('whole_restore.py', 'runner.py', 'run-tests.sh', 'blocked.workstation.example.json', 'blocked.vm.example.json',
             'RESULT.md', 'test/test_harness.py', 'test/test_real_systemd.py', 'test/fake-sia-s3',
             'test/stubs/ssh', 'test/stubs/systemd-run', 'test/stubs/systemctl'):
    paths.add(harness / name)
# The FINAL frozen serving-first pair e7e5057a (host.mjs ea0f6b8a + chain.mjs 3e9fae03) and its bounded test recipe; never
# its dependency trees, logs, tmp/, cutover/ fixture copy or the rest of the candidate tree.
sff = base / 'serving-first-fixes'
for name in ('candidate/windows/node/host.mjs', 'candidate/windows/node/chain.mjs', 'candidate/test/windows-node-lease-renewal-keeper.test.mjs',
             'serving-first-fixes.patch', 'INITIAL.md', 'RESULT.md', 'job-tests.sh', 'stubs/ssh', 'stubs/scp', 'stubs/sftp'):
    paths.add(sff / name)
# The finished bounded-observation helper f7a77598 (node-pair-observe.ps1): helper, tools, jobs, its source copy, deny stubs and
# reports. Never logs/, tmp/ or __pycache__.
nbo = base / 'node-bounded-observation'
for name in ('INITIAL.md', 'RESULT.md', 'offline.sh', 'q.sh'):
    paths.add(nbo / name)
for directory in ('helper', 'tools', 'jobs', 'source', 'stub'):
    for p in (nbo / directory).rglob('*'):
        if p.is_file() and not p.is_symlink() and '__pycache__' not in p.parts:
            paths.add(p)
# The DEPLOYED DNS/TLS fix a2b8fabd: exactly the 18 files of worker C's frozen ALLOWLIST.txt (the five tracked source/test
# files at their committed bytes, reports, patches, rollout source and tests) plus its hash list and root's three rollout
# receipts (hashes, PIDs, statuses only); and the lineage record + full five-file diff. Never node_modules, the base/ and
# rejected/ clones, stubs/, tmp/ or logs/.
tls = base / 'dns-tls-investigation'
frozen = {line.split()[1]: line.split()[0] for line in (tls / 'ALLOWLIST.sha256').read_text().splitlines() if line.strip()}
listed = [l.strip() for l in (tls / 'ALLOWLIST.txt').read_text().splitlines() if l.strip() and not l.startswith('#')]
assert sorted(frozen) == sorted(listed) and len(listed) == 18, 'the DNS/TLS allowlist and its hash list disagree'
for name, want in frozen.items():
    assert hashlib.sha256((tls / name).read_bytes()).hexdigest() == want, f'NOT CAPTURED: {name} changed after its final hash'
    paths.add(tls / name)
paths.add(tls / 'ALLOWLIST.sha256')
paths.update(p for p in (tls / 'rollout' / 'results').glob('*.json') if p.is_file() and not p.is_symlink())
for name in ('LINEAGE.json', 'a2b8fabd-five-files.patch'):
    paths.add(base / 'dns-tls-publication' / name)
# Root's safe Windows helpers (no remote calls / one read-only status query); NOT its mutable identify/apply receipts (runs/).
paths.add(base / 'node-pair-runner/prepare-next-params.py')
paths.add(base / 'node-updater-readonly/current-window.py')
# Root's FROZEN native Windows activation evidence (e7e5057a pair via helper f7a77598): exactly these run files, reviewed to hold
# hashes, PIDs, counts, timestamps, public deployment ids and Windows paths only. Each must still match its reviewed hash.
FROZEN_RUNS = {
    'ROOT-NEXT-WINDOW.txt': 'c7a0ca361c78e1f3599927116e500bf71396b7ef8a0ad1be51fcfe1cc7058f7e',   # root's 01:35Z followup (was 8a79f3c8)
    'params-identify-20261023t011354z.json': '36d245fc7993f6f1afa26505fb20a0334760bef3ddf8cec779a15a8ba986d99b',
    'attempt-identify-identify-20261023t011354z.json': 'a69dd481fbad55374ede149c2ac801fe3a0be1796f5bafe9ed39def6d06a9a35',
    'identify-result-identify-20261023t011354z.json': 'abc199de6f3f01b4d0461382d6137dc50bc4888b601ef1a3efe0ac0f7eb7fd34',
    'params-apply-20261023t011516z.json': 'a182b11048a6f9cb30eb7a1a69d9700f36804ce4bac3732568c3f31b6b43a9ae',
    'attempt-apply-apply-20261023t011516z.json': '12345415375f75da5dba56d7c7747d5f15c308b0a354ceca169635c9390d2d92',
    'apply-result-apply-20261023t011516z.json': '7bfb77ebfa8de38fce01a56073c3490de5d03860607a929ae1291b069606cfeb',
    'params-identify-20261023t011924z.json': '41d6f9ad84de4d6cc87d2a5137f6cd2eb3a6444fde4fbf067b50d4bec5ba6be4',
    'attempt-identify-identify-20261023t011924z.json': 'ff427c84e3c66fde002a181622f2a7e82f5170509da70415dd6fd3051df0a679',
    'identify-result-identify-20261023t011924z.json': 'bb2cffda9a0d07a36f8e2dcfc71ccd5cd40f3156f3cf2c116ca5c049cbc2e83c',
}
for name, want in FROZEN_RUNS.items():
    p = base / 'node-pair-runner/runs' / name
    assert hashlib.sha256(p.read_bytes()).hexdigest() == want, f'NOT CAPTURED: {name} changed after review'
    paths.add(p)
outputs.append(root / 'outputs/decentralization-audit/windows-node-update-20261023.json')
# Root's FINISHED renewal evidence (01:30-01:35Z) and the RUNNING whole-restore receipt, plus worker C's routing report: each at its
# reviewed bytes (hashes, public ids, tx hashes, public RPC hosts, counts, timestamps only; no keys, snapshot, seed or private
# handle). The read-only observation/verification sources sit under production-run/.
FROZEN_RENEWAL = {
    'work/resume-after-checkpoint-20261022/production-run/observe-node-renewal.py': '94b32780433491867c291379d0128f7763d8c1540e9d637770001ae8ec56730a',
    'work/resume-after-checkpoint-20261022/production-run/verify-node-renewal-chain.mjs': '2c6b976222c5052ff06d65dbd40652e95cf637f5cbc3e9489be9237c4f6df90a',
    'work/resume-after-checkpoint-20261022/dns-routing-investigation/RESULT.md': '2a04ed51c6ca551fcf5b2a96ac01c34aafb6a11a34f7ecd9e58bd6a38419058c',
    'work/resume-after-checkpoint-20261022/dns-routing-investigation/EVIDENCE-INVENTORY.json': '36760da10b74b3c914f01f31cf3033da6306124aa4296f8fe2501d41086c3f46',
    'outputs/decentralization-audit/windows-node-update-20261023.json': '32cad8a3f5a9904614ae811c8f5609b7d84527faaa6c8879fa1a3969107a1e74',
    'outputs/decentralization-audit/windows-node-renewal-observation-20261023.json': 'de7be8e14fb1f13e191b4365808fca568d2cce78bc8f8b788423327c52a33893',
    'outputs/decentralization-audit/windows-node-renewal-log-20261023.json': '28bca996beba7451b04d30864c25ce5a1f1b34011fdc9a8d8a8c242685f637c0',
    'outputs/decentralization-audit/windows-node-renewal-chain-20261023.json': '261477b6d464965875659a774a6fd62331c90362c514152bbb7e30f66bfdda00',
    'outputs/decentralization-audit/storage-whole-recovery-live-20261023.json': 'c6bfa9e5a835d4d7fa1e0d89bc4b766d0cd9bed5389f8884c40c6ed3ef1ad57a',
}
for name, want in FROZEN_RENEWAL.items():
    p = root / name
    assert hashlib.sha256(p.read_bytes()).hexdigest() == want, f'NOT CAPTURED: {name} changed after review'
    (outputs.append(p) if name.startswith('outputs/') else paths.add(p))
# Root's public receipts: the EnclaveDNS TLS recovery observation and the 00:40Z progress snapshot.
outputs += [root / 'outputs/decentralization-audit/enclavedns-tls-20261023.json',
            root / 'outputs/decentralization-audit/progress-20261023T0040.json']
# what each new group IS, recorded on its manifest entries (nothing here is activated by this checkpoint)
LABELS = {'queued-funding-small/': 'UNSIGNED PROPOSAL + wallet-handoff source; not funded: no transaction signed or sent (root prepared intent '
                                   'tx-mvk6qcjl-d745ad9e, nonce 1144, pending the user signature)',
          'node-activate-min/': 'SOURCE ONLY: not run natively, not activated',
          'queued-rpc-diagnosis/': 'SOURCE-ONLY PROPOSALS (read-only diagnosis); nothing implemented or activated',
          'windows-serving-first/': 'SOURCE-ONLY CANDIDATE 829a881c (host.mjs 817389ec + chain.mjs 3e9fae03, two-file swap): not deployed or '
                                    'activated; preserved here, not merged into the normal tree (older lineage)',
          'serving-first-review/': 'independent read-only review of the serving-first candidate (no blocker; should-fix items open)',
          'cold-storage-refresh/': 'PLAN/REPORT ONLY: local and source; nothing run',
          'dns-artifact-recovery/': 'HISTORICAL PROCEDURE: reupload-exact.mjs is root-run only and was NOT run; nothing restored or republished. '
                                    'Root live update: the CID answers HEAD 200 with the exact 2588705 bytes; that is NOT a full artifact read '
                                    '(a full GET returned 502)',
          'dns-live-recovery/': 'READ-ONLY receipts: HEAD success only, not a full artifact read (GET 502); no force or republication',
          'sia-whole-bucket-recovery/': 'SOURCE-ONLY CANDIDATE e8f0997f (sia-s3 recovery restore, on 54818ba; recovery.rs 7d2c1d41): not built '
                                        'into a pinned binary, released or run against production data; root runs live verification',
          'node-updater-readonly/': 'READ-ONLY receipts (root): installed updater 36f9e0d6 for published 2026.10.12.47, a same-version no-op; '
                                    'no signed release policy present; no policy changed',
          'production-run/copy-encrypted-recovery.py': 'ROOT-RUN: copies only the pinned encrypted archive (no keys or passphrase) to the '
                                                       'attached array, with read-back verification',
          'dns-tls-investigation/rollout/results/': 'ROOT rollout receipts: DEPLOYED_READY (2 files, 2.2 s, PID 222659->240723, hashes '
                                                    'verified). Their "within 40 s" pending text is corrected: 40 s bounds the '
                                                    'app-evidence phase, not the whole HTTP request; post-deployment certificate '
                                                    'issuance is still UNOBSERVED',
          'dns-tls-investigation/': 'DEPLOYED a2b8fabd (relay/certs.js 77a0d398 + relay/measurement-predict.mjs b2a39242 on the control VM, '
                                    'by root). Tests: rollout 19/19 (rollout-r3); source 108/110, the 2 failures are pre-existing '
                                    'rule pins (NOT 110/110). Not merged into the normal tree',
          'dns-tls-publication/': 'lineage of a2b8fabd (parent ad074e2): no normal-tree conflict (the normal tree holds the parent bytes); '
                                  'not applied there',
          'node-pair-runner/runs/': 'ROOT native activation evidence (frozen): runtime CHANGED 01:17 to host ea0f6b8a + chain 3e9fae03 '
                                    '(e7e5057a, helper f7a77598). The bounded helper ended NOT_READY (M1 not proven within 60 s): NOT a '
                                    'passed activation. Root\'s independent 01:19/01:20 checks: new agent 28460 owns 9600, 9 running, all 9 '
                                    'post-start lease-ready, readiness sequence 3 completed, manager/privacy/VMs/Hyper-V and config hashes '
                                    'unchanged. A renewal by the NEW keeper is still PENDING (first due ~01:29Z); not full completion',
          'outputs/decentralization-audit/windows-node-update-20261023': 'ROOT public receipt: APPLIED and independently verified serving '
                                                                         'after the bounded startup check timed out (helper NOT_READY, not '
                                                                         'passed). 01:34Z followup: six apps renewed 01:30-01:32 under the '
                                                                         'new runtime (two-provider corroboration, NOT independent witness '
                                                                         'verification; logs cannot tell the keeper timer from the regular '
                                                                         'pass); 3 leases not yet due; not full decentralization',
          'outputs/decentralization-audit/windows-node-renewal': 'ROOT receipts (01:31-01:34Z): same agent 28460 before/after, all 9 fresh '
                                                                 'ready; six renewals 01:30-01:32 with matching ledger Renewed + reserve '
                                                                 'LeaseGasPaid events from TWO RPC providers = two-provider corroboration, '
                                                                 'NOT independent witness verification. Logs cannot tell the keeper timer '
                                                                 'from the regular pass. 3 leases not yet due; no full goal completion',
          'outputs/decentralization-audit/storage-whole-recovery-live': 'ROOT receipt: RUNNING, NOT COMPLETE (unit sia-whole-restore-efe2c21b-001; '
                                                                        'the file holds the INITIAL progress, 19 files). Root reported 425 files '
                                                                        '/ 950 MB committed + 327 MB in flight at 01:35. Isolation verified 31/31 '
                                                                        'endpoints blocked, 6/6 names unresolved, 2 Sia hosts reached. SAME '
                                                                        'physical host as indexd: not host-loss proof',
          'production-run/observe-node-renewal.py': 'ROOT source: read-only post-activation observation (one bracketed status query); '
                                                    'no config, keys or raw logs',
          'production-run/verify-node-renewal-chain.mjs': 'ROOT source: read-only two-provider log corroboration (public RPCs); no keys, '
                                                          'signing or sends; NOT independent proof verification',
          'node-pair-runner/runs/ROOT-NEXT-WINDOW.txt': 'ROOT note, updated 01:35Z: runtime CHANGED (e7e5057a); helper NOT_READY (not a '
                                                        'passed activation); post-identify unchanged; six renewals two-provider '
                                                        'corroborated, 3 not yet due; restore RUNNING. Do not rerun apply',
          'dns-routing-investigation/': 'READ-ONLY investigation report + safe evidence inventory (hashes, paths, quoted log lines only): '
                                        'fail-closed authorization withdrawal + DNS lag; no source bug, no patch, nothing changed',
          'node-pair-runner/prepare-next-params.py':'ROOT source: prepares immutable params from an IDENTIFIED receipt; no remote calls',
          'node-updater-readonly/current-window.py': 'ROOT source: one read-only status query of the Windows node; nothing changed',
          'production-run/build-whole-recovery.sh':'ROOT-RUN source: builds the e8f0997f recovery binary (dev profile, '
                                                    'sha256 3ef760ed); not a release',
          'production-run/whole-recovery-size.py': 'ROOT-RUN source: offline (unshare -rn) zero-budget size refusal; no restore, '
                                                   'no network',
          'sia-whole-restore-harness/':'SOURCE + OFFLINE TESTS ONLY: root-run isolated whole-snapshot restore harness; nothing run '
                                        'against production, no restore performed',
          'serving-first-fixes/': 'FINAL FROZEN CANDIDATE e7e5057a (host.mjs ea0f6b8a + chain.mjs 3e9fae03, two-file swap): source only '
                                  'here; root has it staged and IDENTIFIED, NOT activated',
          'node-bounded-observation/': 'FINISHED SOURCE-ONLY HELPER f7a77598 (node-pair-observe.ps1): root has it staged and IDENTIFIED, '
                                       'NOT activated',
          'outputs/decentralization-audit/enclavedns-tls-20261023': 'ROOT public receipt: TLS recovered through the existing retry; no '
                                                                    'production mutation; one recovery is not durable availability',
          'outputs/decentralization-audit/progress-20261023T0040': 'ROOT progress snapshot: status labels only (Windows staged, not '
                                                                   'activated; RPC incomplete; storage restore not run)',
          'outputs/decentralization-audit/storage-cold-recovery-second-device':'ROOT receipt: encrypted archive copy verified on a second '
                                                                               'attached device, same workstation/site; NOT offsite or a '
                                                                               'complete cold recovery',
          'cron-placement/': 'Cron moved to nucbox by the existing dashboard wallet flow; native running 23:58:37Z, 3 RPCs agree at block '
                             '52962071. NOT a durable on-chain pin: the ledger configCid has no placement field. RESULT.md = '
                             'source-only analysis (its setConfig placement option was not executed)'}
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
    label = max(((k, v) for k, v in LABELS.items() if str(rel).startswith(k)), key=lambda kv: len(kv[0]), default=(None, None))[1]  # most specific
    entries.append({**({'label': label} if label else {}), 'source': str(p.relative_to(root)), 'stored': str(out.relative_to(dest)),
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
