#!/usr/bin/env python3
"""ext4-recovery-checksum-stage/r1 ext4_candidate_checksums.py (prepared by Claude 1643; NOT run by Claude). Standard library only.

OFFLINE ext4 metadata_csum qualifier for ONE deleted inode's candidate metadata images found in a COPIED JBD2 journal file. It reads
only: the journal copy (regular, no-follow, non-blocking; 4 KiB preads at the image offsets named by r1 inventories), those inventory
JSON files (bounded) and writes ONE new bounded JSON. No device, image, data block, extraction, replay or repair path.

What it verifies, exactly as the pinned primary sources do (refs/, sha256 in SHA256SUMS and the report):
  seed      s_csum_seed = crc32c(~0, s_uuid)                  linux v6.12 fs/ext4/super.c:4611; e2fsprogs v1.47.2 csum.c:39
            (metadata_csum_seed absent; the caller asserts it, --no-csum-seed)
            i_csum_seed = crc32c(crc32c(s_csum_seed, le32 ino), le32 i_generation)              fs/ext4/inode.c:4774-4779
  inode     crc32c(i_csum_seed, raw inode with i_checksum_lo (and i_checksum_hi if it fits) zeroed, EXT4_INODE_SIZE bytes);
            provided = lo | hi << 16 when 128 + i_extra_isize >= 0x84, else compare the low 16 bits     fs/ext4/inode.c:57-108
  extent    non-root block: crc32c(i_csum_seed, block[0 : 12 + 12*eh_max]) == le32 at that offset   fs/ext4/extents.c:49-73,
            ext4_extents.h:96-105 (EXT4_EXTENT_TAIL_OFFSET); header/entry rules of __ext4_ext_check / ext4_valid_extent_entries
            (magic 0xf30a, eh_depth == expected, 0 < eh_max <= max, entries <= eh_max, entries > 0 at depth > 0, first logical block ==
            parent index, ascending non-overlapping, no zero-length / wrapping extent) - extents.c:367-505
  crc32c    "ext4_chksum" returns the raw shash state (no final inversion), ext4.h:2467-2483: here an independent pure table
            (reflected 0x82F63B78), cross-checked at start against the LOCAL libext2fs ext2fs_crc32c_le and the CRC-32C check vector.
A checksum-valid block proves only that THOSE bytes are what ext4 wrote for (uuid, ino, gen). It does NOT prove which version was
current at a given time, that a newer version did not exist outside the surviving journal, that the JBD2 records are authentic (separate
work, not done here), or anything about the DATA blocks (never read; freed blocks may have been reused). recoveryProven is always false.

    ext4_candidate_checksums.py --journal /ABS/journal-8.bin --inventory /ABS/inv1.json [--inventory ...] --uuid UUID --ino N --gen G
        --inode-size 256 --inode-table-block B --inode-offset O --at-or-before-seq S --fs-blocks N --huge-file yes|no --no-csum-seed
        --out /ABS/out.json [--expect-size BYTES] [--fixture]
Exit 0 written; 2 usage; 3 refused (nothing written).
"""
import argparse, ctypes, ctypes.util, hashlib, json, os, stat, struct, sys

BLOCK = 4096
JOURNAL_BYTES = 1 << 30
INVENTORY_MAX = 16 << 20
MAX_INVENTORIES = 8
OUT_MAX = 16 << 20
MAX_IMAGES_PER_BLOCK = 5000
MAX_TREE_BLOCKS = 4096
JBD2_MAGIC = b"\xc0\x3b\x39\x98"
EXT_MAGIC = 0xF30A
GOOD_OLD = 128
OFF_CSUM_LO, OFF_EXTRA_ISIZE, OFF_CSUM_HI = 0x7C, 0x80, 0x82
HUGE_FILE_FL, EXTENTS_FL = 0x40000, 0x80000
MAX_DEPTH = 2                                   # this qualifier handles depth 0, 1 and 2 only (the candidate is depth 2)
ROOT_MAX = (60 - 12) // 12                      # ext4_ext_space_root: 4
BLOCK_MAX = (BLOCK - 12) // 12                  # ext4_ext_space_block: 340
INIT_MAX_LEN = 1 << 15                          # EXT_INIT_MAX_LEN
INVENTORY_FORMAT = "journal-recovery-r1-jbd2-inventory/v1"


class Refused(Exception):
    pass


# ---- crc32c: independent pure table, raw (no pre/post inversion), as ext4_chksum / ext2fs_crc32c_le ---------------------------------
def _table():
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ 0x82F63B78 if c & 1 else c >> 1
        t.append(c)
    return t


_T = _table()


def crc32c(crc, data):
    crc &= 0xFFFFFFFF
    for b in data:
        crc = _T[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc


def libext2fs_crc32c():
    """the local libext2fs ext2fs_crc32c_le(crc, buf, len), or None if the library is absent"""
    name = ctypes.util.find_library("ext2fs")
    if not name:
        return None
    lib = ctypes.CDLL(name)
    f = lib.ext2fs_crc32c_le
    f.restype, f.argtypes = ctypes.c_uint32, [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_size_t]
    return lambda crc, data: f(crc & 0xFFFFFFFF, bytes(data), len(data))


def crc_self_check():
    if (~crc32c(0xFFFFFFFF, b"123456789")) & 0xFFFFFFFF != 0xE3069283:
        raise Refused("pure-table crc32c fails the CRC-32C check vector")
    lib = libext2fs_crc32c()
    if lib is None:
        raise Refused("local libext2fs (ext2fs_crc32c_le) is required for the cross-check and was not found")
    for seed, data in ((0xFFFFFFFF, b"123456789"), (0, bytes(range(256)) * 3), (0x12345678, b"\x00" * 4096), (0xFFFFFFFF, bytes(16))):
        if crc32c(seed, data) != lib(seed, data):
            raise Refused("pure-table crc32c disagrees with libext2fs ext2fs_crc32c_le")
    return "pure table == libext2fs ext2fs_crc32c_le on 4 vectors; CRC-32C check value 0xE3069283"


# ---- bounded inputs ------------------------------------------------------------------------------------------------------------
def open_regular(path, max_bytes, what):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise Refused(f"{what} path must be absolute")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as e:
        raise Refused(f"{what}: cannot open without following a symlink ({e.strerror})")
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_mode & 0o022 or st.st_uid not in (0, os.geteuid()) or st.st_size > max_bytes:
        os.close(fd)
        raise Refused(f"{what} must be a regular file of root or this user, not group/world-writable, <= {max_bytes} bytes")
    return fd, st


def load_inventory(path):
    fd, st = open_regular(path, INVENTORY_MAX, "inventory")
    try:
        chunks, n = [], 0
        while True:
            b = os.read(fd, 1 << 20)
            if not b:
                break
            n += len(b)
            if n > INVENTORY_MAX:
                raise Refused("inventory grew beyond its bound while read")
            chunks.append(b)
    finally:
        os.close(fd)
    try:
        v = json.loads(b"".join(chunks).decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Refused("inventory is not UTF-8 JSON")
    if not isinstance(v, dict) or v.get("format") != INVENTORY_FORMAT or not isinstance(v.get("targets", {}).get("candidates"), dict):
        raise Refused(f"inventory is not {INVENTORY_FORMAT}")
    return v


def images_by_block(inventories):
    """fs block -> {journalBlock: candidate} (deduplicated over inventories; conflicting duplicates refuse)"""
    out = {}
    for inv in inventories:
        for k, cands in inv["targets"]["candidates"].items():
            if not k.isdigit() or not isinstance(cands, list) or len(cands) > MAX_IMAGES_PER_BLOCK:
                raise Refused("inventory candidates are malformed or exceed the per-block bound")
            for c in cands:
                if not isinstance(c, dict) or not all(isinstance(c.get(x), int) and not isinstance(c.get(x), bool) for x in ("sequence", "imageJournalBlock")):
                    raise Refused("inventory candidate lacks integer sequence / imageJournalBlock")
                slot = out.setdefault(int(k), {})
                prev = slot.get(c["imageJournalBlock"])
                if prev is not None and prev["sequence"] != c["sequence"]:
                    raise Refused(f"inventories disagree about journal block {c['imageJournalBlock']}")
                slot[c["imageJournalBlock"]] = c
    return out


def read_image(fd, jblock, nblocks, escaped):
    if not 1 <= jblock < nblocks:
        raise Refused(f"image journal block {jblock} is outside the journal")
    b = os.pread(fd, BLOCK, jblock * BLOCK)
    if len(b) != BLOCK:
        raise Refused(f"short read at journal block {jblock}")
    return (JBD2_MAGIC + b[4:]) if escaped else b       # JBD2 escape: the log zeroed the block's leading magic


# ---- ext4 structures -------------------------------------------------------------------------------------------------------------
def inode_seed(uuid16, ino, gen):
    return crc32c(crc32c(crc32c(0xFFFFFFFF, uuid16), struct.pack("<I", ino)), struct.pack("<I", gen))


def inode_checksum(raw, iseed, inode_size):
    """(provided, calculated, used_hi) exactly as ext4_inode_csum / ext4_inode_csum_verify"""
    z = bytearray(raw[:inode_size]); z[OFF_CSUM_LO:OFF_CSUM_LO + 2] = b"\0\0"
    extra = struct.unpack_from("<H", raw, OFF_EXTRA_ISIZE)[0] if inode_size > GOOD_OLD else 0
    has_hi = inode_size > GOOD_OLD and OFF_CSUM_HI + 2 <= GOOD_OLD + extra
    if has_hi:
        z[OFF_CSUM_HI:OFF_CSUM_HI + 2] = b"\0\0"
    calc = crc32c(iseed, bytes(z))
    provided = struct.unpack_from("<H", raw, OFF_CSUM_LO)[0]
    if has_hi:
        provided |= struct.unpack_from("<H", raw, OFF_CSUM_HI)[0] << 16
    else:
        calc &= 0xFFFF
    return provided, calc, has_hi


def parse_inode(raw, huge_file):
    g = lambda fmt, o: struct.unpack_from(fmt, raw, o)[0]
    blocks = g("<I", 0x1C) | ((g("<H", 0x74) << 32) if huge_file else 0)
    flags = g("<I", 0x20)
    sectors = blocks * (BLOCK // 512) if huge_file and flags & HUGE_FILE_FL else blocks
    return {"mode": g("<H", 0), "size": g("<I", 4) | (g("<I", 0x6C) << 32), "dtime": g("<I", 0x14), "links": g("<H", 0x1A),
            "flags": flags, "generation": g("<I", 0x64), "iBlocks512": sectors, "mtime": g("<I", 0x10), "ctime": g("<I", 0x0C),
            "extraIsize": g("<H", OFF_EXTRA_ISIZE), "iBlock": raw[0x28:0x28 + 60]}


def parse_node(b, *, depth, max_entries, lblk, root, fs_blocks):
    """(header, entries, problem) per __ext4_ext_check / ext4_valid_extent_entries; entries: index [(lblk, child)] or leaf
    [(lblk, len, pblk, unwritten)]"""
    magic, entries, emax, edepth, _gen = struct.unpack_from("<HHHHI", b, 0)
    hdr = {"entries": entries, "max": emax, "depth": edepth}
    if magic != EXT_MAGIC:
        return hdr, [], "invalid magic"
    if edepth != depth:
        return hdr, [], f"unexpected eh_depth {edepth} (expected {depth})"
    if emax == 0 or emax > max_entries:
        return hdr, [], f"invalid eh_max {emax}"
    if entries > emax:
        return hdr, [], "eh_entries > eh_max"
    if entries == 0 and depth > 0:
        return hdr, [], "eh_entries is 0 but eh_depth > 0"
    out, cur = [], 0
    for i in range(entries):
        o = 12 + 12 * i
        if depth == 0:
            ee_block, ee_len, hi, lo = struct.unpack_from("<IHHI", b, o)
            unwritten = ee_len > INIT_MAX_LEN
            n = ee_len - INIT_MAX_LEN if unwritten else ee_len
            pblk = (hi << 32) | lo
            if n == 0 or ee_block + n > 1 << 32 or pblk == 0 or pblk + n > fs_blocks:
                return hdr, [], f"invalid extent {i} (len {n}, pblk {pblk})"
            if ee_block < cur:
                return hdr, [], f"overlapping extent {i}"
            cur = ee_block + n; out.append((ee_block, n, pblk, unwritten))
        else:
            ei_block, leaf_lo, leaf_hi, _ = struct.unpack_from("<IIHH", b, o)
            child = (leaf_hi << 32) | leaf_lo
            if child == 0 or child >= fs_blocks:
                return hdr, [], f"invalid index {i} (child {child})"
            if ei_block < cur:
                return hdr, [], f"overlapping index {i}"
            cur = ei_block + 1; out.append((ei_block, child))
    if not root and entries and out[0][0] != lblk:
        return hdr, [], f"first logical block {out[0][0]} != parent index {lblk}"
    return hdr, out, None


def check_block_image(b, iseed, *, depth, lblk, fs_blocks):
    hdr, ents, why = parse_node(b, depth=depth, max_entries=BLOCK_MAX, lblk=lblk, root=False, fs_blocks=fs_blocks)
    tail = 12 + 12 * hdr["max"]
    if why is None and tail + 4 > BLOCK:
        why = "tail beyond the block"
    if why is None:
        provided, calc = struct.unpack_from("<I", b, tail)[0], crc32c(iseed, b[:tail])
        if provided != calc:
            return hdr, ents, f"extent block checksum mismatch (stored {provided:08x}, computed {calc:08x}, tail @{tail})", tail
    return hdr, ents, why, tail


# ---- the qualifier ---------------------------------------------------------------------------------------------------------------
def qualify(a):
    crc_note = crc_self_check()
    uuid16 = bytes.fromhex(a.uuid.replace("-", ""))
    if len(uuid16) != 16:
        raise Refused("uuid must be 16 bytes")
    if not a.no_csum_seed:
        raise Refused("only filesystems WITHOUT metadata_csum_seed are supported; assert --no-csum-seed after checking the superblock")
    if a.inode_size not in (128, 256, 512, 1024) or a.inode_offset % a.inode_size or not 0 <= a.inode_offset <= BLOCK - a.inode_size:
        raise Refused("inode size/offset invalid for a 4 KiB inode-table block")
    invs = [load_inventory(p) for p in a.inventory]
    if not 1 <= len(invs) <= MAX_INVENTORIES:
        raise Refused(f"1..{MAX_INVENTORIES} inventories are required")
    imgs = images_by_block(invs)
    fd, st = open_regular(a.journal, JOURNAL_BYTES, "journal copy")
    try:
        if a.fixture:
            if st.st_size % BLOCK or st.st_size < 2 * BLOCK:
                raise Refused("fixture journal size must be whole 4 KiB blocks")
        elif st.st_size != JOURNAL_BYTES:
            raise Refused(f"journal copy must be exactly {JOURNAL_BYTES} bytes")
        nblocks = st.st_size // BLOCK
        iseed = inode_seed(uuid16, a.ino, a.gen)
        huge = a.huge_file == "yes"
        # 1. every image of the inode-table block: the target inode's versions
        versions, other_gen = [], 0
        for jb, c in sorted(imgs.get(a.inode_table_block, {}).items(), key=lambda x: (x[1]["sequence"], x[0])):
            raw = read_image(fd, jb, nblocks, bool(c.get("escaped")))[a.inode_offset:a.inode_offset + a.inode_size]
            ino = parse_inode(raw, huge)
            if ino["generation"] != a.gen:
                other_gen += 1; continue
            provided, calc, has_hi = inode_checksum(raw, iseed, a.inode_size)
            v = {"sequence": c["sequence"], "journalBlock": jb, "commitSec": c.get("commitSec"), "committed": c.get("committed") is True,
                 "txIntact": c.get("txIntact") is True, "checksumValid": provided == calc, "checksumStored": f"{provided:08x}",
                 "checksumComputed": f"{calc:08x}", "checksumHiUsed": has_hi, **{k: ino[k] for k in ino if k != "iBlock"},
                 "rootDigest": hashlib.sha256(ino["iBlock"]).hexdigest()[:16], "_iblock": ino["iBlock"]}
            versions.append(v)
        usable = [v for v in versions if v["checksumValid"] and v["committed"] and v["txIntact"] and v["links"] >= 1 and v["dtime"] == 0
                  and v["flags"] & EXTENTS_FL and v["sequence"] <= a.at_or_before_seq and (a.expect_size is None or v["size"] == a.expect_size)]
        result = {"format": "ext4-recovery-checksum-r1/v1", "crc32c": crc_note,
                  "target": {"uuid": a.uuid, "ino": a.ino, "generation": a.gen, "inodeSize": a.inode_size, "inodeTableBlock": a.inode_table_block,
                             "inodeOffset": a.inode_offset, "atOrBeforeSequence": a.at_or_before_seq, "expectSize": a.expect_size, "hugeFile": huge},
                  "inodeVersions": [{k: x for k, x in v.items() if not k.startswith("_")} for v in versions], "otherGenerationImages": other_gen,
                  "problems": [], "recoveryProven": False,
                  "dataIntact": "NOT ASSESSED: no data block was read; freed blocks may have been reused after the deletion",
                  "jbd2": "JBD2 record authenticity is NOT verified here (separate work); only ext4 metadata_csum of the block bytes"}
        if not usable:
            result.update(chosenInode=None, metadataChecksumsValid=False); result["problems"].append("no checksum-valid committed inode version")
            return result
        chosen = usable[-1]
        newer_bad = [v for v in versions if v["sequence"] > chosen["sequence"] and v["sequence"] <= a.at_or_before_seq and not v["checksumValid"]]
        if newer_bad:
            result["problems"].append(f"{len(newer_bad)} newer image(s) of the inode at or before the bound fail the checksum: the chosen version may not be the latest")
        stable = {(v["rootDigest"], v["size"], v["iBlocks512"]) for v in usable}
        result["chosenInode"] = {k: x for k, x in chosen.items() if not k.startswith("_")}
        result["usableInodeVersions"] = len(usable); result["distinctUsableInodeContents"] = len(stable)
        # 2. the extent tree from the chosen version's root, choosing for every block its newest valid image <= the inode's sequence
        root = chosen["_iblock"]
        rmagic, _, _, rdepth, _ = struct.unpack_from("<HHHHI", root, 0)
        if rmagic != EXT_MAGIC or rdepth > MAX_DEPTH:
            result["problems"].append(f"root header magic {rmagic:#x} / depth {rdepth} unsupported (depth 0..{MAX_DEPTH})")
            result.update(metadataChecksumsValid=False); return result
        hdr, ents, why = parse_node(root, depth=rdepth, max_entries=ROOT_MAX, lblk=0, root=True, fs_blocks=a.fs_blocks)
        if why:
            result["problems"].append(f"inode root: {why}"); result.update(metadataChecksumsValid=False); return result
        tree, extents, ok, meta_blocks = [], [], True, 0
        bound = chosen["sequence"]

        def walk(entries, depth, upper):
            nonlocal ok, meta_blocks
            for i, e in enumerate(entries):
                if depth == 0:
                    extents.append(e); continue
                ei_block, child = e
                hi = entries[i + 1][0] if i + 1 < len(entries) else upper
                meta_blocks += 1
                if meta_blocks > MAX_TREE_BLOCKS:
                    raise Refused(f"more than {MAX_TREE_BLOCKS} extent tree blocks")
                node = {"block": child, "depth": depth - 1, "firstLogical": ei_block, "versions": []}
                tree.append(node)
                for jb, c in sorted(imgs.get(child, {}).items(), key=lambda x: (x[1]["sequence"], x[0])):
                    if c["sequence"] > bound:
                        node["versions"].append({"sequence": c["sequence"], "journalBlock": jb, "afterChosenInode": True}); continue
                    b = read_image(fd, jb, nblocks, bool(c.get("escaped")))
                    h, ce, w, tail = check_block_image(b, iseed, depth=depth - 1, lblk=ei_block, fs_blocks=a.fs_blocks)
                    if w is None and ce and (ce[-1][0] + (ce[-1][1] if depth - 1 == 0 else 1)) > hi:
                        w = f"entries reach logical {ce[-1][0]} beyond the parent range end {hi}"
                    node["versions"].append({"sequence": c["sequence"], "journalBlock": jb, "committed": c.get("committed") is True,
                                             "txIntact": c.get("txIntact") is True, "escaped": bool(c.get("escaped")), "valid": w is None,
                                             "why": w, "entries": h["entries"], "max": h["max"], "tailOffset": tail,
                                             "contentDigest": hashlib.sha256(b[:tail]).hexdigest()[:16], "_ents": ce})
                good = [v for v in node["versions"] if v.get("valid") and v["committed"] and v["txIntact"]]
                if not good:
                    ok = False; node["chosen"] = None; result["problems"].append(f"block {child}: no checksum-valid committed image at or before {bound}")
                    continue
                pick = good[-1]; node["chosen"] = {"sequence": pick["sequence"], "journalBlock": pick["journalBlock"]}
                node["distinctValidContents"] = len({v["contentDigest"] for v in good})
                later_bad = [v for v in node["versions"] if not v.get("afterChosenInode") and v["sequence"] > pick["sequence"] and not (v.get("valid") and v["committed"] and v["txIntact"])]
                if later_bad:
                    ok = False; node["ambiguous"] = f"{len(later_bad)} newer image(s) at or before {bound} are invalid/uncommitted"
                    result["problems"].append(f"block {child}: {node['ambiguous']}")
                walk(pick["_ents"], depth - 1, hi)

        walk(ents, rdepth, 1 << 32)
        for node in tree:
            for v in node["versions"]:
                v.pop("_ents", None)
        result["tree"] = tree
        # 3. coverage, holes, block accounting (holes and the sparse tail are interpreted ONLY when the whole map is authenticated)
        extents.sort()
        overlaps = [i for i in range(1, len(extents)) if extents[i][0] < extents[i - 1][0] + extents[i - 1][1]]
        if overlaps:
            ok = False; result["problems"].append(f"{len(overlaps)} overlapping extents across leaves")
        data_blocks = sum(e[1] for e in extents)
        alloc_blocks = chosen["iBlocks512"] * 512 // BLOCK
        size_blocks = (chosen["size"] + BLOCK - 1) // BLOCK
        accounted = data_blocks + meta_blocks == alloc_blocks and chosen["iBlocks512"] % (BLOCK // 512) == 0
        if not accounted:
            ok = False; result["problems"].append(f"i_blocks {alloc_blocks} fs blocks != {data_blocks} mapped + {meta_blocks} tree blocks")
        end = extents[-1][0] + extents[-1][1] if extents else 0
        beyond = end > size_blocks                    # legal in ext4 (fallocate KEEP_SIZE): reported, not an authentication failure
        result["map"] = {"extents": len(extents), "unwrittenExtents": sum(e[3] for e in extents), "dataBlocks": data_blocks, "treeBlocks": meta_blocks,
                         "iBlocksFsBlocks": alloc_blocks, "accounted": accounted, "endLogical": end, "sizeBlocks": size_blocks, "extentsBeyondSize": beyond,
                         "mapDigest": hashlib.sha256(json.dumps(extents).encode()).hexdigest(), "overlaps": len(overlaps)}
        result["metadataChecksumsValid"] = ok and not newer_bad
        if result["metadataChecksumsValid"]:
            holes, cur = [], 0
            for lb, n, _, _ in extents:
                if lb > cur:
                    holes.append([cur, lb])
                cur = lb + n
            result["map"].update(holes=len(holes), holeBlocks=sum(h[1] - h[0] for h in holes), sparseTailBytes=max(0, chosen["size"] - end * BLOCK),
                                 extentList=[[lb, n, p, u] for lb, n, p, u in extents])
        else:
            result["map"]["holes"] = "NOT INTERPRETED: the map is not fully authenticated"
        return result
    finally:
        os.close(fd)


def main(argv=None):
    ap = argparse.ArgumentParser(description="offline ext4 metadata_csum qualifier for a deleted inode's journal-copy candidates")
    ap.add_argument("--journal", required=True); ap.add_argument("--inventory", action="append", required=True)
    ap.add_argument("--uuid", required=True); ap.add_argument("--ino", type=int, required=True); ap.add_argument("--gen", type=int, required=True)
    ap.add_argument("--inode-size", type=int, required=True); ap.add_argument("--inode-table-block", type=int, required=True)
    ap.add_argument("--inode-offset", type=int, required=True); ap.add_argument("--at-or-before-seq", type=int, required=True)
    ap.add_argument("--fs-blocks", type=int, required=True); ap.add_argument("--huge-file", choices=["yes", "no"], required=True)
    ap.add_argument("--no-csum-seed", action="store_true"); ap.add_argument("--expect-size", type=int)
    ap.add_argument("--out", required=True); ap.add_argument("--fixture", action="store_true")
    a = ap.parse_args(argv)
    try:
        if not a.out.startswith("/"):
            raise Refused("output path must be absolute")
        text = json.dumps(qualify(a), sort_keys=True)
        if len(text) > OUT_MAX:
            raise Refused(f"result exceeds {OUT_MAX} bytes")
        fd = os.open(a.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            data = text.encode(); n = 0
            while n < len(data):
                n += os.write(fd, data[n:])
        finally:
            os.close(fd)
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr); return 3
    except OSError as e:
        print(f"REFUSED: {type(e).__name__}: {e.strerror or e}", file=sys.stderr); return 3
    print(json.dumps({"written": a.out, "bytes": len(text)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
