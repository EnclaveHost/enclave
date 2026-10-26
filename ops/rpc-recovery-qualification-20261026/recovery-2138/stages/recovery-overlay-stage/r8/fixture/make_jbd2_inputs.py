#!/usr/bin/env python3
"""recovery-overlay-stage/r2 fixture/make_jbd2_inputs.py (prepared by Claude 1674; NOT run by Claude).

SYNTHETIC real-mode inputs from the fixture capture, so overlay_plan.py's REAL path (proven images, contentSha256 binding, directory
selection, the 1658 extent-list comparison and the r2 chronology) is exercised on real tools' output: a journal-like file holding the
captured images at chosen journal blocks, a result.json in the verifier's shape and a candidates.json in root 1658's shape.
NOT a JBD2 journal (no descriptors/commits): JBD2 authenticity itself is root 1649's verifier, outside this stage.

    build(capture_dir, out_dir, variant) -> {paths, sha256s, args}
variants: ok | tampered-sha | newer-valid-leaf | revoked | unproven | dir-latest-invalid | partial-tree
"""
import hashlib, json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.dirname(HERE))
import overlay_plan as P    # noqa: E402

BLOCK = 4096
S = 500                                                         # the inode's ("pre-deletion") sequence


def _rd(path, mode="rb"):
    with open(path, mode) as f:
        return f.read()


def build(capture_dir, out, variant="ok"):
    meta = json.loads(_rd(os.path.join(capture_dir, "capture.json")))
    raw = _rd(os.path.join(capture_dir, "captured.bin"))
    img = {(im["kind"], im["fsBlock"]): raw[im["offset"]:im["offset"] + BLOCK] for im in meta["images"]}
    t, d = meta["target"], meta["dir"]
    C = P.load_checker()
    uuid16 = bytes.fromhex(meta["uuid"])
    itb = img[("itable", t["inodeTableBlock"])]
    ins = P.check_inode(C, itb[t["inodeOffset"]:t["inodeOffset"] + 256], uuid16, t["ino"], t["generation"], t["size"], meta["fsBlocks"])
    tree = {b: v for (k, b), v in img.items() if k == "tree"}
    extents, _where = P.walk_tree(C, ins["depth"], ins["rootEntries"], tree, uuid16, t["ino"], t["generation"], meta["fsBlocks"])
    journal, targets, jb = [bytes(BLOCK)], {}, 1                 # journal block 0: a placeholder (read_image refuses block 0)

    def put(fs_block, content, seq, *, partial=False, escaped=False, sha=None, revoked=()):
        nonlocal jb
        stored = (bytes(4) + content[4:]) if escaped else content
        journal.append(stored)
        rec = {"blocknr": fs_block, "imageJournalBlock": jb, "imageByteOffset": jb * BLOCK, "sequence": seq, "escaped": escaped,
               "partialCommit": partial, "deletedFlag": False, "contentSha256": sha or hashlib.sha256(content).hexdigest(),
               "revokedByProvenSequence": list(revoked)}
        targets.setdefault(str(fs_block), {"newerOrUnprovenComplete": True, "newerOrUnprovenReferenceSequences": [],
                                           "provenImages": []})["provenImages"].append(rec)
        jb += 1
        return rec

    chosen = {}
    for i, b in enumerate(sorted(tree)):
        r = put(b, tree[b], 100 + i, partial=(variant == "partial-tree" and i == 0),
                sha=("0" * 64 if variant == "tampered-sha" and i == 0 else None),
                revoked=((S - 2,) if variant == "revoked" and i == 0 else (S + 1,)))
        chosen[b] = {"journalBlock": r["imageJournalBlock"], "sequence": r["sequence"]}
    leaf = sorted(tree)[-1]
    if variant == "newer-valid-leaf":                             # the same valid bytes, logged again later: the chosen one is stale
        put(leaf, tree[leaf], S - 1)
    if variant == "unproven":
        targets[str(leaf)]["newerOrUnprovenReferenceSequences"] = [S - 1]
    ir = put(t["inodeTableBlock"], itb, S)
    put(d["block"], img[("dir", d["block"])], S - 3)
    if variant == "dir-latest-invalid":                          # a newer (still <= S) directory image that fails its CRC
        bad = bytearray(img[("dir", d["block"])]); bad[40] ^= 1
        put(d["block"], bytes(bad), S - 1)
    os.mkdir(out, 0o700)
    paths = {k: os.path.join(out, k) for k in ("journal.bin", "result.json", "candidates.json")}
    with open(paths["journal.bin"], "wb") as f:
        f.write(b"".join(journal))
    result = {"summary": {"failedTransactionsTotal": 0, "referenceIndexComplete": True}, "targets": targets}
    cand = {"chosenInode": {"journalBlock": ir["imageJournalBlock"], "sequence": S, "generation": t["generation"], "checksumValid": True,
                            "size": t["size"]},
            "target": {"ino": t["ino"], "generation": t["generation"], "inodeTableBlock": t["inodeTableBlock"],
                       "inodeOffset": t["inodeOffset"], "expectSize": t["size"]},
            "metadataChecksumsValid": True, "tree": [{"block": b, "chosen": chosen[b]} for b in sorted(tree)],
            "map": {"extentList": [list(e) for e in extents]}}
    for k, v in (("result.json", result), ("candidates.json", cand)):
        with open(paths[k], "w") as f:
            json.dump(v, f)
    sha = {k: hashlib.sha256(_rd(p)).hexdigest() for k, p in paths.items()}
    args = ["real", "--journal", paths["journal.bin"], "--journal-sha256", sha["journal.bin"], "--result", paths["result.json"],
            "--result-sha256", sha["result.json"], "--candidates", paths["candidates.json"], "--candidates-sha256", sha["candidates.json"],
            "--uuid", meta["uuid"], "--fs-blocks", str(meta["fsBlocks"]), "--ino", str(t["ino"]), "--gen", str(t["generation"]),
            "--size", str(t["size"]), "--inode-table-block", str(t["inodeTableBlock"]), "--inode-offset", str(t["inodeOffset"]),
            "--dir-ino", str(d["ino"]), "--dir-gen", str(d["generation"]), "--dir-block", str(d["block"])]
    return {"paths": paths, "sha256": sha, "args": args}
