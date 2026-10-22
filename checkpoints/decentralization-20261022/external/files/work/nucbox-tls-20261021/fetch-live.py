# READ-ONLY: fetch the LIVE manager's wmiserve-run.mjs (public source code) and its sha256.
import subprocess, base64, pathlib, json
ps = open(pathlib.Path(__file__).with_name('fetch-live.ps1')).read()
r = subprocess.run(['ssh', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=15', 'minipc', 'powershell', '-NoProfile', '-NonInteractive', '-EncodedCommand',
                    base64.b64encode(ps.encode('utf-16le')).decode()], capture_output=True, timeout=120)
t = r.stdout.decode('utf-8', 'replace'); i = t.find('RESULT ')
j = json.loads(t[i + 7:].strip().splitlines()[0]); d = pathlib.Path(__file__).with_name('live')
d.mkdir(exist_ok=True); (d / 'wmiserve-run.mjs').write_bytes(base64.b64decode(j['b64']))
print('live wmiserve-run.mjs', j['sha256'], j['written']); raise SystemExit(r.returncode)
