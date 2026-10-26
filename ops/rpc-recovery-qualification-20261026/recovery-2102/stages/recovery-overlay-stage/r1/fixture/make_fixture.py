#!/usr/bin/env python3
"""recovery-overlay-stage/r1 fixture/make_fixture.py (prepared by Claude 1660; NOT run by Claude).

A TINY CONTROLLED DELETE reproducing the real situation, unprivileged, entirely inside one new directory (mkfs.ext4 + debugfs -w on
image FILES; no mount, no device, no root):
  1. a 96 MiB ext4 (4 KiB blocks, 256-byte inodes, metadata_csum WITHOUT metadata_csum_seed, 64bit, extent, huge_file, a journal)
     with /data/db/mdbx.dat: 3000 blocks of deterministic bytes, then every odd block 1..2799 punched -> 1401 extents, i.e. an
     extent tree of DEPTH 2 (inode root -> index block -> leaf blocks), like the real candidate; and /data/db/other.dat
  2. the pre-delete metadata is CAPTURED as the fixture's "proven images": the target's inode-table block, every extent tree block
     (from debugfs's own (ETBn) listing, independent of the code under test) and the /data/db directory block -> captured.bin +
     capture.json (offsets, sha256), plus the expected content (a Python model == debugfs dump of the intact file)
  3. the DELETE (debugfs rm: blocks freed, the extent tree emptied) and an inode REUSE (a new EMPTY mdbx.dat taking the same inode
     number, generation changed) -> parent-clean.qcow2 (0444): the freed data blocks are free and untouched (as root 1657 found)
  4. a REUSED-DATA variant: additionally a 4000-block filler file that must overwrite freed target blocks -> parent-reused.qcow2
     (0444): the restored view must then NOT match the expected content (proves the exact-read check can fail)

    make_fixture.py OUT_DIR    -> prints a JSON summary; OUT_DIR must not exist
"""
import hashlib, json, os, re, shutil, subprocess, sys

BLOCK, FS_BLOCKS, TARGET_BLOCKS, FILLER_BLOCKS = 4096, 24576, 3000, 4000
UUID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
ENV = {"PATH": "/usr/bin:/bin:/usr/sbin", "LC_ALL": "C", "DEBUGFS_PAGER": "__none__", "PAGER": "__none__"}


def sh(cmd, timeout=600):
    r = subprocess.run(cmd, env=ENV, capture_output=True, text=True, timeout=timeout, stdin=subprocess.DEVNULL)
    if r.returncode:
        raise RuntimeError(f"{cmd[:3]} failed ({r.returncode}): {r.stderr.strip()[:300]}")
    return r.stdout + r.stderr


def debugfs(img, request, write=False):
    return sh(["debugfs"] + (["-w"] if write else []) + ["-R", request, img])


def debugfs_script(img, path):
    return sh(["debugfs", "-w", "-f", path, img])


def stat_of(img, p):
    out = debugfs(img, f"stat {p}")
    ino = int(re.search(r"^Inode:\s+(\d+)", out, re.M).group(1))
    gen = int(re.search(r"Generation:\s+(\d+)", out).group(1))
    size = int(re.search(r"Size:\s+(\d+)", out).group(1))
    return ino, gen, size, out


def data_blocks(img, p):
    return {int(x) for x in debugfs(img, f"blocks {p}").split()}


def content(n):
    out = bytearray()
    for i in range(n):
        seed = hashlib.sha256(b"recovery-overlay-fixture %d" % i).digest()
        out += (seed * (BLOCK // 32))
    return bytes(out)


def build(out):
    os.mkdir(out, 0o700)
    raw = os.path.join(out, "fs.raw")
    with open(raw, "wb") as f:
        f.truncate(FS_BLOCKS * BLOCK)
    sh(["mkfs.ext4", "-F", "-q", "-b", "4096", "-I", "256", "-U", UUID, "-J", "size=4",
        "-O", "^metadata_csum_seed,^inline_data,metadata_csum,64bit,extent,huge_file,flex_bg,dir_index,filetype,extra_isize",
        "-E", f"lazy_itable_init=0,lazy_journal_init=0,root_owner={os.getuid()}:{os.getgid()}", raw])
    target = content(TARGET_BLOCKS)
    for name, data in (("target.bin", target), ("other.bin", content(3)[:5000]), ("empty.bin", b""),
                       ("filler.bin", b"\xEE" * (FILLER_BLOCKS * BLOCK))):
        with open(os.path.join(out, name), "wb") as f:
            f.write(data)
    punched = list(range(1, 2800, 2))
    script = os.path.join(out, "create.debugfs")
    with open(script, "w") as f:
        f.write("mkdir data\nmkdir data/db\n")
        f.write(f"write {out}/target.bin data/db/mdbx.dat\nwrite {out}/other.bin data/db/other.dat\n")
        for b in punched:
            f.write(f"punch data/db/mdbx.dat {b} {b}\n")
    debugfs_script(raw, script)
    model = bytearray(target)
    for b in punched:
        model[b * BLOCK:(b + 1) * BLOCK] = bytes(BLOCK)
    expected = hashlib.sha256(model).hexdigest()
    dumped = os.path.join(out, "expected-debugfs.bin")
    debugfs(raw, f"dump -p data/db/mdbx.dat {dumped}")
    with open(dumped, "rb") as f:
        dumped_sha = hashlib.sha256(f.read()).hexdigest()
    if dumped_sha != expected:
        raise RuntimeError("debugfs dump of the intact file is not the Python model")
    ino, gen, size, st = stat_of(raw, "data/db/mdbx.dat")
    etb = sorted({int(x) for x in re.findall(r"\(ETB\d+\):(\d+)", st)})
    m = re.search(r"located at block (\d+), offset 0x([0-9a-f]+)", debugfs(raw, f"imap <{ino}>"))
    itable, ioff = int(m.group(1)), int(m.group(2), 16)
    dino, dgen, _ds, _dst = stat_of(raw, "data/db")
    dblocks = sorted(data_blocks(raw, "data/db"))
    if size != TARGET_BLOCKS * BLOCK or len(etb) < 2 or len(dblocks) != 1:
        raise RuntimeError(f"unexpected fixture shape: size {size}, tree blocks {etb}, dir blocks {dblocks}")
    tdata = data_blocks(raw, "data/db/mdbx.dat")
    images, buf = [], bytearray()
    with open(raw, "rb") as f:
        for kind, blocks in (("itable", [itable]), ("tree", etb), ("dir", dblocks)):
            for b in blocks:
                f.seek(b * BLOCK); img = f.read(BLOCK)
                images.append({"kind": kind, "fsBlock": b, "offset": len(buf), "sha256": hashlib.sha256(img).hexdigest()})
                buf += img
    cap = os.path.join(out, "capture"); os.mkdir(cap, 0o700)
    with open(os.path.join(cap, "captured.bin"), "wb") as f:
        f.write(buf)
    meta = {"uuid": UUID.replace("-", ""), "fsBlocks": FS_BLOCKS, "capturedSha256": hashlib.sha256(buf).hexdigest(),
            "target": {"ino": ino, "generation": gen, "size": size, "inodeTableBlock": itable, "inodeOffset": ioff},
            "dir": {"ino": dino, "generation": dgen, "block": dblocks[0]}, "images": images, "expectedSha256": expected,
            "treeBlocks": etb, "punchedBlocks": len(punched)}
    with open(os.path.join(cap, "capture.json"), "w") as f:
        json.dump(meta, f, indent=1)
    # the DELETE and the inode reuse
    debugfs(raw, "rm data/db/mdbx.dat", write=True)
    debugfs(raw, f"write {out}/empty.bin data/db/mdbx.dat", write=True)
    debugfs(raw, "sif data/db/mdbx.dat generation 777", write=True)
    rino, rgen, rsize, _ = stat_of(raw, "data/db/mdbx.dat")
    if rino != ino or rgen == gen or rsize != 0:
        raise RuntimeError(f"the inode was not reused as intended (ino {rino}, gen {rgen}, size {rsize})")
    parents = {}
    clean_raw = os.path.join(out, "clean.raw"); shutil.copyfile(raw, clean_raw)
    debugfs(raw, f"write {out}/filler.bin data/filler", write=True)
    reused = data_blocks(raw, "data/filler") & tdata
    if not reused:
        raise RuntimeError("the filler did not reuse any freed target block")
    for name, src in (("parent-clean.qcow2", clean_raw), ("parent-reused.qcow2", raw)):
        dst = os.path.join(out, name)
        sh(["qemu-img", "convert", "-q", "-f", "raw", "-O", "qcow2", src, dst])
        os.chmod(dst, 0o444)
        with open(dst, "rb") as f:
            parents[name] = hashlib.sha256(f.read()).hexdigest()
    for fn in ("fs.raw", "clean.raw", "filler.bin", "target.bin", "expected-debugfs.bin"):
        os.unlink(os.path.join(out, fn))
    summary = {"capture": cap, "parents": parents, "target": meta["target"], "dir": meta["dir"], "treeBlocks": etb,
               "reusedTargetBlocks": len(reused), "expectedSha256": expected}
    with open(os.path.join(out, "fixture.json"), "w") as f:
        json.dump(summary, f, indent=1)
    return summary


if __name__ == "__main__":
    if len(sys.argv) != 2 or not os.path.isabs(sys.argv[1]) or os.path.lexists(sys.argv[1]):
        print("usage: make_fixture.py NEW_ABSOLUTE_DIR", file=sys.stderr); sys.exit(2)
    print(json.dumps(build(sys.argv[1])))
