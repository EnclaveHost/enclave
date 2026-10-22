#!/usr/bin/env python3
"""Stands in for the public readback in controller tests."""
import json, os, sys, time
with open(os.environ['FAKE_RB_CALLS'], 'a') as f: f.write(json.dumps({'ip': sys.argv[1], 'expect': sys.argv[2]}) + '\n')
q = json.load(open(os.environ['FAKE_RB_QUEUE'])); step = q.pop(0); json.dump(q, open(os.environ['FAKE_RB_QUEUE'], 'w'))
time.sleep(step.get('sleep', 0)); sys.stdout.write(json.dumps({'ok': step.get('ok', True), 'expect': sys.argv[2]}))
