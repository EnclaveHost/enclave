#!/usr/bin/env python3
"""Stands in for `node public-readback.mjs <ip> --expect X` in controller tests."""
import json, os, sys, time
with open(os.environ['FAKE_RB_CALLS'], 'a') as f:
    f.write(json.dumps({'ip': sys.argv[1], 'expect': sys.argv[3]}) + '\n')
q = json.load(open(os.environ['FAKE_RB_QUEUE']))
step = q.pop(0); json.dump(q, open(os.environ['FAKE_RB_QUEUE'], 'w'))
time.sleep(step.get('sleep', 0))
out = step.get('stdout', {'ok': step.get('ok', True), 'expect': sys.argv[3]})
sys.stdout.write(out if isinstance(out, str) else json.dumps(out))
sys.exit(0 if step.get('ok', True) else 1)
