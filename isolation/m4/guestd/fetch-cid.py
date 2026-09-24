#!/usr/bin/env python3
"""fetch-cid.py -- guestd's fetcher: the bytes a CID names, VERIFIED against it, or a refusal.

    python3 fetch-cid.py <repo root> <cid> <out path> <max bytes> <gateway>

The verification is the platform's own, imported in place from <repo>/wasm/ipfs_fetch.py (the module the
wasm-manager and the Windows node use), never a second implementation: the gateway is asked for a CAR and every
block is hashed back to its CID, so a substituting gateway fails here. On success the bytes are written to <out>
and "ok <bytes> <sha256>" is printed; on failure nothing is written, the reason goes to stderr and the exit is 1.
"""
import hashlib, os, sys


def main():
    if len(sys.argv) != 6:
        print(__doc__, file=sys.stderr)
        return 2
    repo, cid, out, cap, gw = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4]), sys.argv[5]
    sys.path.insert(0, os.path.join(repo, "wasm"))
    import ipfs_fetch
    # Public trustless gateways refuse Python's default user agent (403). Name ourselves instead; the bytes are
    # verified against the CID either way, so which gateway answers decides availability, never content.
    import urllib.request
    opener = urllib.request.build_opener()
    opener.addheaders = [("User-Agent", "enclave-guestd/1")]
    urllib.request.install_opener(opener)
    try:
        data = ipfs_fetch.fetch_verified(cid, gw, cap, 180)
    except Exception as e:
        print(f"fetch/verify failed for {cid}: {e}", file=sys.stderr)
        return 1
    with open(out, "wb") as f:
        f.write(data)
    print(f"ok {len(data)} {hashlib.sha256(data).hexdigest()}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
