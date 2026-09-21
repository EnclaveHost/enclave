#!/usr/bin/env python3
"""fetch-cid.py -- fetch an app artifact by IPFS CID and VERIFY it against that CID, then write it.

    python fetch-cid.py <cid> <out path> [max bytes] [gateway]

The verification is the platform's own (wasm/ipfs_fetch.py, copied beside this file by sync-apps.sh):
the gateway is asked for a CAR and every block is hashed back to its CID, so a tampering or
substituting gateway fails here rather than handing the node somebody else's wasm. Exit 0 and print
"ok <bytes> <sha256>"; on failure exit 1 and print the reason.
"""
import sys, os, hashlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ipfs_fetch

def main():
    if len(sys.argv) < 3:
        print("usage: fetch-cid.py <cid> <out> [max bytes] [gateway]", file=sys.stderr); return 2
    cid, out = sys.argv[1], sys.argv[2]
    cap = int(sys.argv[3]) if len(sys.argv) > 3 else 128 * 1024 * 1024
    gw = sys.argv[4] if len(sys.argv) > 4 else os.environ.get("IPFS_GATEWAY", "https://ipfs.enclave.host")
    try:
        data = ipfs_fetch.fetch_verified(cid, gw, cap, 180)
    except Exception as e:
        print(f"fetch/verify failed for {cid}: {e}", file=sys.stderr); return 1
    tmp = out + ".part"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, out)
    print(f"ok {len(data)} {hashlib.sha256(data).hexdigest()}")
    return 0

if __name__ == "__main__":
    sys.exit(main())
