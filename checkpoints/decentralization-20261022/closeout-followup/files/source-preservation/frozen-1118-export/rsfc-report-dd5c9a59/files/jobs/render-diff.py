#!/usr/bin/env python3
"""Render the vm-3 test configurations with the COMPOSED renderers (S's holder.storage_script from s/, P's
l1pair.storage_script from p/) and diff them, byte for byte, against what vm-3 actually ran
(cache-native-boundary-20261023/run/20261023T094842Z/out/render). Output: render/*.sh, render/*.diff, render/summary.json."""
import difflib, hashlib, importlib.util, json, sys
from pathlib import Path
C = Path(__file__).resolve().parent.parent
VM3 = C.parent / 'cache-native-boundary-20261023/run/20261023T094842Z/out/render'
OUT = C / 'render'; OUT.mkdir(exist_ok=True)
def load(n, p):
    s = importlib.util.spec_from_file_location(n, p); m = importlib.util.module_from_spec(s); s.loader.exec_module(m); return m
H = load('holder', C / 's/holder/holder.py'); L = load('l1pair', C / 'p/l1pair/l1pair.py')
hc, pc = json.loads((VM3 / 'holder.json').read_text()), json.loads((VM3 / 'pair.json').read_text())
new = {'holder-storage.sh': H.storage_script(hc, budget_tool='/src/vendor/holder/budget.py'),
       'pair-storage.sh': L.storage_script(pc, budget_tool='/src/vendor/holder/budget.py')}
summary = {}
for name, vs in (('holder-storage.sh', 'holder-storage.sh'), ('pair-storage.sh', 'pair-storage.sh'), ('pair-storage.sh', 'pair-storage.fixed.sh')):
    old = (VM3 / vs).read_text()
    (OUT / name).write_text(new[name])
    d = list(difflib.unified_diff(old.splitlines(True), new[name].splitlines(True), f'vm3/{vs}', f'composed/{name}'))
    (OUT / f'{name}.vs-vm3-{vs}.diff').write_text(''.join(d))
    summary[f'{name} vs vm3 {vs}'] = {'vm3Sha256': hashlib.sha256(old.encode()).hexdigest(), 'composedSha256': hashlib.sha256(new[name].encode()).hexdigest(),
                                      'identical': old == new[name], 'changedLines': sum(1 for l in d if l[:1] in '+-' and l[:3] not in ('+++', '---'))}
tpl = (C / 's/holder/holder-storage.sh.in').read_text(); ptpl = (C / 'p/l1pair/vendor/holder/holder-storage.sh.in').read_text()
summary['templates'] = {'s': hashlib.sha256(tpl.encode()).hexdigest(), 'pVendored': hashlib.sha256(ptpl.encode()).hexdigest(), 'pEqualsS': tpl == ptpl}
head, tail = tpl.split('@CONSTANTS@')
summary['bothRendersUseComposedTemplateBody'] = all(s.startswith(head) and s.endswith(tail) for s in new.values())
import re
consts = lambda s: [l for l in s.splitlines() if re.fullmatch(r"[A-Z_]+='.*'", l)]
summary['constantsIdenticalToVm3'] = {n: consts(new[n]) == consts((VM3 / n).read_text()) for n in new}
(OUT / 'summary.json').write_text(json.dumps(summary, indent=1) + '\n')
print(json.dumps(summary, indent=1))
