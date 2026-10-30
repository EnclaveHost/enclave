#!/usr/bin/env python3
"""ROOT-EXECUTED, bounded hardware canary of the VERIFIER-ONLY direct-control image (never a production activation).

One disposable SNP guest, booted by the launcher of the image's commit (tree/metal/enclave-metal.mjs, git archive of 10cdf913) from
the exact built image final-proof-image-stage/out/dist-direct-10cdf913, with a VERIFIER-ONLY owner config (canary/owner-config.mjs:
the bare config + chainVerifier expose "attested" whose only proof source is a refused loopback stand-in, so Base is UNREADY):
no registry key, no fleet secret, no relay/tunnel/certificate/ACME input, no apps, no MCP/Platform API/nativeControl member, guestd
endpoints on loopback ports proven to have NO listener (never production guestd 8095/8096), slirp with restrict=on
(canary/qemu-restrict.sh), and ONE loopback port forward to the guest's attested control front (8444), never the plain
supervisor port. The host-side verifier (canary/verify-canary.mjs) uses the published verifyMeasuredControl, verifySnp and the
production verifier-only client with real AMD collateral (a COPY of the existing public cache) and NO registry read. Scope:
hardware attestation + config binding + tamper/wrong-config/wrong-measurement rejection + route fail-closed (Base unready).

  python3 canary/run-canary.py --preflight     read-only gates (no run directory, no lock, no launch)
  python3 canary/run-canary.py --run [--kds on|off]
      ROOT ONLY, after root accepted this exact source (FROZEN-PINS.json), in a quiet window. Takes BOTH shared queue lanes
      (non-blocking: exit 98 if busy). Memory admission (root rule 2026-10-25): RPC VM active -> MemAvailable >= 16384 floor +
      3072 canary; RPC VM NOT active -> its 66 GiB restart reservation is held too: >= 67584 + 3072 + 16384 = 87040 MiB, and
      the memory-guard floor during the run is 16384 + 67584 (the canary yields to an RPC restart: abort, never a pass).
      Re-verifies every frozen pin, creates runs/<UTC stamp> (0700, never reused), then supervise(): systemd-run --user --scope
      (MemoryMax=3072M, MemorySwapMax=0, CPUQuota=200%) memory-guard (3072, floor) timeout -> --child. The child re-verifies the
      pins right before the launcher starts.

Ownership rules (root review 2026-10-22 20:31-20:32Z):
  - a process is OURS only by (pid, /proc starttime) recorded when we started or observed it as the launcher's child;
  - a process GROUP is signalled only while at least one owned identity is alive AND still in that group (a group id
    cannot be reused while any member lives), so a reused pgid is never signalled; nothing is ever killed by name;
  - the transient scope this run created is the ultimate boundary: the parent stops ONLY that unit on every exit path
    (normal, exception, SIGTERM/SIGINT/SIGHUP), proves its cgroup empty and no process naming this run survives, and only
    then scrubs this run's private/ directory (fw_cfg, test pairing key); logs and results are kept.
Acceptance (accept()) requires every promised check; the registry stays a separate diagnostic (expected "pending").
Adapted 2026-10-25 from the root-reviewed native-final-canary/canary/run-canary.py (bc3397ef; run 20261022T225651Z PASSED):
image/receipt/runtime paths, 2048 MiB guest / 3072 MiB scope / CPUQuota 200%, the RPC-reservation admission and floor, the
protected QEMU set taken as a run-time snapshot (every pre-existing QEMU identity must be unchanged; the 10-22 pids are gone),
the verifier-only no-key checks (no host-level chainVerifier/platformPolicyCarriers; fw direct = the verifier-only config),
the wrong-config variant, no registry option, and the scope memory peak record. Ownership and cleanup rules are unchanged.
"""
import datetime, fcntl, hashlib, json, os, pathlib, re, secrets, shutil, signal, socket, subprocess, sys, threading, time

D = pathlib.Path(__file__).resolve().parents[1]
WORK = D.parents[1]                                   # .../wo/work
TREE = D / 'tree'
FROZEN = D / 'FROZEN-PINS.json'
BUILD = D.parent / 'final-proof-image-stage'
IMAGE = BUILD / 'out/dist-direct-10cdf913'
RECEIPT = BUILD / 'receipts/image-verify-direct.json'       # the independent 45/45 image verification (ok: true)
INPUTS = BUILD / 'receipts/measurement-B.txt'               # the independent measurement recomputation
# final-proof-canary: the measurement is NOT known until root's build + independent verification succeed. Root writes it ONCE with
# tools/write-expected.sh (consistency-checked against the build receipts) and it is frozen in FROZEN-PINS.json; absent -> refuse.
EXPECTED_FILE = D / 'EXPECTED-MEASUREMENT.txt'
SOURCE_COMMIT, SOURCE_TREE = '10cdf913b9b8bb168156e42da2a9a2a26c2526ad', '3b0f8114c07dfb30f15720155659259a018caad7'
FINAL_NATIVE = {'opt/rpc-runtime/helios': '8250f08a7b0e1f2432ea6262903ca3203b60bca6a8e17abd6d9bccbe0dbfa378',
                'opt/rpc-runtime/enclave-base-head-listener': '9ca75047ab9ee4f2c44a211b237aa5a8171af1661b17047aafaf2e9b63d10ba3',
                'opt/rpc-runtime/witness-check': '4fe0cd3b1a9fd28fc324cd4d58079fea3bc41836dab86cddbcf83fe9c3023411'}
RPC_UNIT, RPC_RESERVE_MIB = 'enclave-rpc-production-vm.service', 67584   # 66 GiB restart reservation held while it is down
OVMF = pathlib.Path('/home/steven/.cache/enclave-isolation/fwbuild/OVMF.amdsev.fd')
QEMU = pathlib.Path('/usr/bin/qemu-system-x86_64')
NODE = pathlib.Path('/usr/bin/node')
COLLATERAL_SRC = pathlib.Path('/home/steven/enclave-prod/capacity-audit/state/amd')   # public AMD collateral: COPIED, never written
MEASURED_CMDLINE = 'console=ttyS0 root=/dev/ram0 rootfstype=ramfs quiet metal.mode=snp metal.isolation=snp-guest-per-app metal.control=direct'
PRODUCTION_GUESTD = (8095, 8096)
CPUS, MEM_MIB, CONTROL_PORT = 4, 2048, 8444           # 4 vCPU: the measurement recipe; guest RAM is not measured
CAP_MIB, FLOOR_MIB, CPU_QUOTA = 3072, 16384, '200%'   # scope MemoryMax = guest 2048 + 1024 QEMU/launcher/verifier overhead
CHILD_TIMEOUT_S, KILL_AFTER_S, VERIFY_DEADLINE_S = 420, 40, 300   # verifier: boot + A..D probes; cleanup_group ~22 s < KILL_AFTER_S
STUB_BIN = D / 'bin'
FORBIDDEN_HOST_KEYS = ('registryKey', 'registryKeyFile', 'fleetSecret', 'relayUrl', 'tunnelToken', 'certsApi', 'acmeEabKid', 'acmeEabHmac',
                       'acmeBringYourOwn', 'egressHelper', 'publicUrl', 'referral', 'volumes', 'leaseGas', 'ownerNomination', 'hostAdmission', 'vcekFile',
                       'chainVerifier', 'platformPolicyCarriers')

def now(): return datetime.datetime.now(datetime.timezone.utc).isoformat()
def sha256_file(p):
    h = hashlib.sha256()
    with open(p, 'rb') as f:
        for c in iter(lambda: f.read(1 << 20), b''): h.update(c)
    return h.hexdigest()
def save(run, name, value):
    with (pathlib.Path(run) / name).open('x') as f: json.dump(value, f, indent=2)
def available_mib():
    return next(int(l.split()[1]) // 1024 for l in pathlib.Path('/proc/meminfo').read_text().splitlines() if l.startswith('MemAvailable:'))
def _stat(pid):
    try: st = pathlib.Path(f'/proc/{pid}/stat').read_text(); return st[st.rfind(')') + 2:].split()
    except OSError: return None
def starttime(pid):
    f = _stat(pid); return int(f[19]) if f and len(f) > 19 else None
def ppid(pid):
    f = _stat(pid); return int(f[1]) if f else None
def pgid_of(pid):
    f = _stat(pid); return int(f[2]) if f else None
def comm(pid):
    try: return pathlib.Path(f'/proc/{pid}/comm').read_text().strip()
    except OSError: return None
def alive(identity):
    """identity = (pid, starttime): alive only if it is the SAME process (a reused pid never counts)."""
    return identity[1] is not None and starttime(identity[0]) == identity[1]
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
    return bool(subprocess.run(['ss', '-ltnH', f'sport = :{port}'], capture_output=True, text=True, timeout=10).stdout.strip())
def pick_ports(n):
    out = []
    while len(out) < n:
        with socket.socket() as s:
            s.bind(('127.0.0.1', 0)); p = s.getsockname()[1]
        if p in PRODUCTION_GUESTD or p in out or listening(p): continue
        out.append(p)
    return out
def expected_measurement():
    if not EXPECTED_FILE.exists(): raise RuntimeError('EXPECTED-MEASUREMENT.txt is absent: the final image is not built and verified yet')
    m = EXPECTED_FILE.read_text().strip()
    if not re.fullmatch(r'[0-9a-f]{96}', m): raise RuntimeError('EXPECTED-MEASUREMENT.txt is not exactly one 96-hex SNP measurement')
    rec = json.loads(RECEIPT.read_text())
    if rec.get('ok') is not True or not rec.get('checks') or not all(c.get('ok') is True for c in rec['checks']): raise RuntimeError('the image verification receipt is not ok')
    if rec.get('commit') != SOURCE_COMMIT: raise RuntimeError(f"the image verification receipt is for {rec.get('commit')}, not {SOURCE_COMMIT}")
    for k, v in FINAL_NATIVE.items():
        if ((rec.get('native') or {}).get(k) or {}).get('sha256') != v: raise RuntimeError(f'the verified image native {k} is not {v[:12]}')
    if INPUTS.read_text().strip() != m: raise RuntimeError('the independent measurement recomputation differs')
    if (IMAGE / 'MEASUREMENT').read_text().strip() != m: raise RuntimeError('image MEASUREMENT differs from the pinned value')
    return m
def expected_runtime():
    f = {r['path']: r['sha256'] for r in json.loads((IMAGE / 'manifest.json').read_text())['controlOverlay']['files']}
    return {'gsupSha256': f['/opt/metal/gsup.mjs'], 'helperSha256': f['/opt/metal/measured-control.mjs'], 'supervisorSha256': f['/app/supervisor.js']}
def rpc_state():
    """the RPC VM user unit: (active?, reserve MiB held for its restart while it is not active)."""
    r = subprocess.run(['systemctl', '--user', 'show', RPC_UNIT, '-p', 'ActiveState', '-p', 'MemoryMax'], capture_output=True, text=True, timeout=20).stdout
    kv = dict(l.split('=', 1) for l in r.splitlines() if '=' in l)
    mm = kv.get('MemoryMax', '')
    reserve = max(RPC_RESERVE_MIB, int(mm) // (1 << 20)) if mm.isdigit() else RPC_RESERVE_MIB
    return kv.get('ActiveState') == 'active', reserve, kv.get('ActiveState', 'unknown')
def admission():
    """-> (need MiB at start, guard floor MiB during the run, detail). Root rule 2026-10-25."""
    active, reserve, state = rpc_state()
    if active: return FLOOR_MIB + CAP_MIB, FLOOR_MIB, f'RPC {state}: floor {FLOOR_MIB} + canary {CAP_MIB}'
    return reserve + CAP_MIB + FLOOR_MIB, FLOOR_MIB + reserve, f'RPC {state}: reserve {reserve} + canary {CAP_MIB} + floor {FLOOR_MIB}'
def qemu_units():
    out = {}
    for pid in qemus():
        try: out[pid] = pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip().rsplit('/', 1)[-1]
        except OSError: out[pid] = None
    return out
SECRETISH = re.compile(r'(SECRET|PRIVATE_KEY|ADMIN_TOKEN|MNEMONIC|PASSWORD|pairingKey)\s*["=:]', re.I)
def sanitize(text, secrets_):
    for s in secrets_:
        if s: text = text.replace(s, '<redacted>')
    return '\n'.join('<line redacted: secret-shaped>' if SECRETISH.search(l) else l for l in text.splitlines()) + '\n'
def tree_fingerprint(root):
    """sha256 over (relative path, size, mtime_ns, sha256) of every file: proves a read-only source was not written."""
    h = hashlib.sha256()
    for p in sorted(pathlib.Path(root).rglob('*')):
        if p.is_file(): st = p.stat(); h.update(f'{p.relative_to(root)}\0{st.st_size}\0{st.st_mtime_ns}\0{sha256_file(p)}\n'.encode())
    return h.hexdigest()
def file_list_sha(root, prune_node_modules):
    expr = '-path ./node_modules -prune -o -type f -print0' if prune_node_modules else '-type f -print0'
    out = subprocess.run(['bash', '-c', f'cd "{root}" && find . {expr} | sort -z | xargs -0 sha256sum'], capture_output=True, text=True, check=True).stdout
    return hashlib.sha256(out.encode()).hexdigest()

# ---- frozen pins: the exact source/inputs root accepts; re-verified at the launch boundary ---------------------------------
def pin_targets():
    """name -> callable computing the CURRENT value. Files by sha256; the source tree and its node_modules by file-list sha."""
    files = {f'canary/{f}': D / 'canary' / f for f in ('run-canary.py', 'verify-canary.mjs', 'owner-config.mjs', 'qemu-restrict.sh')}
    files.update({f'bin/{c}': D / 'bin' / c for c in ('ssh', 'scp', 'sftp')})
    files.update({f'image/{f}': IMAGE / f for f in ('vmlinuz', 'initramfs.cpio.gz', 'cmdline', 'manifest.json', 'MEASUREMENT')})
    files.update({'ovmf': OVMF, 'qemu': QEMU, 'node': NODE, 'receipt': RECEIPT, 'inputs': INPUTS, 'tree.sha256': D / 'tree.sha256',
                  'expected-measurement': EXPECTED_FILE})
    files.update({f'tools/{f}': D / 'tools' / f for f in ('env.sh',)})
    t = {k: (lambda p=p: sha256_file(p)) for k, p in files.items()}
    t['tree/source-files'] = lambda: file_list_sha(TREE, True)
    t['tree/node_modules'] = lambda: file_list_sha(TREE / 'node_modules', False)
    return t
def verify_pins(frozen=None, targets=None):
    """-> list of mismatching names ([] = every frozen pin holds now)."""
    frozen = frozen if frozen is not None else json.loads(FROZEN.read_text())['pins']
    targets = targets or pin_targets()
    bad = [k for k in targets if k not in frozen]
    for k, want in frozen.items():
        try: got = targets[k]() if k in targets else None
        except Exception: got = None
        if got != want: bad.append(k)
    return sorted(set(bad))

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

def no_key_evidence(host_cfg, fw, owner_cfg, ports):
    """no signer, no claim, no relay: judged from the launcher's OWN inputs (host config) and OUTPUT (the fw_cfg it wrote)."""
    iso = (fw or {}).get('isolation') or {}
    return {
        'hostConfigHasNoKeyOrRelayInput': not any(k in host_cfg for k in FORBIDDEN_HOST_KEYS),
        'fwRegistryKeyEmpty': (fw or {}).get('registryKey') == '', 'fwFleetSecretEmpty': (fw or {}).get('fleetSecret') == '',
        'fwRelayAndTunnelEmpty': (fw or {}).get('relayUrl') == '' and (fw or {}).get('tunnelToken') == '' and 'relayHost' not in (fw or {}),
        'fwNoCertificateOrAcmeInput': not (fw or {}).get('certsApi') and not (fw or {}).get('acmeEabKid') and not (fw or {}).get('acmeEabHmac'),
        'fwNoVolumes': (fw or {}).get('volumes') == [], 'fwNoLeaseGasOrNomination': 'leaseGas' not in (fw or {}) and 'ownerNomination' not in (fw or {}),
        'fwDirectIsTheOwnerConfig': fw is not None and fw.get('direct') == owner_cfg,
        'fwDirectIsVerifierOnly': fw is not None and ((fw.get('direct') or {}).get('chainVerifier') or {}).get('expose') == 'attested'
            and 'txBackend' not in (fw.get('direct') or {}).get('chainVerifier', {}) and not any(k in (fw.get('direct') or {}) for k in ('mcp', 'platformApi', 'leaseGas', 'ownerNomination', 'nativeControl')),
        'fwNoHostLevelChainVerifier': fw is not None and 'chainVerifier' not in fw and 'platformPolicyCarriers' not in fw,
        'proofSourceIsTheRefusedStandIn': ((owner_cfg or {}).get('chainVerifier') or {}).get('proofSources') == [f"http://10.0.2.2:{ports['proofStandIn']}/"],
        'fwIsolationIsTheRefusedStandIns': iso.get('managerUrl') == f"http://10.0.2.2:{ports['guestdStandInManager']}" and iso.get('dataAddr') == f"10.0.2.2:{ports['guestdStandInData']}"
            and 'release' not in iso and not any(f':{p}' in str(iso.get('managerUrl', '')) + str(iso.get('dataAddr', '')) for p in PRODUCTION_GUESTD),
        'ownerConfigNotSelling': (owner_cfg or {}).get('selling') == {'cpuPrice6': None, 'payout': None},
    }

def accept(result):
    """-> (ok, failed): EVERY promised check gates acceptance (root review). The registry stays diagnostic."""
    req = {
        'no error': not result.get('error'),
        'frozen pins hold at the launch boundary': result.get('pinsAtLaunch') == [],
        'verifier exit 0': result.get('verifierExit') == 0,
        'verifier acceptance (A hardware + binding, B tamper/replay, C wrong measurement/config, D route fail-closed)': (result.get('acceptance') or {}).get('pass') is True,
        'exactly one QEMU started (no relaunch)': result.get('qemuStarts') == 1,
        'QEMU argv = the measured, restricted launch': bool(result.get('qemuArgvChecks')) and all(all(c.values()) for c in result['qemuArgvChecks']),
        'no key / no relay evidence from the launcher\'s own inputs and fw_cfg': bool(result.get('noKeyEvidence')) and all(result['noKeyEvidence'].values()),
        'fw_cfg file mode 0600 in a 0700 directory': result.get('fwCfgModes') == ['0o600', '0o700'],
        'every owned process absent, no foreign group signalled': (result.get('cleanup') or {}).get('allOwnedAbsent') is True and not (result.get('cleanup') or {}).get('refused'),
        'every pre-existing QEMU identity unchanged (run-time snapshot)': result.get('protectedQemuIdentitiesUnchanged') is True,
        'RPC VM unit state unchanged during the run': result.get('rpcStateUnchanged') is True,
        'running user services unchanged': result.get('userServicesUnchanged') is True,
        'collateral source unchanged': result.get('collateralSourceUnchanged') is True,
        'private directory removed': result.get('privateRemoved') is True,
    }
    failed = [k for k, ok in req.items() if not ok]
    return not failed, failed

# ---- process ownership ---------------------------------------------------------------------------------------------------
def owned_group_alive(pgid, ids):
    """True only while an owned identity is alive AND still a member of pgid (then the group cannot have been reused)."""
    return any(alive(i) and pgid_of(i[0]) == pgid for i in ids)
def signal_owned_group(pgid, ids, sig, out):
    if not owned_group_alive(pgid, ids):
        out['steps'].append(f'{sig.name}: no owned member alive in group {pgid}: nothing signalled'); return False
    try: os.killpg(pgid, sig); out['steps'].append(f'killpg {pgid} {sig.name}'); return True
    except ProcessLookupError: out['steps'].append(f'killpg {pgid} {sig.name}: group gone'); return False
def cleanup_group(launcher, owned, waits=(8, 4, 3, 6)):
    """Stop the launcher's group (SIGTERM, bounded waits, SIGKILL) ONLY while owned, then prove every owned identity gone."""
    out = {'steps': [], 'refused': False}
    if launcher is None: out['allOwnedAbsent'] = True; return out
    lid = tuple(owned.get('launcher') or (launcher.pid, None))
    pgid = owned.get('pgid', launcher.pid)
    ids = [lid] + [tuple(v) for v in (owned.get('children') or {}).values()]
    if lid[1] is None or pgid != launcher.pid:
        out['refused'] = True; out['steps'].append('launcher identity/group not bound at start: no group signal')
    else:
        signal_owned_group(pgid, ids, signal.SIGTERM, out)
        try: launcher.wait(timeout=waits[0])
        except subprocess.TimeoutExpired: out['steps'].append(f'launcher alive {waits[0]} s after SIGTERM')
        end = time.monotonic() + waits[1]
        while time.monotonic() < end and any(alive(i) for i in ids): time.sleep(0.2)
        if any(alive(i) for i in ids):
            signal_owned_group(pgid, ids, signal.SIGKILL, out)
            try: launcher.wait(timeout=waits[2])
            except subprocess.TimeoutExpired: out['steps'].append(f'launcher alive {waits[2]} s after SIGKILL')
            end = time.monotonic() + waits[3]
            while time.monotonic() < end and any(alive(i) for i in ids): time.sleep(0.2)
    if launcher.poll() is None:
        try: launcher.wait(timeout=1)
        except subprocess.TimeoutExpired: pass
    out['identities'] = [{'pid': i[0], 'starttime': i[1], 'alive': alive(i)} for i in ids]
    out['allOwnedAbsent'] = not any(alive(i) for i in ids)
    return out

# ---- read-only preflight ------------------------------------------------------------------------------------------------
def gates():
    g = []
    def gate(name, ok, detail=''): g.append((name, bool(ok), detail))
    gate('SEV-SNP enabled (kvm_amd sev_snp=Y)', pathlib.Path('/sys/module/kvm_amd/parameters/sev_snp').read_text().strip() == 'Y')
    gate('/dev/sev and /dev/kvm read+write for this user', all(os.access(p, os.R_OK | os.W_OK) for p in ('/dev/sev', '/dev/kvm')))
    cpu = pathlib.Path('/proc/cpuinfo').read_text()
    sig = tuple(int(re.search(rf'^{k}\s*:\s*(\d+)', cpu, re.M).group(1)) for k in ('cpu family', 'model', 'stepping'))
    gate('CPU signature = the measurement recipe (family 26 model 2 stepping 1)', sig == (26, 2, 1), str(sig))
    gate(f'>= {CPUS} host CPUs', os.cpu_count() >= CPUS, str(os.cpu_count()))
    gate('FROZEN-PINS.json present', FROZEN.is_file(), sha256_file(FROZEN) if FROZEN.is_file() else 'missing')
    if FROZEN.is_file():
        bad = verify_pins(); gate('every frozen pin holds (canary helpers, stubs, image, OVMF, QEMU, node, receipt, source tree, node_modules)', not bad, ','.join(bad))
    try: m = expected_measurement(); gate('expected measurement: full 96 hex from the receipt == image MEASUREMENT', True, m)
    except Exception as e: gate('expected measurement from the receipt', False, str(e))
    gate('image cmdline template + metal.mode=snp == the measured cmdline the launcher builds',
         (IMAGE / 'cmdline').read_text().strip().replace('${MODE}', 'snp') == MEASURED_CMDLINE)
    gate('pre-existing QEMU identities recorded (protected: never signalled, must be unchanged after)', True, json.dumps({k: [qemus()[k], u] for k, u in qemu_units().items()}))
    gate('production guestd 8095/8096 are never the canary\'s endpoints (listening there is expected)', True,
         f'8095 listening={listening(8095)} 8096 listening={listening(8096)}')
    need, floor, why = admission(); a = available_mib()
    gate(f'MemAvailable >= {need} MiB ({why}); run guard floor {floor} MiB', a >= need, f'{a} MiB')
    cg = pathlib.Path('/sys/fs/cgroup/user.slice/user-1000.slice/user@1000.service/app.slice/cgroup.subtree_control')
    gate('user app.slice delegates cpu + memory (CPUQuota/MemoryMax enforceable in the scope)', cg.is_file() and {'cpu', 'memory'} <= set(cg.read_text().split()))
    gate('public AMD collateral cache present (copied read-only at run time)', (COLLATERAL_SRC / 'Turin/chain.pem').is_file(), str(COLLATERAL_SRC))
    gate('runs/ parent has >= 2 GiB free', shutil.disk_usage(D).free >= 2 << 30)
    gate('ssh/scp/sftp stubs first in PATH', all(shutil.which(c) == str(STUB_BIN / c) for c in ('ssh', 'scp', 'sftp')))
    gate('qemu-restrict.sh and the stubs are executable', all(os.access(x, os.X_OK) for x in [D / 'canary/qemu-restrict.sh'] + [STUB_BIN / c for c in ('ssh', 'scp', 'sftp')]))
    return g

# ---- child (inside the transient scope) ----------------------------------------------------------------------------------
ARGS = {}
def child(run):
    run = pathlib.Path(run)
    def interrupted(signum, frame): raise KeyboardInterrupt(f'canary interrupted by signal {signum}')
    for s_ in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP): signal.signal(s_, interrupted)
    before_q, before_s, rpc_before = qemus(), user_services(), rpc_state()[2]
    save(run, 'protected-before.json', {'qemus': before_q, 'services': before_s})
    private = run / 'private'; private.mkdir(mode=0o700); (private / 'tmp').mkdir(mode=0o700)
    result = dict(startedAt=now(), scope='VERIFIER-ONLY direct control: hardware quote + bound config + attested TLS key + running supervisor keys + exact runtime; '
                  'tamper/replay/wrong-measurement/wrong-config rejection; /chain-verifier fails closed while Base is unready. '
                  'NOT Base chain readiness, native provenance or finality; no registration, no MCP/Platform API/native names, no apps.', productionActivated=False)
    launcher, owned, stop_poll, pairing = None, {}, threading.Event(), secrets.token_hex(32)
    collateral_before = tree_fingerprint(COLLATERAL_SRC)
    host, owner_cfg = None, None
    try:
        M = expected_measurement()
        ctl, mgr, data, proof = pick_ports(4)
        result['ports'] = {'controlHostLoopback': ctl, 'guestdStandInManager': mgr, 'guestdStandInData': data, 'proofStandIn': proof, 'productionGuestdAvoided': list(PRODUCTION_GUESTD)}
        (private / 'pairing.key').write_text(pairing + '\n'); os.chmod(private / 'pairing.key', 0o600)
        env = dict(PATH=f'{STUB_BIN}:/usr/bin:/usr/sbin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8', TMPDIR=str(private / 'tmp'))
        ocargs = [str(NODE), str(D / 'canary/owner-config.mjs'), '--manager-port', str(mgr), '--data-port', str(data), '--proof-port', str(proof)]
        oc = subprocess.run(ocargs + ['--out', str(private / 'owner-config.json')], env=env, capture_output=True, text=True, timeout=30, check=True)
        result['ownerConfig'] = json.loads(oc.stdout)
        wc = subprocess.run(ocargs + ['--variant', 'wrong-config', '--out', str(private / 'wrong-config.json')], env=env, capture_output=True, text=True, timeout=30, check=True)
        result['wrongConfig'] = {k: v for k, v in json.loads(wc.stdout).items() if k in ('digest', 'hostData')}
        owner_cfg = json.loads((private / 'owner-config.json').read_text())
        shutil.copyfile(private / 'owner-config.json', run / 'owner-config.json')          # public: the bound config
        host = dict(mode='snp', name='direct-control-canary', cpus=CPUS, memMiB=MEM_MIB, dist=str(IMAGE), ovmf=str(OVMF),
                    qemu=str(D / 'canary/qemu-restrict.sh'), sevDevice='/dev/sev', control='direct', direct=str(private / 'owner-config.json'),
                    isolation=dict(backend='snp-guest-per-app', pairingKeyFile=str(private / 'pairing.key'),
                                   managerUrl=f'http://10.0.2.2:{mgr}', dataAddr=f'10.0.2.2:{data}'),
                    hostfwd=[dict(host=ctl, guest=CONTROL_PORT)], measureGflops=False)
        (private / 'host-config.json').write_text(json.dumps(host, indent=1)); os.chmod(private / 'host-config.json', 0o600)
        save(run, 'host-config.public.json', {**host, 'isolation': {**host['isolation'], 'pairingKeyFile': '<private, 0600, removed at the end>'}})
        shutil.copytree(COLLATERAL_SRC, private / 'collateral')                             # the verifier writes only to this COPY
        (private / 'runtime.json').write_text(json.dumps(expected_runtime()))
        for p in (ctl, mgr, data, proof):
            if listening(p): raise RuntimeError(f'port {p} has a listener')
        result['pinsAtLaunch'] = verify_pins()                                              # the launch boundary
        if result['pinsAtLaunch']: raise RuntimeError(f"frozen pins changed: {result['pinsAtLaunch']}")
        lenv = dict(env, CANARY_REAL_QEMU=str(QEMU), CANARY_REAL_QEMU_SHA256=json.loads(FROZEN.read_text())['pins']['qemu'],
                    CANARY_QEMU_ARGV_LOG=str(private / 'qemu-argv.log'))
        with (private / 'serial.log').open('x') as log:
            launcher = subprocess.Popen([str(NODE), str(TREE / 'metal/enclave-metal.mjs'), '--config', str(private / 'host-config.json')],
                                        env=lenv, cwd=str(private), stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        # bind ownership at once: our child (not reaped, so its pid cannot be reused), its starttime, and its own group
        lid = (launcher.pid, None)
        for _ in range(100):
            lid = (launcher.pid, starttime(launcher.pid))
            if lid[1] is not None and pgid_of(launcher.pid) == launcher.pid: break
            time.sleep(0.02)
        owned.update(launcher=list(lid), pgid=launcher.pid, children={})
        save(run, 'launcher.json', dict(pid=lid[0], starttime=lid[1], pgid=pgid_of(launcher.pid), startedAt=now()))
        def poll():                                   # every process the launcher spawns (QEMU via the wrapper; a relaunch too)
            while not stop_poll.is_set():
                for p in pathlib.Path('/proc').iterdir():
                    if p.name.isdigit() and ppid(p.name) == launcher.pid:
                        s = starttime(p.name)
                        if s is not None and p.name not in owned['children']: owned['children'][p.name] = (int(p.name), s)
                time.sleep(0.2)
        threading.Thread(target=poll, daemon=True).start()
        with (run / 'verify.log').open('x') as vlog:
            v = subprocess.run([str(NODE), str(D / 'canary/verify-canary.mjs'), '--url', f'https://127.0.0.1:{ctl}', '--config', str(private / 'owner-config.json'),
                                '--wrong-config', str(private / 'wrong-config.json'),
                                '--measurement', M, '--expect-runtime', str(private / 'runtime.json'), '--collateral-dir', str(private / 'collateral'),
                                '--kds', ARGS.get('kds', 'on'), '--deadline-sec', str(VERIFY_DEADLINE_S - 30),
                                '--out', str(run / 'verify-result.json')], env=env, stdout=vlog, stderr=subprocess.STDOUT, timeout=VERIFY_DEADLINE_S + 20)
        result['verifierExit'] = v.returncode
        if (run / 'verify-result.json').exists():
            vr = json.loads((run / 'verify-result.json').read_text())
            result.update(acceptance=vr.get('acceptance'), verdict=vr.get('verdict'), statementChecks=vr.get('statementChecks'), route=vr.get('route'))
        result['launcherAliveAtVerifyEnd'] = alive(tuple(owned['launcher']))
    except BaseException as e:                          # KeyboardInterrupt (timeout/TERM) included: cleanup below always runs
        result['error'] = f'{type(e).__name__}: {e}'[:500]
    finally:
        stop_poll.set()
        result['cleanup'] = cleanup_group(launcher, owned)
        after_q, after_s = qemus(), user_services()
        save(run, 'protected-after.json', {'qemus': after_q, 'services': after_s})
        mine = {str(i[0]) for i in (owned.get('children') or {}).values()}
        result['protectedQemuIdentitiesUnchanged'] = bool(before_q) and {k: v for k, v in after_q.items() if k not in mine} == before_q
        result['rpcStateUnchanged'] = rpc_state()[2] == rpc_before
        try:                                            # this scope's own memory peak (cgroup v2), the <= 3 GiB evidence
            cgp = pathlib.Path('/proc/self/cgroup').read_text().strip().split('::', 1)[-1]
            result['scopeMemoryPeakMiB'] = int(pathlib.Path(f'/sys/fs/cgroup{cgp}/memory.peak').read_text()) // (1 << 20)
        except Exception as e: result['scopeMemoryPeakMiB'] = f'unavailable: {e}'[:120]
        result['userServicesUnchanged'] = after_s == before_s
        if not result['userServicesUnchanged']: result['userServicesDrift'] = {'before': before_s, 'after': after_s}
        try:                                            # evidence from the launcher's own output, then sanitized copies
            fws = sorted((private / 'tmp').glob('metal-fwcfg-*.json'))
            fw = json.loads(fws[0].read_text()) if len(fws) == 1 else None
            result['fwCfgModes'] = [oct(fws[0].stat().st_mode & 0o777), oct((private / 'tmp').stat().st_mode & 0o777)] if len(fws) == 1 else None
            if host is not None and result.get('ports'):
                result['noKeyEvidence'] = no_key_evidence(host, fw, owner_cfg, result['ports'])
            if fw: result['fwCfgKeys'] = sorted(fw)
            if (private / 'serial.log').exists():
                (run / 'serial.sanitized.log').write_text(sanitize((private / 'serial.log').read_text(errors='replace'), [pairing]))
            recs = [r.split('\0') for r in (private / 'qemu-argv.log').read_text().split('\0\n') if r] if (private / 'qemu-argv.log').exists() else []
            result['qemuStarts'] = len(recs)
            (run / 'qemu-argv.json').write_text(json.dumps([[a.replace(str(private), '<private>') for a in r] for r in recs], indent=1))
            if recs and result.get('ownerConfig'):
                result['qemuArgvChecks'] = argv_checks(recs, result['ownerConfig']['hostData'], result['ports']['controlHostLoopback'])
            result['collateralSourceUnchanged'] = tree_fingerprint(COLLATERAL_SRC) == collateral_before
        except Exception as e:
            result['evidenceError'] = str(e)[:300]
        shutil.rmtree(private, ignore_errors=True)
        result['privateRemoved'] = not private.exists()
        result['finishedAt'] = now()
        result['ok'], result['failed'] = accept(result)
        save(run, 'result.json', result)
    print(json.dumps({'ok': result['ok'], 'failed': result['failed'], 'acceptance': (result.get('acceptance') or {}).get('failed'),
                      'scopeMemoryPeakMiB': result.get('scopeMemoryPeakMiB'), 'error': result.get('error')}, indent=2), flush=True)
    return 0 if result['ok'] else 1

# ---- parent: one transient scope, stopped on EVERY exit path -------------------------------------------------------------
def scope_cgroup(pid, unit, timeout=5.0):
    """the cgroup path of `pid` once systemd-run has moved it into <unit>.scope (None if never seen)."""
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        try:
            cg = pathlib.Path(f'/proc/{pid}/cgroup').read_text().strip().split('::', 1)[-1]
            if cg.endswith(f'/{unit}.scope'): return cg
        except OSError: return None
        time.sleep(0.05)
    return None
def survivors_naming(path):
    out = []
    for p in pathlib.Path('/proc').iterdir():
        if not p.name.isdigit() or p.name == str(os.getpid()): continue
        try: cl = (p / 'cmdline').read_bytes().replace(b'\0', b' ').decode('utf8', 'replace')
        except OSError: continue
        if str(path) in cl: out.append(p.name)
    return out
def supervise(cmd, unit, run, env, log_name='execution.log'):
    """Run `cmd` (systemd-run --user --scope --unit=<unit> ...). On every exit path - normal end, exception, SIGTERM/SIGINT/
    SIGHUP to this parent - stop ONLY <unit>.scope, prove its cgroup empty and that no process names this run, and only then
    scrub run/private (the ephemeral fw_cfg and test key). Logs and results are kept. -> terminal record (also saved)."""
    run = pathlib.Path(run)
    rec = {'unit': f'{unit}.scope', 'startedAt': now(), 'interrupted': None, 'exitCode': None}
    def handler(signum, frame): raise KeyboardInterrupt(f'parent signal {signum}')
    old = {s_: signal.signal(s_, handler) for s_ in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP)}
    p, cg = None, None
    try:
        with (run / log_name).open('x') as out:
            p = subprocess.Popen(cmd, stdout=out, stderr=subprocess.STDOUT, env=env)
            cg = scope_cgroup(p.pid, unit)
            rec['cgroup'] = cg
            rec['exitCode'] = p.wait()
    except BaseException as e:
        rec['interrupted'] = f'{type(e).__name__}: {e}'[:300]
    finally:
        for s_ in old: signal.signal(s_, signal.SIG_IGN)          # cleanup itself is not interruptible
        try:
            st = subprocess.run(['systemctl', '--user', 'stop', f'{unit}.scope'], capture_output=True, text=True, timeout=30, env=env)
            rec['scopeStop'] = st.returncode
        except Exception as e:
            rec['scopeStop'] = f'error: {e}'[:200]
        if p is not None and p.poll() is None:
            try: p.wait(timeout=10)
            except subprocess.TimeoutExpired: rec['systemdRunStillAlive'] = True
        state = subprocess.run(['systemctl', '--user', 'show', f'{unit}.scope', '-p', 'ActiveState', '--value'], capture_output=True, text=True, timeout=10, env=env).stdout.strip()
        rec['scopeActiveState'] = state or 'unknown'
        procs = pathlib.Path(f'/sys/fs/cgroup{cg}/cgroup.procs') if cg else None
        rec['cgroupEmpty'] = (not procs.exists() or not procs.read_text().strip()) if procs else None
        rec['survivors'] = survivors_naming(run)
        absent = rec['scopeActiveState'] in ('inactive', 'failed', 'unknown', '') and rec['cgroupEmpty'] is not False and not rec['survivors'] \
            and (p is None or p.poll() is not None)
        rec['ownedAbsenceProven'] = absent
        priv = run / 'private'
        rec['privatePresentAfterChild'] = priv.exists()
        if priv.exists() and absent:
            shutil.rmtree(priv, ignore_errors=True)
        rec['privateAbsent'] = not priv.exists()
        rec['qemusNow'] = qemus()
        rec['finishedAt'] = now()
        code = rec['exitCode'] if isinstance(rec['exitCode'], int) else 1
        if rec['interrupted'] or not absent or not rec['privateAbsent'] or rec.get('scopeStop') not in (0, 5):
            code = code or 1
        rec['code'] = code
        save(run, 'terminal.json', rec)
        for s_, h in old.items(): signal.signal(s_, h)
    return rec

def main():
    a = sys.argv[1:]
    for k in ('kds',):
        if f'--{k}' in a:
            v = a[a.index(f'--{k}') + 1]
            if v not in ('on', 'off'): raise SystemExit(f'--{k} on|off')
            ARGS[k] = v
    if a[:1] == ['--child']:
        return child(a[1])
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
        print('NOT STARTED: preflight failed (frozen pins included)', flush=True); return 98
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    (D / 'runs').mkdir(mode=0o700, exist_ok=True)
    run = D / 'runs' / stamp; run.mkdir(mode=0o700)                       # never reused
    (run / 'preflight.txt').write_text('\n'.join(f"{'PASS' if ok else 'FAIL'}  {n}  [{d}]" for n, ok, d in g) + '\n')
    need, floor, why = admission()
    save(run, 'attempt.json', dict(at=now(), measurement=expected_measurement(), frozenPinsSha256=sha256_file(FROZEN), capMiB=CAP_MIB, cpuQuota=CPU_QUOTA,
         admissionMiB=need, guardFloorMiB=floor, admissionBasis=why, guestMemMiB=MEM_MIB, cpus=CPUS, childTimeoutS=CHILD_TIMEOUT_S, killAfterS=KILL_AFTER_S,
         kds=ARGS.get('kds', 'on'), registry='none (verifier-only rule)', exclusiveBothQueueLanes=True, qemusAtAdmission=qemu_units()))
    unit = f'enclave-snp-verifier-canary-{stamp.lower()}-{secrets.token_hex(4)}'
    env = dict(PATH=f'{STUB_BIN}:/usr/bin:/usr/sbin:/bin', HOME=os.environ['HOME'], LANG='C.UTF-8',
               XDG_RUNTIME_DIR=os.environ.get('XDG_RUNTIME_DIR', f'/run/user/{os.getuid()}'),
               DBUS_SESSION_BUS_ADDRESS=os.environ.get('DBUS_SESSION_BUS_ADDRESS', f'unix:path=/run/user/{os.getuid()}/bus'))
    cmd = ['systemd-run', '--user', '--scope', '--quiet', '--expand-environment=no', f'--unit={unit}', '-p', f'MemoryMax={CAP_MIB}M', '-p', 'MemorySwapMax=0',
           '-p', f'CPUQuota={CPU_QUOTA}',
           str(NODE), str(TREE / 'test/helpers/memory-guard.mjs'), '--max-rss-mib', str(CAP_MIB), '--floor-available-mib', str(floor),
           '--log', str(run / 'memory.log'), '--', 'timeout', '--signal=TERM', f'--kill-after={KILL_AFTER_S}s', f'{CHILD_TIMEOUT_S}s',
           sys.executable, str(pathlib.Path(__file__).resolve()), '--child', str(run)] + sum(([f'--{k}', v] for k, v in ARGS.items()), [])
    (run / 'command.json').write_text(json.dumps(cmd, indent=1))
    rec = supervise(cmd, unit, run, env)
    res = json.loads((run / 'result.json').read_text()) if (run / 'result.json').exists() else None
    code = rec['code'] if res and res.get('ok') else (rec['code'] or 1)
    print('CANARY TERMINAL', code, str(run), 'result.ok=' + str(bool(res and res.get('ok'))), flush=True)
    return code

if __name__ == '__main__': sys.exit(main())
