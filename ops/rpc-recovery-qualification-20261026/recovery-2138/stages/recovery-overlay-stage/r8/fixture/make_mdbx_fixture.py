#!/usr/bin/env python3
"""recovery-overlay-stage/r8 fixture/make_mdbx_fixture.py (prepared by Claude 1707; NOT run by Claude).

An END-TO-END diagnostic fixture with a REAL MDBX database, unprivileged, image files only:
  1. the PINNED mk_fixture (mdbx-recovery-validator-stage/r4 run, libmdbx v0.13.12) creates a small DB (mdbx.dat + mdbx.lck)
  2. a 64 MiB ext4 (the same features as make_fixture) gets /data/db/mdbx.dat and /data/db/mdbx.lck (as a real reth db dir)
  3. the pre-delete metadata is CAPTURED in make_fixture's capture format (inode-table block, any extent tree blocks, the dir block)
  4. DELETE mdbx.dat only (mdbx.lck stays live, as it would) and REUSE its inode (a new empty mdbx.dat, another generation)
  5. -> parent-mdbx.qcow2 (0444)
The restored view must then be judged structurally clean by the PINNED mdbx_chk through the real wrapper (diag/run_validator.py)
on the read-only fuse2fs mount - the whole diagnostic chain, end to end. A small file has an inode-only extent tree (depth 0):
the depth-2 tree path is covered by make_fixture's fixture.

    build(out_dir, mk_fixture_path) -> summary
"""
import hashlib, json, os, re, shutil, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_fixture as F    # noqa: E402  (strict sh/debugfs helpers: stdout parsing, stderr only the banner)

FS_BLOCKS = 16384
UUID = "1a2b3c4d-5e6f-4708-9a1b-2c3d4e5f6071"


def build(out, mk_fixture):
    os.mkdir(out, 0o700)
    dbsrc = os.path.join(out, "dbsrc")
    os.mkdir(dbsrc, 0o700)                                     # mk_fixture opens an EXISTING directory (as the r4 tests do)
    F.sh([mk_fixture, dbsrc, "3000"])
    dat, lck = os.path.join(dbsrc, "mdbx.dat"), os.path.join(dbsrc, "mdbx.lck")
    if not (os.path.isfile(dat) and os.path.isfile(lck)):
        raise RuntimeError("mk_fixture did not create mdbx.dat and mdbx.lck")
    with open(dat, "rb") as f:
        expected = hashlib.sha256(f.read()).hexdigest()
    raw = os.path.join(out, "fs.raw")
    with open(raw, "wb") as f:
        f.truncate(FS_BLOCKS * F.BLOCK)
    F.sh(["mkfs.ext4", "-F", "-q", "-b", "4096", "-I", "256", "-U", UUID, "-J", "size=4",
          "-O", "^metadata_csum_seed,^inline_data,metadata_csum,64bit,extent,huge_file,flex_bg,dir_index,filetype,extra_isize",
          "-E", f"lazy_itable_init=0,lazy_journal_init=0,root_owner={os.getuid()}:{os.getgid()}", raw])
    script = os.path.join(out, "create.debugfs")
    with open(script, "w") as f:
        f.write(f"mkdir data\nmkdir data/db\nwrite {dat} data/db/mdbx.dat\nwrite {lck} data/db/mdbx.lck\n")
    F.debugfs_script(raw, script)
    ino, gen, size, st = F.stat_of(raw, "data/db/mdbx.dat")
    etb = sorted({int(x) for x in re.findall(r"\(ETB\d+\):(\d+)", st)})
    m = re.search(r"located at block (\d+), offset 0x([0-9a-f]+)", F.debugfs(raw, f"imap <{ino}>"))
    itable, ioff = int(m.group(1)), int(m.group(2), 16)
    dino, dgen, _ds, _ = F.stat_of(raw, "data/db")
    dblocks = sorted(F.data_blocks(raw, "data/db"))
    if size != os.path.getsize(dat) or len(dblocks) != 1:
        raise RuntimeError(f"unexpected shape: size {size}, dir blocks {dblocks}")
    images, buf = [], bytearray()
    with open(raw, "rb") as f:
        for kind, blocks in (("itable", [itable]), ("tree", etb), ("dir", dblocks)):
            for b in blocks:
                f.seek(b * F.BLOCK); img = f.read(F.BLOCK)
                images.append({"kind": kind, "fsBlock": b, "offset": len(buf), "sha256": hashlib.sha256(img).hexdigest()})
                buf += img
    cap = os.path.join(out, "capture"); os.mkdir(cap, 0o700)
    with open(os.path.join(cap, "captured.bin"), "wb") as f:
        f.write(buf)
    meta = {"uuid": UUID.replace("-", ""), "fsBlocks": FS_BLOCKS, "capturedSha256": hashlib.sha256(buf).hexdigest(),
            "target": {"ino": ino, "generation": gen, "size": size, "inodeTableBlock": itable, "inodeOffset": ioff},
            "dir": {"ino": dino, "generation": dgen, "block": dblocks[0]}, "images": images, "expectedSha256": expected, "treeBlocks": etb}
    with open(os.path.join(cap, "capture.json"), "w") as f:
        json.dump(meta, f, indent=1)
    empty = os.path.join(out, "empty.bin")
    open(empty, "wb").close()
    F.debugfs(raw, "rm data/db/mdbx.dat", write=True)
    F.debugfs(raw, f"write {empty} data/db/mdbx.dat", write=True)
    F.debugfs(raw, "sif data/db/mdbx.dat generation 777", write=True)
    rino, rgen, rsize, _ = F.stat_of(raw, "data/db/mdbx.dat")
    if rino != ino or rgen == gen or rsize != 0:
        raise RuntimeError(f"the inode was not reused as intended (ino {rino}, gen {rgen}, size {rsize})")
    parent = os.path.join(out, "parent-mdbx.qcow2")
    F.sh(["qemu-img", "convert", "-q", "-f", "raw", "-O", "qcow2", raw, parent])
    os.chmod(parent, 0o444)
    with open(parent, "rb") as f:
        psha = hashlib.sha256(f.read()).hexdigest()
    os.unlink(raw); shutil.rmtree(dbsrc)
    return {"capture": cap, "parent": parent, "parentSha256": psha, "expectedSha256": expected, "treeBlocks": etb, "target": meta["target"]}
