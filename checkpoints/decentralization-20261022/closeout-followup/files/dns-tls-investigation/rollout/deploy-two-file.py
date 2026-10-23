"""ROOT-RUN: the two-file relay swap for the Shield certificate evidence fix, by the same transport, CAS and receipt pattern
as relay-release-live/deploy-reviewed.py (one `sudo python3 -` over the control-VM SSH, pinned bytes, a JSON receipt).
Prepared by Claude; never run by its author.

  python3 deploy-two-file.py preflight [--expected-pid N]   read-only on the control VM
  python3 deploy-two-file.py apply     [--expected-pid N]   both files + ONE restart of enclave-api-relay
  python3 deploy-two-file.py rollback                       both files back to their exact old bytes + ONE restart
  python3 deploy-two-file.py status                         read-only: hashes, MainPID, probes, the last remote result

An outcome this side could not read (SSH dropped, or the bounded wait below expired) is UNCERTAIN: never re-run apply or
rollback on it. Run `status` (the remote program ignores SIGHUP, finishes, and keeps its result in the backup directory).

Pinned here and checked before anything is sent: the source commit, both NEW files (read from that commit, never from the
working tree), both OLD hashes (the installed bytes root read on the control VM), and the remote program's own sha256.
The remote program (remote_two_file.py) gets only these values and the production paths below; there is no other
command, path or argument. Receipts: results/<mode>-<UTC>.json (the remote program's one JSON line; no logs, no keys).
"""
from pathlib import Path
import base64, datetime, hashlib, json, re, subprocess, sys

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[3]                       # .../wo (the SSH known_hosts path below is relative to it, as in r2)
REPO = HERE.parent / 'candidate'
COMMIT = 'a2b8fabd2c0b5685aeff6ef159a745a1f3b889c5'
REMOTE_SHA = '460ee850e9d53fb5b246c28c29c8210bbc1dcddd311cfdb7b56c35d9e90ea672'
FILES = [  # name in /opt/nan-relay, path in the commit, installed OLD sha256 (root's read), reviewed NEW sha256
    ('certs.js', 'relay/certs.js',
     '237834d8eed6e0f38caca1007170233690167e42c4f606adfaa11693bb6da8a4', '77a0d398c191bbe91ff5b514308b88b5c645b2a56636eb081262427731a50229'),
    ('measurement-predict.mjs', 'relay/measurement-predict.mjs',
     'a6372f419adcb7241cf50e6391e5af95a944688de67725b1e9c6880d1a8ef335', 'b2a39242d93cb9bd8fd87927a52d5c2249e9a8bfc265295dee7b19d43e0f5297'),
]
EXPECTED_PID = '222659'                      # root's live preflight; a different MainPID refuses (re-read and pass it)
CFG = {'dir': '/opt/nan-relay', 'backup': '/var/backups/enclave-dns-tls-20261023', 'service': 'enclave-api-relay',
       'systemctl': '/usr/bin/systemctl', 'node': '/usr/bin/node', 'probeBase': 'http://127.0.0.1:8100',
       'probeId': '0x59f1273d3633117fb1a5314f627ed1e6977cf901336d3c24f6e86e45d9ac778c', 'readySec': 60, 'restartSec': 45}
# The remote worst case, from its own bounds (remote_two_file.py docstring): checks 2x5 + 2x15 node + 2x5 probes = 50;
# staging 2x15 node + re-check 2x5 = 40; apply restart 45 + readiness 60 + one iteration (5+5+2x5+1) = 126; rollback read
# 5 + restart 45 + readiness 81 = 131. Total 347 s. The SSH session waits that plus 73 s of transport and start-up margin.
REMOTE_WORST_SEC = 50 + 40 + (CFG['restartSec'] + CFG['readySec'] + 21) + (5 + CFG['restartSec'] + CFG['readySec'] + 21)
WRAPPER_SEC = 420
assert WRAPPER_SEC >= REMOTE_WORST_SEC + 60, (WRAPPER_SEC, REMOTE_WORST_SEC)
SSH = ['ssh', '-p', '32423', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=8', '-o', 'UserKnownHostsFile=work/control-vm/known_hosts',
       '-i', '/home/steven/.ssh/minipc', 'controladmin@127.0.0.1', 'sudo python3 -']
sha = lambda b: hashlib.sha256(b).hexdigest()


def build(mode, expected_pid):
    remote = (HERE / 'remote_two_file.py').read_bytes()
    if sha(remote) != REMOTE_SHA:
        raise SystemExit('remote_two_file.py is not the pinned bytes')
    files = []
    for name, path, old, new in FILES:
        entry = {'name': name, 'old': old, 'new': new}
        if mode == 'apply':
            src = subprocess.run(['git', '-C', str(REPO), 'show', f'{COMMIT}:{path}'], capture_output=True, check=True).stdout
            if sha(src) != new:
                raise SystemExit(f'{path} at {COMMIT[:12]} is not the pinned new sha256')
            entry['source'] = base64.b64encode(src).decode()
        files.append(entry)
    cfg = dict(CFG, expectedPid=expected_pid)
    return remote.decode() + (f'\nimport json as _j\n_r = _j.dumps(main({{"files": {json.dumps(files)}}}, {json.dumps(cfg)}, {json.dumps(mode)}))\n'
                               'try:\n    print(_r, flush=True)\nexcept BrokenPipeError:\n    pass\n')


def run(argv):
    mode = argv[1] if len(argv) > 1 else ''
    if mode not in ('preflight', 'apply', 'rollback', 'status'):
        raise SystemExit(__doc__)
    pid = EXPECTED_PID
    if len(argv) == 4 and mode in ('preflight', 'apply') and argv[2] == '--expected-pid' and re.fullmatch(r'[1-9][0-9]{0,9}', argv[3]):
        pid = argv[3]
    elif len(argv) != 2:
        raise SystemExit(__doc__)
    program = build(mode, pid)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    (HERE / 'results').mkdir(exist_ok=True)
    receipt = HERE / 'results' / f'{mode}-{stamp}.json'
    try:
        r = subprocess.run(SSH, input=program, text=True, capture_output=True, timeout=WRAPPER_SEC, cwd=ROOT)
    except subprocess.TimeoutExpired:
        receipt.write_text(json.dumps({'status': 'UNCERTAIN', 'why': f'no answer within {WRAPPER_SEC} s; do NOT re-run {mode}: run status'}) + '\n')
        print(f'UNCERTAIN: no answer within {WRAPPER_SEC} s. Do not re-run {mode}; run: python3 deploy-two-file.py status')
        return 2
    line = next((l for l in reversed(r.stdout.splitlines()) if l.startswith('{')), '')
    receipt.write_text((line or json.dumps({'status': 'UNCERTAIN', 'sshExit': r.returncode, 'why': 'no result line; run status'})) + '\n')
    print(line or f'UNCERTAIN: no result line (ssh exit {r.returncode}); do not re-run {mode}, run status. stderr tail: {r.stderr[-600:]}')
    try:
        status = json.loads(line)['status']
    except Exception:
        return 2
    return 0 if status in ('PREFLIGHT_OK', 'STATUS', 'DEPLOYED_READY', 'ROLLED_BACK_READY', 'NOTHING_TO_ROLL_BACK') else 1


if __name__ == '__main__':
    sys.exit(run(sys.argv))
