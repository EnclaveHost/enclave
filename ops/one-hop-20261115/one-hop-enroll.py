#!/usr/bin/env python3
"""How the NucBox's network-enroll.mjs of the one-hop release was made.

  one-hop-enroll.py <network-enroll.mjs of the near-routes release> <output>

The input is the file ops/near-routes-20261115 installs (3ba1282c...), itself the installed October file with two
changes carried onto it. Three insertions, each after text that occurs exactly once, carry the windows/node hunk of
main f814b020a: validOneHop, the reading of enclaveNetwork.oneHop, and the field in the section the node writes
(after nearRoutes, the place set-one-hop.cjs writes it). Everything else is the input byte for byte. Neither file is
in the repository: both are copies of an installed tree.
"""
import hashlib, sys

BASE = '3ba1282c1303044e7ed8ed0fbeaf71fb5cef70836c1d9d0497a3101525b86a09'
OUT = '42bc9b4a4c5bcf811764e40221aa6def3d97422bc1d0a2f871557179e63b43bf'

EDITS = [
    # (text that occurs once, what goes in front of it)
    ("/** An operator's enclaveNetwork.paceMbps",
     '''/** An operator's enclaveNetwork.oneHop as the privacy agent accepts it (network/enclave-network-host.mjs oneHopOffer): "all"
 *  or a non-empty list of deployment ids; anything else is not carried. */
export function validOneHop(v) {
  if (v === "all") return "all";
  return Array.isArray(v) && v.length && v.every((id) => typeof id === "string" && /^0x[0-9a-f]{64}$/.test(id)) ? [...v] : null;
}

'''),
    ("    // HOST SERVICES: the operator's opt-in, kept byte-for-byte",
     '''    // ONE HOP (docs/design/enclave-network.md): the operator's opt-in to letting named apps (or "all") reach a provider from
    // this box's own address when their owner signed guard:false; set by hand and kept the same way, a malformed value dropped
    const oneHop = validOneHop(cfg?.enclaveNetwork?.oneHop);
'''),
]
# (text that occurs once, what goes after it)
AFTER = ("...(nearRoutes ? { nearRoutes } : {})", ", ...(oneHop ? { oneHop } : {})")


def main():
    src, dst = sys.argv[1], sys.argv[2]
    raw = open(src, 'rb').read()
    if hashlib.sha256(raw).hexdigest() != BASE:
        sys.exit('STOP: the input is not the near-routes release\'s network-enroll.mjs')
    s = raw.decode('utf-8')
    for anchor, text in EDITS:
        if s.count(anchor) != 1:
            sys.exit(f'STOP: {anchor[:40]!r} occurs {s.count(anchor)} times')
        s = s.replace(anchor, text + anchor)
    anchor, text = AFTER
    if s.count(anchor) != 1:
        sys.exit(f'STOP: {anchor[:40]!r} occurs {s.count(anchor)} times')
    s = s.replace(anchor, anchor + text)
    out = s.encode('utf-8')
    got = hashlib.sha256(out).hexdigest()
    if got != OUT:
        sys.exit(f'STOP: the result is {got[:12]}, not the file of this release')
    open(dst, 'wb').write(out)
    print(f'{dst}: {len(out)} bytes, sha256 {got}')


if __name__ == '__main__':
    main()
