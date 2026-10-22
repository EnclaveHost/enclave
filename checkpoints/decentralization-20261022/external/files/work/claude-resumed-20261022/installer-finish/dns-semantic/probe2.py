#!/usr/bin/env python3
"""READ-ONLY follow-ups (same rules as probe.py: verified TLS, bounded, public endpoints only).
  probe2.py wire              RFC 8484 POST /dns-query over HTTP/1.1 (curl --http1.1; the server offers no h2 ALPN, which is
                              what made dig +https fail), wire decoded by dnspython: rcode, flags (AD/CD), EDE option (15)
  probe2.py lapseA FILE N..   /api/status, then /resolve of each name; records each answer's TTL and timestamp in FILE
  probe2.py lapseB FILE       for each name in FILE whose returned TTL has lapsed: /resolve, then again, plus an independent
                              answer (9.9.9.9) for current IPs; /api/status before and after
"""
import json, subprocess, sys, time, datetime, pathlib, tempfile
import dns.message, dns.flags, dns.edns, dns.rcode
from probe import HERE, HOST, iso, sh, front, get, status_digest, resolve


def doh(ip, name, cd=False, do=True):
    q = dns.message.make_query(name, 'A', want_dnssec=do, use_edns=0, payload=1232)
    if cd: q.flags |= dns.flags.CD
    with tempfile.NamedTemporaryFile(suffix='.bin') as f:
        f.write(q.to_wire()); f.flush()
        r = sh(['curl', '-sS', '-m', '15', '--http1.1', '--resolve', f'{HOST}:443:{ip}', '-H', 'content-type: application/dns-message',
                '-H', 'accept: application/dns-message', '--data-binary', f'@{f.name}', '-o', f.name + '.out',
                '-w', '%{http_code} %{ssl_verify_result} %{content_type}', f'https://{HOST}/dns-query'])
        out = {'at': r['at'], 'curlRc': r['rc'], 'httpVerifyCtype': r['stdout'], 'stderr': r['stderr']}
        try:
            raw = pathlib.Path(f.name + '.out').read_bytes(); pathlib.Path(f.name + '.out').unlink()
            m = dns.message.from_wire(raw)
            out.update(rawHex=raw.hex(), rcode=dns.rcode.to_text(m.rcode()), flags=dns.flags.to_text(m.flags),
                       AD=bool(m.flags & dns.flags.AD), CD=bool(m.flags & dns.flags.CD),
                       ede=[{'code': o.code, 'text': o.text} for o in m.options if o.otype == dns.edns.EDE],
                       answer=[r.to_text() for r in m.answer])
        except Exception as e:
            out['parseError'] = f'{type(e).__name__}: {e}'
    return out


def main():
    mode = sys.argv[1]
    ip, fr = front()
    out = {'mode': mode, 'started': iso(), 'front': ip, 'frontLookup': fr}
    if mode == 'wire':
        out['bogus'] = doh(ip, 'dnssec-failed.org')
        out['bogus_cd'] = doh(ip, 'dnssec-failed.org', cd=True)
        out['secure_control'] = doh(ip, 'isc.org')
    else:
        file = HERE / sys.argv[2]
        out['statusPre'] = get(ip, '/api/status'); out['statusPreDigest'] = status_digest(out['statusPre'])
        if mode == 'lapseA':
            names = sys.argv[3:]
            res = {n: resolve(ip, n) for n in names}
            rec = {n: {'at': r['at'], 'epoch': datetime.datetime.fromisoformat(r['at']).timestamp(), 'Sources': r['interpreted']['Sources'],
                       'answer': r['interpreted']['answer']} for n, r in res.items()}
            file.write_text(json.dumps(rec, indent=1) + '\n')
            out['first'] = res
        else:
            rec = json.loads(file.read_text()); now = time.time(); out['plan'] = {}
            out['afterExpiry'] = {}; out['again'] = {}; out['independent'] = {}
            for n, r in rec.items():
                ttl = min([a[1] for a in r['answer'] if a[0] == 1] or [0])
                lapsed = now - (r['epoch'] + ttl)
                out['plan'][n] = {'firstAt': r['at'], 'firstSources': r['Sources'], 'returnedTtl': ttl, 'secondsPastExpiry': round(lapsed, 1)}
                if lapsed <= 1: continue           # not lapsed: not a valid observation, skipped
                out['afterExpiry'][n] = resolve(ip, n)
                out['independent'][n] = sh(['dig', '+time=5', '+tries=1', 'A', n, '@9.9.9.9'])
            time.sleep(1)
            for n in out['afterExpiry']: out['again'][n] = resolve(ip, n)
        out['statusPost'] = get(ip, '/api/status'); out['statusPostDigest'] = status_digest(out['statusPost'])
    out['finished'] = iso()
    f = HERE / f'{mode}-{out["started"].replace(":", "").replace(".", "")}.json'
    f.write_text(json.dumps(out, indent=1) + '\n')
    brief = {'front': ip}
    for k in ('bogus', 'bogus_cd', 'secure_control'):
        if k in out: brief[k] = {x: out[k].get(x) for x in ('at', 'httpVerifyCtype', 'rcode', 'flags', 'AD', 'CD', 'ede', 'answer', 'parseError')}
    for k in ('plan',):
        if k in out: brief[k] = out[k]
    for k in ('first', 'afterExpiry', 'again'):
        if k in out: brief[k] = {n: {'at': v['at'], 'http': v['http'], 'verify': v['sslVerifyResult'], 'Sources': v['interpreted']['Sources'], 'answer': v['interpreted']['answer'], 'ElapsedMs': v['interpreted']['ElapsedMs']} for n, v in out[k].items()}
    if 'independent' in out: brief['independent'] = {n: [l for l in v['stdout'].splitlines() if '\tA\t' in l or ' A ' in l and not l.startswith(';')] for n, v in out['independent'].items()}
    for k in ('statusPreDigest', 'statusPostDigest'):
        if k in out: brief[k] = {'at': out[k]['at'], 'version': out[k]['version'], 'uptime_s': out[k]['uptime_s'], **{x: out[k]['resolver'][x] for x in ('stale_served', 'refreshes', 'cache_hits', 'cache_misses', 'upstream_timeouts')}}
    print(json.dumps(brief, indent=1)); print('WROTE', f.name)


if __name__ == '__main__':
    main()
