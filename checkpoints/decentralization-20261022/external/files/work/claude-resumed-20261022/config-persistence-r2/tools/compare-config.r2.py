#!/usr/bin/env python3
"""compare-config.r2.py LIVE.json INSTALLER.ps1 VARS.json OUT.json -- LOCAL, OFFLINE review aid (replaces compare-config.py).

The previous tool compared NAMES only and printed installSafe=true from that, which is unsound: a same-name/different-value
setting, a conditional or quoted assignment, or a non-SET launcher line is invisible to a name comparison. This one:
  1. renders the target installer's REAL launcher templates with the host's known inputs (tools/render.ps1);
  2. classifies every live `set` NAME per file by VALUE HASH against the rendered value:
       generated-same | generated-differs | generated-input-unknown (a machine/box-specific input: never declared equal)
       | live-only (no generated line) | rendered-only (the install would ADD it);
  3. classifies every live NON-SET line by hash: template-line | UNKNOWN-line (not produced by the target template);
  4. checks each customization (generated-differs, live-only) against the file's local hook by value hash
       (node-config.local.cmd for run-node/node-config, shield-config.local.cmd for shield-config/run-shield, none otherwise).
It NEVER certifies preservation: certifiesPreservation is always false. The input has names and value hashes only (no assignment
form, condition or order), so conditional/quoted/ordering effects are verified on the host by the root-only migration plan
(root/migrate-local-config.ps1), which parses the actual lines. `blocking` lists what must be resolved before an install.
Values never appear: only names, hashes and line numbers of the RENDERED (non-secret, generated) text."""
import hashlib, json, pathlib, re, subprocess, sys, tempfile

HERE = pathlib.Path(__file__).resolve().parent
PWSH = '/home/steven/Documents/Codex/2026-10-18/wo/work/node-hold-package-20261021/tools/pwsh/pwsh'
# root's corrected reader regex (config-names-read.py 018f9b93), same groups: NAME, value
SET = re.compile(r'(?i)^\s*(?:if [^\r\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=(.*?)"?\s*$')
H = lambda s: hashlib.sha256(s.encode('utf-8')).hexdigest()
HOOK = {'run-node.cmd': 'node-config.local.cmd', 'node-config.cmd': 'node-config.local.cmd', 'shield-config.cmd': 'shield-config.local.cmd',
        'run-shield.cmd': 'shield-config.local.cmd', 'run-card.cmd': None, 'run-network.cmd': None}
# the hook's position decides which value is EFFECTIVE: called LAST by these generated files (it overrides them, before and after an
# install), called FIRST by the SET-free launchers (their own hand-made lines overrode it; after the rewrite only the hook remains)
HOOK_LAST = {'node-config.cmd', 'shield-config.cmd'}
# computed by the installer from the box and the local hook (RAM -> slots); a difference is a review item, not an operator setting
DERIVED = {'NODE_APP_RAM_GB', 'APP_SLOTS'}
SECURITY = {'BASE_RPCS', 'IPFS_GATEWAY', 'IPFS_GATEWAYS', 'ENCLAVE_CONTRACT_PINS_FILE', 'ENCLAVE_HOST_OWNERSHIP', 'ENCLAVE_HOST_REGISTRY_PIN',
            'ENCLAVE_HOST_CATALOG_PIN', 'ENCLAVE_HOST_POLICY_DIR', 'ENCLAVE_HOST_POLICY_ORIGINS', 'ENCLAVE_HOST_ID', 'ENCLAVE_NETWORK_WALLET_HOLD',
            'ENCLAVE_NETWORK_CHECKERS', 'ENCLAVE_NETWORK_DIRECTORIES', 'ENCLAVE_IDENTITY_MODE', 'ENCLAVE_SHIELD_PROFILE', 'ENCLAVE_STARTUP_RPCS',
            'PUBLIC_URL', 'RELAY_URL'} | {f'ENCLAVE_PLATFORM_HOST_POLICY{s}' for s in ('', '_RPCS', '_MIRRORS', '_ACTIVATION', '_INTERVAL_SEC', '_GRACE_SEC')}


def render(installer, varsf, ram=None):
    out = pathlib.Path(tempfile.mkdtemp(prefix='cfg-render-'))
    if ram is not None:
        # the installer's own carry: NODE_APP_RAM_GB from node-config.local.cmd (resolved by hash below), the machine large enough
        (out / 'node-config.local.cmd').write_text(f'set NODE_APP_RAM_GB={ram}\r\n')
        v = json.loads(pathlib.Path(varsf).read_text()); v['ramGb'] = 65536
        varsf = out / 'vars.json'; varsf.write_text(json.dumps(v))
    r = subprocess.run([PWSH, '-NoProfile', '-NonInteractive', '-File', str(HERE / 'render.ps1'), '-Installer', str(installer), '-Vars', str(varsf), '-OutDir', str(out)],
                       capture_output=True, text=True, timeout=120)
    if r.returncode: raise SystemExit('render failed: ' + r.stderr[-2000:])
    return json.loads((out / 'rendered.json').read_text())


def parse(text):
    sets, other = {}, []
    for i, l in enumerate(text.replace('\r\n', '\n').split('\n')[:-1], 1):
        m = SET.match(l)
        if m: sets[m.group(1)] = {'valueSha256': H(m.group(2)), 'unknownInput': '<UNKNOWN:' in m.group(2), 'line': i}
        else: other.append({'sha256': H(l), 'line': i})
    return sets, other


def main(argv):
    live = json.loads(pathlib.Path(argv[0]).read_text()); installer, varsf, outf = argv[1], argv[2], argv[3]
    # NODE_APP_RAM_GB is the box's own RAM figure (a small integer, not a secret): resolved only if its hash matches one in 1..4096
    lh = {s['name']: s['valueSha256'] for s in (live.get('node-config.local.cmd') or {}).get('sets', [])}.get('NODE_APP_RAM_GB')
    ram = next((n for n in range(1, 4097) if H(str(n)) == lh), None) if lh else None
    rendered = render(installer, varsf, ram)
    report, blocking, review = {}, [], []
    for f, hook in HOOK.items():
        L = live.get(f)
        rs, ro = parse(rendered[f]) if f in rendered else ({}, [])
        if not L or not L.get('present'):
            report[f] = {'live': 'NOT READ' if L is None else 'absent', 'note': 'not in the live read: customizations here are UNKNOWN' if L is None else None}
            if L is None: review.append(f'{f}: not read by the live names/hashes read (no evidence either way)')
            continue
        hookSets = {s['name']: s['valueSha256'] for s in (live.get(hook) or {}).get('sets', [])} if hook else {}
        if hook and hook not in live: review.append(f'{f}: its hook {hook} is not in the live read (hook coverage unknown; add it to the reader)')
        names = {}
        liveSets = {}
        for s in L.get('sets', []): liveSets[s['name']] = s['valueSha256']          # last assignment per name
        for n, vh in liveSets.items():
            r = rs.get(n)
            if r is None: st = 'live-only'
            elif r['unknownInput']: st = 'generated-input-unknown'
            elif r['valueSha256'] == vh: st = 'generated-same'
            else: st = 'generated-differs'
            e = {'status': st, 'security': n in SECURITY}
            if st in ('live-only', 'generated-differs'):
                e['hook'] = hook
                e['inHookSameValueHash'] = bool(hook) and hookSets.get(n) == vh
                # effective before and after the install is the hook's value whenever a last-called hook sets the name
                e['overriddenByHookAnyway'] = f in HOOK_LAST and n in hookSets
                if e['inHookSameValueHash'] or e['overriddenByHookAnyway']: pass
                elif n in DERIVED and st == 'generated-differs': review.append(f'{f}:{n} ({st}; installer-derived from the box/local hook: the install recomputes it)')
                else: blocking.append(f'{f}:{n} ({st}; ' + ('no persistence hook' if not hook else f'not in {hook} with the same value hash') + ')')
            if st == 'generated-input-unknown' and n in SECURITY: review.append(f'{f}:{n} (security-relevant, generated from a box-specific input: compare on host)')
            names[n] = e
        for n in rs:
            if n not in liveSets: names[n] = {'status': 'rendered-only', 'security': n in SECURITY}
        known = {o['sha256'] for o in ro}
        lines = [{'liveIndex': i, 'status': 'template-line' if h in known else 'UNKNOWN-line'} for i, h in enumerate(L.get('otherLineSha256', []))]
        unknown = [x['liveIndex'] for x in lines if x['status'] == 'UNKNOWN-line']
        if unknown: review.append(f'{f}: {len(unknown)} non-SET line(s) not produced by the target template (live otherLineSha256 index {unknown}); the install drops them')
        report[f] = {'liveSha256': L.get('sha256'), 'names': names, 'nonSetLines': {'live': len(lines), 'templateLines': len(lines) - len(unknown), 'unknown': unknown},
                     'renderedNonSetLinesNotLive': [o['line'] for o in ro if o['sha256'] not in set(L.get('otherLineSha256', []))]}
    out = {'tool': 'compare-config.r2.py', 'installer': str(installer), 'installerSha256': hashlib.sha256(pathlib.Path(installer).read_bytes()).hexdigest(),
           'liveSha256': hashlib.sha256(pathlib.Path(argv[0]).read_bytes()).hexdigest(), 'report': report,
           'ramResolvedByHash': ram is not None, 'blocking': blocking, 'needsRootReview': review, 'certifiesPreservation': False,
           'whyNoCertification': 'names and value hashes only: no assignment form, condition, order or effective-value evidence; the on-host migration plan verifies those'}
    pathlib.Path(outf).write_text(json.dumps(out, indent=1) + '\n')
    print(json.dumps({'blocking': blocking, 'needsRootReview': review, 'certifiesPreservation': False}, indent=1))
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
