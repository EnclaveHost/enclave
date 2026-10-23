"""Read-only byte scan (streamed, 1 MiB windows) of production binaries: the Go build-info lines (vcs.revision/time/modified,
module path, go version) and the COUNT of a few protocol strings. Prints counts and build metadata only, never content."""
import re, sys, hashlib, json
NEEDLES = [b'awaitingCustodyAuth', b'custody-auth', b'enclave-custody-release-v2', b'enclave-custody-release-v1', b'directBootstrap',
           b'custody/v2', b'"v":2', b'v2/custody', b'bootstrapSha256', b'secretsMode']
out = {}
for path in sys.argv[1:]:
    h = hashlib.sha256(); counts = {n.decode(): 0 for n in NEEDLES}; info = set(); tail = b''
    with open(path, 'rb') as f:
        while True:
            c = f.read(1 << 20)
            if not c: break
            h.update(c); w = tail + c
            for n in NEEDLES: counts[n.decode()] += w.count(n) - tail.count(n)
            for m in re.finditer(rb'(?:vcs\.(?:revision|time|modified)=[0-9A-Za-z:.\-+TZ]{1,64}|\bgo1\.\d+(?:\.\d+)?\b|path\t[\x21-\x7e]{1,120}|mod\t[\x21-\x7e]{1,120}\t[\x21-\x7e]{1,60})', w):
                info.add(m.group().decode('ascii', 'replace'))
            tail = c[-256:]
    out[path] = {'sha256': h.hexdigest(), 'strings': counts, 'buildInfo': sorted(info)[:40]}
print(json.dumps(out, indent=1))
