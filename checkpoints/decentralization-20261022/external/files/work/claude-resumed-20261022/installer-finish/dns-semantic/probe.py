#!/usr/bin/env python3
"""READ-ONLY live checks of EnclaveDNS at https://59f1273d.app.enclave.host (endpoint formats from tree-r2 src/http.rs):
  GET /api/status            counters (status(): resolver.stale_served/refreshes/cache_hits/cache_misses, version, uptime_s)
  GET /resolve?name=&type=[&cd=1][&do=1]   JSON: Status, CD, AD, Security, Sources, Answer[{name,type,TTL,data}], EDE{code,text}
  POST/GET /dns-query        RFC 8484 wire (dig +https, with +tls-ca so the certificate IS verified)
Every HTTPS call verifies TLS (curl default; no -k). The front address comes from the authoritative ns-us-west answer and is
passed with --resolve, so SNI/hostname verification is unchanged. Bounded: 15 s per call. Writes one JSON file per phase.

  probe.py A NAMES_FILE   phase A: cert, status, DNSSEC checks, first+second /resolve of each test name
  probe.py B NAMES_FILE   phase B: status, /resolve of each test name after its TTL lapsed, again, status
"""
import json, subprocess, sys, time, datetime, pathlib, urllib.parse, secrets

HERE = pathlib.Path(__file__).resolve().parent
HOST = '59f1273d.app.enclave.host'
iso = lambda: datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds')


def sh(args, timeout=20):
    t0 = time.time(); at = iso()
    p = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    return {'at': at, 'cmd': args, 'rc': p.returncode, 'stdout': p.stdout, 'stderr': p.stderr[-1500:], 'seconds': round(time.time() - t0, 3)}


def front():
    r = sh(['dig', '+norec', '+short', '+time=5', '+tries=1', 'A', HOST, '@ns-us-west.enclave.host'])
    ips = [l for l in r['stdout'].split() if l.count('.') == 3]
    return ips[0] if ips else None, r


def get(ip, path):
    r = sh(['curl', '-sS', '-m', '15', '--resolve', f'{HOST}:443:{ip}', '-w', '\n__HTTP__ %{http_code} %{ssl_verify_result} %{remote_ip} %{time_total}', f'https://{HOST}{path}'])
    body, _, tail = r['stdout'].rpartition('\n__HTTP__ ')
    f = tail.split()
    r.update(http=f[0] if f else None, sslVerifyResult=f[1] if len(f) > 1 else None, remoteIp=f[2] if len(f) > 2 else None)
    try: r['json'] = json.loads(body)
    except Exception: r['body'] = body[:2000]
    del r['stdout']
    return r


def status_digest(s):
    j = s.get('json') or {}; rs = j.get('resolver', {})
    keep = ['upstream_queries', 'upstream_timeouts', 'cache_entries', 'cache_hits', 'cache_misses', 'stale_served', 'refreshes', 'prefetches', 'joined_in_flight', 'hedged', 'validated']
    return {'at': s['at'], 'http': s['http'], 'sslVerifyResult': s['sslVerifyResult'], 'version': j.get('version'), 'uptime_s': j.get('uptime_s'),
            'validating': rs.get('validating'), 'mode': rs.get('mode'), 'resolver': {k: rs.get(k) for k in keep}, 'queries': j.get('queries')}


def resolve(ip, name, typ='A', **flags):
    q = urllib.parse.urlencode({'name': name, 'type': typ, **{k: '1' for k, v in flags.items() if v}})
    r = get(ip, '/resolve?' + q)
    j = r.get('json') or {}
    r['interpreted'] = {'Status': j.get('Status'), 'StatusName': j.get('StatusName'), 'CD': j.get('CD'), 'AD': j.get('AD'), 'Security': j.get('Security'),
                        'Sources': j.get('Sources'), 'EDE': j.get('EDE'), 'ElapsedMs': j.get('ElapsedMs'),
                        'answer': [(a.get('type'), a.get('TTL'), a.get('data')) for a in j.get('Answer', []) or []]}
    return r


def main():
    phase, names_file = sys.argv[1], HERE / sys.argv[2]
    ip, fr = front()
    out = {'phase': phase, 'started': iso(), 'host': HOST, 'frontLookup': fr, 'front': ip}
    out['statusPre'] = get(ip, '/api/status'); out['statusPreDigest'] = status_digest(out['statusPre'])
    if phase == 'A':
        out['cert'] = sh(['bash', '-c', f'openssl s_client -connect {ip}:443 -servername {HOST} -verify_return_error -verify_hostname {HOST} </dev/null 2>&1 | grep -E "Verify return code|verify error|depth=" ; '
                                        f'openssl s_client -connect {ip}:443 -servername {HOST} </dev/null 2>/dev/null | openssl x509 -noout -subject -issuer -dates -ext subjectAltName -fingerprint -sha256'])
        d = 'dnssec-failed.org'
        out['dnssec'] = {
            'bogus_json': resolve(ip, d), 'bogus_json_cd': resolve(ip, d, cd=True), 'bogus_json_cd_do': resolve(ip, d, cd=True, do=True),
            'secure_control_json': resolve(ip, 'isc.org'), 'insecure_control_json': resolve(ip, 'example.org'),
            'bogus_wire': sh(['dig', '+https', '+tls-ca', f'+tls-hostname={HOST}', '+time=10', '+tries=1', '+dnssec', '+multiline', f'@{ip}', d, 'A']),
            'bogus_wire_cd': sh(['dig', '+https', '+tls-ca', f'+tls-hostname={HOST}', '+time=10', '+tries=1', '+cd', '+dnssec', f'@{ip}', d, 'A']),
        }
        tag = 'e' + secrets.token_hex(5)
        names = [f'{tag}-192-0-2-77.nip.io', f'{tag}-192-0-2-78.sslip.io']
        names_file.write_text(json.dumps({'tag': tag, 'names': names, 'at': iso()}) + '\n')
        out['names'] = names
        out['first'] = {n: resolve(ip, n) for n in names}
        time.sleep(3)
        out['second'] = {n: resolve(ip, n) for n in names}
        out['authority'] = {n: sh(['dig', '+time=5', '+tries=1', 'A', n, '@9.9.9.9']) for n in names}
    else:
        names = json.loads(names_file.read_text())['names']
        out['names'] = names
        out['afterExpiry'] = {n: resolve(ip, n) for n in names}
        time.sleep(2)
        out['again'] = {n: resolve(ip, n) for n in names}
        out['authority'] = {n: sh(['dig', '+time=5', '+tries=1', 'A', n, '@9.9.9.9']) for n in names}
    out['statusPost'] = get(ip, '/api/status'); out['statusPostDigest'] = status_digest(out['statusPost'])
    out['finished'] = iso()
    f = HERE / f'phase{phase}-{out["started"].replace(":", "").replace(".", "")}.json'
    f.write_text(json.dumps(out, indent=1) + '\n')
    brief = {k: v for k, v in out.items() if k in ('front', 'statusPreDigest', 'statusPostDigest', 'names')}
    for sec in ('dnssec', 'first', 'second', 'afterExpiry', 'again'):
        if sec in out: brief[sec] = {k: {'at': v.get('at'), 'http': v.get('http'), 'verify': v.get('sslVerifyResult'), **v['interpreted']} if 'interpreted' in v else {'rc': v['rc'], 'out': v['stdout'][-900:]} for k, v in out[sec].items()}
    if 'cert' in out: brief['cert'] = out['cert']['stdout']
    print(json.dumps(brief, indent=1)); print('WROTE', f.name)


if __name__ == '__main__':
    main()
