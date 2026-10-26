#!/usr/bin/env python3
"""postdelete-bitmap-stage/r4 postdelete_bitmap.py: bounded OFFLINE post-deletion block-bitmap REUSE checker.

r4 (independent review 1701, root review of r3): the COALESCED model is accepted only under explicit adjacent proof - the first slot
image after the last live tid P is a NEW generation at tid T == P + 1 (proven, inode-checksum valid, links >= 1, inode bit SET at T,
and set at every later tid while that generation stays live), no old-generation image at/after T, and EVERY covered group (old data
blocks AND the bound extent-tree blocks) has a proven block-bitmap image IN T with every old bit CLEAR. A missing T image, a set bit in
T, T != P + 1 or a gap -> BLOCKED; a set bit in a later image -> REUSE_OBSERVED. The output never fabricates a deletion start: in the
coalesced model deletionStartTid is null ("not observed"); T is reported as firstObservedCompletionTid (internally the bitmap rules
evaluate the free at T). The classic model (explicit unlinked -> freed -> reused images) is unchanged. In BOTH models the bound
extent-tree blocks (index + leaves) are part of the no-reuse masks, not only the data blocks.

r3 (review 1687 F1/F2/F3, root 1698): (a) the candidate extent map is BOUND to the proven extent tree - the last live inode's
extent root (depth 1 or 2), the newest proven index/leaf images before the deletion (ext4 extent block checksum with the OLD inode
generation), leaf pointers == picked[] blocks in order, picked[].sequence/journalBlock == those images, decoded extents == extents[];
(b) window completeness starts at the OLDEST bound tree image tid (not only at P); (c) per group, bits with an OBSERVED proven
SET -> CLEAR transition are counted separately from bits only ever seen clear (reported, never invented); (d) S0 checks the orphan
i_dtime (next orphan ino or 0, <= inode count) as documented; (e) r3's single-transaction mode is superseded by r4's coalesced
rules above.

Inputs (all local, read-only, nofollow): the JBD2 journal COPY, the debugfs `stats` text of the filesystem (group -> block bitmap
location), the candidate extent map (physical extents of the deleted file) and a small pinned case file. Every input is pinned by
sha256 in the case file. Nothing is mounted, replayed, repaired or written except one NEW 0600 JSON result.

Authentication is done ONLY by the frozen JBD2 runtime (journal-recovery-verifier-stage r1 jbd2_verify.py, byte-identical in r3;
sha256 pinned below and checked before it is executed): every image used here is a PROVEN image (descriptor + tag + commit
checksums, contiguous walk) and its bytes are re-read and must hash to the verifier's contentSha256.

Method (no assumed boundary; everything is derived from proven images):
  1. inode slot (inode table block + offset from the group layout) through all proven images of that block, in tid order:
       P  = last image where the OLD generation is live (i_links_count > 0)
       S0 = the next image: must be the OLD generation unlinked (links 0; orphan: i_dtime = next orphan ino or 0, <= inode count),
            or (r4) the coalesced model: a NEW generation at T == P + 1 (see above; deletionStartTid is then null)
       C  = first image with the completed-deletion shape (OLD generation, links 0, i_size 0, i_blocks 0, extent root with 0
            entries and depth 0, i_dtime a time > inode count) AND an inode-bitmap image IN THE SAME TRANSACTION with the bit
            clear (ext4_evict_inode sets i_dtime and calls ext4_free_inode in one handle). Absent -> BLOCKED, never guessed.
       R  = first later image with a different generation (slot reuse); must come after C.
     The ext4 inode checksum (crc32c, metadata_csum, seed crc32c(~0, fs uuid) -> ino -> generation) must verify on every row from P.
  2. window completeness: every tid from P to the newest proven tid is a proven transaction; no JBD2 header block of any tid >= P
     is outside the proven set; the newest tid is s_sequence-1, or s_sequence-2 with NO header of s_sequence-1 and s_head = the
     block after the newest commit (pinned journal.c jbd2_journal_destroy: j_tail_sequence = ++j_transaction_sequence).
  3. every block-bitmap block of every group the old extents touch is verified (<= 4096 targets per verifier call, starting at
     2048; a call whose listing is incomplete is split in halves; <= 24 calls). Per DB block bit, in tid order:
       before S0, at/after the bit's leaf-image tid: must be SET (else freed before the deletion -> BLOCKED)
       S0..C: a bit seen CLEAR and later SET = REUSE (allocated again after its own free committed)
       at/after C: any SET bit = REUSE
       every bit must be seen CLEAR in some image at or before C (the freeing transaction is journaled) -> else BLOCKED
  Verdicts: NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY (rc 0), REUSE_OBSERVED (rc 4), BLOCKED (rc 5), refused input (rc 3).
  NONE of them is a recovery acceptance; see LIMITS.
"""
import argparse, bisect, hashlib, json, os, re, struct, sys, types

RUNTIME = "jbd2_verify.py"
RUNTIME_SHA256 = "d3cfa34e2fa80744b99ddde1a06ace056ccd962e65e45ef9241c0cc6727eb973"   # journal-recovery-verifier-stage r1 (= r3)


def _load_runtime():
    path = os.path.join(os.path.dirname(os.path.realpath(__file__)), RUNTIME)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        raw = os.read(fd, (1 << 20) + 1)
    finally:
        os.close(fd)
    if len(raw) > 1 << 20 or hashlib.sha256(raw).hexdigest() != RUNTIME_SHA256:
        raise SystemExit(f"REFUSED: {RUNTIME} is not the pinned r1 runtime {RUNTIME_SHA256}")
    mod = types.ModuleType("jbd2_verify_r1"); mod.__file__ = path
    exec(compile(raw, path, "exec"), mod.__dict__)               # the exact hashed bytes are what runs
    return mod


V = _load_runtime()
Refuse, refuse = V.Refuse, V.refuse
BS = V.BS
BPG = 8 * BS                        # one 4 KiB block bitmap = exactly one group of 32768 blocks
MAX_FS_STATS, MAX_COVERAGE, MAX_CASE = 32 << 20, 16 << 20, 64 << 10
MAX_EXTENTS, MAX_GROUPS = 65536, 1 << 20
MAX_BATCH = V.MAX_TARGETS           # 4096: the verifier's own per-call target bound (hard cap)
INITIAL_BATCH = 2048                # start below it: the verifier's 12 MiB listing budget is shared by all targets of a call
MAX_VERIFY_CALLS = 24              # incomplete listings are split in halves; each call reads the journal once (+ walk <= 4x)
MAX_IMAGE_READS = V.PROD_BYTES // BS
MAX_ROWS, MAX_LISTED, MAX_SAMPLE = 512, 4096, 32
HUGE_FILE_FL, EXT_MAGIC, MASK32, EXT_INIT_MAX = 0x40000, 0xF30A, 0xFFFFFFFF, 32768
REQUIRED_FEATURES = {"has_journal", "extent", "64bit", "flex_bg", "metadata_csum"}
FORBIDDEN_FEATURES = {"bigalloc", "metadata_csum_seed", "orphan_file"}   # cluster bitmaps / other csum seed / no i_dtime orphan chain
CASE_FORMAT, OUT_FORMAT = "postdelete-bitmap-case/r1", "enclave-postdelete-bitmap/r4"
ACCEPTANCE = ("NOT A RECOVERY ACCEPTANCE: this only reports what COMMITTED, checksum-proven block-bitmap images say about the old "
              "extents after the deletion. No reuse observed is NOT proof that the bytes are intact; reuse observed is NOT proof of "
              "overwritten bytes. The candidate extent map alone is never accepted.")
LIMITS = [
    "commit granularity: an allocate+free of a block INSIDE one transaction leaves no bitmap trace (data may still have been written)",
    "writes that never touch the bitmap are invisible: discard/TRIM (online 'discard' mount option or fstrim after the deletion), "
    "raw device or image-layer (qcow2) writes; the image layer must be checked separately (e.g. allocation map / sampled reads)",
    "history before the oldest retained transaction cannot be proven absent; this check needs and verifies only tids >= the last "
    "live inode image",
    "state after the newest journaled transaction is the current on-disk bitmap (checked separately: current-allocation.json)",
    "block bitmap locations come from the current group descriptors (fs-stats); they are static unless the fs was resized",
    "writers that bypass JBD2 are INVISIBLE: userspace e2fsprogs (debugfs -w, e2fsck, tune2fs, resize2fs), fuse2fs read-write, a mount "
    "by any other kernel/OS, raw block-device or image writes, and discard/TRIM (mount -o discard, fstrim / fstrim.timer); compare "
    "geometry.lastWriteTime with journal.window.newestCommitSec and check the image layer separately",
    "ownership: each old block is attributed by the extent tree bound to proven root/index/leaf images (checksummed with the old inode "
    "generation); a bitmap SET image of a bit is only available if its group bitmap was logged between the leaf tid and the free - bits "
    "only ever seen CLEAR are counted as clearWithoutObservedSetBlocks, never as observed",
    "coalesced model: accepted only with T == P + 1 and a proven T bitmap image of EVERY covered group with all old data + tree bits "
    "clear; the deletion start is NOT observed (deletionStartTid null) and nothing is inferred about intermediate states; an "
    "allocate+free of old blocks inside T (a very large transaction) or any later single transaction leaves no bitmap trace",
    "NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY only reflects the current flags of proven bitmap images; it is not recovery acceptance",
    "NONE of this is a recovery acceptance: full MDBX structural check, plain-vs-hashed state / trie verification and a canonical "
    "(L1-authenticated) root remain separate gates; journal absence of reuse alone is never acceptance",
]


def tid_ge(a, b):
    return ((a - b) & MASK32) < 0x80000000


# ---- bounded inputs -----------------------------------------------------------------------------------------------------------
def read_small(path, what, cap):
    fd, st = V.open_ro(path, what)
    try:
        if st.st_size > cap:
            refuse(f"{what} larger than {cap} bytes")
        out = bytearray()
        while len(out) <= cap:
            c = os.read(fd, 1 << 20)
            if not c:
                break
            out += c
    finally:
        os.close(fd)
    if len(out) > cap:
        refuse(f"{what} grew beyond {cap} bytes")
    return bytes(out)


def sha_file(path, what, cap):
    fd, st = V.open_ro(path, what)
    try:
        if st.st_size > cap:
            refuse(f"{what} larger than {cap} bytes")
        h, n = hashlib.sha256(), 0
        while True:
            c = os.read(fd, 8 << 20)
            if not c:
                break
            n += len(c); h.update(c)
            if n > cap:
                refuse(f"{what} grew beyond {cap} bytes")
    finally:
        os.close(fd)
    return h.hexdigest()


def is_int(v, lo=0, hi=1 << 64):
    return isinstance(v, int) and not isinstance(v, bool) and lo <= v < hi


def parse_json(raw, what):
    try:
        return json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        refuse(f"{what} is not UTF-8 JSON")


def parse_case(raw):
    c = parse_json(raw, "case")
    hexsha = lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None
    ok = isinstance(c, dict) and set(c) == {"format", "inode", "oldGeneration", "metadataBlocks", "inputs", "expect"} \
        and c["format"] == CASE_FORMAT and is_int(c["inode"], 1, 1 << 32) and is_int(c["oldGeneration"], 0, 1 << 32) \
        and is_int(c["metadataBlocks"], 0, 1 << 32) and isinstance(c["inputs"], dict) \
        and set(c["inputs"]) == {"journalSha256", "fsStatsSha256", "coverageSha256"} and all(hexsha(v) for v in c["inputs"].values()) \
        and isinstance(c["expect"], dict) and set(c["expect"]) == {"fsUuid", "inodeTableBlock", "slotOffset", "lastLiveSequence",
                                                                    "deletionStartSequence", "oldSize"} \
        and isinstance(c["expect"]["fsUuid"], str) and re.fullmatch(r"[0-9a-f]{32}", c["expect"]["fsUuid"]) is not None \
        and all(is_int(c["expect"][k]) for k in ("inodeTableBlock", "slotOffset", "oldSize")) \
        and all(is_int(c["expect"][k], 0, 1 << 32) for k in ("lastLiveSequence", "deletionStartSequence"))
    if not ok:
        refuse(f"case must be {CASE_FORMAT} with exactly inode, oldGeneration, metadataBlocks, "
               "inputs{journalSha256,fsStatsSha256,coverageSha256}, "
               "expect{fsUuid,inodeTableBlock,slotOffset,lastLiveSequence,deletionStartSequence,oldSize}")
    return c


_GROUP = re.compile(r" Group\s+(\d+): block bitmap at (\d+), inode bitmap at (\d+), inode table at (\d+)")
_KEY = re.compile(r"([A-Za-z][^:]*):\s*(.*)")


def parse_fs_stats(raw):
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        refuse("fs-stats is not UTF-8")
    hdr, bb, ib, it, in_groups = {}, [], [], [], False
    for ln in text.split("\n"):
        if ln.startswith(" Group"):
            m = _GROUP.fullmatch(ln)
            if not m or int(m[1]) != len(bb) or len(bb) >= MAX_GROUPS:
                refuse(f"fs-stats group line not understood or out of order: {ln[:80]!r}")
            bb.append(int(m[2])); ib.append(int(m[3])); it.append(int(m[4])); in_groups = True
        elif in_groups:
            if ln and not ln.startswith("           "):
                refuse(f"fs-stats line after the group table not understood: {ln[:80]!r}")
        elif ln.strip():
            m = _KEY.fullmatch(ln.rstrip())
            if not m or m[1].strip() in hdr:
                refuse(f"fs-stats header line not understood or duplicated: {ln[:80]!r}")
            hdr[m[1].strip()] = m[2].strip()

    def need(k, pat=r"\d+"):
        v = hdr.get(k)
        if v is None or not re.fullmatch(pat, v):
            refuse(f"fs-stats '{k}' missing or malformed")
        return v

    num = lambda k: int(need(k))
    uuid = need("Filesystem UUID", r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}").replace("-", "")
    feats = set(need("Filesystem features", r"[a-z0-9_ ]+").split())
    g = {"uuid": uuid, "features": sorted(feats), "blockSize": num("Block size"), "blocksPerGroup": num("Blocks per group"),
         "inodesPerGroup": num("Inodes per group"), "inodeSize": num("Inode size"), "inodeCount": num("Inode count"),
         "blockCount": num("Block count"), "firstBlock": num("First block"), "inodeBlocksPerGroup": num("Inode blocks per group"),
         "groups": len(bb), "lastWriteTime": hdr.get("Last write time"), "lastMountTime": hdr.get("Last mount time"),
         "state": hdr.get("Filesystem state")}
    if need("Checksum type", r"[a-z0-9]+") != "crc32c" or not REQUIRED_FEATURES <= feats or feats & FORBIDDEN_FEATURES:
        refuse(f"filesystem must have {sorted(REQUIRED_FEATURES)} with crc32c and none of {sorted(FORBIDDEN_FEATURES)}")
    isz, ipg = g["inodeSize"], g["inodesPerGroup"]
    if g["blockSize"] != BS or g["blocksPerGroup"] != BPG or g["firstBlock"] != 0 or isz not in (256, 512, 1024) \
            or not 0 < ipg <= BPG or ipg % 8 or ipg * isz != g["inodeBlocksPerGroup"] * BS \
            or not bb or len(bb) != -(-g["blockCount"] // BPG) or g["inodeCount"] != ipg * len(bb):
        refuse("unsupported or inconsistent geometry (need 4 KiB blocks, 32768 blocks/group, first block 0, one bitmap block/group)")
    meta = sorted([(b, b + 1) for b in bb] + [(b, b + 1) for b in ib] + [(b, b + g["inodeBlocksPerGroup"]) for b in it])
    for (a0, a1), (b0, b1) in zip(meta, meta[1:]):
        if b0 < a1:
            refuse("group metadata locations overlap")
    if meta[-1][1] > g["blockCount"]:
        refuse("group metadata beyond the block count")
    return g, bb, ib, it, meta


def parse_coverage(raw, geo, meta):
    d = parse_json(raw, "coverage")
    if not isinstance(d, dict) or not isinstance(d.get("extents"), list) or not isinstance(d.get("picked"), list):
        refuse("coverage must have extents[] and picked[]")
    ext, picked = d["extents"], d["picked"]
    if not 1 <= len(ext) <= MAX_EXTENTS or not 1 <= len(picked) <= MAX_EXTENTS:
        refuse("coverage extent / leaf count out of bounds")
    for e in ext:
        if not isinstance(e, dict) or set(e) != {"logical", "blocks", "physical", "unwritten"} or not is_int(e["logical"], 0, 1 << 32) \
                or not is_int(e["blocks"], 1, 1 << 16) or not is_int(e["physical"], 1, geo["blockCount"]) or not isinstance(e["unwritten"], bool) \
                or e["physical"] + e["blocks"] > geo["blockCount"]:
            refuse("coverage extent malformed or outside the filesystem")
    for p in picked:
        if not isinstance(p, dict) or not all(is_int(p.get(k), 0, 1 << 64) for k in ("block", "sequence", "entries")) \
                or p["sequence"] > MASK32 or p["entries"] < 1:
            refuse("coverage picked[] leaf malformed")
    if sum(p["entries"] for p in picked) != len(ext):
        refuse("picked[].entries do not add up to the extent count")
    for a, b in zip(ext, ext[1:]):
        if a["logical"] + a["blocks"] > b["logical"]:
            refuse("coverage extents not in strictly increasing, non-overlapping logical order")
    leaf_seq = []
    for p in picked:
        leaf_seq += [p["sequence"]] * p["entries"]
    phys = sorted((e["physical"], e["physical"] + e["blocks"], leaf_seq[k]) for k, e in enumerate(ext))
    for (a0, a1, _), (b0, b1, _) in zip(phys, phys[1:]):
        if b0 < a1:
            refuse("coverage extents overlap physically")
    j = 0                                                                     # sweep against group metadata
    for a0, a1, _ in phys:
        while j < len(meta) and meta[j][1] <= a0:
            j += 1
        if j < len(meta) and meta[j][0] < a1:
            refuse(f"coverage extent [{a0},{a1}) overlaps group metadata at {meta[j][0]}")
    return d, phys


def group_pieces(phys):
    groups = {}
    for p, end, ls in phys:
        while p < end:
            g, off = divmod(p, BPG)
            k = min(end - p, BPG - off)
            m = ((1 << k) - 1) << off
            e = groups.setdefault(g, [0, []])
            e[0] |= m; e[1].append((m, ls))
            p += k
    return groups


# ---- ext4 inode (on-disk struct ext4_inode, little endian) ------------------------------------------------------------------------
def inode_fields(s, isz, block_unit):
    u16 = lambda o: struct.unpack_from("<H", s, o)[0]
    u32 = lambda o: struct.unpack_from("<I", s, o)[0]
    flags = u32(0x20)
    blocks = u32(0x1C) | u16(0x74) << 32
    return {"mode": u16(0x00), "links": u16(0x1A), "size": u32(0x04) | u32(0x6C) << 32, "dtime": u32(0x14), "ctime": u32(0x0C),
            "flags": flags, "generation": u32(0x64), "iBlocks": blocks,
            "allocatedBytes": blocks * (BS if flags & HUGE_FILE_FL and block_unit else 512),
            "extentMagic": u16(0x28), "extentEntries": u16(0x2A), "extentDepth": u16(0x2E), "extraIsize": u16(0x80) if isz > 128 else 0}


def inode_csum(crc, fs_seed, ino, s, isz):
    """fs/ext4/inode.c ext4_inode_csum / ext4_inode_csum_verify (crc32c over the inode with i_checksum_lo/_hi taken as zero)"""
    u16 = lambda o: struct.unpack_from("<H", s, o)[0]
    lo, hi, old = 0x7C, 0x82, 128
    seed = crc(crc(fs_seed, struct.pack("<I", ino)), s[0x64:0x68])
    c = crc(seed, s[:lo]); c = crc(c, b"\0\0"); c = crc(c, s[lo + 2:old])
    fits_hi = isz > old and old + u16(0x80) >= hi + 2
    if isz > old:
        c = crc(c, s[old:hi]); off = hi
        if fits_hi:
            c = crc(c, b"\0\0"); off += 2
        c = crc(c, s[off:isz])
    stored = u16(lo) | (u16(hi) << 16 if fits_hi else 0)
    calc = c if fits_hi else c & 0xFFFF
    return calc == stored, stored


def extent_node(b):
    """struct ext4_extent_header + entries (fs/ext4/ext4_extents.h) -> (magic, entries, max, depth, list or None). Depth 0 entries are
    (logical, len, physical, unwritten) (ee_len > 32768 = unwritten); index entries are (logical, child block)."""
    mag, n, mx, depth = struct.unpack_from("<HHHH", b, 0)
    if 12 + 12 * n > len(b):
        return mag, n, mx, depth, None
    out = []
    for i in range(n):
        o = 12 + 12 * i
        if depth == 0:
            lb, ln, hi, lo = struct.unpack_from("<IHHI", b, o)
            out.append((lb, ln - EXT_INIT_MAX if ln > EXT_INIT_MAX else ln, hi << 32 | lo, ln > EXT_INIT_MAX))
        else:
            lb, lo, hi = struct.unpack_from("<IIH", b, o)
            out.append((lb, hi << 32 | lo))
    return mag, n, mx, depth, out


def extent_block_csum_ok(crc, inode_seed, b):
    """fs/ext4/extents.c ext4_extent_block_csum: crc32c(i_csum_seed, block[0:12 + 12 * eh_max]) == et_checksum (le32 right after);
    i_csum_seed = crc32c(crc32c(s_csum_seed, ino), generation) - binds the node to the inode number AND generation"""
    off = 12 + 12 * struct.unpack_from("<H", b, 4)[0]
    return off + 4 <= len(b) and crc(inode_seed, b[:off]) == struct.unpack_from("<I", b, off)[0]


# ---- journal access -------------------------------------------------------------------------------------------------------------
def header_scan(fd, first, maxlen):
    seqs, total, other = {}, 0, 0
    for p in range(first, maxlen):
        h = os.pread(fd, 12, p * BS)
        if len(h) != 12:
            refuse(f"short read at journal block {p}")
        if V.be32(h, 0) != V.MAGIC:
            continue
        t = V.be32(h, 4)
        if t in (V.DESC, V.COMMIT, V.REVOKE):
            seqs.setdefault(V.be32(h, 8), []).append(p); total += 1
        else:
            other += 1
    return seqs, total, other


def run_batches(journal, targets, crc, fixture, calls=None, sig=None):
    """r3: `calls` (the shared <= MAX_VERIFY_CALLS budget) and `sig` (the proven transaction set every call must agree on) may be
    passed in by a second phase (extent index blocks)"""
    n = len(targets)
    k = -(-n // min(INITIAL_BATCH, MAX_BATCH))
    size = -(-n // k)
    queue = [targets[i:i + size] for i in range(0, n, size)]
    calls = [] if calls is None else calls
    per, first_doc = {}, None
    while queue:
        b = queue.pop(0)
        if len(calls) >= MAX_VERIFY_CALLS:
            refuse(f"more than {MAX_VERIFY_CALLS} verifier calls needed")
        doc = V.verify(journal, b, crc, fixture=fixture)
        s, tg = doc["summary"], doc["targets"]
        listed = s["listedTransactionsTotal"] == len(doc["transactions"]) and s["failedTransactionsTotal"] == len(doc["failedTransactions"]) \
            and all(t["provenImagesTotal"] == len(t["provenImages"]) and t["unverifiedReferencesTotal"] == len(t["unverifiedReferences"])
                    for t in tg.values())
        calls.append({"targets": len(b), "firstTarget": b[0], "lastTarget": b[-1], "listedBytes": s["listedBytes"],
                      "listingComplete": listed, "referenceIndexComplete": s["referenceIndexComplete"],
                      "walkBudgetExhausted": s["walkBudgetExhausted"]})
        if s["walkBudgetExhausted"]:
            refuse("verifier walk read budget exhausted")
        if not (listed and s["referenceIndexComplete"]):
            if len(b) == 1:
                refuse(f"verifier listing incomplete even for the single target {b[0]}")
            queue[:0] = [b[:len(b) // 2], b[len(b) // 2:]]
            continue
        tx = sorted([t["sequence"], t["startBlock"], t["commitBlock"], t["commit"], t["commitSec"]] for t in doc["transactions"])
        fl = sorted([f["sequence"], f["commitBlock"]] for f in doc["failedTransactions"])
        h = hashlib.sha256(json.dumps([tx, fl, doc["superblock"]], sort_keys=True).encode()).hexdigest()
        if sig is None:
            sig, first_doc = h, {"transactions": tx, "failed": fl, "superblock": doc["superblock"], "summary": s}
        elif h != sig:
            refuse("verifier calls disagree on the proven transaction set")
        for bn, t in tg.items():
            per[int(bn)] = {"images": [{"seq": i["sequence"], "off": i["imageByteOffset"], "esc": i["escaped"], "sha": i["contentSha256"],
                                        "revoked": i["revokedByProvenSequence"], "commitSec": i["commitSec"]} for i in t["provenImages"]],
                            "refs": [(r["sequence"], r["kind"]) for r in t["unverifiedReferences"]]}
    if set(per) != set(targets):
        refuse("verifier output does not cover every target")
    return per, calls, first_doc, sig


# ---- the check --------------------------------------------------------------------------------------------------------------------
def check(a, crc, crc_info):
    case = parse_case(read_small(a.case, "case", MAX_CASE))
    pins = {"journalSha256": sha_file(a.journal, "journal", V.PROD_BYTES), "fsStatsSha256": sha_file(a.fs_stats, "fs-stats", MAX_FS_STATS),
            "coverageSha256": sha_file(a.coverage, "coverage", MAX_COVERAGE)}
    if pins != case["inputs"]:
        refuse(f"inputs differ from the case pins: {sorted(k for k in pins if pins[k] != case['inputs'][k])}")
    geo, bb, ib, it, meta = parse_fs_stats(read_small(a.fs_stats, "fs-stats", MAX_FS_STATS))
    cov, phys = parse_coverage(read_small(a.coverage, "coverage", MAX_COVERAGE), geo, meta)
    groups = group_pieces(phys)
    exp, ino, old = case["expect"], case["inode"], case["oldGeneration"]
    blockers = []
    block = lambda msg: blockers.append(msg) if len(blockers) < 256 else None

    if not 11 <= ino <= geo["inodeCount"]:
        refuse("case inode outside the filesystem's inode range")
    ig, idx = divmod(ino - 1, geo["inodesPerGroup"])
    it_block, slot_off = it[ig] + idx * geo["inodeSize"] // BS, idx * geo["inodeSize"] % BS
    ib_block = ib[ig]
    if (it_block, slot_off) != (exp["inodeTableBlock"], exp["slotOffset"]) or geo["uuid"] != exp["fsUuid"]:
        refuse("derived inode location / fs uuid differ from the case expectation")
    data_blocks = sum(e1 - e0 for e0, e1, _ in phys)
    gl = sorted(groups)
    bitmap_of = {g: bb[g] for g in gl}
    leaf_blocks = [p["block"] for p in cov["picked"]]
    if any(not 0 < b < geo["blockCount"] for b in leaf_blocks):
        refuse("coverage picked[] leaf block outside the filesystem")
    for g in sorted({b // BPG for b in leaf_blocks}):              # r4: tree-block groups are checked too (no-reuse masks)
        bitmap_of.setdefault(g, bb[g])
    targets = sorted({it_block, ib_block} | set(bitmap_of.values()) | set(leaf_blocks))
    if len(targets) != len(bitmap_of) + 2 + len(leaf_blocks):
        refuse("bitmap / inode / extent leaf block numbers are not distinct")
    starts = [e0 for e0, _, _ in phys]
    in_data = lambda b: (lambda i: i >= 0 and b < phys[i][1])(bisect.bisect_right(starts, b) - 1)

    per, calls, vdoc, vsig = run_batches(a.journal, targets, crc, a.fixture)
    sbv = vdoc["superblock"]
    fd, _ = V.open_ro(a.journal, "journal")
    reads = [MAX_IMAGE_READS]

    def image(im):
        if reads[0] <= 0:
            refuse("image read budget exhausted")
        reads[0] -= 1
        b = os.pread(fd, BS, im["off"])
        if len(b) != BS:
            refuse("short image read")
        c = (V.MAGIC_BE + b[4:]) if im["esc"] else b
        if hashlib.sha256(c).hexdigest() != im["sha"]:
            refuse("image bytes differ from the verifier's proven content (journal copy changed?)")
        return c

    try:
        sb = os.pread(fd, 1024, 0)
        if len(sb) != 1024 or [V.be32(sb, o) for o in (0x10, 0x14, 0x18, 0x1C)] != [sbv["maxlen"], sbv["first"], sbv["sequence"], sbv["start"]] \
                or sb[0x30:0x40].hex() != sbv["uuid"]:
            refuse("journal superblock changed between the verifier and this check")
        sseq, s_head, first, maxlen = sbv["sequence"], V.be32(sb, 0x58), sbv["first"], sbv["maxlen"]
        if sbv["uuid"] != geo["uuid"]:
            block("journal superblock uuid differs from the filesystem uuid")
        if not sbv["clean"]:
            block("journal is not clean (s_start != 0): pending replay is outside this check")
        hseqs, htotal, hother = header_scan(fd, first, maxlen)
        if htotal != vdoc["summary"]["headerBlocks"]:
            refuse("header scan disagrees with the verifier's header index")
        rel = lambda s: (s - sseq) & MASK32                                          # ascending = older -> newer below s_sequence
        proven = {t[0]: t for t in vdoc["transactions"]}
        if any(tid_ge(s, sseq) for s in proven):
            block("a proven tid is not older than s_sequence")
        newest = max(proven, key=rel) if proven else None

        # 1. inode slot ---------------------------------------------------------------------------------------------------
        fs_seed = crc(0xFFFFFFFF, bytes.fromhex(geo["uuid"]))
        huge = "huge_file" in geo["features"]
        rows, raws = [], []
        for im in sorted(per[it_block]["images"], key=lambda i: rel(i["seq"])):
            s = image(im)[slot_off:slot_off + geo["inodeSize"]]
            raws.append(s)
            f = inode_fields(s, geo["inodeSize"], huge)
            ok, stored = inode_csum(crc, fs_seed, ino, s, geo["inodeSize"])
            f.update(sequence=im["seq"], commitSec=im["commitSec"], inodeChecksumValid=ok, inodeChecksum=f"{stored:08x}",
                     revokedBy=im["revoked"])
            rows.append(f)
        bit = idx % (8 * BS)
        ibits = {}
        for im in per[ib_block]["images"]:
            ibits[im["seq"]] = (int.from_bytes(image(im), "little") >> bit) & 1
        freed_shape = lambda r: r["generation"] == old and r["links"] == 0 and r["size"] == 0 and r["iBlocks"] == 0 \
            and r["extentMagic"] == EXT_MAGIC and r["extentEntries"] == 0 and r["extentDepth"] == 0 and r["dtime"] > geo["inodeCount"]
        P = S0 = C = R = mode = None
        live = [i for i, r in enumerate(rows) if r["generation"] == old and r["links"] > 0]
        if not live:
            block("no proven image of the old inode generation alive")
        else:
            iP = live[-1]; P = rows[iP]["sequence"]; after = rows[iP + 1:]
            if after and after[0]["generation"] != old:
                # r4 coalesced model (review 1701): accepted ONLY with adjacent proof; nothing about intermediate states is inferred.
                # Internally S0 = C = R = T so the bitmap rules evaluate the free at T; the output reports deletionStartTid = null.
                T, tr = after[0]["sequence"], after[0]
                if T != (P + 1) & MASK32:
                    block(f"coalesced model refused: the first slot image after the last live tid {P} is tid {T}, not P + 1")
                elif not tr["inodeChecksumValid"] or tr["links"] < 1:
                    block(f"coalesced model refused: the new-generation slot image at tid {T} is not checksum-valid with links >= 1")
                else:
                    S0 = C = R = T; mode = "coalesced"
                    for r in after:                      # the inode bit stays SET while that new generation is live
                        if r["generation"] != tr["generation"] or r["links"] < 1:
                            break
                        if ibits.get(r["sequence"], 1) != 1:
                            block(f"coalesced model: inode bit clear at tid {r['sequence']} while the new generation is live")
            elif not after or after[0]["links"] != 0 or after[0]["dtime"] > geo["inodeCount"]:
                block("the image after the last live one is not the old inode unlinked (links 0, orphan i_dtime = next orphan ino or 0)")
            else:
                S0 = after[0]["sequence"]; mode = "classic"
                for r in after:
                    if r["generation"] != old:
                        R = r["sequence"]; break
                    if C is None and freed_shape(r):
                        if ibits.get(r["sequence"]) != 0:
                            block(f"completed-deletion shape at tid {r['sequence']} without an inode-bitmap image clearing the bit in that transaction")
                            break
                        C = r["sequence"]
                if C is None:
                    block("no explicit deletion-completion image (freed slot + cleared inode bit in one transaction)")
            if R is not None and any(r["generation"] == old for r in rows if rel(r["sequence"]) > rel(R)):
                block("old generation seen again after the slot was reused")
            if any(not r["inodeChecksumValid"] for r in rows[iP:]):
                block("ext4 inode checksum invalid on a slot image at or after the last live image")
            lp = rows[iP]
            if lp["size"] != exp["oldSize"] or lp["allocatedBytes"] != (data_blocks + case["metadataBlocks"]) * BS:
                block("last live inode size / allocated bytes do not match the candidate map + metadata blocks")
            if (P, S0) != (exp["lastLiveSequence"], exp["deletionStartSequence"]):
                block(f"derived last-live/deletion-start tids {P}/{S0} differ from the prior finding "
                      f"{exp['lastLiveSequence']}/{exp['deletionStartSequence']}")
        if C is not None:
            for s, v in ibits.items():
                if rel(S0) <= rel(s) < rel(C) and v != 1:
                    block(f"inode bit already clear at tid {s} before completion {C}")
                if rel(C) < rel(s) and (R is None or rel(s) < rel(R)) and v != 0:
                    block(f"inode bit set at tid {s} between completion and any slot reuse")
            if R is not None and ibits.get(R) != 1:
                block(f"slot reuse at tid {R} without an inode-bitmap image setting the bit")

        # 1b. r3: the candidate map bound to the proven extent tree ------------------------------------------------------------
        tree = {"depth": None, "indexBlocks": [], "leaves": len(cov["picked"]), "boundLeaves": 0, "bound": False}
        tree_tids, index_blocks, tree_pieces, n_blockers = [], [], [], len(blockers)
        if P is not None:
            bound_tid = S0 if S0 is not None else (P + 1) & MASK32
            iseed = crc(crc(fs_seed, struct.pack("<I", ino)), struct.pack("<I", old))

            def node(blk, want_depth, what):
                """the NEWEST proven image of blk before the deletion; window completeness (below, from its tid) excludes an
                unproven newer one"""
                ims = [im for im in per[blk]["images"] if rel(im["seq"]) < rel(bound_tid)]
                if not ims:
                    block(f"{what} {blk}: no proven image before the deletion"); return None, None
                im = max(ims, key=lambda i: rel(i["seq"])); b = image(im)
                mag, n, mx, dp, ents = extent_node(b)
                if mag != EXT_MAGIC or dp != want_depth or ents is None or n > mx or 12 + 12 * mx + 4 > BS:
                    block(f"{what} {blk} at tid {im['seq']}: not an ext4 extent node of depth {want_depth}"); return im, None
                if not extent_block_csum_ok(crc, iseed, b):
                    block(f"{what} {blk} at tid {im['seq']}: extent block checksum invalid for inode {ino} generation {old}"); return im, None
                tree_pieces.append((blk, blk + 1, im["seq"]))    # r4: a bound tree block joins the no-reuse masks from its image tid
                return im, ents
            mag, n, mx, dp, rents = extent_node(raws[iP][0x28:0x28 + 60])
            tree["depth"] = dp
            if mag != EXT_MAGIC or rents is None or n > mx or dp not in (1, 2):
                block(f"last live extent root unsupported (magic {mag:#x}, depth {dp}): need an index root of depth 1 or 2")
            else:
                ptrs = [c for _, c in rents]
                if dp == 2:
                    index_blocks = ptrs
                    if set(ptrs) & set(targets) or len(set(ptrs)) != len(ptrs) or any(not 0 < c < geo["blockCount"] for c in ptrs):
                        block("extent index block numbers collide with other targets, repeat or lie outside the filesystem")
                    else:
                        extra_bm = {}
                        for g in sorted({c // BPG for c in ptrs} - set(bitmap_of)):
                            extra_bm[g] = bb[g]
                        if set(extra_bm.values()) & (set(targets) | set(ptrs)):
                            refuse("extent index group bitmap collides with another target")
                        bitmap_of.update(extra_bm)
                        p2, calls, _, vsig = run_batches(a.journal, sorted(set(ptrs) | set(extra_bm.values())), crc, a.fixture, calls=calls, sig=vsig)
                        per.update(p2)                          # same proven transaction set as phase 1 (else refused)
                        leaves = []
                        for c in ptrs:
                            im, ents = node(c, 1, "extent index block")
                            tree["indexBlocks"].append({"block": c, "tid": im["seq"] if im else None})
                            if im:
                                tree_tids.append(im["seq"])
                            leaves += [x for _, x in ents or []]
                        ptrs = leaves
                picked = cov["picked"]
                if ptrs != [p["block"] for p in picked]:
                    block("leaf pointers of the proven extent root/index images differ from coverage picked[] (blocks or order)")
                else:
                    k = 0
                    for p in picked:
                        im, ents = node(p["block"], 0, "extent leaf")
                        want = [(e["logical"], e["blocks"], e["physical"], e["unwritten"]) for e in cov["extents"][k:k + p["entries"]]]
                        k += p["entries"]
                        if im is None:
                            continue
                        tree_tids.append(im["seq"])
                        if (im["seq"], im["off"] // BS) != (p["sequence"], p.get("journalBlock")):
                            block(f"leaf {p['block']}: newest proven image before the deletion is tid {im['seq']} at journal block "
                                  f"{im['off'] // BS}; coverage says {p['sequence']} / {p.get('journalBlock')}")
                        elif ents is not None and ents != want:
                            block(f"leaf {p['block']} at tid {im['seq']}: proven extents differ from the candidate map")
                        elif ents is not None:
                            tree["boundLeaves"] += 1
                tblocks = index_blocks + [p["block"] for p in picked]
                if len(tblocks) != case["metadataBlocks"] or len(set(tblocks)) != len(tblocks) or any(in_data(x) for x in tblocks):
                    block(f"extent tree blocks ({len(tblocks)}) differ from metadataBlocks {case['metadataBlocks']}, repeat or lie inside the old data")
            tree["bound"] = len(blockers) == n_blockers and tree["boundLeaves"] == len(cov["picked"])

        # 2. window completeness (r3: from the OLDEST bound tree image or P, whichever is older) ------------------------------
        W0 = min([P] + tree_tids, key=rel) if P is not None else None
        window = {"from": W0, "lastLiveTid": P, "newestProven": newest, "sSequence": sseq, "sHead": s_head}
        if W0 is not None and newest is not None:
            s, steps, gaps = W0, 0, []
            while True:
                if s not in proven:
                    gaps.append(s)
                if s == newest or steps > len(proven) + 1:
                    break
                s, steps = (s + 1) & MASK32, steps + 1
            stray = sorted(q for q in hseqs if tid_ge(q, W0) and q not in proven)
            failed = sorted(f[0] for f in vdoc["failed"] if tid_ge(f[0], W0))
            gap = (sseq - newest) & MASK32
            nxt = proven[newest][2] + 1 if proven[newest][2] + 1 < maxlen else first
            if gap == 1:
                tail = "newest proven tid = s_sequence - 1"
            elif gap == 2 and ((sseq - 1) & MASK32) not in hseqs and s_head == nxt:
                tail = ("s_sequence - 1 never committed: clean unmount (jbd2_journal_destroy: j_tail_sequence = ++j_transaction_sequence), "
                        "no header of that tid anywhere, s_head = the block after the newest commit")
            else:
                tail = None; block(f"tail not explained: newest proven {newest}, s_sequence {sseq}, s_head {s_head} (expected {nxt})")
            window.update(gaps=gaps[:64], gapsTotal=len(gaps), strayHeaderTids=stray[:64], failedTids=failed[:64], tail=tail,
                          contiguous=not gaps and steps <= len(proven), newestCommitSec=proven[newest][4])
            if gaps or stray or failed or steps > len(proven):
                block("transactions from the oldest bound tree image / last live image to the newest are not all proven")
        elif P is not None:
            block("no proven transactions")

        # unverified references in the window must all be proven images of that block; a revoke blocks, except a revoke of the
        # file's OWN extent tree blocks at/after the deletion start (the truncate frees and forgets them)
        unproven, tree_set = [], set(index_blocks) | set(leaf_blocks)
        if W0 is not None:
            for t in sorted(per):
                seen = {im["seq"] for im in per[t]["images"]}
                for s, kind in per[t]["refs"]:
                    if not tid_ge(s, W0):
                        continue
                    if kind == "revoke":
                        if not (t in tree_set and S0 is not None and tid_ge(s, S0)):
                            unproven.append([t, s, kind])
                    elif s not in seen:
                        unproven.append([t, s, kind])
        if unproven:
            block(f"{len(unproven)} descriptor/revoke references at tids >= {W0} are not proven images (or revoke a block before the deletion)")

        # 3. block bitmaps -----------------------------------------------------------------------------------------------------
        bm = {"groups": len(gl), "dataBlocks": data_blocks}
        if C is not None:                      # also run when other blockers exist (diagnostic); the verdict stays BLOCKED
            if any(not rel(ls) < rel(S0) for _, _, ls in phys):
                block("a leaf image tid is not older than the deletion start")
            reused_total = missing_total = pre_total = obs_total = unobs_total = set_in_t = 0
            reused, missing, pre, pergroup, no_t = [], [], [], [], []
            allg = group_pieces(list(phys) + tree_pieces)                # r4: old data AND bound extent-tree blocks
            for g in sorted(allg):
                mask, pieces = allg[g]
                if mode == "coalesced":
                    tim = [im for im in per[bitmap_of[g]]["images"] if im["seq"] == C]
                    if not tim:
                        no_t.append(g)
                    else:
                        set_in_t += bin(int.from_bytes(image(tim[0]), "little") & mask).count("1")
                lmin = min((ls for _, ls in pieces), key=rel)
                cleared = cleared_c = reuse = pre_clear = seen_set = trans = 0
                first_reuse = freed_at = None; n_img = n_post = 0
                for im in sorted(per[bitmap_of[g]]["images"], key=lambda i: rel(i["seq"])):
                    s = im["seq"]; n_img += 1
                    if rel(s) < rel(lmin):
                        continue
                    bits = int.from_bytes(image(im), "little")
                    if rel(s) < rel(S0):
                        for m, ls in pieces:
                            if rel(s) >= rel(ls):
                                pre_clear |= m & ~bits
                                seen_set |= m & bits             # r3: owned bit OBSERVED set in a proven image
                        continue
                    n_post += 1
                    setb = bits & mask
                    r = setb if rel(s) >= rel(C) else setb & cleared
                    if r:
                        reuse |= r; first_reuse = s if first_reuse is None else first_reuse
                    if rel(s) <= rel(C):
                        trans |= mask & ~bits & ~cleared & seen_set     # first clear of a bit previously observed set
                        seen_set |= setb & ~cleared                     # still set before its first clear (not yet freed)
                    cleared |= mask & ~bits
                    if rel(s) <= rel(C):
                        cleared_c |= mask & ~bits
                        if freed_at is None and cleared_c == mask:
                            freed_at = s
                miss = mask & ~cleared_c
                absb = lambda x: [g * BPG + i for i in range(BPG) if x >> i & 1][:MAX_SAMPLE]
                if reuse:
                    reused_total += bin(reuse).count("1")
                    if len(reused) < MAX_LISTED:
                        reused.append({"group": g, "bitmapBlock": bitmap_of[g], "blocks": bin(reuse).count("1"), "firstReuseTid": first_reuse, "sample": absb(reuse)})
                if miss:
                    missing_total += bin(miss).count("1")
                    if len(missing) < MAX_LISTED:
                        missing.append({"group": g, "bitmapBlock": bitmap_of[g], "blocks": bin(miss).count("1"), "sample": absb(miss)})
                if pre_clear:
                    pre_total += bin(pre_clear).count("1")
                    if len(pre) < MAX_LISTED:
                        pre.append({"group": g, "bitmapBlock": bitmap_of[g], "blocks": bin(pre_clear).count("1"), "sample": absb(pre_clear)})
                n_obs, n_unobs = bin(trans).count("1"), bin(cleared_c & ~trans).count("1")
                obs_total += n_obs; unobs_total += n_unobs
                pergroup.append([g, bitmap_of[g], bin(mask).count("1"), n_img, n_post, freed_at, first_reuse, n_obs, n_unobs])
            if no_t:
                block(f"{len(no_t)} covered groups have no proven block-bitmap image in the coalesced transaction {C}: completion not provable")
            if set_in_t:
                block(f"{set_in_t} old data/tree bits SET in the coalesced transaction {C} (not freed there, or reallocated within it)")
            if missing_total:
                block(f"{missing_total} old data/tree blocks never seen freed in a proven bitmap image at or before completion {C}")
            if pre_total:
                block(f"{pre_total} old data blocks clear in a proven bitmap image after their leaf image but before the deletion")
            bm.update(reusedBlocks=reused_total, reusedGroups=reused, notObservedFreedBlocks=missing_total, notObservedFreedGroups=missing,
                      preDeletionClearBlocks=pre_total, preDeletionClearGroups=pre,
                      observedSetToClearBlocks=obs_total, clearWithoutObservedSetBlocks=unobs_total,
                      treeBlocksInMasks=len(tree_pieces), groupsChecked=len(allg),
                      coalesced={"T": C, "groupsWithTImage": len(allg) - len(no_t), "groupsWithoutTImage": no_t[:MAX_SAMPLE],
                                 "groupsWithoutTImageTotal": len(no_t), "oldBitsSetInT": set_in_t} if mode == "coalesced" else None,
                      ownershipNote="clearWithoutObservedSet bits are attributed by the bound extent tree only (no proven SET bitmap image "
                                    "between their leaf tid and their free); they are reported, never counted as observed",
                      perGroupColumns=["group", "bitmapBlock", "oldDataBits", "provenImages", "imagesFromDeletionStart", "allFreedAtTid",
                                       "firstReuseTid", "observedSetToClear", "clearWithoutObservedSet"],
                      perGroup=pergroup)
        imgs_read = MAX_IMAGE_READS - reads[0]
    finally:
        os.close(fd)

    verdict = "BLOCKED" if blockers else ("REUSE_OBSERVED" if bm.get("reusedBlocks") else "NO_REUSE_OBSERVED_IN_JOURNALED_HISTORY")
    doc = {
        "format": OUT_FORMAT, "verdict": verdict, "acceptance": ACCEPTANCE, "blockers": blockers, "limits": LIMITS,
        "inputs": {**pins, "case": case, "coverageAuthentication": cov.get("authentication"), "coverageRecoveryProven": cov.get("recoveryProven")},
        "runtime": {"jbd2_verify.py": RUNTIME_SHA256, "crc": crc_info, "verifierCalls": calls, "verifierTransactionSetSha256": vsig,
                    "imagesRead": imgs_read},
        "geometry": {**geo, "inodeGroup": ig, "inodeIndex": idx, "inodeTableBlock": it_block, "slotOffset": slot_off, "inodeBitmapBlock": ib_block},
        "map": {"extents": len(phys), "dataBlocks": data_blocks, "metadataBlocks": case["metadataBlocks"], "coveredGroups": len(gl),
                "leafTids": sorted({ls for _, _, ls in phys}, key=rel)},
        "journal": {"superblock": sbv, "sHead": s_head, "headerBlocks": htotal, "otherHeaderBlocks": hother,
                    "provenTransactions": len(proven), "window": window, "unprovenReferences": unproven[:256], "unprovenReferencesTotal": len(unproven)},
        "recoveryAcceptance": False,
        "tree": tree,
        "boundary": {"mode": mode, "lastLiveTid": P,
                     "deletionStartTid": None if mode == "coalesced" else S0,
                     "deletionStartReason": "coalesced: no committed intermediate unlinked image; deletion start NOT observed" if mode == "coalesced" else None,
                     "firstObservedCompletionTid": C, "completionTid": C, "slotReuseTid": R,
                     "slotRows": [r for r in rows if P is not None and rel(r["sequence"]) >= rel(P)][:MAX_ROWS],
                     "inodeBitmapRows": sorted(([s, v] for s, v in ibits.items() if P is not None and rel(s) >= rel(P)), key=lambda x: rel(x[0]))[:MAX_ROWS]},
        "bitmaps": bm}
    return doc, {"BLOCKED": 5, "REUSE_OBSERVED": 4}.get(verdict, 0)


def main(argv=None):
    ap = argparse.ArgumentParser(description="bounded offline post-deletion block-bitmap reuse checker (no recovery acceptance)")
    for k in ("--journal", "--fs-stats", "--coverage", "--case", "--out"):
        ap.add_argument(k, required=True)
    ap.add_argument("--fixture", action="store_true"); ap.add_argument("--crc", choices=["libext2fs", "pure"], default="libext2fs")
    a = ap.parse_args(argv)
    try:
        if a.crc == "pure" and not a.fixture:
            refuse("the pure-python crc is for fixtures only")
        crc, info = V.crc_impl(a.crc)
        doc, rc = check(a, crc, info)
        V.write_out(a.out, doc)
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3
    print(json.dumps({"written": a.out, "verdict": doc["verdict"]}))
    return rc


if __name__ == "__main__":
    sys.exit(main())
