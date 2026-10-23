import json, sys
out = sys.argv[1]
run = next(l.split('=', 1)[1].strip() for l in open(out) if l.startswith('run='))
for l in open(out):
    if l.startswith('{'):
        d = json.loads(l)
        if not d['ok'] or d['step'] in ('allocation', 'summary'):
            print('HOST', 'OK ' if d['ok'] else 'FAIL', d['step'], json.dumps({k: v for k, v in d.items() if k not in ('step', 'ok')})[:600])
try:
    g = json.load(open(run + '/out/results.json'))
except Exception as e:
    print('no guest results', e); sys.exit()
for x in g:
    s = json.dumps({k: v for k, v in x.items() if k not in ('step', 'ok', 't')})
    print('OK  ' if x['ok'] else 'FAIL', x['step'], '' if x['ok'] else s[:1400])
