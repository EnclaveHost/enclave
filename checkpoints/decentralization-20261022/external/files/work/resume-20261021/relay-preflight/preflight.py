#!/usr/bin/env python3
# Bounded READ-ONLY operational preflight for the eu-central relay -> warden-host user-service cutover
# (package work/eu-relay-user-target release 5e13596d...). It changes nothing anywhere:
#   - local: hashes, stat, systemctl --user show, ss, ip, ps, cgroup files, df (no unit, file, port or service change);
#   - published main: GitHub contents API reads of the closure files (no fetch into any local repo);
#   - eu-central (existing ssh alias, its root login): systemctl show, sha256 of the unit and relay.env (hashes only,
#     never contents), stat of the key and send record (never opened), process/listener counts, the local /v1/info;
#   - public: the relay's https /v1/info (TLS verified, signed statement verified) and the payee's public chain state.
# No key, env or journal CONTENT is read or printed. Every command has a timeout. Output: preflight.json (gates).
import json, os, subprocess, hashlib, datetime, re, sys
HERE = os.path.dirname(os.path.abspath(__file__))
WORK = os.path.abspath(os.path.join(HERE, '../..'))
PKG = os.path.join(WORK, 'eu-relay-user-target')
MAIN = os.path.join(WORK, 'enclave')
PUBLISHED = '7752a4239b3bec2cf452491cd1b95164a8c2bdb8'
REPO_SLUG = 'EnclaveHost/enclave'
PAYEE = '0xC5D88d2D1c898fCACDCe965Cbe2f1C3cD38Bb26a'
SRC = 'eu-central'
now = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat()
def sh(cmd, timeout=25, inp=None):
    try:
        r = subprocess.run(cmd, shell=isinstance(cmd, str), capture_output=True, text=True, timeout=timeout, input=inp)
        return {'rc': r.returncode, 'out': r.stdout.strip(), 'err': r.stderr.strip()[:400]}
    except subprocess.TimeoutExpired:
        return {'rc': 124, 'out': '', 'err': f'timeout {timeout}s'}
def h(p): return hashlib.sha256(open(p, 'rb').read()).hexdigest()
gates, facts = [], {}
def gate(name, ok, evidence, blocker=None, kind='required'):
    gates.append({'gate': name, 'status': 'READY' if ok else 'BLOCKED', 'kind': kind, 'evidence': evidence, **({'blocker': blocker} if not ok and blocker else {})})

# ---- G1 the package: bytes, freshness against work/enclave and against PUBLISHED main
inv = json.load(open(os.path.join(PKG, 'inventory.json')))
rel = inv['release']
changed = [p for p, s in inv['files'].items() if not os.path.exists(os.path.join(PKG, p)) or h(os.path.join(PKG, p)) != s]
arch_ok = h(os.path.join(PKG, rel['archive'])) == rel['archiveSha256']
vr = sh(['/usr/bin/node', os.path.join(PKG, 'release', rel['id'], 'verify-release.mjs')])
gate('package-bytes', not changed and arch_ok and vr['rc'] == 0,
     {'release': rel['id'], 'archiveSha256': rel['archiveSha256'], 'archiveMatches': arch_ok, 'workspaceFilesChanged': changed, 'verifyRelease': vr['out'][:200]})
sources = rel['builtFrom']['sources']
diff_main = [p for p, s in sources.items() if h(os.path.join(MAIN, p)) != s]
gate('closure-equals-work-enclave', not diff_main, {'files': len(sources), 'differ': diff_main, 'workEnclaveHead': sh(['git', '-C', MAIN, 'rev-parse', 'HEAD'])['out']})
pub = {}
for p in sorted(sources):
    r = subprocess.run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', f'repos/{REPO_SLUG}/contents/{p}?ref={PUBLISHED}'], capture_output=True, timeout=30)
    pub[p] = hashlib.sha256(r.stdout).hexdigest() if r.returncode == 0 else f'unavailable rc={r.returncode} {r.stderr[:120]!r}'
# relay/net-guard.mjs is a symlink in git: the contents API returns the link text; compare its target too
if not re.fullmatch(r'[0-9a-f]{64}', pub.get('relay/net-guard.mjs', '')) or pub['relay/net-guard.mjs'] != sources.get('relay/net-guard.mjs'):
    r = subprocess.run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', f'repos/{REPO_SLUG}/contents/net-guard.mjs?ref={PUBLISHED}'], capture_output=True, timeout=30)
    if r.returncode == 0 and hashlib.sha256(r.stdout).hexdigest() == sources.get('relay/net-guard.mjs'): pub['relay/net-guard.mjs'] = sources['relay/net-guard.mjs'] + ' (via the symlink target net-guard.mjs)'
lockr = subprocess.run(['gh', 'api', '-H', 'Accept: application/vnd.github.raw', f'repos/{REPO_SLUG}/contents/package-lock.json?ref={PUBLISHED}'], capture_output=True, timeout=60)
lock_diff = None
if lockr.returncode == 0:
    lp = json.loads(lockr.stdout).get('packages', {})
    lock_diff = [k for k, v in inv['release']['packages'].items() if (lp.get(f'node_modules/{k}') or {}).get('version') != v]
missing = sorted(p for p, s in pub.items() if s.startswith('unavailable') and '404' in s)
differ = sorted(p for p, s in pub.items() if not s.startswith('unavailable') and not s.startswith(sources[p]))
same = sorted(p for p, s in pub.items() if s.startswith(sources[p]))
gate('closure-equals-published-main', not missing and not differ and lock_diff == [], {'published': PUBLISHED, 'sameBytes': same, 'absentInPublished': missing, 'differentInPublished': differ, 'lockVersionsDiffer': lock_diff},
     blocker='published main 7752a4239 does not carry this closure (the role source is in work/enclave\'s unpushed working tree): the package is current for work/enclave; after root reconciles and publishes main, refresh the package (RUNBOOK refresh) and re-pin if any closure byte changed',
     kind='freshness (does not block the cutover itself)')

# ---- G2 the target host (this machine, the operator user)
uid = os.getuid()
user = sh(['id', '-un'])['out']
linger = sh(['loginctl', 'show-user', user, '-p', 'Linger', '--value'])['out']
um = sh(['systemctl', '--user', 'is-system-running'])['out']
nodev = sh(['/usr/bin/node', '-v'])['out']
sysv = sh('systemctl --version | head -1')['out']
cg = f'/sys/fs/cgroup/user.slice/user-{uid}.slice/user@{uid}.service'
ctl = open(os.path.join(cg, 'cgroup.controllers')).read().split() if os.path.exists(os.path.join(cg, 'cgroup.controllers')) else []
sub = open(os.path.join(cg, 'cgroup.subtree_control')).read().split() if os.path.exists(os.path.join(cg, 'cgroup.subtree_control')) else []
units = {u: [sh(['systemctl', '--user', 'show', u, '-p', p, '--value'])['out'] for p in ('LoadState', 'ActiveState')] for u in ['enclave-host-relay-eu.service', 'enclave-host-relay-eu-lan.service']}
unitdir = os.path.expanduser('~/.config/systemd/user')
st = os.lstat(unitdir)
target, parent = '/home/steven/enclave-prod/host-relay-eu', '/home/steven/enclave-prod'
pst = os.lstat(parent)
listen8549 = sh("ss -Hltn 'sport = :8549'")['out']
lan = sh("ip -4 -o addr show | awk '{print $2\" \"$4}'")['out']
df = sh(['df', '--output=avail', '-B1M', parent])['out'].split('\n')[-1].strip()
facts['target'] = {'user': user, 'uid': uid, 'linger': linger, 'userManager': um, 'node': nodev, 'systemd': sysv, 'delegatedControllers': ctl, 'subtreeControl': sub,
                   'units': units, 'unitDir': {'uid': st.st_uid, 'mode': oct(st.st_mode & 0o777), 'symlink': os.path.islink(unitdir)},
                   'targetRootExists': os.path.lexists(target), 'parent': {'uid': pst.st_uid, 'mode': oct(pst.st_mode & 0o777), 'symlink': os.path.islink(parent)},
                   'listeners8549': listen8549, 'lanHas249': bool(re.search(r'\b192\.168\.8\.249/', lan)), 'lanInterface': next((l.split()[0] for l in lan.split('\n') if '192.168.8.249/' in l), None), 'freeMiB': df}
gate('target-user-service', user == 'steven' and linger == 'yes' and um in ('running', 'degraded') and nodev.startswith('v22') and {'memory', 'pids'} <= set(ctl) and {'memory', 'pids'} <= set(sub),
     {k: facts['target'][k] for k in ['user', 'linger', 'userManager', 'node', 'systemd', 'delegatedControllers', 'subtreeControl']})
gate('target-clean-and-free', all(v[0] == 'not-found' for v in units.values()) and not facts['target']['targetRootExists'] and not listen8549
     and st.st_uid == uid and not os.path.islink(unitdir) and pst.st_uid == uid and not (pst.st_mode & 0o022) and int(df or 0) > 1024,
     {k: facts['target'][k] for k in ['units', 'targetRootExists', 'listeners8549', 'unitDir', 'parent', 'freeMiB']})
gate('windows-fallback-address', facts['target']['lanHas249'], {'lanInterface': facts['target']['lanInterface']}, kind='later (forwarder step)')

# ---- G3 the control CVM's path to the host loopback, and the RUNNING control release's client
mpid = sh(['systemctl', '--user', 'show', 'enclave-metal.service', '-p', 'MainPID', '--value'])['out']
prop = lambda unit, p: sh(['systemctl', '--user', 'show', unit, '-p', p, '--value'])['out']   # one property per call (show orders them itself)
mwd = [prop('enclave-metal.service', 'WorkingDirectory'), prop('enclave-metal.service', 'ActiveState')]
qemu = sh("ps -eo pid,args | grep -E 'qemu-system' | grep -v grep")['out']
netdev = re.findall(r'-netdev (\S+)', qemu)
user_net = [n for n in netdev if n.startswith('user,')]
loop_listen = sh("ss -Hltn | awk '{print $4}' | grep -E '^127\\.0\\.0\\.1:(8095|8096)$' | sort -u")['out'].split()
rel_dir = mwd[0] if mwd else ''
running_client = h(os.path.join(rel_dir, 'client/lease-executor-client.mjs')) if os.path.exists(os.path.join(rel_dir, 'client/lease-executor-client.mjs')) else None
running_pinned = open(os.path.join(rel_dir, 'metal/guest/lease-gas-conduit.bundle.mjs')).read().count('ENCLAVE_LEASE_GAS_PINNED_RELAYS') if os.path.exists(os.path.join(rel_dir, 'metal/guest/lease-gas-conduit.bundle.mjs')) else None
facts['cvm'] = {'enclaveMetal': {'workingDirectory': rel_dir, 'active': mwd[1] if len(mwd) > 1 else None, 'mainPid': mpid}, 'qemuNetdevs': [re.sub(r'hostfwd=[^,]*', 'hostfwd=...', n) for n in netdev],
                'userNetRestricted': any('restrict=on' in n or 'restrict=yes' in n for n in user_net), 'hostLoopbackServicesTheGuestUses': loop_listen,
                'runningClientSha256': running_client, 'runningConduitHasPinned': running_pinned}
gate('cvm-slirp-path-to-host-loopback', bool(user_net) and not facts['cvm']['userNetRestricted'] and facts['cvm']['enclaveMetal']['active'] == 'active',
     {'netdevs': facts['cvm']['qemuNetdevs'], 'restricted': facts['cvm']['userNetRestricted'], 'loopbackServicesReachedVia10.0.2.2': loop_listen})
# the host config's lease-gas relay routes (public fields only: relays, pinnedRelays, digest; RPC hosts only)
cfgp = None
m = re.search(r'--config (\S+)', sh(['systemctl', '--user', 'show', 'enclave-metal.service', '-p', 'ExecStart', '--value'])['out'])
if m: cfgp = m.group(1)
lg = None
if cfgp and os.path.exists(cfgp):
    try:
        c = json.load(open(cfgp)); g = c.get('leaseGas')
        lg = None if g is None else {'relays': g.get('relays'), 'pinnedRelays': g.get('pinnedRelays'), 'digest': g.get('digest'), 'rpcHosts': [re.sub(r'^https?://([^/?#]+).*$', r'\1', u) for u in g.get('rpcs', [])], 'quorum': g.get('quorum')}
    except Exception as e: lg = {'unreadable': str(e)[:120]}
facts['cvm']['hostConfigLeaseGas'] = lg
st3 = os.path.join(WORK, 'linux-combined-release/stage3/metal-e68067d24')
inv3 = json.load(open(os.path.join(WORK, 'linux-combined-release/INVENTORY-final.json')))
facts['canary'] = {'stage3': {'dir': st3, 'status': inv3.get('status'), 'measurement': inv3['image']['measurement'], 'client': h(os.path.join(st3, 'client/lease-executor-client.mjs')),
                              'conduitBundleHasPinned': open(os.path.join(st3, 'metal/guest/lease-gas-conduit.bundle.mjs')).read().count('ENCLAVE_LEASE_GAS_PINNED_RELAYS'),
                              'stagedInEnclaveProd': os.path.exists('/home/steven/enclave-prod/metal-e68067d24')}}
canary_ok = bool(running_pinned) and bool(lg) and bool(lg.get('pinnedRelays')) and any(p.get('origin') == 'http://10.0.2.2:8549' for p in (lg.get('pinnedRelays') or []))
gate('linux-pinned-client-canary', canary_ok,
     {'running': {'release': rel_dir, 'clientSha256': running_client, 'conduitPinnedSupport': running_pinned, 'hostConfigLeaseGas': lg}, 'candidate': facts['canary']['stage3']},
     blocker='the RUNNING control (enclave-metal.service) has no pinned-relay client and its leaseGas names no pinnedRelays: root must admit and activate a control image carrying the integrated pinned client (stage3 metal-e68067d24 / measurement a940e71e..., or its reconciled successor) with leaseGas.pinnedRelays [{origin http://10.0.2.2:8549, payee 0xC5D8..., operator 0xC9D0...}] and the eu-central relay kept, and see an app-paid renewal under it, BEFORE the eu-central stop')

# ---- G4 the eu-central source (read-only over the existing alias)
src_cmd = r'''set -u
U=enclave-lease-relay.service
echo "host=$(hostname)"
systemctl show "$U" -p LoadState -p ActiveState -p SubState -p UnitFileState -p FragmentPath -p NRestarts -p ActiveEnterTimestamp -p MainPID 2>/dev/null
for f in /etc/systemd/system/$U /etc/enclave-lease-relay/relay.env; do [ -f "$f" ] && echo "sha $f $(sha256sum "$f" | cut -c1-64)" || echo "sha $f ABSENT"; done
for f in /var/lib/enclave-lease-relay/relay.key /var/lib/private/enclave-lease-relay-state/relay-send.json; do [ -e "$f" ] && echo "stat $f $(stat -c '%F %a %U %s' "$f")" || echo "stat $f ABSENT"; done
for d in /var/lib/enclave-lease-relay-migration /root/eu-relay-move; do [ -e "$d" ] && echo "exists $d" || echo "absent $d"; done
echo "procs $(pgrep -fc 'lease-relay\.mjs' || true)"
echo "listen $(ss -Hltn 'sport = :8549' | awk '{print $4}' | tr '\n' ' ')"
echo "localinfo $(curl -fsS --max-time 5 http://127.0.0.1:8549/v1/info 2>/dev/null | head -c 600)"
echo "node $(/usr/local/bin/node -v 2>/dev/null || node -v 2>/dev/null || echo none)"
echo "free $(df --output=avail -B1M /var/lib | tail -1 | tr -d ' ')"'''
s = sh(['ssh', '-n', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', SRC, src_cmd], timeout=45)
src = {'rc': s['rc'], 'err': s['err']}
for line in s['out'].split('\n'):
    if '=' in line and line.split('=')[0] in ('host', 'LoadState', 'ActiveState', 'SubState', 'UnitFileState', 'FragmentPath', 'NRestarts', 'ActiveEnterTimestamp', 'MainPID'):
        k, v = line.split('=', 1); src[k] = v
    elif line.startswith(('sha ', 'stat ', 'exists ', 'absent ')):
        parts = line.split(' ', 2); src.setdefault(parts[0], {})[parts[1]] = parts[2] if len(parts) > 2 else True
    elif ' ' in line:
        k, v = line.split(' ', 1); src[k] = v
try: li = json.loads(src.get('localinfo', '') or '{}')
except Exception: li = {}
src['localinfoPayee'] = li.get('payee'); src.pop('localinfo', None)
facts['source'] = src
shas = src.get('sha', {})
stats = src.get('stat', {})
gate('source-lifecycle-as-reviewed', s['rc'] == 0 and src.get('ActiveState') == 'active' and src.get('UnitFileState') == 'enabled'
     and shas.get('/etc/systemd/system/enclave-lease-relay.service') == '4b3e5ac7b384911aec0995bc42d255c1b503197935aa24f5945984fd4e09b6ba'
     and shas.get('/etc/enclave-lease-relay/relay.env') == '7c05d44ad8b0ad2777d73af8cb7895c6dbb8abd040ce8e5cb36e8d466b0d6769'
     and str(stats.get('/var/lib/enclave-lease-relay/relay.key', '')).startswith('regular file 600 root')
     and str(stats.get('/var/lib/private/enclave-lease-relay-state/relay-send.json', '')).startswith('regular file')
     and src.get('absent', {}).get('/var/lib/enclave-lease-relay-migration') and src.get('absent', {}).get('/root/eu-relay-move')
     and (src.get('localinfoPayee') or '').lower() == PAYEE.lower() and src.get('node', 'none') != 'none',
     {k: src.get(k) for k in ['host', 'LoadState', 'ActiveState', 'UnitFileState', 'FragmentPath', 'NRestarts', 'ActiveEnterTimestamp', 'sha', 'stat', 'exists', 'absent', 'procs', 'listen', 'localinfoPayee', 'node', 'free', 'rc', 'err']})

# ---- G5/G6 public payee identity (TLS + signed statement) and the payee's public chain state
idc = sh(['/usr/bin/node', os.path.join(HERE, 'payee-identity.mjs')], timeout=90)
try: ident = json.loads(idc['out'].split('\n')[-1])
except Exception: ident = {'error': idc['out'][-300:] + idc['err']}
facts['payee'] = ident
# the deployed eu-central artifact (94f4ebdf) predates signed relay statements: its identity is the TLS-verified IP
# certificate plus the payee it serves (and the same payee on its loopback, G4); the warden target's package signs them
statement_absent = ident.get('statementError') == 'no signed relay statement'
gate('public-payee-identity', ident.get('tlsVerified') is True and (ident.get('payee') or '').lower() == PAYEE.lower() and ident.get('deploymentMatches') is True
     and (ident.get('statementVerified') is True or statement_absent),
     {**{k: ident.get(k) for k in ['origin', 'tlsVerified', 'payee', 'statementVerified', 'statementError', 'deploymentMatches', 'error']},
      'note': 'the deployed source artifact serves no signed statement (pre-statement build); identity = verified TLS + payee here and on its loopback' if statement_absent else None})
gate('payee-nothing-in-flight', ident.get('chain', {}).get('agreed') is True and ident.get('chain', {}).get('pendingEqualsLatest') is True,
     ident.get('chain'), blocker='the payee has an in-flight transaction or the RPCs do not agree: re-check right before the stop (the gate re-proves it at activation)', kind='point-in-time')

out = {'at': now(), 'mode': 'read-only preflight; no mutation anywhere', 'package': {'release': rel['id'], 'archive': rel['archive'], 'archiveSha256': rel['archiveSha256']},
       'gates': gates, 'facts': facts,
       'summary': {'ready': [g['gate'] for g in gates if g['status'] == 'READY'], 'blocked': [g['gate'] for g in gates if g['status'] == 'BLOCKED']}}
json.dump(out, open(os.path.join(HERE, 'preflight.json'), 'w'), indent=1)
print(json.dumps(out['summary']))
