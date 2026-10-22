#!/usr/bin/env python3
"""Controller for the enclave-public-directory runtime upgrade (old reads-897b170 -> runtime-cb9ff18). Root runs it.

  python3 work/directory-runtime-activation/activation/activate-runtime.py plan
  python3 .../activate-runtime.py status   --hosts us-west[,eu-central,...]      (read-only SSH)
  python3 .../activate-runtime.py apply    --hosts us-west --approve <manifest sha256> [--reconcile]
  python3 .../activate-runtime.py rollback --hosts us-west --approve <manifest sha256> [--reconcile]

apply/rollback take exactly ONE host per invocation (canary discipline; run again for the next host). Every step is
journaled to activation/runtime-journal.jsonl with an explicit outcome:
  verified-active | verified-inactive | rolled-back-verified | refused | rollback-refused-drift | unknown
`unknown` (lost connection, timeout, unparsable answer, unverified rollback or public view disagreeing) and
`rollback-refused-drift` block further apply/rollback on that host until --reconcile, which prints the read-only status
first; the host program then reconciles from the drop-in hash, the loaded ExecStart and the running process (it never
overwrites bytes it does not expect, never touches the state directory, and caps restarts).
Public readback after the host verified: http://<ip>:8188/health, /v1/network/records carries the new runtime's
`management` list, and an invalid management record is refused with 400. Root then re-runs the frozen HTTPS canary.

Test hooks (fixture only): DHR_SSH (JSON argv prefix replacing ssh), DHR_READBACK (JSON argv prefix replacing the built-in
public readback), DHR_JOURNAL, DHR_REMOTE_TIMEOUT, DHR_READBACK_TIMEOUT.
"""
import argparse, base64, hashlib, json, os, subprocess, sys, time, urllib.request, uuid
from pathlib import Path

CAND = Path(__file__).resolve().parent.parent
REMOTE = (CAND / 'activation' / 'runtime-remote.py').read_text()
BUNDLE = (CAND / 'enclave-directory.mjs').read_bytes()
JOURNAL = Path(os.environ.get('DHR_JOURNAL') or (CAND / 'activation' / 'runtime-journal.jsonl'))
sha = lambda b: hashlib.sha256(b).hexdigest()
BUNDLE_SHA = 'cb9ff1839ebbaaf2335174cbf29d86a8f4060160eb548ca250111e5a081d82e5'
OLD_BUNDLE = '/opt/enclave-directory/reads-897b170/enclave-directory.mjs'
OLD_SHA = '897b1702e36346cb2f614220a4a6000e9bed9adac6080e43491652fe5898172a'
NEW_BUNDLE = '/opt/enclave-directory/runtime-cb9ff18/enclave-directory.mjs'
CONFIG = '/etc/enclave-directory/config-f6959cb.json'
DROPIN_DIR = '/etc/systemd/system/enclave-public-directory.service.d'
BASE_DROPIN = ('[Service]\nExecStart=\nExecStart=/usr/local/bin/node %s %s\n' % (OLD_BUNDLE, CONFIG)).encode()
NEW_DROPIN = ('[Service]\nExecStart=\nExecStart=/usr/local/bin/node %s %s\n' % (NEW_BUNDLE, CONFIG)).encode()
# Per-host facts read 2026-10-20 (hosts/<host>.facts.json): config differs only by its peer list.
HOSTS = {
    'us-west': {'ip': '134.199.235.187', 'config_sha256': 'e1fa0ccf8369d5aa17b4228309c978a750726d3d4338a78994c173ac95e523cb'},
    'eu-central': {'ip': '134.209.248.172', 'config_sha256': '7af67ba65163fa96259e639c38546b22eb4dab97b911b5301f276d64cbd862bb'},
    'ap-southeast': {'ip': '165.245.191.129', 'config_sha256': '56886b4a17d0083eac22dc67ff9713dd7e8cc8ca62e51e17f1c081a6bed73810'},
    'ca-east': {'ip': '146.190.246.39', 'config_sha256': '6efeddb0bff78bb3ac50f77361407e67ff1093743caa19b30b5e2ee1354d4e6b'},
}
COMMON = {'unit': 'enclave-public-directory', 'dropin': DROPIN_DIR + '/zz-authority-pins.conf', 'backup': DROPIN_DIR + '/rollback-before-runtime-cb9ff18.txt',
          'base_dropin_sha256': sha(BASE_DROPIN), 'new_dropin_sha256': sha(NEW_DROPIN), 'bundle_path': NEW_BUNDLE, 'bundle_sha256': BUNDLE_SHA,
          'old_bundle_path': OLD_BUNDLE, 'old_bundle_sha256': OLD_SHA, 'config_path': CONFIG, 'node': '/usr/local/bin/node',
          'state_dir': '/var/lib/private/enclave-public-directory', 'port': 8188, 'lock': '/run/lock/enclave-public-directory-runtime.lock',
          'journal': '/var/log/enclave-directory-runtime.journal.jsonl', 'systemctl': ['systemctl'],
          'critical_labels': ['7ae476a3', '9eb4e600'], 'minimum_routes': 10,
          'active_timeout_s': 30, 'health_timeout_s': 30, 'routes_timeout_s': 120, 'routes_needed': 3, 'restart_cap': 2}
REMOTE_TIMEOUT = float(os.environ.get('DHR_REMOTE_TIMEOUT', 600))
READBACK_TIMEOUT = float(os.environ.get('DHR_READBACK_TIMEOUT', 60))
SSH = json.loads(os.environ['DHR_SSH']) if os.environ.get('DHR_SSH') else ['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', '-o', 'ServerAliveInterval=15']
READBACK = json.loads(os.environ['DHR_READBACK']) if os.environ.get('DHR_READBACK') else None


def manifest():
    if sha(BUNDLE) != BUNDLE_SHA:
        raise SystemExit('local bundle is not the reviewed build')
    if sha(BASE_DROPIN) != '6e908763a8908b533881b58caeb4b4ec53dadd7877e6383e039a04b21b585dad':
        raise SystemExit('baseline drop-in reconstruction differs from the live hash')
    doc = {'schema': 'enclave-directory-runtime-activation/1', 'common': COMMON, 'hosts': HOSTS, 'remoteSha256': sha(REMOTE.encode()),
           'newDropin': NEW_DROPIN.decode(), 'baseDropin': BASE_DROPIN.decode(), 'sourceCommit': 'abe862628e5d6cef1d64b08bd3d7ffdfd473eab3'}
    text = json.dumps(doc, indent=2, sort_keys=True) + '\n'
    return doc, sha(text.encode()), text


def log(event, **kw):
    JOURNAL.parent.mkdir(parents=True, exist_ok=True)
    with open(JOURNAL, 'a') as f:
        f.write(json.dumps({'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), 'event': event, **kw}, sort_keys=True) + '\n'); f.flush(); os.fsync(f.fileno())


def last_event(host):
    try:
        rows = [json.loads(l) for l in JOURNAL.read_text().splitlines() if l.strip()]
    except FileNotFoundError:
        return None
    rows = [r for r in rows if r.get('host') == host and r['event'] != 'start']
    return rows[-1]['event'] if rows else None


def remote(host, mode, run_id, timeout=None):
    params = {**COMMON, **{k: v for k, v in HOSTS[host].items() if k != 'ip'}, 'mode': mode, 'run_id': run_id, 'new_dropin_b64': base64.b64encode(NEW_DROPIN).decode()}
    if mode == 'apply':
        params['bundle_b64'] = base64.b64encode(BUNDLE).decode()
    program = 'PARAMS = ' + repr(json.dumps(params)) + '\n' + REMOTE
    try:
        r = subprocess.run([*SSH, host, 'python3', '-'], input=program, capture_output=True, text=True, timeout=timeout or REMOTE_TIMEOUT)
    except subprocess.TimeoutExpired:
        return None, 'timeout after %ss' % (timeout or REMOTE_TIMEOUT)
    try:
        out = json.loads(r.stdout.strip().splitlines()[-1])
        if not isinstance(out, dict) or 'state' not in out:
            raise ValueError
        return out, 'rc %s' % r.returncode
    except Exception:
        return None, 'unparsable answer (rc %s): %s' % (r.returncode, ((r.stderr or '') + (r.stdout or ''))[-400:])


def builtin_readback(ip, expect):
    def req(method, path, body=None):
        q = urllib.request.Request('http://%s:8188%s' % (ip, path), data=body, method=method, headers={'Content-Type': 'application/json'} if body else {})
        try:
            with urllib.request.urlopen(q, timeout=15) as r:
                return r.status, json.loads(r.read() or b'null')
        except urllib.error.HTTPError as e:
            return e.code, None
    out = {'ip': ip, 'expect': expect}
    out['health'] = req('GET', '/health')[0]
    s, rec = req('GET', '/v1/network/records'); out['records'] = s
    out['managementList'] = isinstance((rec or {}).get('management'), list)
    if expect == 'new':
        out['invalidManagement'] = req('POST', '/v1/network/management', b'{}')[0]
        out['ok'] = out['health'] == 200 and s == 200 and out['managementList'] and out['invalidManagement'] == 400
    else:  # old runtime: no management list in its snapshot; no POST probe
        out['ok'] = out['health'] == 200 and s == 200 and not out['managementList']
    return out


def public_readback(host, expect):
    ip = HOSTS[host]['ip']
    if READBACK is None:
        try:
            return builtin_readback(ip, expect)
        except Exception as e:
            return {'ok': False, 'state': 'unknown', 'error': type(e).__name__ + ': ' + str(e)[:200]}
    try:
        r = subprocess.run([*READBACK, ip, expect], capture_output=True, text=True, timeout=READBACK_TIMEOUT)
    except subprocess.TimeoutExpired:
        return {'ok': False, 'state': 'unknown', 'error': 'public readback timeout'}
    try:
        return json.loads(r.stdout)
    except Exception:
        return {'ok': False, 'state': 'unknown', 'error': 'public readback unparsable'}


def classify(out):
    return {'active': 'verified-active', 'rolled-back': 'rolled-back-verified', 'baseline': 'verified-inactive', 'refused': 'refused',
            'rollback-refused-drift': 'rollback-refused-drift'}.get(out.get('state'), 'unknown')


def run_host(host, mode, digest, run_id, reconcile):
    if last_event(host) in ('unknown', 'rollback-refused-drift') and not reconcile:
        return False, {'host': host, 'outcome': 'refused-local', 'why': 'last outcome %s; read `status`, then --reconcile' % last_event(host)}
    if reconcile:
        st, detail = remote(host, 'status', run_id, timeout=120)
        print(json.dumps({'host': host, 'reconcileStatus': st, 'detail': detail}, sort_keys=True), flush=True)
        if st is None:
            log('unknown', host=host, mode='status', run=run_id, detail=detail)
            return False, {'host': host, 'outcome': 'unknown', 'why': 'status unavailable; nothing attempted'}
    log('start', host=host, mode=mode, run=run_id, manifest=digest)
    out, detail = remote(host, mode, run_id)
    if out is None:
        log('unknown', host=host, mode=mode, run=run_id, detail=detail)
        return False, {'host': host, 'outcome': 'unknown', 'detail': detail, 'next': 'status, then --reconcile'}
    outcome = classify(out)
    if outcome in ('verified-active', 'rolled-back-verified', 'verified-inactive'):
        pub = public_readback(host, 'new' if outcome == 'verified-active' else 'old')
        if pub.get('ok'):
            log(outcome, host=host, mode=mode, run=run_id, remote=out, public=pub)
            ok = (mode == 'apply' and outcome == 'verified-active') or (mode == 'rollback' and outcome in ('rolled-back-verified', 'verified-inactive'))
            return ok, {'host': host, 'outcome': outcome, 'remote': out, 'public': pub}
        log('unknown', host=host, mode=mode, run=run_id, remote=out, public=pub, why='host verified but the public view disagrees')
        return False, {'host': host, 'outcome': 'unknown', 'remote': out, 'public': pub, 'next': 'status, then --reconcile (or rollback --reconcile)'}
    log(outcome, host=host, mode=mode, run=run_id, remote=out)
    return False, {'host': host, 'outcome': outcome, 'remote': out}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('mode', choices=['plan', 'status', 'apply', 'rollback'])
    ap.add_argument('--hosts', default='')
    ap.add_argument('--approve', default='')
    ap.add_argument('--reconcile', action='store_true')
    a = ap.parse_args()
    doc, digest, text = manifest()
    if a.mode == 'plan':
        print(text + 'manifest sha256 ' + digest); return 0
    hosts = [h for h in a.hosts.split(',') if h]
    if not hosts or any(h not in HOSTS for h in hosts) or len(set(hosts)) != len(hosts):
        raise SystemExit('--hosts: a comma-separated subset of ' + ','.join(HOSTS))
    run_id = time.strftime('%Y%m%dT%H%M%SZ', time.gmtime()) + '-' + uuid.uuid4().hex[:8]
    if a.mode == 'status':
        ok = True
        for h in hosts:
            out, detail = remote(h, 'status', run_id, timeout=120); ok = ok and out is not None
            print(json.dumps({'host': h, 'status': out, 'detail': detail}, sort_keys=True), flush=True)
        return 0 if ok else 1
    if len(hosts) != 1:
        raise SystemExit('apply/rollback: exactly one host per invocation')
    if a.approve != digest:
        raise SystemExit('--approve must equal the reviewed manifest sha256 ' + digest)
    ok, report = run_host(hosts[0], a.mode, digest, run_id, a.reconcile)
    print(json.dumps(report, sort_keys=True), flush=True)
    if not ok:
        print('NOT VERIFIED on ' + hosts[0] + ': ' + report['outcome'], file=sys.stderr)
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
