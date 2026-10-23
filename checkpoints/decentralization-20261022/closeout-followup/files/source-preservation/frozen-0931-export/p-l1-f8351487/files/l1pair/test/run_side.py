"""Test driver: run ONE side of the pair from an already-validated canonical config (test paths/ports substituted after
validation; production uses `l1pair.py run-el|run-cl CONFIG`, which validates first). Calls the same L.run().
TEST SEAM: arguments after the side are APPENDED to that side's rendered argv (e.g. the test-only
--allow-insecure-genesis-sync that production validation refuses); every use is labelled in the calling test."""
import importlib.util, json, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('l1pair', Path(__file__).resolve().parent.parent / 'l1pair.py')
L = importlib.util.module_from_spec(spec); spec.loader.exec_module(L)
side, extra = sys.argv[2], sys.argv[3:]
seam = json.loads(extra[0][len('--seam='):]) if extra and extra[0].startswith('--seam=') else {'append': extra}
if seam.get('chainIdHex'):                       # TEST network only: the supervisor's readiness chain id
    L.MAIN = dict(L.MAIN, elChainIdHex=seam['chainIdHex'])
if seam.get('append') or seam.get('set'):
    name = 'el_argv' if side == 'el' else 'cl_argv'
    orig = getattr(L, name)
    def patched(c):
        a = list(orig(c))
        for flag, value in (seam.get('set') or {}).items():
            a[a.index(flag) + 1] = value          # replace the VALUE of a rendered flag (e.g. --chain <test genesis>)
        return a + list(seam.get('append') or [])
    setattr(L, name, patched)
sys.exit(L.run(json.loads(Path(sys.argv[1]).read_text()), side))
