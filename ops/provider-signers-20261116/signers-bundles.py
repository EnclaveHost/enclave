#!/usr/bin/env python3
"""How the edges' provider bundles with the remembered signer recovery were made (README.md).

Each target is the bundle an edge runs now (the one-hop release's, identified by SHA-256) with ONE replacement: the
bundle's single copy of viem's recoverMessageAddress. A signer already recovered for the same text and signature is
remembered, and after each new recovery the caller yields to the event loop (main: recoverSigner in
network/provider-directory.mjs). The anchor must occur exactly once or nothing is written; everything else is the
installed file byte for byte.

  signers-bundles.py <dir with the one-hop payload> <output dir>
"""
import hashlib, pathlib, sys

BODY = ('{if(typeof %(m)s!="string"||typeof %(s)s!="string")return %(rec)s({hash:%(hash)s(%(m)s),signature:%(s)s});'
        'let k=%(s)s+"\\n"+%(m)s,h=%(map)s.get(k);if(h){%(map)s.delete(k);%(map)s.set(k,h);return h}'
        'let a=await %(rec)s({hash:%(hash)s(%(m)s),signature:%(s)s});%(map)s.set(k,a);'
        'if(%(map)s.size>4096)%(map)s.delete(%(map)s.keys().next().value);await new Promise(r=>setImmediate(r));return a}')

# three edges (minified build)
MIN = ('async function Ye({message:e,signature:t}){return Zo({hash:_t(e),signature:t})}',
       'var sgc1=new Map;async function Ye({message:e,signature:t})' + BODY % dict(m='e', s='t', rec='Zo', hash='_t', map='sgc1'))
# ca-east (unminified build with host services)
HS = ('async function recoverMessageAddress({ message, signature }) {\n  return recoverAddress({ hash: hashMessage(message), signature });\n}\n',
      'var rememberedSigners = new Map();\nasync function recoverMessageAddress({ message, signature }) '
      + BODY % dict(m='message', s='signature', rec='recoverAddress', hash='hashMessage', map='rememberedSigners') + '\n')

TARGETS = [('03cb11f6/provider.mjs', '03cb11f680217674', MIN), ('0c201bd7/wg-provider.mjs', '0c201bd79619cde4', HS)]

def main(src, out):
    src, out = pathlib.Path(src), pathlib.Path(out)
    for name, prefix, (anchor, replacement) in TARGETS:
        raw = (src / name).read_bytes(); before = hashlib.sha256(raw).hexdigest()
        if not before.startswith(prefix): sys.exit(f'{name}: not the installed file ({before[:16]})')
        text = raw.decode('utf-8')
        if text.count(anchor) != 1: sys.exit(f'{name}: anchor occurs {text.count(anchor)} times')
        data = text.replace(anchor, replacement).encode('utf-8'); after = hashlib.sha256(data).hexdigest()
        target = out / after[:8] / pathlib.Path(name).name
        target.parent.mkdir(parents=True, exist_ok=True); target.write_bytes(data)
        print(f'{name}\t{len(raw)}\t{before}\t->\t{after[:8]}/{target.name}\t{len(data)}\t{after}')

if __name__ == '__main__':
    if len(sys.argv) != 3: sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2])
