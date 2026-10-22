#!/usr/bin/env python3
"""READ-ONLY: (1) nucbox network.log proof lines for 0x59f1273d (last 8) via root's reviewed transport; (2) public DNS and
HTTPS for https://59f1273d.app.enclave.host: status, issuer, subject, notAfter, served-key SPKI sha256. -> read-after.json"""
import importlib.util, json, pathlib, subprocess, ssl, socket, hashlib, datetime
here = pathlib.Path(__file__).resolve().parent
s = importlib.util.spec_from_file_location('activation', here.parent / 'root-activate-reviewed.py')
m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
ps = r"""$o=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};
$o.proof=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\network.log' -Tail 3000|Where-Object {$_ -match '59f1273d' -and $_ -match 'proof|egress|circuit'}|Select-Object -Last 8|ForEach-Object {$x=([string]$_) -replace '[^\x20-\x7E]','~'; if($x.Length -gt 300){$x.Substring(0,300)}else{$x}});
$o.cert=@(Get-Content -LiteralPath 'C:\ProgramData\Enclave\logs\node.log' -Tail 5000|Where-Object {$_ -match '0x59f1273d certificate:'}|Select-Object -Last 2|ForEach-Object {$x=([string]$_) -replace '[^\x20-\x7E]','~'; if($x.Length -gt 300){$x.Substring(0,300)}else{$x}});
$o|ConvertTo-Json -Depth 4 -Compress"""
out = {'nucbox': m.ps(ps, secs=60)}
name = '59f1273d.app.enclave.host'
dig = lambda r: subprocess.run(['dig', '+time=5', '+tries=1', f'@{r}', name, 'A'], capture_output=True, text=True).stdout
out['dns'] = {r: {'status': (lambda t: t.split('status: ')[1].split(',')[0] if 'status: ' in t else 'no answer')(dig(r)),
                  'a': subprocess.run(['dig', '+short', '+time=5', '+tries=1', f'@{r}', name, 'A'], capture_output=True, text=True).stdout.split()} for r in ('1.1.1.1', '8.8.8.8')}
ips = out['dns']['1.1.1.1']['a'] or out['dns']['8.8.8.8']['a']
tls = {}
for ip in ips[:2]:
    try:
        ctx = ssl.create_default_context()
        with socket.create_connection((ip, 443), timeout=15) as raw, ctx.wrap_socket(raw, server_hostname=name) as t:
            der = t.getpeercert(binary_form=True); c = t.getpeercert()
            pub = subprocess.run(['openssl', 'x509', '-inform', 'der', '-noout', '-pubkey'], input=der, capture_output=True).stdout
            spki = subprocess.run(['openssl', 'pkey', '-pubin', '-outform', 'der'], input=pub, capture_output=True).stdout
            tls[ip] = {'verified': True, 'issuer': dict(x[0] for x in c['issuer']).get('organizationName'), 'subject': dict(x[0] for x in c['subject']).get('commonName'),
                       'notAfter': c['notAfter'], 'spkiSha256': hashlib.sha256(spki).hexdigest(), 'certSha256': hashlib.sha256(der).hexdigest()}
    except Exception as e:
        tls[ip] = {'verified': False, 'error': str(e)[:200]}
out['tls'] = tls
r = subprocess.run(['curl', '-sS', '--max-time', '25', '-o', '/dev/null', '-w', '%{http_code} %{http_version} %{size_download} %{ssl_verify_result}', f'https://{name}/'], capture_output=True, text=True)
out['https'] = {'curl': r.stdout.strip(), 'err': r.stderr.strip()[:200]}
out['at'] = datetime.datetime.now(datetime.timezone.utc).isoformat()
(here / 'read-after.json').write_text(json.dumps(out, indent=1) + '\n'); print(json.dumps(out, indent=1))
