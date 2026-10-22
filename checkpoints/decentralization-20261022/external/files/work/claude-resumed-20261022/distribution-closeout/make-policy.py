#!/usr/bin/env python3
"""make-policy.py - write a host release policy (ProgramData\\Enclave\\node\\release-policy.json format) from the OWNER's
PUBLIC key spec(s). Local only. It never creates, reads or asks for a private key, never installs anything and never
contacts a mirror. The installed verifier's own check-policy validates the result (same parser the host uses).

  make-policy.py --key ecdsa-p256:<SPKI> [--key ...] --threshold N --mirror https://.../windows/ [--mirror ...]
                 [--channel stable] --out release-policy.json
Refuses: workspace TEST keys; anything check-policy refuses. Reports every mirror's provider class; it never reports
provider independence (that needs mirrors in independent failure domains, e.g. Enclave hosts/apps outside DigitalOcean,
attested by root; none serves the Windows channel today). Keyholders and threshold are the owner's choice.
Root installs the file ON THE HOST with the installed verifier (RECIPE.md step P3), not with this script.
"""
import argparse, json, pathlib, sys
from channel_common import classify_mirror, node_policy, test_key_specs

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument('--key', action='append', required=True); a.add_argument('--threshold', type=int, required=True)
    a.add_argument('--mirror', action='append', required=True); a.add_argument('--channel', default='stable'); a.add_argument('--out', required=True)
    o = a.parse_args(argv)
    bad = [k[:40] + '...' for k in o.key if k in test_key_specs()]
    if bad: print(json.dumps({'refused': 'workspace TEST key(s) are never a release authority', 'keys': bad})); return 2
    doc = {'format': 'enclave-windows-release-policy/v1', 'channel': o.channel, 'keys': o.key, 'threshold': o.threshold, 'mirrors': o.mirror}
    out = pathlib.Path(o.out)
    try:
        with out.open('x') as f: f.write(json.dumps(doc) + '\n')
    except FileExistsError: print(json.dumps({'refused': f'{out} exists (never overwritten)'})); return 2
    try: checked = node_policy(out)
    except ValueError as e: out.unlink(); print(json.dumps({'refused': f'check-policy: {e}'})); return 2
    classes = {m: classify_mirror(m) for m in checked['mirrors']}
    print(json.dumps({'written': str(out), 'policy': checked, 'mirrorProviders': classes, 'providerIndependence': False,
                      'why': 'external-provider independence needs mirrors in independent failure domains (e.g. Enclave hosts/apps outside DigitalOcean); not attested here, and none serves the Windows channel today'}, indent=1))
    return 0

if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
