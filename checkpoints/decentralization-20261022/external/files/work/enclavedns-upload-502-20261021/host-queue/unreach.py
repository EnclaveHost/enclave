# READ-ONLY: for the 13 hosts sia-diag could not reach via minipc host egress (18:41Z), resolve A/AAAA through public
# resolvers and try a plain TCP connect (no bytes sent) from this workstation (same site uplink), 6 s each.
import json, socket, subprocess, time, concurrent.futures as cf
d = json.load(open('../sia-diag-result.json'))
targets = []
for k in d['errors']:
    a = k.split('CONNECT ', 1)[1].split(' refused')[0]; h, p = a.rsplit(':', 1); targets.append((h, int(p), k.rsplit('(', 1)[1].rstrip(')')))
def dig(h, t):
    try: return subprocess.run(['dig', '+short', '+time=3', '+tries=1', '@1.1.1.1', h, t], capture_output=True, text=True, timeout=8).stdout.split()
    except Exception: return ['ERR']
def probe(x):
    h, p, rep = x
    try: socket.inet_aton(h); a4, a6 = [h], []
    except OSError: a4, a6 = [y for y in dig(h, 'A') if y[0].isdigit()], [y for y in dig(h, 'AAAA') if ':' in y]
    res = []
    for ip in a4[:2]:
        t = time.time(); s = socket.socket(); s.settimeout(6)
        try: s.connect((ip, p)); r = 'open'
        except socket.timeout: r = 'timeout'
        except OSError as e: r = type(e).__name__ + ':' + str(e.errno)
        finally: s.close()
        res.append((ip, r, round(time.time() - t, 1)))
    return {'target': f'{h}:{p}', 'diagRep': rep, 'A': len(a4), 'AAAA': len(a6), 'tcp4': res}
with cf.ThreadPoolExecutor(13) as ex:
    for r in ex.map(probe, targets): print(json.dumps(r))
