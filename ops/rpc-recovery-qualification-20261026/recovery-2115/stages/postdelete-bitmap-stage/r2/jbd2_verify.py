#!/usr/bin/env python3
"""journal-recovery-verifier-stage/r1 jbd2_verify.py: bounded OFFLINE checksum + commit verifier for a JBD2 (csum v3) journal COPY.

Separate from journal-recovery-stage/r1 (an unauthenticated inventory). This tool proves, per target filesystem block, which
journal images are AUTHENTIC LOGGED CONTENT of a COMMITTED transaction, using the exact primary semantics of upstream Linux
fs/jbd2 (pinned below by URL + sha256):
  seed        j_csum_seed = crc32c(~0, sb.s_uuid[16])                                   (journal.c load_superblock)
  superblock  s_checksum == crc32c(~0, sb[0:1024] with s_checksum zeroed)               (journal.c jbd2_superblock_csum)
  descriptor  tail == crc32c(seed, block with the 4-byte tail zeroed)                   (recovery.c jbd2_descriptor_block_csum_verify)
  revoke      same tail rule (recovery.c do_one_pass REVOKE -> jbd2_descriptor_block_csum_verify)
  tag (v3)    t_checksum == crc32c(crc32c(seed, be32(sequence)), logged image as written, i.e. still ESCAPED)
              (recovery.c jbd2_block_tag_csum_verify; commit.c jbd2_block_tag_csum_set over wbuf = the escaped copy)
  commit      h_chksum[0] == crc32c(seed, block with h_chksum[0] zeroed), or the "partial" form over the first
              sizeof(struct commit_header) = 64 bytes in a zeroed block (recovery.c *_commit_block_csum_verify[_partial])
  crc32c      the kernel's raw crc32c(crc, data): Castagnoli, reflected, NO pre/post inversion (jbd2.h jbd2_chksum)
  tags        16-byte tag3; flags = low 16 bits (be16 at +6) as the kernel reads them; +16 UUID unless SAME_UUID; stop at
              LAST_TAG or when the next tag would reach the tail (recovery.c count_tags / do_one_pass)
  revoke      r_count = bytes used incl. the 16-byte header, <= blocksize - 4; be64 records (64bit) (recovery.c scan_revoke_records)
              a block is revoked for every tag of a sequence <= the revoke's sequence (revoke.c jbd2_journal_test_revoke)
A stale (clean) journal is never replayed by the kernel; this tool instead WALKS each committed transaction backwards-anchored:
from one of its own descriptor/revoke blocks forward, contiguously, every block carrying the transaction's sequence, every
checksum valid, every image's tag checksum valid, until exactly its commit block. Only images on such a walk are "proven".
A proven image is the block's content AS LOGGED IN THAT TRANSACTION. It is NEVER proof of the current / final state: later
transactions may have been overwritten or be unprovable (reported as newerUnproven), and the checkpointed home block may differ.
No image bytes are written; only their sha256. No extraction, replay, repair, MDBX or extent work.
"""
import argparse, array, hashlib, json, os, stat, struct, sys

MAGIC, MAGIC_BE = 0xC03B3998, bytes.fromhex("c03b3998")
DESC, COMMIT, SB_V1, SB_V2, REVOKE = 1, 2, 3, 4, 5
F_ESCAPE, F_SAME_UUID, F_DELETED, F_LAST_TAG = 1, 2, 4, 8
INC_REVOKE, INC_64BIT, INC_CSUM_V3 = 0x1, 0x2, 0x10
CRC32C_TYPE, BS, PROD_BYTES = 4, 4096, 1 << 30
TAG3, UUID_LEN, TAIL, COMMIT_HDR, REVOKE_HDR, REVOKE_REC, SB_STRUCT, SB_CSUM = 16, 16, 4, 64, 16, 8, 1024, 0xFC
LIBEXT2FS = "/usr/lib/libext2fs.so.2"
MAX_TARGETS, MAX_TARGETS_FILE = 4096, 1 << 20
MAX_OUT = 16 << 20
ENTRY_BUDGET = 12 << 20          # accumulated JSON bytes of listed entries (refs, images, failures, transactions), checked AS ADDED
MAX_STARTS = 4                    # walk start attempts per commit block
READ_FACTOR = 4                   # walk block reads <= 4 x log length (whole scan)
MAX_REFS = 200_000                # (target, sequence) reference/revoke index entries kept in memory (counted beyond)
UPSTREAM = {
    "https://raw.githubusercontent.com/torvalds/linux/master/fs/jbd2/recovery.c": "ccb2b0572719fc07ea851cb91c3c89440bc0fd296b3a5a94f11f69d64f72cd45",
    "https://raw.githubusercontent.com/torvalds/linux/master/fs/jbd2/commit.c": "f3915db63d1c07df99a33b16af040a73db8d8abcab5d3ea3656cce40dd4ab5f5",
    "https://raw.githubusercontent.com/torvalds/linux/master/fs/jbd2/journal.c": "6579ac57a8fb7560c43e3897906b7dcf9490ed633922272d7c56725664acf31b",
    "https://raw.githubusercontent.com/torvalds/linux/master/fs/jbd2/revoke.c": "60a0287bf5acfd99f72a836ecb74e69e9af4b891c141374c9c4b7b06550e1ae2",
    "https://raw.githubusercontent.com/torvalds/linux/master/include/linux/jbd2.h": "f99701769c0b7f509158baf86ccfb15ad401a6d8117653b2cc3f9f81323ef3f2",
    "/usr/src/linux/include/linux/jbd2.h (local; same on-disk structs)": "e52d521537037fc9fef6668a33f7558a934c75018cfad71eb45cbf7914e9645b"}


class Refuse(Exception):
    pass


class ReadBudget(Exception):
    pass


def refuse(msg):
    raise Refuse(msg)


def be32(b, o):
    return struct.unpack_from(">I", b, o)[0]


# ---- crc32c (raw kernel form) -------------------------------------------------------------------------------------------
def _table():
    t = []
    for i in range(256):
        c = i
        for _ in range(8):
            c = (c >> 1) ^ 0x82F63B78 if c & 1 else c >> 1
        t.append(c)
    return t


_T = _table()


def crc32c_pure(crc, data):
    t = _T
    for b in data:
        crc = t[(crc ^ b) & 0xFF] ^ (crc >> 8)
    return crc & 0xFFFFFFFF


def crc32c_libext2fs(path=LIBEXT2FS):
    import ctypes
    f = ctypes.CDLL(path).ext2fs_crc32c_le
    f.restype, f.argtypes = ctypes.c_uint32, [ctypes.c_uint32, ctypes.c_char_p, ctypes.c_size_t]
    return lambda crc, data: f(crc & 0xFFFFFFFF, bytes(data), len(data))


VECTORS = [(0xFFFFFFFF, b"123456789", 0x1CF96D7C)]    # CRC-32C check 0xE3069283 = ~0x1CF96D7C (raw register form)


def crc_impl(kind):
    if kind == "pure":
        fn, info = crc32c_pure, {"impl": "pure-python table (fixtures only)"}
    else:
        try:
            fn = crc32c_libext2fs()
        except (OSError, AttributeError) as e:
            refuse(f"libext2fs ext2fs_crc32c_le unavailable ({e})")
        with open(LIBEXT2FS, "rb") as f:
            info = {"impl": "libext2fs ext2fs_crc32c_le", "path": os.path.realpath(LIBEXT2FS), "sha256": hashlib.sha256(f.read()).hexdigest()}
    probes = [d for _, d, _ in VECTORS] + [hashlib.sha256(bytes([i])).digest() * 128 for i in range(3)]
    for seed, data, want in VECTORS:
        if fn(seed, data) != want:
            refuse("crc32c self-test vector failed")
    for d in probes:                                   # the selected implementation must agree with the reference table
        if fn(0xFFFFFFFF, d) != crc32c_pure(0xFFFFFFFF, d) or fn(0x12345678, d) != crc32c_pure(0x12345678, d):
            refuse("crc32c implementation disagrees with the reference table")
    return fn, info


# ---- bounded inputs / output ----------------------------------------------------------------------------------------------
def open_ro(path, what):
    if not isinstance(path, str) or not os.path.isabs(path):
        refuse(f"{what} path must be absolute")
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | os.O_CLOEXEC)
    except OSError as e:
        refuse(f"{what}: cannot open without following a symlink ({e.strerror})")
    st = os.fstat(fd)
    if not stat.S_ISREG(st.st_mode) or st.st_uid not in (0, os.getuid()) or st.st_mode & 0o022:
        os.close(fd); refuse(f"{what} must be a regular file owned by root or the caller, not group/world-writable")
    return fd, st


def read_targets(path):
    fd, st = open_ro(path, "targets")
    try:
        if st.st_size > MAX_TARGETS_FILE:
            refuse("targets file larger than 1 MiB")
        raw = os.read(fd, MAX_TARGETS_FILE + 1)
    finally:
        os.close(fd)
    try:
        t = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        refuse("targets is not UTF-8 JSON")
    ints = lambda v, hi: isinstance(v, list) and all(isinstance(b, int) and not isinstance(b, bool) and 0 <= b < hi for b in v)
    if not isinstance(t, dict) or "blocks" not in t or not set(t) <= {"blocks", "journalBlocks"} or not ints(t["blocks"], 1 << 64) \
            or not 1 <= len(t["blocks"]) <= MAX_TARGETS or not ints(t.get("journalBlocks", []), 1 << 32) or len(t.get("journalBlocks", [])) > MAX_TARGETS:
        refuse(f'targets must be {{"blocks": [1..{MAX_TARGETS} fs blocks], optional "journalBlocks": [<= {MAX_TARGETS} journal block positions]}}')
    return sorted(set(t["blocks"])), sorted(set(t.get("journalBlocks", [])))


class Listed:
    """append-time caps: an entry is listed only while the shared byte budget allows; everything is still COUNTED"""
    def __init__(self, budget):
        self.budget, self.used = budget, 0

    def add(self, lst, entry, counter):
        counter[0] += 1
        n = len(json.dumps(entry, sort_keys=True)) + 2
        if self.used + n > self.budget:
            return False
        self.used += n; lst.append(entry); return True


# ---- the verifier -----------------------------------------------------------------------------------------------------------
def verify(journal_path, targets, crc, fixture=False, jblocks=()):
    fd, st = open_ro(journal_path, "journal")
    try:
        size = st.st_size
        if fixture:
            if size % BS or not 2 * BS <= size <= PROD_BYTES:
                refuse("fixture journal must be 2..262144 whole 4 KiB blocks")
        elif size != PROD_BYTES:
            refuse("production journal copy must be exactly 1 GiB")
        nblocks = size // BS

        def block(p):
            b = os.pread(fd, BS, p * BS)
            if len(b) != BS:
                refuse(f"short read at journal block {p}")
            return b

        sb = block(0)
        if be32(sb, 0) != MAGIC or be32(sb, 4) != SB_V2:
            refuse("not a JBD2 v2 superblock")
        bsz, maxlen, first, sseq, start = (be32(sb, o) for o in (0xC, 0x10, 0x14, 0x18, 0x1C))
        compat, incompat, ro = be32(sb, 0x24), be32(sb, 0x28), be32(sb, 0x2C)
        if bsz != BS or maxlen != nblocks or not 1 <= first < maxlen or not (start == 0 or first <= start < maxlen):
            refuse("unsupported journal geometry")
        if compat or ro or incompat & ~(INC_REVOKE | INC_64BIT | INC_CSUM_V3) or not incompat & INC_64BIT or not incompat & INC_CSUM_V3 \
                or sb[0x50] != CRC32C_TYPE:
            refuse("unsupported features (only revoke + 64bit + csum_v3 with crc32c)")
        tmp = bytearray(sb[:SB_STRUCT]); tmp[SB_CSUM:SB_CSUM + 4] = bytes(4)
        if crc(0xFFFFFFFF, tmp) != be32(sb, SB_CSUM):
            refuse("journal superblock checksum mismatch: nothing in this copy can be authenticated")
        seed = crc(0xFFFFFFFF, sb[0x30:0x40])
        L = maxlen - first
        nxt = lambda p: p + 1 if p + 1 < maxlen else first
        dist = lambda a, b: ((b - first) - (a - first)) % L
        tset, jset = set(targets), set(jblocks)
        if any(not first <= q < maxlen for q in jset):
            refuse("journalBlocks must lie inside the log area")
        listed = Listed(ENTRY_BUDGET)
        jmaps, jmaps_n = {q: {"provenAs": [], "unverifiedMappings": []} for q in jblocks}, {q: [0] for q in jblocks}

        def tail_ok(b):
            t = bytearray(b); t[BS - TAIL:] = bytes(TAIL)
            return crc(seed, t) == be32(b, BS - TAIL)

        def commit_ok(b):
            t = bytearray(b); t[0x10:0x14] = bytes(4)
            if crc(seed, t) == be32(b, 0x10):
                return "full"
            p = bytearray(BS); p[:COMMIT_HDR] = b[:COMMIT_HDR]; p[0x10:0x14] = bytes(4)
            return "partial" if crc(seed, p) == be32(b, 0x10) else None

        def tags_of(b):
            out, off = [], 12
            while off + TAG3 <= BS - TAIL:
                low, hi = be32(b, off), be32(b, off + 8)
                flags16, csum = struct.unpack_from(">H", b, off + 6)[0], be32(b, off + 12)
                out.append({"blocknr": low | hi << 32, "flags": flags16, "flagsHigh16": struct.unpack_from(">H", b, off + 4)[0], "csum": csum})
                off += TAG3
                if not flags16 & F_SAME_UUID:
                    off += UUID_LEN
                if flags16 & F_LAST_TAG:
                    break
            return out

        def revokes_of(b):
            r = be32(b, 12)
            if r > BS - TAIL or r < REVOKE_HDR:
                return None
            return [struct.unpack_from(">Q", b, o)[0] for o in range(REVOKE_HDR, r - REVOKE_REC + 1, REVOKE_REC)]

        # pass 1: header index (12 bytes per block) -------------------------------------------------------------------
        hpos, hseq, htyp = array.array("I"), array.array("I"), array.array("B")
        other = [0]
        for p in range(first, maxlen):
            h = os.pread(fd, 12, p * BS)
            if len(h) != 12:
                refuse(f"short read at journal block {p}")
            if be32(h, 0) != MAGIC:
                continue
            t = be32(h, 4)
            if t in (DESC, COMMIT, REVOKE):
                hpos.append(p); hseq.append(be32(h, 8)); htyp.append(t)
            else:
                other[0] += 1
        commits, starts = {}, {}
        for i in range(len(hpos)):
            (commits if htyp[i] == COMMIT else starts).setdefault(hseq[i], []).append(hpos[i])

        # unverified references to targets (every descriptor / revoke, checksum NOT required) ---------------------------
        refs, refs_n = {b: [] for b in targets}, {b: [0] for b in targets}
        ref_seqs, ref_kept, refs_complete = {b: set() for b in targets}, [0], [True]
        if tset or jset:
            for i in range(len(hpos)):
                if htyp[i] == COMMIT:
                    continue
                b = block(hpos[i])
                tags = tags_of(b) if htyp[i] == DESC else []
                if jset and tags:                             # which fs block would each image slot be (descriptor NOT yet trusted)
                    q, valid = hpos[i], None
                    for t in tags:
                        q = nxt(q)
                        if q in jset:
                            valid = tail_ok(b) if valid is None else valid
                            listed.add(jmaps[q]["unverifiedMappings"], {"sequence": hseq[i], "descriptorBlock": hpos[i], "fsBlock": t["blocknr"],
                                                                        "descriptorChecksumValid": valid}, jmaps_n[q])
                items = [t["blocknr"] for t in tags] if htyp[i] == DESC else (revokes_of(b) or [])
                for bn in set(items) & tset:
                    if ref_kept[0] < MAX_REFS:
                        ref_seqs[bn].add((hseq[i], "revoke" if htyp[i] == REVOKE else "descriptor")); ref_kept[0] += 1
                    else:
                        refs_complete[0] = False
                    listed.add(refs[bn], {"sequence": hseq[i], "kind": "revoke" if htyp[i] == REVOKE else "descriptor",
                                          "journalBlock": hpos[i], "blockChecksumValid": tail_ok(b)}, refs_n[bn])

        # pass 2: contiguous checksum walks of committed transactions --------------------------------------------------
        budget = [READ_FACTOR * L]
        images, images_n = {b: [] for b in targets}, {b: [0] for b in targets}
        proven_revokes = {b: [] for b in targets}
        txs, txs_n, fails, fails_n = [], [0], [], [0]
        proven_seqs, budget_exhausted, proven_tx = 0, False, set()

        def walk(start, S, C):
            pos, hits, revs, ntags, jhits = start, [], [], 0, []
            for _ in range(L + 1):
                if budget[0] <= 0:
                    raise ReadBudget
                b = block(pos); budget[0] -= 1
                if be32(b, 0) != MAGIC or be32(b, 8) != S:
                    return None, f"journal block {pos} is not a block of transaction {S} (overwritten or not contiguous)"
                t = be32(b, 4)
                if t == COMMIT:
                    if pos != C:
                        return None, f"another commit block of sequence {S} at {pos}"
                    kind = commit_ok(b)
                    if not kind:
                        return None, f"commit block {pos} checksum mismatch"
                    return {"hits": hits, "jhits": jhits, "revokes": revs, "tags": ntags, "commit": kind,
                            "commitSec": struct.unpack_from(">Q", b, 0x30)[0], "commitNsec": be32(b, 0x38)}, None
                if pos == C:
                    return None, f"commit position {C} holds block type {t}"
                if t == DESC:
                    if not tail_ok(b):
                        return None, f"descriptor block {pos} checksum mismatch"
                    for tag in tags_of(b):
                        pos = nxt(pos)
                        if pos == C:
                            return None, f"descriptor maps an image onto the commit block {C}"
                        img = block(pos); budget[0] -= 1; ntags += 1
                        if crc(crc(seed, struct.pack(">I", S)), img) != tag["csum"]:
                            return None, f"tag checksum mismatch for the image at journal block {pos} (fs block {tag['blocknr']})"
                        if pos in jset:
                            jhits.append({"journalBlock": pos, "fsBlock": tag["blocknr"], "escaped": bool(tag["flags"] & F_ESCAPE),
                                          "contentSha256": hashlib.sha256((MAGIC_BE + img[4:]) if tag["flags"] & F_ESCAPE else img).hexdigest()})
                        if tag["blocknr"] in tset:
                            content = (MAGIC_BE + img[4:]) if tag["flags"] & F_ESCAPE else img
                            hits.append({"blocknr": tag["blocknr"], "imageJournalBlock": pos, "imageByteOffset": pos * BS,
                                         "escaped": bool(tag["flags"] & F_ESCAPE), "deletedFlag": bool(tag["flags"] & F_DELETED),
                                         "contentSha256": hashlib.sha256(content).hexdigest()})
                elif t == REVOKE:
                    if not tail_ok(b):
                        return None, f"revoke block {pos} checksum mismatch"
                    recs = revokes_of(b)
                    if recs is None:
                        return None, f"revoke block {pos} has an invalid r_count"
                    revs += [r for r in recs if r in tset]
                else:
                    return None, f"journal block {pos} has unexpected type {t}"
                pos = nxt(pos)
            return None, "walk exceeded the log length"

        try:
            for S in sorted(commits):
                for C in commits[S]:
                    cands = sorted((p for p in starts.get(S, []) if 0 < dist(p, C) < L), key=lambda p: -dist(p, C))
                    ok, reasons = None, []
                    for p in cands[:MAX_STARTS]:
                        res, why = walk(p, S, C)
                        if res:
                            ok = (p, res); break
                        reasons.append(why)
                    if not ok:
                        listed.add(fails, {"sequence": S, "commitBlock": C, "reasons": reasons[:MAX_STARTS] or ["no descriptor or revoke block of this sequence before its commit"]}, fails_n)
                        continue
                    p, res = ok
                    proven_seqs += 1
                    full = p == cands[0]
                    listed.add(txs, {"sequence": S, "startBlock": p, "commitBlock": C, "commit": res["commit"], "commitSec": res["commitSec"],
                                     "commitNsec": res["commitNsec"], "tags": res["tags"], "walkFromEarliestBlock": full}, txs_n)
                    for h in res["hits"]:
                        listed.add(images[h["blocknr"]], {**h, "sequence": S, "commitBlock": C, "commitSec": res["commitSec"], "commitNsec": res["commitNsec"],
                                                          "partialCommit": res["commit"] == "partial", "walkFromEarliestBlock": full}, images_n[h["blocknr"]])
                    proven_tx.add(S)
                    for h in res["jhits"]:
                        listed.add(jmaps[h["journalBlock"]]["provenAs"], {**h, "sequence": S, "commitBlock": C, "commitSec": res["commitSec"],
                                                                         "partialCommit": res["commit"] == "partial"}, jmaps_n[h["journalBlock"]])
                    for r in set(res["revokes"]):
                        proven_revokes[r].append(S)
        except ReadBudget:
            budget_exhausted = True

        tid_ge = lambda a, b: ((a - b) & 0xFFFFFFFF) < 0x80000000      # a >= b in the kernel's circular tid order
        out_targets = {}
        for bn in targets:
            ims = images[bn]
            for im in ims:
                im["revokedByProvenSequence"] = sorted(s for s in proven_revokes[bn] if tid_ge(s, im["sequence"]))
            # newest = closest below s_sequence in the kernel's circular tid order
            latest = max((im["sequence"] for im in ims if not im["revokedByProvenSequence"]), default=None,
                         key=lambda s: (s - sseq + 0x80000000) & 0xFFFFFFFF)
            proven_set = {im["sequence"] for im in ims}
            newer_unproven = sorted({s for s, _ in ref_seqs[bn] if s not in proven_set and s not in proven_tx and (latest is None or (tid_ge(s, latest) and s != latest))})
            out_targets[str(bn)] = {
                "status": "PROVEN LOGGED CONTENT (authentic, committed; NOT current-state proof)" if latest is not None else "NO PROVEN UNREVOKED IMAGE",
                "latestProvenUnrevokedSequence": latest, "newerOrUnprovenReferenceSequences": newer_unproven[:256],
                "newerOrUnprovenComplete": refs_complete[0] and not budget_exhausted and len(newer_unproven) <= 256,
                "provenImages": ims, "provenImagesTotal": images_n[bn][0], "unverifiedReferences": refs[bn], "unverifiedReferencesTotal": refs_n[bn][0]}
        return {
            "format": "enclave-jbd2-verify/r1", "acceptance": "NOT A RECOVERY ACCEPTANCE: proven images are authentic content as logged in a "
            "committed transaction; never the current or final state of the filesystem or the database",
            "crc": None, "upstream": UPSTREAM,
            "superblock": {"checksumVerified": True, "sequence": sseq, "start": start, "clean": start == 0, "first": first, "maxlen": maxlen,
                           "incompat": incompat, "uuid": sb[0x30:0x40].hex(), "seed": f"{seed:08x}"},
            "summary": {"headerBlocks": len(hpos), "otherHeaderBlocks": other[0], "commitSequences": len(commits), "provenTransactions": proven_seqs,
                        "failedTransactionsTotal": fails_n[0], "listedTransactionsTotal": txs_n[0], "walkBudgetExhausted": budget_exhausted,
                        "listedBytes": listed.used, "listedBudget": ENTRY_BUDGET, "referenceIndexComplete": refs_complete[0]},
            "targets": out_targets, "transactions": txs, "failedTransactions": fails,
            "journalBlocks": {str(q): {**jmaps[q], "entriesTotal": jmaps_n[q][0]} for q in jblocks}}
    finally:
        os.close(fd)


def write_out(path, doc):
    raw = (json.dumps(doc, indent=1, sort_keys=True) + "\n").encode()
    if len(raw) > MAX_OUT:
        refuse(f"output {len(raw)} bytes exceeds {MAX_OUT}")
    if not os.path.isabs(path):
        refuse("output path must be absolute")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    except OSError as e:
        refuse(f"output must be a NEW file ({e.strerror})")
    with os.fdopen(fd, "wb") as f:
        f.write(raw); f.flush(); os.fsync(f.fileno())


def main(argv=None):
    ap = argparse.ArgumentParser(description="bounded offline JBD2 csum-v3 verifier (no recovery acceptance)")
    ap.add_argument("--journal", required=True); ap.add_argument("--targets", required=True); ap.add_argument("--out", required=True)
    ap.add_argument("--fixture", action="store_true"); ap.add_argument("--crc", choices=["libext2fs", "pure"], default="libext2fs")
    a = ap.parse_args(argv)
    try:
        if a.crc == "pure" and not a.fixture:
            refuse("the pure-python crc is for fixtures only")
        crc, info = crc_impl(a.crc)
        blocks, jblocks = read_targets(a.targets)
        doc = verify(a.journal, blocks, crc, fixture=a.fixture, jblocks=jblocks)
        doc["crc"] = info
        write_out(a.out, doc)
    except Refuse as e:
        print(f"REFUSED: {e}", file=sys.stderr)
        return 3
    print(json.dumps({"written": a.out}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
