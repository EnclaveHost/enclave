#!/usr/bin/env python3
"""recovery-overlay-stage/r2 overlay_plan.py (prepared by Claude 1660/1674; NOT run by Claude). Standard library only.
r2 CHRONOLOGY (real mode): for every patched block, no NEWER committed image at or before the inode's sequence may still be valid
for this inode (a tree block: checksum-valid at its depth and parent start; the inode table block: an inode 1950053 image of the
same generation), and no unproven reference to it may fall in that window - otherwise the chosen image could be stale.

Builds and VERIFIES the metadata patch plan for a DISPOSABLE read-only recovery view of ONE deleted ext4 file. It reads only bounded
local inputs (the copied journal, root's JBD2 verifier result, root's ext4 candidate selection - or, for the fixture, a captured metadata
file) and writes ONE new plan directory: plan.json + sources/*.bin (the exact bytes each patch writes into a NEW overlay). It never
opens the original image, a device, a mount or the network, and it never writes anywhere else.

Every patched byte must be BOTH:
  authentic   real mode: the JBD2 image root's verifier proved (result.json provenImages: exact journal block + sequence, committed,
              not partial; sha256 of the unescaped content equal to contentSha256, re-read from the pinned journal copy)
  consistent  ext4 metadata_csum, with the pinned frozen checker (ext4-recovery-checksum-stage/r2, sha-pinned, its crc32c cross-checked
              against libext2fs): the 256-byte inode for (uuid, ino, gen), every extent index/leaf block for that inode seed and
              its parent's logical start, the EXACT set of tree blocks the inode references (no missing, no extra), and the
              directory leaf block's ext4_dir_entry_tail checksum for (uuid, dir ino, dir gen) with a live entry name -> ino, ft 1
Real mode additionally requires the leaf extents to equal root 1658's map.extentList exactly, and the directory image to be the LATEST
proven image at or before the inode's sequence (an older one is never chosen silently).

Patches: the 256 inode bytes ONLY (inode table block + inode offset; the other inodes in that table block stay current), every
tree block (4096), the directory block (4096). The plan is a diagnostic recovery view, never a recovery or production acceptance.

    overlay_plan.py real    --journal J --journal-sha256 H --result R --result-sha256 H --candidates C --candidates-sha256 H
                            --uuid U --fs-blocks N --ino I --gen G --size S --inode-table-block B --inode-offset O
                            --dir-ino D --dir-gen DG --dir-block DB --name mdbx.dat --path /data/db/mdbx.dat --out DIR
    overlay_plan.py fixture --capture DIR --path /data/db/mdbx.dat --name mdbx.dat --out DIR [--dir-gen DG] [--drop-tree-block N]
Exit 0 written; 2 usage; 3 refused (the out directory is removed; nothing else exists).
"""
import argparse, hashlib, json, os, shutil, stat, struct, sys, types

BLOCK = 4096
INODE_SIZE = 256
CHECKER = ("/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/ext4-recovery-checksum-stage/r2/"
           "ext4_candidate_checksums.py")
CHECKER_SHA256 = "662291e5784a37c820f69902ef7b3c2fd6cf96d34822f60ce1df6f96db7da097"
JOURNAL_MAX, JSON_MAX, CAPTURE_MAX = 1 << 30, 16 << 20, 64 << 20
MAX_TREE = 4096
MAX_SAMPLES = 64
PLAN_FORMAT = "recovery-overlay-plan/v1"
NOT_ACCEPTANCE = "DIAGNOSTIC RECOVERY VIEW ONLY: patched metadata is authentic journal content; the DATA blocks are not authenticated"


class Refused(Exception):
    pass


def load_checker(path=CHECKER, sha=CHECKER_SHA256):
    """the frozen checker, executed from the exact bytes whose sha256 was checked (no re-open between check and use)"""
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > 1 << 20:
            raise Refused("checker is not a bounded regular file")
        src = os.read(fd, st.st_size + 1)
    finally:
        os.close(fd)
    if hashlib.sha256(src).hexdigest() != sha:
        raise Refused(f"checker {path} is not the pinned {sha}")
    mod = types.ModuleType("ext4_candidate_checksums")
    exec(compile(src, path, "exec"), mod.__dict__)
    mod.crc_self_check()
    return mod


def read_pinned(path, sha, max_bytes, what, keep=True):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_size > max_bytes:
            raise Refused(f"{what} must be a regular file of at most {max_bytes} bytes")
        h, data = hashlib.sha256(), bytearray()
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            h.update(b)
            if keep:
                data += b
        if sha is not None and h.hexdigest() != sha:
            raise Refused(f"{what} sha256 {h.hexdigest()} is not the pinned {sha}")
        return bytes(data), st
    finally:
        os.close(fd)


# ---- ext4 checks (built on the frozen checker C) ---------------------------------------------------------------------------------
def dir_seed(C, uuid16, ino, gen):
    return C.inode_seed(uuid16, ino, gen)                        # ext4: a directory's i_csum_seed, same derivation as any inode


def check_dir_block(C, b, uuid16, dir_ino, dir_gen, name, ino):
    """linear directory leaf (no htree): ext4_dir_entry_tail + crc32c(dir seed, block[:size-12]); the live entry name -> ino, ft 1"""
    t = BLOCK - 12
    tino, trl, tnl, tft = struct.unpack_from("<IHBB", b, t)
    if (tino, trl, tnl, tft) != (0, 12, 0, 0xDE):
        raise Refused("directory block has no ext4_dir_entry_tail (htree or not a metadata_csum leaf)")
    provided, calc = struct.unpack_from("<I", b, t + 8)[0], C.crc32c(dir_seed(C, uuid16, dir_ino, dir_gen), b[:t])
    if provided != calc:
        raise Refused(f"directory block checksum mismatch for dir ino {dir_ino} gen {dir_gen} (stored {provided:08x}, computed {calc:08x})")
    o, hits = 0, []
    while o < t:
        eino, rl, nl, ft = struct.unpack_from("<IHBB", b, o)
        if rl < 8 or rl % 4 or o + rl > t or 8 + nl > rl:
            raise Refused(f"malformed directory entry at offset {o}")
        if eino and b[o + 8:o + 8 + nl] == name:
            hits.append((o, eino, ft))
        o += rl
    if o != t:
        raise Refused("directory entries do not end at the tail")
    if len(hits) != 1 or hits[0][1] != ino or hits[0][2] != 1:
        raise Refused(f"directory block does not hold exactly one live regular-file entry {name!r} -> {ino} (found {hits})")
    return {"entryOffset": hits[0][0], "checksum": f"{calc:08x}"}


def check_inode(C, raw, uuid16, ino, gen, size, fs_blocks):
    if len(raw) != INODE_SIZE:
        raise Refused("inode image is not 256 bytes")
    p = C.parse_inode(raw, huge_file=True)
    if p["generation"] != gen:
        raise Refused(f"inode generation {p['generation']} is not the pinned {gen}")
    provided, calc, hi = C.inode_checksum(raw, C.inode_seed(uuid16, ino, gen), INODE_SIZE)
    if provided != calc:
        raise Refused(f"inode checksum mismatch (stored {provided:08x}, computed {calc:08x})")
    if p["mode"] & 0xF000 != 0x8000 or p["links"] < 1 or p["dtime"] != 0 or not p["flags"] & C.EXTENTS_FL or p["size"] != size:
        raise Refused(f"inode is not a live extent-mapped regular file of {size} bytes ({ {k: p[k] for k in ('mode', 'links', 'dtime', 'flags', 'size')} })")
    root = p["iBlock"]
    depth = struct.unpack_from("<H", root, 6)[0]
    if depth > C.MAX_DEPTH:
        raise Refused(f"extent tree depth {depth} exceeds {C.MAX_DEPTH}")
    hdr, ents, why = C.parse_node(root, depth=depth, max_entries=C.ROOT_MAX, lblk=0, root=True, fs_blocks=fs_blocks)
    if why:
        raise Refused(f"inode extent root: {why}")
    return {"depth": depth, "rootEntries": ents, "checksum": f"{calc:08x}", "checksumHiUsed": hi, "iBlocks512": p["iBlocks512"]}


def walk_tree(C, depth, root_ents, images, uuid16, ino, gen, fs_blocks):
    """the EXACT set of tree blocks referenced from the inode root must equal the planned images; every block checksum-valid"""
    iseed, used, extents, where = C.inode_seed(uuid16, ino, gen), set(), [], {}

    def visit(d, ents):
        for e in ents:
            if d == 0:
                extents.append(list(e)); continue
            lblk, child = e
            if child not in images:
                raise Refused(f"tree block {child} (depth {d - 1}) is referenced but has no planned image")
            if child in used:
                raise Refused(f"tree block {child} is referenced twice")
            used.add(child)
            where[child] = (d - 1, lblk)
            if len(used) > MAX_TREE:
                raise Refused("too many tree blocks")
            _h, ch, why, _t = C.check_block_image(images[child], iseed, depth=d - 1, lblk=lblk, fs_blocks=fs_blocks)
            if why:
                raise Refused(f"tree block {child}: {why}")
            visit(d - 1, ch)

    visit(depth, root_ents)
    if used != set(images):
        raise Refused(f"planned tree blocks are not exactly the referenced set (extra {sorted(set(images) - used)[:5]})")
    cur = 0
    for l, n, p, unwritten in extents:
        if l < cur:
            raise Refused(f"extent at logical {l} overlaps its predecessor")
        if unwritten:
            raise Refused(f"unwritten extent at logical {l}: not supported by this view")
        cur = l + n
    return extents, where


def samples_of(extents, size):
    """(logical, physical) pairs: first and last mapped block and up to MAX_SAMPLES-2 evenly spaced extent starts"""
    if not extents:
        return []
    pick = {0, len(extents) - 1}
    step = max(1, len(extents) // (MAX_SAMPLES - 2))
    pick.update(range(0, len(extents), step))
    out = []
    for i in sorted(pick)[:MAX_SAMPLES - 1]:
        l, n, p, _u = extents[i]
        out.append([l, p])
    l, n, p, _u = extents[-1]
    if (l + n - 1) * BLOCK < size:
        out.append([l + n - 1, p + n - 1])
    return out


# ---- plan output -----------------------------------------------------------------------------------------------------------------
def write_plan(out, plan, sources):
    if os.path.lexists(out):
        raise Refused(f"out {out} already exists")
    os.mkdir(out, 0o700)
    os.mkdir(os.path.join(out, "sources"), 0o700)
    for p in plan["patches"]:
        b = sources[p["source"]]
        if len(b) != p["length"] or hashlib.sha256(b).hexdigest() != p["sha256"]:
            raise Refused("internal: a source does not match its patch")
        fn = os.path.join(out, "sources", p["source"])
        fd = os.open(fn, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
        try:
            os.write(fd, b)
        finally:
            os.close(fd)
    data = json.dumps(plan, indent=1, sort_keys=True).encode()
    fd = os.open(os.path.join(out, "plan.json"), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o400)
    try:
        os.write(fd, data)
    finally:
        os.close(fd)
    return hashlib.sha256(data).hexdigest()


def assemble(C, *, mode, uuid16, fs_blocks, ino, gen, size, itable, ioff, dir_ino, dir_gen, dir_block, name, path,
             inode_raw, tree_images, dir_image, provenance, expected_sha256=None):
    ins = check_inode(C, inode_raw, uuid16, ino, gen, size, fs_blocks)
    extents, where = walk_tree(C, ins["depth"], ins["rootEntries"], tree_images, uuid16, ino, gen, fs_blocks)
    dirc = check_dir_block(C, dir_image, uuid16, dir_ino, dir_gen, name, ino)
    if not path.startswith("/") or not path.endswith("/" + name.decode()) or "/../" in path or "//" in path:
        raise Refused("target path must be absolute and end with the entry name")
    patches, sources = [], {}

    def add(kind, fs_block, offset_in_block, raw, prov):
        src = f"{len(patches):03d}-{kind}-{fs_block}.bin"
        sources[src] = raw
        patches.append({"kind": kind, "fsBlock": fs_block, "byteOffset": fs_block * BLOCK + offset_in_block, "length": len(raw),
                        "sha256": hashlib.sha256(raw).hexdigest(), "source": src, "provenance": prov})

    add("inode", itable, ioff, inode_raw, provenance["inode"])
    for b in sorted(tree_images):
        add("tree", b, 0, tree_images[b], provenance["tree"][b])
    add("dir", dir_block, 0, dir_image, provenance["dir"])
    data_blocks = sum(n for _l, n, _p, _u in extents)
    plan = {"format": PLAN_FORMAT, "mode": mode, "acceptance": NOT_ACCEPTANCE,
            "fs": {"uuid": uuid16.hex(), "blockSize": BLOCK, "fsBlocks": fs_blocks, "fsOffset": 0},
            "target": {"path": path, "ino": ino, "generation": gen, "size": size, "inodeTableBlock": itable, "inodeOffset": ioff,
                       "inodeChecksum": ins["checksum"], "treeDepth": ins["depth"], "treeBlocks": len(tree_images),
                       **({"expectedSha256": expected_sha256} if expected_sha256 else {})},
            "dir": {"ino": dir_ino, "generation": dir_gen, "block": dir_block, **dirc},
            "map": {"extents": len(extents), "dataBlocks": data_blocks,
                    "digest": hashlib.sha256(json.dumps(extents, separators=(",", ":")).encode()).hexdigest()},
            "samples": samples_of(extents, size), "patches": patches, "patchBytes": sum(p["length"] for p in patches)}
    return plan, sources, extents, where


# ---- real mode -------------------------------------------------------------------------------------------------------------------
def proven(result, fs_block, jblock, seq):
    t = result["targets"].get(str(fs_block))
    if not t or t.get("newerOrUnprovenComplete") is not True:
        raise Refused(f"fs block {fs_block}: no complete proven-image record in the verifier result")
    m = [x for x in t["provenImages"] if x["blocknr"] == fs_block and x["imageJournalBlock"] == jblock and x["sequence"] == seq]
    if len(m) != 1 or m[0].get("partialCommit") is not False:
        raise Refused(f"fs block {fs_block}: journal block {jblock} sequence {seq} is not exactly one proven committed image")
    return m[0]


def read_proven(C, jfd, img, nblocks):
    if img["imageByteOffset"] != img["imageJournalBlock"] * BLOCK:
        raise Refused("proven image offset does not match its journal block")
    content = C.read_image(jfd, img["imageJournalBlock"], nblocks, img["escaped"])
    if hashlib.sha256(content).hexdigest() != img["contentSha256"]:
        raise Refused(f"journal block {img['imageJournalBlock']}: content is not the verifier's contentSha256")
    return content


def newer_in_window(C, result, jfd, nblocks, fs_block, chosen_seq, limit_seq, still_valid):
    """r2 chronology: refuse if a NEWER committed image (chosen_seq < seq <= limit_seq) is still valid for this target, or if an
    unproven reference to the block falls in that window (it cannot be ruled out)"""
    t = result["targets"][str(fs_block)]
    revoked = [q for x in t["provenImages"] if x["sequence"] == chosen_seq for q in x.get("revokedByProvenSequence", [])
               if chosen_seq < q <= limit_seq]
    if revoked:
        raise Refused(f"fs block {fs_block}: the chosen image (sequence {chosen_seq}) was revoked at {revoked[:5]} before the inode's sequence")
    unproven = [q for q in t.get("newerOrUnprovenReferenceSequences", []) if chosen_seq < q <= limit_seq]
    if unproven:
        raise Refused(f"fs block {fs_block}: unproven references at sequences {unproven[:5]} after the chosen {chosen_seq}")
    checked = 0
    for x in t["provenImages"]:
        if x["blocknr"] == fs_block and chosen_seq < x["sequence"] <= limit_seq and x.get("partialCommit") is False:
            if still_valid(read_proven(C, jfd, x, nblocks)):
                raise Refused(f"fs block {fs_block}: a NEWER valid image (sequence {x['sequence']}, journal block "
                              f"{x['imageJournalBlock']}) exists after the chosen {chosen_seq}: the chosen image may be stale")
            checked += 1
    return checked


def plan_real(C, a):
    result_b, _ = read_pinned(a.result, a.result_sha256, JSON_MAX, "verifier result")
    cand_b, _ = read_pinned(a.candidates, a.candidates_sha256, JSON_MAX, "candidate selection")
    _j, jst = read_pinned(a.journal, a.journal_sha256, JOURNAL_MAX, "journal copy", keep=False)
    result, cand = json.loads(result_b), json.loads(cand_b)
    if result["summary"].get("failedTransactionsTotal") != 0 or result["summary"].get("referenceIndexComplete") is not True:
        raise Refused("the verifier result is not a complete, failure-free proof")
    ci, tgt = cand["chosenInode"], cand["target"]
    if (tgt["ino"], tgt["generation"], tgt["inodeTableBlock"], tgt["inodeOffset"], tgt["expectSize"]) != \
            (a.ino, a.gen, a.inode_table_block, a.inode_offset, a.size) or cand["metadataChecksumsValid"] is not True \
            or ci["generation"] != a.gen or ci["checksumValid"] is not True or ci["size"] != a.size:
        raise Refused("the candidate selection is not for the pinned target")
    uuid16 = bytes.fromhex(a.uuid.replace("-", ""))
    nblocks = jst.st_size // BLOCK
    jfd = os.open(a.journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        js = os.fstat(jfd)
        if (js.st_dev, js.st_ino, js.st_size, js.st_mtime_ns) != (jst.st_dev, jst.st_ino, jst.st_size, jst.st_mtime_ns):
            raise Refused("journal copy changed between hash and read")     # each image is ALSO bound to its proven contentSha256
        img = proven(result, a.inode_table_block, ci["journalBlock"], ci["sequence"])
        itb = read_proven(C, jfd, img, nblocks)
        inode_raw = itb[a.inode_offset:a.inode_offset + INODE_SIZE]
        prov = {"inode": {"journalBlock": ci["journalBlock"], "sequence": ci["sequence"], "tableBlockSha256": img["contentSha256"]},
                "tree": {}, "dir": None}
        tree = {}
        for node in cand["tree"]:
            b, ch = node["block"], node["chosen"]
            ti = proven(result, b, ch["journalBlock"], ch["sequence"])
            tree[b] = read_proven(C, jfd, ti, nblocks)
            prov["tree"][b] = {"journalBlock": ch["journalBlock"], "sequence": ch["sequence"], "contentSha256": ti["contentSha256"],
                               "revokedByProvenSequence": ti.get("revokedByProvenSequence", [])}
        # the directory: the LATEST proven image at or before the inode's sequence; it must validate - never an older one silently
        dt = result["targets"].get(str(a.dir_block))
        if not dt or dt.get("newerOrUnprovenComplete") is not True:
            raise Refused("no complete proven-image record for the directory block")
        before = [x for x in dt["provenImages"] if x["blocknr"] == a.dir_block and x["sequence"] <= ci["sequence"]
                  and x.get("partialCommit") is False]
        if not before:
            raise Refused("no proven directory image at or before the inode's sequence")
        di = max(before, key=lambda x: (x["sequence"], x["imageJournalBlock"]))
        dir_image = read_proven(C, jfd, di, nblocks)
        prov["dir"] = {"journalBlock": di["imageJournalBlock"], "sequence": di["sequence"], "contentSha256": di["contentSha256"],
                       "considered": len(before)}
    finally:
        os.close(jfd)
    plan, sources, extents, where = assemble(C, mode="real", uuid16=uuid16, fs_blocks=a.fs_blocks, ino=a.ino, gen=a.gen, size=a.size,
                                      itable=a.inode_table_block, ioff=a.inode_offset, dir_ino=a.dir_ino, dir_gen=a.dir_gen,
                                      dir_block=a.dir_block, name=a.name.encode(), path=a.path, inode_raw=inode_raw,
                                      tree_images=tree, dir_image=dir_image, provenance=prov)
    if [list(x) for x in cand["map"]["extentList"]] != [[l, n, p, u] for l, n, p, u in extents]:
        raise Refused("the restored extent map is not root 1658's map.extentList")
    # r2 chronology, re-reading only the (bounded) proven images in each window
    uuid16, S = bytes.fromhex(a.uuid.replace("-", "")), ci["sequence"]
    iseed = C.inode_seed(uuid16, a.ino, a.gen)

    def tree_valid(blk):
        d, l = where[blk]
        return lambda b: C.check_block_image(b, iseed, depth=d, lblk=l, fs_blocks=a.fs_blocks)[2] is None

    def inode_valid(b):
        raw = b[a.inode_offset:a.inode_offset + INODE_SIZE]
        if struct.unpack_from("<I", raw, 0x64)[0] != a.gen:
            return False
        provided, calc, _hi = C.inode_checksum(raw, iseed, INODE_SIZE)
        return provided == calc

    jfd = os.open(a.journal, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    try:
        nblocks = os.fstat(jfd).st_size // BLOCK
        chron = {"inode": newer_in_window(C, result, jfd, nblocks, a.inode_table_block, ci["sequence"], S, inode_valid), "tree": 0,
                 "dir": newer_in_window(C, result, jfd, nblocks, a.dir_block, di["sequence"], S, lambda b: True)}
        for node in cand["tree"]:
            chron["tree"] += newer_in_window(C, result, jfd, nblocks, node["block"], node["chosen"]["sequence"], S, tree_valid(node["block"]))
    finally:
        os.close(jfd)
    plan["chronology"] = {"limitSequence": S, "newerImagesChecked": chron,
                          "rule": "no newer committed image <= the inode's sequence is still valid for (ino, gen); no unproven reference"}
    plan["inputs"] = {"journalSha256": a.journal_sha256, "resultSha256": a.result_sha256, "candidatesSha256": a.candidates_sha256,
                      "checkerSha256": CHECKER_SHA256}
    return plan, sources


# ---- fixture mode ----------------------------------------------------------------------------------------------------------------
def plan_fixture(C, a):
    cap = os.path.join(a.capture, "capture.json")
    meta_b, _ = read_pinned(cap, None, JSON_MAX, "capture.json")
    meta = json.loads(meta_b)
    raw, _ = read_pinned(os.path.join(a.capture, "captured.bin"), meta["capturedSha256"], CAPTURE_MAX, "captured.bin")
    imgs = {}
    for im in meta["images"]:
        b = raw[im["offset"]:im["offset"] + BLOCK]
        if len(b) != BLOCK or hashlib.sha256(b).hexdigest() != im["sha256"]:
            raise Refused(f"captured image of block {im['fsBlock']} is not its recorded sha256")
        imgs[(im["kind"], im["fsBlock"])] = b
    t, d = meta["target"], meta["dir"]
    itb = imgs[("itable", t["inodeTableBlock"])]
    tree = {blk: b for (k, blk), b in imgs.items() if k == "tree" and blk != a.drop_tree_block}
    prov = {"inode": {"fixtureCapture": True}, "tree": {b: {"fixtureCapture": True} for b in tree}, "dir": {"fixtureCapture": True}}
    plan, sources, _e, _w = assemble(C, mode="fixture", uuid16=bytes.fromhex(meta["uuid"]), fs_blocks=meta["fsBlocks"], ino=t["ino"],
                                gen=t["generation"], size=t["size"], itable=t["inodeTableBlock"], ioff=t["inodeOffset"],
                                dir_ino=d["ino"], dir_gen=a.dir_gen if a.dir_gen is not None else d["generation"], dir_block=d["block"],
                                name=a.name.encode(), path=a.path, inode_raw=itb[t["inodeOffset"]:t["inodeOffset"] + INODE_SIZE],
                                tree_images=tree, dir_image=imgs[("dir", d["block"])], provenance=prov,
                                expected_sha256=meta["expectedSha256"])
    plan["inputs"] = {"captureSha256": meta["capturedSha256"], "checkerSha256": CHECKER_SHA256}
    return plan, sources


def main(argv=None):
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="mode", required=True)
    r = sub.add_parser("real")
    for k in ("journal", "result", "candidates"):
        r.add_argument(f"--{k}", required=True); r.add_argument(f"--{k}-sha256", required=True)
    for k in ("fs-blocks", "ino", "gen", "size", "inode-table-block", "inode-offset", "dir-ino", "dir-gen", "dir-block"):
        r.add_argument(f"--{k}", type=int, required=True)
    r.add_argument("--uuid", required=True)
    f = sub.add_parser("fixture")
    f.add_argument("--capture", required=True); f.add_argument("--dir-gen", type=int); f.add_argument("--drop-tree-block", type=int)
    for p in (r, f):
        p.add_argument("--name", required=True); p.add_argument("--path", required=True); p.add_argument("--out", required=True)
    a = ap.parse_args(argv)
    if not os.path.isabs(a.out):
        print("--out must be absolute", file=sys.stderr); return 2
    existed = os.path.lexists(a.out)
    try:
        C = load_checker()
        plan, sources = plan_real(C, a) if a.mode == "real" else plan_fixture(C, a)
        digest = write_plan(a.out, plan, sources)
    except (Refused, KeyError, ValueError, OSError) as e:
        if not existed and os.path.isdir(a.out) and not os.path.islink(a.out):
            shutil.rmtree(a.out)                      # only the directory this run created
        print(json.dumps({"refused": f"{type(e).__name__}: {e}"}))
        return 3
    print(json.dumps({"plan": os.path.join(a.out, "plan.json"), "planSha256": digest, "patches": len(plan["patches"]),
                      "patchBytes": plan["patchBytes"], "extents": plan["map"]["extents"], "acceptance": NOT_ACCEPTANCE}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
