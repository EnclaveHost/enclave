#!/usr/bin/env python3
"""compare-config.py LIVE.json - local, offline. Which LIVE launch/config settings a release install (install-host r5 1d1580c8)
would DROP, and whether each can be persisted. Template names are extracted from the exact r5 source (its here-strings), so
the comparison never guesses. Hooks in r5: node-config.cmd ends with `call node-config.local.cmd` (updates never write it),
and run-node.cmd calls node-config.cmd -> every NODE setting can live in node-config.local.cmd. shield-config.cmd, run-card.cmd
and run-network.cmd call nothing: a live-only setting there has NO persistence hook (a reviewed change or root's post-install
reapply is needed; this tool only reports it).
Values are compared by sha256 only (as config-names-read.py returns them); a static-name value difference is reported for
root's judgement (many are machine paths/slots the installer recomputes)."""
import json, pathlib, re, sys

W = next(p for p in pathlib.Path(__file__).resolve().parents if p.name == 'work')
R5 = W / 'claude-resumed-20261022/dns-package-review/installer-review/src/install-host.r5.ps1'
def template_names():
    s = R5.read_text(); out = {}
    for m in re.finditer(r'@"\n(.*?)\n"@ \| Set-Content -Encoding ASCII (?:\(Join-Path \$PD "([^"]+)"\)|\$file)', s, re.S):
        names = set(re.findall(r'(?im)^\s*(?:if [^\n]*?\s)?set\s+"?([A-Za-z_][A-Za-z0-9_]*)=', m.group(1)))
        if m.group(2): out[m.group(2)] = names
        else: out['run-node.cmd'] = out['run-shield.cmd'] = names
    out['node-config.cmd'] |= {'BASE_RPCS', 'ENCLAVE_CONTRACT_PINS_FILE'}   # written only for a recorded independent identity ($(if ...) lines)
    return out
HOOK = {'run-node.cmd': 'node-config.local.cmd', 'node-config.cmd': 'node-config.local.cmd', 'shield-config.cmd': None, 'run-card.cmd': None, 'run-network.cmd': None}
def main(argv):
    live = json.loads(pathlib.Path(argv[0]).read_text()); tpl = template_names(); rep = {}
    local = {s['name'] for s in (live.get('node-config.local.cmd') or {}).get('sets', [])}
    for f, hook in HOOK.items():
        e = live.get(f) or {}
        if not e.get('present'): rep[f] = {'present': False}; continue
        names = [s['name'] for s in e.get('sets', [])]
        extra = sorted(set(names) - tpl.get(f, set()))
        rep[f] = {'liveOnlySettings': extra, 'alreadyInLocal': sorted(set(extra) & local), 'persistVia': hook,
                  'needsReviewedChange': bool(extra) and hook is None, 'otherLines': e.get('otherLines')}
    blockers = [f for f, r in rep.items() if r.get('needsReviewedChange')]
    print(json.dumps({'report': rep, 'nodeSettingsToMove': sorted({n for f in ('run-node.cmd', 'node-config.cmd') for n in rep.get(f, {}).get('liveOnlySettings', []) if n not in local}),
                      'noHookFiles': blockers, 'installSafe': not blockers and not any(rep.get(f, {}).get('liveOnlySettings') and not set(rep[f]['liveOnlySettings']) <= local for f in ('run-node.cmd', 'node-config.cmd'))}, indent=1))
    return 0
if __name__ == '__main__': sys.exit(main(sys.argv[1:]))
