#!/usr/bin/env python3
"""ONE read-only recovery-monitor round for cron 0x38f368d6 after root's 15:00Z fix (bundle 66c6, host c462, respawn cfg
85698d20, node restart exec 26541). Public, normal DNS + full TLS verification (never a bypass); host state only on round
1 / change / every 3rd round; chain lease (2 agreeing RPCs) on round 1, every 5th round, and whenever renewal is near or
past due. No secret, env, config content, API key or job data. Writes progress.json (latest) + progress.jsonl (append).
  python3 monitor-round.py <round>"""
import datetime, json, pathlib, re, socket, subprocess, sys, time, importlib.util
HERE = pathlib.Path(__file__).resolve().parent
C = HERE.parent
CRON, DEP = '38f368d6.app.enclave.host', '0x38f368d67995676e0bbe48ebbc1d18a643bb314942374b44e1e52239a1cd215c'
US_WEST = '134.199.235.187'
rnd = int(sys.argv[1]); now = time.time(); utc = lambda t=None: datetime.datetime.fromtimestamp(t or time.time(), datetime.timezone.utc).strftime('%H:%M:%SZ')
st_path = HERE / 'monitor-state.json'
st = json.loads(st_path.read_text()) if st_path.exists() else {}
o = {'round': rnd, 'at': utc(now)}

# restart receipt (root's), newest only, small fields
rr = sorted((C / 'respawn-activation').glob('receipt-*restart*.json'))
if rr:
    try: j = json.loads(rr[-1].read_text()); o['restartReceipt'] = {'file': rr[-1].name, **{k: j.get(k) for k in ('status', 'result', 'exit', 'ok', 'at') if k in j}}
    except Exception as e: o['restartReceipt'] = {'file': rr[-1].name, 'parse': str(e)[:60]}
else: o['restartReceipt'] = None

# DNS
try: o['dnsSystem'] = sorted({a[4][0] for a in socket.getaddrinfo(CRON, 443, socket.AF_INET)})
except Exception as e: o['dnsSystem'] = 'FAIL ' + type(e).__name__
d = subprocess.run(['dig', '+time=4', '+tries=1', '+noall', '+comments', '+answer', CRON, 'A', '@ns-us-west.enclave.host'], capture_output=True, text=True, timeout=15).stdout
m = re.search(r'status: (\w+)', d); o['dnsAuthUsWest'] = {'status': m.group(1) if m else 'no answer', 'a': re.findall(r'\sA\s+([\d.]+)', d)}

# HTTPS, normal DNS, full verification
def get(path, resolve=None):
    cmd = ['curl', '-sS', '--max-time', '20', '-o', '-', '-w', '\n%{http_code} %{ssl_verify_result} %{time_total}', '-H', 'User-Agent: cron-recovery-monitor']
    if resolve: cmd += ['--resolve', f'{CRON}:443:{resolve}']
    r = subprocess.run(cmd + [f'https://{CRON}{path}'], capture_output=True, timeout=35)
    body, _, meta = r.stdout.rpartition(b'\n'); mm = meta.decode().split()
    res = {'http': mm[0] if mm else None, 'tlsVerify': mm[1] if len(mm) > 1 else None, 's': mm[2] if len(mm) > 2 else None}
    if r.returncode: res['err'] = r.stderr.decode(errors='replace').strip()[:100]
    if path == '/ping': res['body'] = body[:160].decode(errors='replace')
    return res
o['ping'] = get('/ping'); o['root'] = get('/'); o['root'].pop('body', None)
if isinstance(o['dnsSystem'], str): o['pingViaUsWest'] = get('/ping', US_WEST)
pub = o['ping']['http'] if o['ping']['http'] not in (None, '000') else (o.get('pingViaUsWest') or {}).get('http')

# host state: round 1, a public change, or every 3rd round (existing transport; cron fields only)
changed = pub != st.get('lastPublic')
if rnd == 1 or changed or rnd % 3 == 0:
    try:
        p = C.parent / 'nucbox-tls-20261021/root-activate-reviewed.py'
        s = importlib.util.spec_from_file_location('transport', p); mod = importlib.util.module_from_spec(s); s.loader.exec_module(mod)
        h = mod.ps(r"""$id='%s';$o=[ordered]@{};
$s=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:9600/v1/host/state';$o.dep=@($s.deployments|Where-Object {$_.id -eq $id}|Select-Object status,reason);
$v=Invoke-RestMethod -TimeoutSec 15 'http://127.0.0.1:8091/vms';$o.vm=@($v.vms|Where-Object {$_.name -eq $id}|Select-Object id,status);
$f='C:\ProgramData\Enclave\network\state\status.json';if(Test-Path -LiteralPath $f){$j=Get-Content -Raw -LiteralPath $f|ConvertFrom-Json;$a=@($j.apps|Where-Object {$_.deploymentId -eq $id})|Select-Object -First 1;
 if($a){$o.net=[ordered]@{ready=$a.ready;error=$a.error;proofUntil=$a.proofUntil;circuits=@($a.circuits).Count;updatedAt=$j.updatedAt}}}
$o|ConvertTo-Json -Depth 4 -Compress""" % DEP, secs=80)
        vm = (h.get('vm') or [{}])[0] if isinstance(h, dict) else {}
        o['host'] = {'dep': (h.get('dep') or [None])[0] if isinstance(h, dict) else None, 'vm': vm, 'net': h.get('net') if isinstance(h, dict) else None}
        if not isinstance(h, dict) or 'vm' not in h: o['host'] = {'error': str(h)[:160]}
        vid = (vm or {}).get('id')
        if vid and vid != st.get('vm'): st['vm'] = vid; st['vmSince'] = now
        net = o['host'].get('net') or {}
        if net.get('ready') and not st.get('readySince'): st['readySince'] = now
        if not net.get('ready'): st.pop('readySince', None)
    except Exception as e: o['host'] = {'error': f'{type(e).__name__}: {e}'[:160]}

# chain lease: round 1, every 5th round, renewal near/past due
lu = st.get('leaseUntil')
if rnd == 1 or rnd % 5 == 0 or (lu and lu - now < 300):
    r = subprocess.run(['node', str(C / 'storage-network/chain-read-any.mjs'), DEP], capture_output=True, text=True, timeout=120)
    try:
        j = json.loads(r.stdout); dd = j['deployment']
        st['leaseUntil'] = int(dd['leaseUntil'])
        o['chain'] = {'block': j['block'], 'leaseUntil': utc(int(dd['leaseUntil'])), 'leftS': int(dd['leaseUntil']) - int(now), 'runner': dd['runner'][:10], 'active': dd['active'],
                      'appRef': dd['appRef'][-2:], 'balance6': dd['balance6'], 'spent6': dd['spent6']}
    except Exception: o['chain'] = {'error': (r.stderr or r.stdout)[-160:]}

st['lastPublic'] = pub
o['summary'] = {'public': pub, 'tlsOk': o['ping'].get('tlsVerify') == '0' or (o.get('pingViaUsWest') or {}).get('tlsVerify') == '0',
                'vm': st.get('vm'), 'sameVmMin': round((now - st['vmSince']) / 60, 1) if st.get('vmSince') else None,
                'egressReadyMin': round((now - st['readySince']) / 60, 1) if st.get('readySince') else None,
                'leaseUntil': utc(st['leaseUntil']) if st.get('leaseUntil') else None}
o['summary']['healthy'] = pub == '200' and o['summary']['tlsOk']
o['summary']['storageBlockerSuspected'] = (pub == '503' and (o['summary']['sameVmMin'] or 0) >= 10 and (o['summary']['egressReadyMin'] or 0) >= 10)
st_path.write_text(json.dumps(st))
(HERE / 'progress.json').write_text(json.dumps(o, separators=(',', ':')) + '\n')
with open(HERE / 'progress.jsonl', 'a') as f: f.write(json.dumps(o, separators=(',', ':')) + '\n')
print(json.dumps(o['summary']))
