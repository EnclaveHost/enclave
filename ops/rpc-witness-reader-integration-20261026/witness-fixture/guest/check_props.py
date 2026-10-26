#!/usr/bin/env python3
"""witness-rpc-live-canary-stage/r2: compare the ACTUAL transient bridge unit (`systemctl show` text) with the SHIPPED unit file's constraints.
  check_props.py UNIT_FILE SHOW_TEXT  -> JSON {prop: {want, got, ok}} on stdout; exit 0 only if every property matches
Every expected value comes from the shipped unit file; `systemctl show` spellings are canonicalised (sizes in bytes, address families as a
set, IPAddressDeny/Allow `any`/`localhost` as their CIDR sets, booleans), never loosened."""
import json, sys

PROPS = ('User', 'Group', 'CapabilityBoundingSet', 'NoNewPrivileges', 'ProtectSystem', 'ProtectHome', 'PrivateTmp', 'PrivateDevices',
         'RestrictAddressFamilies', 'IPAddressDeny', 'IPAddressAllow', 'MemoryMax', 'MemorySwapMax', 'TasksMax', 'UMask')
CIDR = {'any': {'0.0.0.0/0', '::/0'}, 'localhost': {'127.0.0.0/8', '::1/128'}}
BOOL = {'yes': True, 'true': True, '1': True, 'on': True, 'no': False, 'false': False, '0': False, 'off': False}


def unit_values(text):
    out, sec = {}, None
    for l in text.splitlines():
        s = l.strip()
        if not s or s.startswith('#'):
            continue
        if s.startswith('['):
            sec = s; continue
        if sec == '[Service]' and '=' in s:
            k, v = s.split('=', 1); out[k] = v
    return out


def size(v):
    v = v.strip()
    m = {'K': 1 << 10, 'M': 1 << 20, 'G': 1 << 30}
    return int(v[:-1]) * m[v[-1]] if v and v[-1] in m else int(v)


def canon(k, v):
    v = (v or '').strip()
    if k in ('MemoryMax', 'MemorySwapMax'):
        return size(v) if v not in ('', 'infinity') else v
    if k == 'TasksMax':
        return int(v) if v.isdigit() else v
    if k == 'UMask':
        return int(v, 8) if v else None
    if k in ('NoNewPrivileges', 'PrivateTmp', 'PrivateDevices'):
        return BOOL.get(v.lower(), v)
    if k == 'ProtectHome':
        return {'yes': 'yes', 'true': 'yes'}.get(v.lower(), v.lower())
    if k == 'RestrictAddressFamilies':
        return frozenset(v.split())
    if k in ('IPAddressDeny', 'IPAddressAllow'):
        s = set()
        for x in v.split():
            s |= CIDR.get(x, {x})
        return frozenset(s)
    if k == 'CapabilityBoundingSet':
        return frozenset(v.split())
    return v


def check(unit_text, show_text):
    want = unit_values(unit_text); got = dict(l.split('=', 1) for l in show_text.splitlines() if '=' in l)
    res = {}
    for k in PROPS:
        if k not in want:
            res[k] = {'want': None, 'got': got.get(k), 'ok': False, 'why': 'the shipped unit does not set it'}; continue
        w, g = canon(k, want[k]), canon(k, got.get(k)) if k in got else None
        res[k] = {'want': want[k], 'got': got.get(k), 'ok': k in got and w == g}
    return res


if __name__ == '__main__':
    r = check(open(sys.argv[1]).read(), open(sys.argv[2]).read())
    print(json.dumps(r, sort_keys=True)); sys.exit(0 if all(v['ok'] for v in r.values()) else 1)
