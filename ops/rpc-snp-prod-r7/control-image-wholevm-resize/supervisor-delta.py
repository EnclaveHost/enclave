"""Give the supervisor of metal0's running generation (2c9e322: whole-VM shares are booked) the resize hooks: an
owner's share change on a whole-VM app is booked in place with the VM running, and a resized slice of any app is
judged against the share ledger its own release just credited. The text is main's, taken from
metal/snpvm-supervisor-patch.py (its entries 11 and 12, and snpVmResize from its entry 8) so the two cannot drift.

python3 -I supervisor-delta.py PATCH_SCRIPT SUPERVISOR_JS
"""
import importlib.util
import sys

spec = importlib.util.spec_from_file_location('snpvm_patch', sys.argv[1])
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
body = next(new for old, new in mod.PATCHES if old == 'async function spawnContainer({ deploymentId,')
start = body.index("// An owner's setShares on a whole-VM app, in place.")
function = body[start:body.index('async function snpVmConsider(', start)]
edits = [('async function snpVmConsider(', function + 'async function snpVmConsider(')]
edits += [(old, new) for old, new in mod.PATCHES if new is not body and ('snpVmResize(rec, d)' in new or 'heldReservation: true' in new)]
assert len(edits) == 3, len(edits)
path = sys.argv[2]
s = open(path).read()
if 'function snpVmSlice(' not in s:
    raise SystemExit('%s does not book whole-VM shares yet (apply control-image-wholevm-share first)' % path)
if 'function snpVmResize(' in s:
    raise SystemExit('%s already has the resize hooks' % path)
for old, _ in edits:
    if s.count(old) != 1:
        raise SystemExit('anchor not found exactly once in %s: %r' % (path, old[:70]))
for old, new in edits:
    s = s.replace(old, new)
open(path, 'w').write(s)
