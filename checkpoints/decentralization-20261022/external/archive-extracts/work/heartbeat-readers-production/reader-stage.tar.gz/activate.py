"""Run on control VM only after local candidate integration tests pass. Code-only, with rollback."""
import datetime, hashlib, json, os, pathlib, shutil, subprocess, sys, time, urllib.request
stage = pathlib.Path(sys.argv[1]).resolve()
manifest = json.loads((stage / 'candidate-manifest.json').read_text())
original = json.loads((stage / 'live-source-manifest.json').read_text())
api = pathlib.Path('/opt/nan-relay')
dns = pathlib.Path('/opt/enclave-dns')
sha = lambda p: hashlib.sha256(p.read_bytes()).hexdigest() if p.is_file() else None

def get(route, port=8100):
    with urllib.request.urlopen(f'http://127.0.0.1:{port}' + route, timeout=15) as r:
        return json.load(r)

def active(unit):
    return subprocess.run(['systemctl', 'is-active', '--quiet', unit]).returncode == 0

def dns_ok():
    if get('/health', 8153).get('ok') is not True: return False
    # Actual configured listener, verified before preparing this rollout.
    for transport in ([], ['+tcp']):
        result = subprocess.run(['dig', '@127.0.0.1', '-p', '1053', 'app.enclave.host', 'SOA',
                                 '+time=2', '+tries=1', '+short', *transport],
                                capture_output=True, text=True, timeout=5)
        fields = result.stdout.split()
        if (result.returncode != 0 or len(fields) != 7 or
            fields[:2] != ['ns-us-west.enclave.host.', 'hostmaster.enclave.host.'] or
            not all(v.isdigit() for v in fields[2:])): return False
    return True

def atomic(source, dest):
    temp = dest.with_name(dest.name + '.reader-update.tmp')
    # Keep the live deployment user's ownership, including for newly added modules.
    owner = dest.stat() if dest.exists() else (dest.parent / 'api-relay.js').stat()
    with temp.open('wb') as f:
        f.write(source.read_bytes()); f.flush()
        os.fchmod(f.fileno(), owner.st_mode & 0o777)
        os.fchown(f.fileno(), owner.st_uid, owner.st_gid)
        os.fsync(f.fileno())
    os.replace(temp, dest)
    fd = os.open(dest.parent, os.O_RDONLY)
    try: os.fsync(fd)
    finally: os.close(fd)

assert os.geteuid() == 0
assert active('enclave-api-relay') and active('enclave-dns'), 'both baseline services must be active'
assert get('/health').get('ok') is True, 'baseline API unhealthy'
assert dns_ok(), 'baseline DNS API or UDP/TCP listener unhealthy'
before = get('/enclaves')
ids = {r['id'] for r in before['enclaves']}
assert ids, 'no baseline hosts available for the continuity check'
# A restart interrupts prediction work; refuse before any live-file mutation.
prediction = subprocess.run(['pgrep', '-f', 'isolation/m4/[e]xpected-measurement[.]sh'], capture_output=True)
assert prediction.returncode == 1, 'prediction running or process check failed; retry after it completes'
for name, expected in original.items():
    assert sha(api / name) == expected, 'live runtime changed since review: ' + name
for name, entry in manifest['files'].items():
    assert sha(stage / 'candidate' / name) == entry['candidate'], 'candidate changed: ' + name
    assert sha(api / name) == entry['before'], 'baseline changed: ' + name
assert sha(dns / 'fleet.mjs') == manifest['files']['fleet.mjs']['before'], 'DNS baseline changed'
# Check imports' syntax without loading any production environment or credentials.
for name in manifest['files']:
    subprocess.run(['node', '--check', str(stage / 'candidate' / name)], check=True, capture_output=True)
backup = pathlib.Path('/var/backups/enclave-reader-rollouts') / datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
backup.mkdir(parents=True, exist_ok=False, mode=0o700)
changes = [(stage / 'candidate' / name, api / name, backup / 'api' / name) for name in manifest['files']]
changes.append((stage / 'candidate/fleet.mjs', dns / 'fleet.mjs', backup / 'dns/fleet.mjs'))
existed = {}
for source, dest, saved in changes:
    existed[str(dest)] = dest.exists()
    if dest.exists():
        saved.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(dest, saved)
(backup / 'manifest.json').write_text(json.dumps({'candidate': manifest, 'existed': existed}, indent=2) + '\n')
try:
    # Recheck immediately before replacing code; backups contain public source only.
    assert subprocess.run(['pgrep', '-f', 'isolation/m4/[e]xpected-measurement[.]sh'], capture_output=True).returncode == 1
    for source, dest, saved in changes: atomic(source, dest)
    subprocess.run(['systemctl', 'restart', 'enclave-api-relay'], check=True, timeout=90)
    subprocess.run(['systemctl', 'restart', 'enclave-dns'], check=True, timeout=90)
    checks = []; deadline = time.monotonic() + 150
    while time.monotonic() < deadline:
        time.sleep(5)
        try:
            health = get('/health'); hosts = get('/enclaves')
            present = {r['id'] for r in hosts['enclaves']}
            good = health.get('ok') is True and ids <= present and active('enclave-api-relay') and active('enclave-dns') and dns_ok()
            checks.append({'ok': good, 'hosts': len(present), 'missingBaselineHosts': sorted(ids - present)})
        except Exception:
            checks.append({'ok': False, 'reason': 'health request failed'})
        if len(checks) >= 3 and all(c['ok'] for c in checks[-3:]): break
    else: raise RuntimeError('services or baseline hosts did not recover within 150 seconds')
    result = {'activated': True, 'backup': str(backup), 'checks': checks,
              'source': {str(dest): sha(dest) for _, dest, _ in changes},
              'scope': 'API/DNS liveness readers only; no host update, wallet action or configuration/state migration'}
    (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
except BaseException:
    restore_errors = []
    for source, dest, saved in changes:
        try:
            if existed[str(dest)]: atomic(saved, dest)
            elif dest.exists():
                dest.unlink()
                fd = os.open(dest.parent, os.O_RDONLY)
                try: os.fsync(fd)
                finally: os.close(fd)
        except Exception as e:
            restore_errors.append({'path': str(dest), 'error': str(e)})
    statuses = {}
    for unit in ['enclave-api-relay', 'enclave-dns']:
        try: statuses[unit] = subprocess.run(['systemctl', 'restart', unit], timeout=90).returncode
        except Exception as e: statuses[unit] = str(e)
    restored = all(sha(dest) == (sha(saved) if existed[str(dest)] else None)
                   for _, dest, saved in changes)
    recovered = False
    deadline = time.monotonic() + 90
    while restored and not restore_errors and time.monotonic() < deadline:
        try:
            recovered = (get('/health').get('ok') is True and
                         ids <= {r['id'] for r in get('/enclaves')['enclaves']} and
                         all(active(unit) for unit in statuses) and dns_ok())
            if recovered: break
        except Exception: pass
        time.sleep(5)
    result = {'activated': False, 'rolledBack': restored and recovered and not restore_errors,
              'sourceRestored': restored, 'servicesRecovered': recovered, 'restoreErrors': restore_errors,
              'backup': str(backup), 'restartStatuses': statuses}
    (backup / 'result.json').write_text(json.dumps(result, indent=2) + '\n')
    print(json.dumps(result), flush=True)
    raise
