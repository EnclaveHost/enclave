#!/usr/bin/env python3
"""Stage-only builder for the two loader-only bench initramfs images.

Takes explicit paths to already-built static binaries (CGO_ENABLED=0
GOOS=linux GOARCH=amd64), checks the pinned kernel and firmware digests,
and writes into a NEW directory:

  arm-A.initramfs.cpio.gz   init, bin/shieldmodel, reclaim marker
  arm-B.initramfs.cpio.gz   the same plus the drop-cache marker
  build-manifest.json       every input and output digest, archive listings

It runs no process, needs no privilege (the console node exists only inside
the archive), never opens the model, and refuses an existing output path.
"""

import argparse
import glob
import json
import os
import sys

import benchlib as B

HERE = os.path.dirname(os.path.abspath(__file__))


def write_new(path, data, mode=0o444):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_CLOEXEC, 0o600)
    with os.fdopen(fd, "wb") as f:
        f.write(data)
    os.chmod(path, mode)


def source_digests(dirs):
    out = {}
    for d in dirs:
        for p in sorted(glob.glob(os.path.join(d, "*.go")) + glob.glob(os.path.join(d, "*.py"))):
            out[os.path.abspath(p)] = B.sha256_file(p)
    return out


def build(args):
    out = os.path.abspath(args.out)
    for name, p in (("init", args.init), ("loader", args.loader)):
        B.check_static_elf_amd64(p)
    if os.path.realpath(args.init) == os.path.realpath(args.loader):
        raise ValueError("init and loader must be different binaries")
    pins = {"kernel": (args.kernel, B.KERNEL_SHA256), "firmware": (args.firmware, B.FIRMWARE_SHA256)}
    for name, (p, want) in pins.items():
        got = B.sha256_file(p)
        if got != want:
            raise ValueError(f"{name} {p}: sha256 {got} != pinned {want}")
    with open(args.init, "rb") as f:
        init_bytes = f.read()
    with open(args.loader, "rb") as f:
        loader_bytes = f.read()

    os.mkdir(out, 0o755)  # refuses an existing directory
    manifest = {
        "kind": "shield-loader-only-snp-ab-build",
        "note": "stage only; model never read on the host, verified in guest by shieldmodel",
        "inputs": {
            "init": {"path": os.path.abspath(args.init), "sha256": B.sha256_file(args.init)},
            "loader": {"path": os.path.abspath(args.loader), "sha256": B.sha256_file(args.loader)},
            "kernel": {"path": os.path.abspath(args.kernel), "sha256": B.KERNEL_SHA256},
            "firmware": {"path": os.path.abspath(args.firmware), "sha256": B.FIRMWARE_SHA256},
        },
        "sources": source_digests([args.init_source, args.loader_source, HERE]),
        "model": {"path": B.MODEL_PATH, "size": B.MODEL_SIZE, "sha256": B.MODEL_SHA256,
                  "host_check": "stat identity only"},
        "cmdline": B.CMDLINE,
        "arms": {},
    }
    for arm in B.ARMS:
        entries = B.initramfs_entries(init_bytes, loader_bytes, arm)
        gz = B.deterministic_gzip(B.newc_archive(entries))
        path = os.path.join(out, f"arm-{arm}.initramfs.cpio.gz")
        write_new(path, gz)
        manifest["arms"][arm] = {
            "initramfs": path,
            "sha256": B.sha256_file(path),
            "entries": [{"path": p, "mode": "%o" % m, "size": len(d),
                         "rdev": "%d:%d" % r if r else None} for p, m, d, r in entries],
        }
    write_new(os.path.join(out, "build-manifest.json"),
              (json.dumps(manifest, indent=2, sort_keys=True) + "\n").encode())
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--init", required=True, help="static bench init binary")
    ap.add_argument("--loader", required=True, help="static shieldmodel binary (same for both arms)")
    ap.add_argument("--init-source", required=True, help="directory holding init/*.go")
    ap.add_argument("--loader-source", required=True, help="directory holding loader-candidate/*.go")
    ap.add_argument("--kernel", required=True, help="existing release kernel (digest pinned)")
    ap.add_argument("--firmware", required=True, help="existing release firmware (digest pinned)")
    ap.add_argument("--out", required=True, help="new output directory; must not exist")
    args = ap.parse_args(argv)
    try:
        m = build(args)
    except (OSError, ValueError) as e:
        print(f"build refused: {e}", file=sys.stderr)
        return 1
    for arm, a in m["arms"].items():
        print(f"arm {arm}: {a['initramfs']} sha256={a['sha256']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
