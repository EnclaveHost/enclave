"""Give the supervisor of metal0's deployed generation (7baabe2, which already has the snpVm paths) the hooks that
book a whole-VM app's CPU share. The text is main's (supervisor.js, 61e620be9), taken from metal/snpvm-supervisor-patch.py
so the two cannot drift: its entries 9 and 10 as they are, and the two edits inside its entry 8.

python3 -I supervisor-delta.py PATCH_SCRIPT SUPERVISOR_JS
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('snpvm_patch', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
body = next(new for old, new in mod.PATCHES if old == 'async function spawnContainer({ deploymentId,')
between = lambda s, a, b: s[s.index(a):s.index(b, s.index(a))]
# inside entry 8: the share functions ahead of snpVmConsider, and the claim's last statement
functions = between(body, '// A whole VM runs on the host', 'async function snpVmConsider(')
claim_new = between(body, '  let slice; try { slice = snpVmSlice(', 'async function snpVmSpawn(')
claim_old = ('  return await tryClaim(d, { ...g, wasmRef: "snpvm:" + d.appRef, _snpVm: plan }, firewall,\n'
             '                        { cpu: true, cpuShare: 0, gpuShare: 0 }, { hinted, resume });\n}\n')
edits = [('async function snpVmConsider(', functions + 'async function snpVmConsider('), (claim_old, claim_new)]
edits += [(old, new) for old, new in mod.PATCHES if 'snpVmDueShare(r)' in new or 'raised = []' in new
          or 'const fixed = raised' in new or 'advertisedCpuFree' in new]
assert len(edits) == 7, len(edits)
path = sys.argv[2]
s = open(path).read()
if 'function snpVmSlice(' in s:
    raise SystemExit('%s already books whole-VM shares' % path)
for old, _ in edits:
    if s.count(old) != 1:
        raise SystemExit('anchor not found exactly once in %s: %r' % (path, old[:70]))
for old, new in edits:
    s = s.replace(old, new)
open(path, 'w').write(s)
