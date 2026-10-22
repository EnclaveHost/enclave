#!/usr/bin/env python3
"""Insert ipfs-trustless-routes.caddy into a front's ipfs.enclave.host site block (root runs this on each front).

  python3 apply-front.py --caddyfile /etc/caddy/Caddyfile --snippet ipfs-trustless-routes.caddy [--check-only] [--adapt-only]

- Refuses unless the file has exactly ONE `ipfs.enclave.host {` site block containing exactly ONE `    handle /ipfs/* {` line;
  the snippet goes immediately before that line (so it precedes the generic /ipfs/* route).
- Idempotent: if the snippet's begin marker is already in the block, nothing is written ("already applied").
- Backup first: <caddyfile>.pre-trustless-<sha256[:12]> (byte-exact; rollback = copy it back and reload).
- Validates the candidate with `caddy validate` (or `caddy adapt` with --adapt-only, for offline tests) BEFORE an atomic
  rename into place. It never reloads Caddy: that is root's explicit next command.
"""
import argparse, hashlib, os, subprocess, sys, tempfile
from pathlib import Path

BEGIN = "    # --- trustless-gateway block serving for published sites"
ANCHOR = "    handle /ipfs/* {\n"

def site_block(text):
    starts = [i for i in range(len(text)) if text.startswith("ipfs.enclave.host {\n", i) and (i == 0 or text[i - 1] == "\n")]
    if len(starts) != 1: raise SystemExit(f"refused: {len(starts)} 'ipfs.enclave.host {{' site blocks (need exactly 1)")
    s = starts[0]; end = text.find("\n}\n", s)
    if end < 0: raise SystemExit("refused: the ipfs.enclave.host block does not close")
    return s, end + 3

def main():
    a = argparse.ArgumentParser(); a.add_argument("--caddyfile", required=True); a.add_argument("--snippet", required=True)
    a.add_argument("--caddy", default="caddy"); a.add_argument("--check-only", action="store_true"); a.add_argument("--adapt-only", action="store_true")
    o = a.parse_args()
    path, snippet = Path(o.caddyfile), Path(o.snippet).read_text()
    if not snippet.startswith(BEGIN): raise SystemExit("refused: the snippet does not start with its begin marker")
    text = path.read_text(); s, e = site_block(text); block = text[s:e]
    if BEGIN in block: print("already applied: nothing written"); return 0
    if block.count(ANCHOR) != 1: raise SystemExit(f"refused: {block.count(ANCHOR)} '{ANCHOR.strip()}' lines in the block (need exactly 1)")
    new = text[:s] + block.replace(ANCHOR, snippet.rstrip("\n") + "\n" + ANCHOR, 1) + text[e:]
    with tempfile.NamedTemporaryFile("w", dir=path.parent, prefix=".Caddyfile.trustless.", delete=False) as f: f.write(new); cand = f.name
    try:
        cmd = [o.caddy, "adapt" if o.adapt_only else "validate", "--config", cand, "--adapter", "caddyfile"]
        r = subprocess.run(cmd, capture_output=True, text=True)
        if r.returncode != 0: raise SystemExit("refused: caddy " + cmd[1] + " failed:\n" + r.stderr[-2000:])
        old_sha = hashlib.sha256(text.encode()).hexdigest()
        if o.check_only: print(f"check only: the candidate {cmd[1]}s OK; {path} (sha256 {old_sha}) unchanged"); return 0
        backup = path.with_name(path.name + ".pre-trustless-" + old_sha[:12])
        if not backup.exists(): backup.write_bytes(text.encode()); os.chmod(backup, path.stat().st_mode & 0o777)
        os.chmod(cand, path.stat().st_mode & 0o777)
        try: os.chown(cand, path.stat().st_uid, path.stat().st_gid)
        except PermissionError: pass
        os.replace(cand, path); cand = None
        print(f"applied: {path} sha256 {old_sha} -> {hashlib.sha256(new.encode()).hexdigest()}; backup {backup}; NOT reloaded")
        return 0
    finally:
        if cand and os.path.exists(cand): os.unlink(cand)

if __name__ == "__main__": sys.exit(main())
