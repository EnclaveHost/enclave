#!/usr/bin/env python3
"""Stands in for `ssh <host> python3 -` in controller tests: records the host program's mode, answers from a queue."""
import ast, json, os, re, sys, time
program = sys.stdin.read()
mode = ast.literal_eval(re.match(r"PARAMS = (.*)\n", program).group(1))
mode = json.loads(mode)["mode"]
with open(os.environ['FAKE_CALLS'], 'a') as f:
    f.write(json.dumps({'host': sys.argv[1], 'mode': mode}) + '\n')
q = json.load(open(os.environ['FAKE_QUEUE']))
step = q.pop(0); json.dump(q, open(os.environ['FAKE_QUEUE'], 'w'))
assert step.get('mode', mode) == mode, (step, mode)
time.sleep(step.get('sleep', 0))
out = step.get('stdout')
sys.stdout.write(out if isinstance(out, str) else json.dumps(out) + '\n')
sys.exit(step.get('rc', 0))
