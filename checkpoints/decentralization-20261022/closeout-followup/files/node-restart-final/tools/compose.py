#!/usr/bin/env python3
"""Compose helper/node-pair-restart.ps1 from tools/helper-template.ps1: every '# <<verbatim:Name>>' marker is replaced by the
EXACT lines of that function in the root-reviewed node-hold-cutover.ps1 df2e58f2 (source/), with a provenance comment.
tools/provenance-test.ps1 then proves, by the PowerShell AST, that each such function's text is byte-identical to the source."""
import hashlib, json, pathlib, re, sys
H = pathlib.Path(__file__).resolve().parent.parent
SRC = H / 'source/node-hold-cutover.df2e58f2.ps1'
assert hashlib.sha256(SRC.read_bytes()).hexdigest() == 'df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8'
lines = SRC.read_text().split('\n')
RANGES = {'Iso': (74, 74), 'Left': (75, 75), 'NowS': (84, 84), 'LeaseLeft': (85, 85), 'Lim': (87, 87), 'NeedForward': (88, 88),
  'UpdateDecision': (94, 105), 'UpdateState': (107, 111), 'Now': (134, 134), 'NowMs': (135, 135), 'IsoMs': (136, 136), 'Sha': (149, 149),
  'Log': (150, 151), 'Final': (152, 152), 'Invoke-BoundedQuery': (156, 193), 'Query': (196, 204), 'PollRoom': (207, 207), 'Utc': (208, 208),
  'ProcessRows': (209, 213), 'ById': (214, 217), 'Same': (218, 220), 'NodeProcs': (221, 231), 'Privacy': (232, 234), 'Listeners': (235, 241),
  'Manager': (242, 243), 'HostState': (251, 257), 'Vms': (258, 264), 'Known': (266, 266), 'ReadinessNumber': (267, 271), 'LeaseReady': (272, 292),
  'OwnsAgentPort': (293, 297), 'AgentUp': (298, 312), 'LogFrom': (315, 320), 'WaitNodeGone': (354, 365), 'Invoke-TaskCommand': (368, 392),
  'NodeTask': (393, 404), 'StopNode': (406, 431), 'NodeStopped': (432, 432), 'Identity': (530, 533)}
t = (H / 'tools/helper-template.ps1').read_text()
used = []
def sub(m):
    n = m.group(1); a, b = RANGES[n]; body = lines[a - 1:b]
    assert body[0].startswith('function ' + n), (n, body[0][:40])
    used.append(n)
    return f'# verbatim df2e58f2 L{a}-{b}\n' + '\n'.join(body)
out = re.sub(r'^# <<verbatim:([A-Za-z-]+)>>$', sub, t, flags=re.M)
assert '<<verbatim' not in out and sorted(used) == sorted(RANGES), set(RANGES) ^ set(used)
dst = H / 'helper/node-pair-restart.ps1'; dst.write_text(out)
(H / 'helper/provenance.json').write_text(json.dumps({'source': 'work/root-control-rpc-final-20261022/control-package/helper/node-hold-cutover.ps1',
  'sourceSha256': 'df2e58f2569d04b2021a570d8525769ef84976335d2c2657e7e2a3a92604a5d8', 'verbatim': {n: f'L{a}-{b}' for n, (a, b) in RANGES.items()},
  'modified': ['ForwardLeft', 'BeforeStop', 'StartNode', 'Others', 'HyperV', 'Recovery'],
  'new': ['TaskAction', 'UpdateHorizon', 'UnchangedFiles', 'PairNow', 'NewIdentity', 'Invoke-SwapChild', 'SwapJournal', 'SwapStep', 'SwapPair'],
  'helperSha256': hashlib.sha256(dst.read_bytes()).hexdigest()}, indent=1) + '\n')
print(dst, hashlib.sha256(dst.read_bytes()).hexdigest(), len(out.split('\n')), 'lines')
