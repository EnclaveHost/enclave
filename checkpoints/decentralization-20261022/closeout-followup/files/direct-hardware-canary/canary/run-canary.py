#!/usr/bin/env python3
"""ROOT-EXECUTED, bounded hardware canary of the measured DIRECT-control image (never a production activation).

One disposable SNP guest, booted by the PUBLISHED launcher (tree/metal/enclave-metal.mjs, git archive of 6f2c7da4) from the
exact built image measured-image-build/image/dist-direct-6f2c7da46, with a BARE owner config (canary/owner-config.mjs):
no registry key (not selling), no fleet secret, no relay/tunnel/certificate/ACME input, no apps, no MCP/Platform API
member, guestd endpoints on two loopback ports proven to have NO listener (never production guestd 8095/8096), slirp with
restrict=on (canary/qemu-restrict.sh: the guest reaches no host or outside address), and ONE loopback port forward to the
guest's attested control front (8444) - never the plain supervisor port. The host-side verifier (canary/verify-canary.mjs)
uses the published verifyMeasuredControl with real AMD collateral (a copy of the existing public cache) and, optionally, a
read-only registry read.

  python3 canary/run-canary.py --preflight            read-only gates only (no run directory, no locks, no launch)
  python3 canary/run-canary.py --run [--kds on|off] [--registry on|off]
      root only, in a quiet window: takes BOTH shared queue lanes (non-blocking; 98 if busy), needs MemAvailable >=
      16384 + CAP + 1024 MiB, creates runs/<UTC stamp> (0700, never reused), then
      systemd-run --user --scope (MemoryMax=CAP, MemorySwapMax=0) memory-guard (CAP, floor 16384) timeout 330s -> --child.
Owned processes are identified by (pid, /proc starttime) and killed only by the launcher's own process group and this run's
transient scope; the protected QEMUs and running user services are snapshotted before and after; nothing is killed by name.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, secrets, shutil, signal, socket, subprocess, sys, threading, time

D = pathlib.Path(__file__).resolve().parents[1]
WORK = D.parents[1]                                   # .../wo/work
TREE = D / 'tree'
BUILD = D.parent / 'measured-image-build'
IMAGE = BUILD / 'image/dist-direct-6f2c7da46'
RECEIPT = BUILD / 'public/BUILD-RECEIPT.json'
INPUTS = BUILD / 'public/inputs-precheck.json'
OVMF = pathlib.Path('/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd')
OVMF_SHA = '142589cc4882f29a419af34dde03ccda91faf313bd2c09b3a8b53c137df4f8a9'
QEMU = pathlib.Path('/usr/bin/qemu-system-x86_64')
QEMU_SHA = 'a2250f5e2b3b07c754473c0817df1cccf6c3c2443fc616dc474c4c311fa6ef1c'
NODE = pathlib.Path('/usr/bin/node')
COLLATERAL_SRC = pathlib.Path('/home/steven/enclave-prod/capacity-audit/state/amd')   # public AMD collateral; COPIED, never written
IMAGE_SHA = {'vmlinuz': '1a3a02d5a982946e6cec2590171ba742e5528c647790a9ed9127879b76a124e7',
             'initramfs.cpio.gz': 'f778b9d8d843d2245876ff20da0f453ab5a8b0e0eda5bf9aa0a8d2d7d6e7fa60',
             'cmdline': 'fd236eb2762c457bbe20376216e078f3aab3f2f40a3646f9509137b8f67fabb6',
             'manifest.json': 'd187f8fd85c6dc9cad7845da8df62dfb46b175e3f359488621105110c4cec9de',
             'MEASUREMENT': 'cd13ed09f067dd9c0cbc5648cadab00c12324e1d2678a2fb6f070f615b50bc3a'}
MEASURED_CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct'
PROTECTED = {3483499: 87503396, 3817658: 32598976}    # pid -> /proc starttime (enclave-metal.service, enclave-custodian-v2.service)
PRODUCTION_GUESTD = (8095, 8096)
CPUS, MEM_MIB, CONTROL_PORT = 4, 4096, 8444
CAP_MIB, FLOOR_MIB, MARGIN_MIB = 6144, 16384, 1024    # scope MemoryMax = guest 4096 + 2048 QEMU/launcher/verifier overhead
CHILD_TIMEOUT_S, KILL_AFTER_S, VERIFY_DEADLINE_S = 330, 40, 210   # cleanup_group is bounded at ~22 s < KILL_AFTER_S
STUB_BIN = D / 'bin'

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()
def save(run, name, value):
    with (run / name).open('x') as f: json.dump(value, f, indent=2)
def available_mib():
    return next(int(l.split()[1]) // 1024 for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
def starttime(pid):
    try:
        st = pathlib.Path(f'/proc/{pid}/stat').read_text(); return int(st[st.rfind(')') + 2:].split()[19])
    except (OSError, IndexError, ValueError): return None
def comm(pid):
    try: return pathlib.Path(f'/proc/{pid}/comm').read_text().strip()
    except OSError: return None
def ppid(pid):
    try:
        st = pathlib.Path(f'/proc/{pid}/stat').read_text(); return int(st[st.rfind(')') + 2:].split()[1])
    except (OSError, IndexError, ValueError): return None
def alive(identity):
    """identity = (pid, starttime): alive only if the SAME process (pid reuse never counts)."""
    return starttime(identity[0]) == identity[1]
def qemus():
    out = {}
    for p in pathlib.Path('/proc').iterdir():
        if p.name.isdigit() and (comm(p.name) or '').startswith('qemu'):
            s = starttime(p.name)
            if s is not None: out[p.name] = s
    return out
def user_services():
    """running user services, and for enclave-* units their MainPID + its starttime (identity, not just state)."""
    names = subprocess.run(['systemctl', '--user', 'list-units', '--type=service', '--state=running', '--no-legend', '--plain'],
                           capture_output=True, text=True, timeout=20).stdout.split()
    names = sorted(n for n in names if n.endswith('.service'))
    ident = {}
    for n in names:
        if not n.startswith('enclave-'): continue
        r = subprocess.run(['systemctl', '--user', 'show', n, '-p', 'MainPID', '--value'], capture_output=True, text=True, timeout=20).stdout.strip()
        ident[n] = [int(r or 0), starttime(r) if r and r != '0' else None]
    return {'running': names, 'enclaveMainPids': ident}
def listening(port):
    r = subprocess.run(['ss', '-ltnH', f'sport = :{port}'], capture_output=True, text=True, timeout=10)
    return bool(r.stdout.strip())
def free_loopback_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0)); return s.getsockname()[1]
def pick_ports(n):
    out = []
    while len(out) < n:
        p = free_loopback_port()
        if p in PRODUCTION_GUESTD or p in out or listening(p): continue
        out.append(p)
    return out
def expected_measurement():
    m = json.loads(RECEIPT.read_text())['measurement']['value']
    if not re.fullmatch(r'[0-9a-f]{96}', m): raise SystemExit('receipt measurement is not 96 hex')
    if (IMAGE / 'MEASUREMENT').read_text().strip() != m: raise SystemExit('image MEASUREMENT differs from the receipt')
    return m
def expected_runtime():
    i = json.loads(INPUTS.read_text())['inputs']
    return {'gsupSha256': i['opt/metal/gsup.mjs']['sha256'], 'helperSha256': i['opt/metal/measured-control.mjs']['sha256'],
            'supervisorSha256': i['app/supervisor.js']['sha256']}
SECRETISH = re.compile(r'(SECRET|PRIVATE_KEY|ADMIN_TOKEN|MNEMONIC|PASSWORD|pairingKey)\s*["=:]', re.I)
def tree_fingerprint(root):
    """sha256 over (relative path, size, mtime_ns, sha256) of every file: proves a read-only source was not written."""
    h = hashlib.sha256()
    for p in sorted(pathlib.Path(root).rglob('*')):
        if p.is_file(): st = p.stat(); h.update(f'{p.relative_to(root)}\0{st.st_size}\0{st.st_mtime_ns}\0{sha256_file(p)}\n'.encode())
    return h.hexdigest()
def argv_checks(records, host_data_hex, ctl_port):
    """the QEMU argv the launcher actually built (through qemu-restrict.sh), checked against the measured launch."""
    import base64
    out = []
    for argv in records:
        a = argv[1:]
        val = lambda flag: [a[i + 1] for i, x in enumerate(a[:-1]) if x == flag]
        snp = [x for x in val('-object') if x.startswith('sev-snp-guest,')]
        out.append({'measuredCmdline': val('-append') == [MEASURED_CMDLINE], 'smp': val('-smp') == [str(CPUS)], 'mem': val('-m') == [str(MEM_MIB)],
                    'ovmf': val('-bios') == [str(OVMF)], 'kernel': val('-kernel') == [str(IMAGE / 'vmlinuz')], 'initrd': val('-initrd') == [str(IMAGE / 'initramfs.cpio.gz')],
                    'snpKernelHashesAndHostData': len(snp) == 1 and 'kernel-hashes=on' in snp[0] and f"host-data={base64.b64encode(bytes.fromhex(host_data_hex)).decode()}" in snp[0],
                    'netdevRestrictedOneLoopbackForwardToControlFront': val('-netdev') == [f'user,id=net0,restrict=on,hostfwd=tcp:127.0.0.1:{ctl_port}-:{CONTROL_PORT}'],
                    'noDrives': '-drive' not in a, 'realQemu': argv[0] == str(QEMU)})
    return out
def sanitize(text, secrets_):
    for s in secrets_:
        if s: text = text.replace(s, '<redacted>')
    return '\n'.join('<line redacted: secret-shaped>' if SECRETISH.search(l) else l for l in text.splitlines()) + '\n'

# ---------------------------------------------------------------------------------------------------------------------------
def gates():
    """Read-only preflight. -> list of (name, ok, detail)"""
    g = []
    def gate(name, ok, detail=''): g.append((name, bool(ok), detail))
    gate('SEV-SNP enabled (kvm_amd sev_snp=Y)', pathlib.Path('/sys/module/kvm_amd/parameters/sev_snp').read_text().strip() == 'Y')
    gate('/dev/sev and /dev/kvm read+write for this user', all(os.access(p, os.R_OK | os.W_OK) for p in ('/dev/sev', '/dev/kvm')))
    cpu = pathlib.Path('/proc/cpuinfo').read_text()
    sig = tuple(int(re.search(rf'^{k}\s*:\s*(\d+)', cpu, re.M).group(1)) for k in ('cpu family', 'model', 'stepping'))
    gate('CPU signature = the measurement recipe (family 26 model 2 stepping 1)', sig == (26, 2, 1), str(sig))
    gate(f'>= {CPUS} host CPUs', os.cpu_count() >= CPUS, str(os.cpu_count()))
    for f, want in IMAGE_SHA.items():
        p = IMAGE / f; gate(f'image {f} == build receipt', p.is_file() and sha256_file(p) == want, want[:16])
    try: m = expected_measurement(); gate('expected measurement (full 96 hex) from the receipt == image MEASUREMENT', True, m)
    except SystemExit as e: gate('expected measurement from the receipt', False, str(e))
    gate('image cmdline template + metal.mode=snp == the measured cmdline the launcher builds',
         (IMAGE / 'cmdline').read_text().strip().replace('${MODE}', 'snp') == MEASURED_CMDLINE)
    gate('OVMF == pinned (the measured firmware)', OVMF.is_file() and sha256_file(OVMF) == OVMF_SHA, OVMF_SHA[:16])
    gate('QEMU binary == pinned', QEMU.is_file() and sha256_file(QEMU) == QEMU_SHA, QEMU_SHA[:16])
    lines = (D / 'tree.sha256').read_text()
    r = subprocess.run(['bash', '-c', f'cd {TREE} && find . -path ./node_modules -prune -o -type f -print0 | sort -z | xargs -0 sha256sum'], capture_output=True, text=True)
    gate('tree == the staged git archive of 6f2c7da4 (tree.sha256)', r.stdout == lines, hashlib.sha256(lines.encode()).hexdigest()[:16])
    for p, st in PROTECTED.items():
        gate(f'protected QEMU {p} present with its recorded identity', starttime(p) == st and (comm(p) or '').startswith('qemu'), f'starttime {starttime(p)}')
    gate('production guestd ports are NOT the canary\'s (8095/8096 listening is expected, informational)', True,
         f'8095 listening={listening(8095)} 8096 listening={listening(8096)}')
    need = FLOOR_MIB + CAP_MIB + MARGIN_MIB; a = available_mib()
    gate(f'MemAvailable >= {FLOOR_MIB} floor + {CAP_MIB} cap + {MARGIN_MIB} margin = {need} MiB', a >= need, f'{a} MiB')
    gate('public AMD collateral cache present (copied read-only at run time)', (COLLATERAL_SRC / 'Turin/chain.pem').is_file(), str(COLLATERAL_SRC))
    gate('runs/ parent has >= 2 GiB free', shutil.disk_usage(D).free >= 2 << 30)
    gate('ssh/scp/sftp stubs first in PATH', all(shutil.which(c) == str(STUB_BIN / c) for c in ('ssh', 'scp', 'sftp')))
    return g

# ---------------------------------------------------------------------------------------------------------------------------
def child(run):
    def interrupted(signum, frame): raise KeyboardInterrupt(f'canary interrupted by signal {signum}')
    signal.signal(signal.SIGTERM, interrupted); signal.signal(signal.SIGINT, interrupted)
    before_q, before_s = qemus(), user_services()
    save(run, 'protected-before.json', {'qemus': before_q, 'services': before_s})
    private = run / 'private'; private.mkdir(mode=0o700); (private / 'tmp').mkdir(mode=0o700)
    result = dict(startedAt=now(), scope='BARE direct control: hardware quote + bound config + attested TLS key + running supervisor keys. '
                  'No MCP, no Platform API, no apps, no registration: NOT service readiness.',
                  noRegistryKey=True, notSelling=True, noFleetSecret=True, noRelayOrTunnel=True, netRestricted=True,
                  productionActivated=False)
    M = expected_measurement()
    launcher, owned, stop_poll = None, {}, threading.Event()
    collateral_before = tree_fingerprint(COLLATERAL_SRC)
    pairing = secrets.token_hex(32)
    try:
        ctl, mgr, data = pick_ports(3)
        result['ports'] = {'controlHostLoopback': ctl, 'guestdStandInManager': mgr, 'guestdStandInData': data, 'productionGuestdAvoided': list(PRODUCTION_GUESTD)}
        for p in (ctl, mgr, data):
            if listening(p): raise RuntimeError(f'port {p} has a listener')
        (private / 'pairing.key').write_text(pairing + '\n'); os.chmod(private / 'pairing.key', 0o600)
        env = dict(PATH=f'{STUB_BIN}:/usr/bin:/usr/sbin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8', TMPDIR=str(private / 'tmp'))
        oc = subprocess.run([str(NODE), str(D / 'canary/owner-config.mjs'), '--manager-port', str(mgr), '--data-port', str(data),
                             '--out', str(private / 'owner-config.json')], env=env, capture_output=True, text=True, timeout=30, check=True)
        result['ownerConfig'] = json.loads(oc.stdout)
        shutil.copyfile(private / 'owner-config.json', run / 'owner-config.json')          # public: the bound config
        host = dict(mode='snp', name='direct-control-canary', cpus=CPUS, memMiB=MEM_MIB, dist=str(IMAGE), ovmf=str(OVMF),
                    qemu=str(D / 'canary/qemu-restrict.sh'), sevDevice='/dev/sev', control='direct', direct=str(private / 'owner-config.json'),
                    isolation=dict(backend='snp-guest-per-app', pairingKeyFile=str(private / 'pairing.key'),
                                   managerUrl=f'http://10.0.2.2:{mgr}', dataAddr=f'10.0.2.2:{data}'),
                    hostfwd=[dict(host=ctl, guest=CONTROL_PORT)], measureGflops=False)
        (private / 'host-config.json').write_text(json.dumps(host, indent=1)); os.chmod(private / 'host-config.json', 0o600)
        save(run, 'host-config.public.json', {**host, 'isolation': {**host['isolation'], 'pairingKeyFile': '<private, 0600, deleted at the end>'}})
        shutil.copytree(COLLATERAL_SRC, private / 'collateral')                             # verifier writes only to this COPY
        (private / 'runtime.json').write_text(json.dumps(expected_runtime()))
        lenv = dict(env, CANARY_REAL_QEMU=str(QEMU), CANARY_REAL_QEMU_SHA256=QEMU_SHA, CANARY_QEMU_ARGV_LOG=str(private / 'qemu-argv.log'))
        with (private / 'serial.log').open('x') as log:
            launcher = subprocess.Popen([str(NODE), str(TREE / 'metal/enclave-metal.mjs'), '--config', str(private / 'host-config.json')],
                                        env=lenv, cwd=str(private), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        lid = (launcher.pid, None)
        for _ in range(50):
            lid = (launcher.pid, starttime(launcher.pid))
            if lid[1] is not None: break
            time.sleep(0.05)
        owned['launcher'] = list(lid)
        save(run, 'launcher.json', dict(pid=lid[0], starttime=lid[1], pgid=launcher.pid, startedAt=now()))
        def poll():                                   # every QEMU the launcher spawns (it relaunches an exited guest)
            while not stop_poll.is_set():
                for p in pathlib.Path('/proc').iterdir():
                    if p.name.isdigit() and ppid(p.name) == launcher.pid and (comm(p.name) or '').startswith('qemu'):
                        s = starttime(p.name)
                        if s is not None: owned.setdefault('qemus', {}).setdefault(p.name, s)
                time.sleep(0.5)
        threading.Thread(target=poll, daemon=True).start()
        with (run / 'verify.log').open('x') as vlog:
            v = subprocess.run([str(NODE), str(D / 'canary/verify-canary.mjs'), '--url', f'https://127.0.0.1:{ctl}', '--config', str(private / 'owner-config.json'),
                                '--measurement', M, '--expect-runtime', str(private / 'runtime.json'), '--collateral-dir', str(private / 'collateral'),
                                '--kds', ARGS.get('kds', 'on'), '--registry', ARGS.get('registry', 'on'), '--deadline-sec', str(VERIFY_DEADLINE_S),
                                '--out', str(run / 'verify-result.json')], env=env, stdout=vlog, stderr=subprocess.STDOUT, timeout=VERIFY_DEADLINE_S + 20)
        result['verifierExit'] = v.returncode
        if (run / 'verify-result.json').exists():
            vr = json.loads((run / 'verify-result.json').read_text()); result['verdict'] = vr.get('verdict'); result['statementChecks'] = vr.get('statementChecks')
        result['launcherAliveAtVerifyEnd'] = alive(tuple(owned['launcher']))
        result['qemuRelaunches'] = max(0, len(owned.get('qemus', {})) - 1)
        result['ok'] = v.returncode == 0 and (result.get('verdict') or {}).get('hardwarePass') is True and result['qemuRelaunches'] == 0
    except BaseException as e:                          # KeyboardInterrupt (timeout/TERM) included: cleanup below always runs
        result.update(ok=False, error=f'{type(e).__name__}: {e}'[:500])
    finally:
        stop_poll.set()
        cleanup = cleanup_group(launcher, owned)
        result['cleanup'] = cleanup
        after_q, after_s = qemus(), user_services()
        save(run, 'protected-after.json', {'qemus': after_q, 'services': after_s})
        result['protectedQemuIdentitiesUnchanged'] = all(after_q.get(str(p)) == before_q.get(str(p)) for p in PROTECTED) and \
            {k: v for k, v in after_q.items() if k not in map(str, (owned.get('qemus') or {}))} == before_q
        result['userServicesUnchanged'] = after_s == before_s
        # sanitized copies, then the private directory (fw_cfg, pairing key, host config, collateral copy) is removed
        try:
            fw = next((private / 'tmp').glob('metal-fwcfg-*.json'), None)
            if fw:
                c = json.loads(fw.read_text())
                result['fwCfgSummary'] = {'keys': sorted(c), 'registryKeyEmpty': c.get('registryKey') == '', 'fleetSecretEmpty': c.get('fleetSecret') == '',
                    'relayUrlEmpty': c.get('relayUrl') == '', 'tunnelTokenEmpty': c.get('tunnelToken') == '', 'noAcme': not c.get('acmeEabKid'),
                    'certsApiEmpty': not c.get('certsApi'), 'isolation': {k: (v if k != 'pairingKey' else '<64 hex, redacted>') for k, v in (c.get('isolation') or {}).items()},
                    'directIsOwnerConfig': c.get('direct') == json.loads((private / 'owner-config.json').read_text()), 'volumes': c.get('volumes'), 'fileMode': oct(fw.stat().st_mode & 0o777)}
            if (private / 'serial.log').exists():
                (run / 'serial.sanitized.log').write_text(sanitize((private / 'serial.log').read_text(errors='replace'), [pairing]))
            if (private / 'qemu-argv.log').exists():
                recs = [r.split('\0') for r in (private / 'qemu-argv.log').read_text().split('\0\n') if r]   # one record per QEMU start
                (run / 'qemu-argv.json').write_text(json.dumps([[a.replace(str(private), '<private>') for a in r] for r in recs], indent=1))
                if result.get('ownerConfig'):
                    result['qemuArgvChecks'] = argv_checks(recs, result['ownerConfig']['hostData'], result['ports']['controlHostLoopback'])
            result['collateralSourceUnchanged'] = tree_fingerprint(COLLATERAL_SRC) == collateral_before
        except Exception as e:
            result['sanitizeError'] = str(e)[:300]
        shutil.rmtree(private, ignore_errors=True)
        result['privateRemoved'] = not private.exists()
        result['finishedAt'] = now()
        argv_ok = bool(result.get('qemuArgvChecks')) and all(all(c.values()) for c in result['qemuArgvChecks'])
        result['ok'] = bool(result.get('ok')) and argv_ok and cleanup['allOwnedAbsent'] and result['protectedQemuIdentitiesUnchanged'] and result['privateRemoved'] \
            and result.get('collateralSourceUnchanged') is True
        save(run, 'result.json', result)
    print(json.dumps({k: v for k, v in result.items() if k not in ('statementChecks',)}, indent=2), flush=True)
    return 0 if result['ok'] else 1

def cleanup_group(launcher, owned):
    """SIGTERM the launcher's process group (the launcher then stops its QEMU), bounded waits, SIGKILL the group, then PROVE
    that every owned identity (launcher + every QEMU it spawned) is gone. Only this group; never by name."""
    out = {'steps': []}
    if launcher is None: out['allOwnedAbsent'] = True; return out
    owned.setdefault('launcher', [launcher.pid, starttime(launcher.pid)])
    def group(sig):
        try: os.killpg(launcher.pid, sig); out['steps'].append(f'killpg {sig.name}')
        except ProcessLookupError: out['steps'].append(f'killpg {sig.name}: group already gone')
    group(signal.SIGTERM)
    try: launcher.wait(timeout=8)
    except subprocess.TimeoutExpired: out['steps'].append('launcher alive 8 s after SIGTERM')
    ids = [tuple(owned['launcher'])] + [(int(p), s) for p, s in (owned.get('qemus') or {}).items()]
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and any(alive(i) for i in ids): time.sleep(0.25)
    if any(alive(i) for i in ids) or launcher.poll() is None:
        group(signal.SIGKILL)
        try: launcher.wait(timeout=3)
        except subprocess.TimeoutExpired: out['steps'].append('launcher alive 3 s after SIGKILL')
        deadline = time.monotonic() + 6
        while time.monotonic() < deadline and any(alive(i) for i in ids): time.sleep(0.25)
    out['identities'] = [{'pid': i[0], 'starttime': i[1], 'alive': alive(i)} for i in ids]
    out['allOwnedAbsent'] = not any(alive(i) for i in ids)
    return out

# ---------------------------------------------------------------------------------------------------------------------------
ARGS = {}
def main():
    a = sys.argv[1:]
    for k in ('kds', 'registry'):
        if f'--{k}' in a:
            v = a[a.index(f'--{k}') + 1]
            if v not in ('on', 'off'): raise SystemExit(f'--{k} on|off')
            ARGS[k] = v
    if a[:1] == ['--child']:
        return child(pathlib.Path(a[1]))
    if a[:1] == ['--preflight']:
        g = gates()
        for name, ok, detail in g: print(f"{'PASS' if ok else 'FAIL'}  {name}" + (f'  [{detail}]' if detail else ''))
        ok = all(x[1] for x in g); print('PREFLIGHT', 'PASS' if ok else 'FAIL'); return 0 if ok else 1
    if a[:1] != ['--run']:
        raise SystemExit(__doc__)
    locks = []
    for name in ('claude-test-queue.lock', 'claude-test-small-queue.lock'):
        f = (WORK / name).open('a+')
        try: fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError: print('NOT STARTED: a shared queue lane is busy', flush=True); return 98
        locks.append(f)
    g = gates()
    if not all(x[1] for x in g):
        for name, ok, detail in g: print(f"{'PASS' if ok else 'FAIL'}  {name}  [{detail}]")
        print('NOT STARTED: preflight failed', flush=True); return 98
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    (D / 'runs').mkdir(mode=0o700, exist_ok=True)
    run = D / 'runs' / stamp; run.mkdir(mode=0o700)                       # never reused
    (run / 'preflight.txt').write_text('\n'.join(f"{'PASS' if ok else 'FAIL'}  {n}  [{d}]" for n, ok, d in g) + '\n')
    pinned = [IMAGE / f for f in IMAGE_SHA] + [OVMF, QEMU, NODE, RECEIPT, INPUTS, D / 'tree.sha256'] + \
             [D / 'canary' / f for f in ('run-canary.py', 'verify-canary.mjs', 'owner-config.mjs', 'qemu-restrict.sh')] + \
             [TREE / f for f in ('metal/enclave-metal.mjs', 'metal/measured-control-verify.mjs', 'metal/guest/measured-control.mjs', 'test/helpers/memory-guard.mjs')]
    save(run, 'attempt.json', dict(at=now(), measurement=expected_measurement(), capMiB=CAP_MIB, floorMiB=FLOOR_MIB, guestMemMiB=MEM_MIB, cpus=CPUS,
         childTimeoutS=CHILD_TIMEOUT_S, killAfterS=KILL_AFTER_S, kds=ARGS.get('kds', 'on'), registry=ARGS.get('registry', 'on'),
         exclusiveBothQueueLanes=True, hashes={str(p): sha256_file(p) for p in pinned}))
    unit = f'enclave-direct-control-canary-{stamp.lower()}'
    env = dict(PATH=f'{STUB_BIN}:/usr/bin:/usr/sbin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8',
               XDG_RUNTIME_DIR=os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'),
               DBUS_SESSION_BUS_ADDRESS=os.environ.get('DBUS_SESSION_BUS_ADDRESS', f'unix:path=/run/user/{os.getuid()}/bus'))
    cmd = ['systemd-run', '--user', '--scope', '--quiet', f'--unit={unit}', '-p', f'MemoryMax={CAP_MIB}M', '-p', 'MemorySwapMax=0',
           str(NODE), str(TREE / 'test/helpers/memory-guard.mjs'), '--max-rss-mib', str(CAP_MIB), '--floor-available-mib', str(FLOOR_MIB),
           '--log', str(run / 'memory.log'), '--', 'timeout', '--signal=TERM', f'--kill-after={KILL_AFTER_S}s', f'{CHILD_TIMEOUT_S}s',
           sys.executable, str(pathlib.Path(__file__).resolve()), '--child', str(run)] + \
          sum(([f'--{k}', v] for k, v in ARGS.items()), [])
    (run / 'command.json').write_text(json.dumps(cmd, indent=1))
    with (run / 'execution.log').open('x') as out:
        code = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, env=env).wait()
    # the scope's cgroup holds every process of this run whatever its session: stop it (a no-op when empty), then prove
    # that no process naming this run's directory survives
    stop = subprocess.run(['systemctl', '--user', 'stop', f'{unit}.scope'], capture_output=True, text=True, timeout=30, env=env)
    survivors = []
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or p.name == str(os.getpid()): continue
        try: cl = (p / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf8', 'replace')
        except OSError: continue
        if str(run) in cl: survivors.append(p.name)
    if survivors and code == 0: code = 1
    # if memory-guard SIGKILLed the child before its finally ran, the private directory (fw_cfg, test pairing key) is removed here
    leftover = (run / 'private').exists()
    if leftover: shutil.rmtree(run / 'private', ignore_errors=True)
    if leftover and code == 0: code = 1
    save(run, 'terminal.json', dict(at=now(), exitCode=code, scopeStop=stop.returncode, survivors=survivors,
                                    privateLeftoverRemovedByOuter=leftover, privateAbsent=not (run / 'private').exists(),
                                    protectedNow={str(p): starttime(p) for p in PROTECTED}))
    print('CANARY TERMINAL', code, str(run), flush=True)
    return code

if __name__ == '__main__': sys.exit(main())
