"""re-pin run-native.py FILES to the current local fixture/script bytes (local file edit only; prints old -> new).
--check: change nothing; exit 1 if a pin differs from the local bytes."""
import hashlib, pathlib, re, sys
N = pathlib.Path(__file__).resolve().parent.parent / 'native'; p = N / 'run-native.py'; t = p.read_text()
for f in ('chact.ps1', 'native-challenge-test.ps1'):
    h = hashlib.sha256((N / f).read_bytes()).hexdigest(); old = re.search(rf"'{re.escape(f)}': '([0-9a-f]{{64}})'", t).group(1)
    t = t.replace(f"'{f}': '{old}'", f"'{f}': '{h}'"); print(f, old[:8], '->', h[:8], 'same' if old == h else 'DIFFERS')
if '--check' in sys.argv: sys.exit(0 if t == p.read_text() else 1)
p.write_text(t)
