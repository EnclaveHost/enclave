#!/usr/bin/env python3
"""journal-recovery-stage/r1 jbd2_inventory.py (prepared by Claude 1624; NOT run by Claude). Standard library only.

OFFLINE inventory of ONE copied JBD2 journal file (e.g. `debugfs dump <8>` of the deleted-mdbx filesystem's journal). It reads only that
regular file (no-follow, non-blocking, bounded 4 KiB reads), an optional target-block list, and writes ONE new bounded JSON file. It
never opens a device, an image, a filesystem or database bytes, and has no extraction, replay or repair path.

AUTHENTICATION: NONE. Every reported record is an UNAUTHENTICATED CANDIDATE. The struct layouts used here come from the local primary
header /usr/src/linux/include/linux/jbd2.h (journal_header_t, commit_header, journal_block_tag3_t, jbd2_journal_block_tail,
jbd2_journal_revoke_header_t, journal_superblock_t, block types, tag flags, feature bits). The JBD2 checksum COMPUTATION (seed,
coverage, field zeroing) is NOT in that header (it lives in fs/jbd2/*.c, absent locally), so no checksum is verified, raw checksum
fields are only reported, and "acceptance" is always refused. A few placement rules are not stated by the header either and are
INFERRED (listed in LAYOUT_BASIS and in the output); an independent decoder (debugfs `logdump -O -f COPY`) must agree before any use.

    jbd2_inventory.py --journal /ABS/journal-8.bin --out /ABS/inventory.json [--targets /ABS/targets.json] [--fixture]
    targets.json: {"blocks": [fs block numbers, <= 100000]}
Exit: 0 inventory written; 2 usage; 3 refused (unsupported format, bad input, bound exceeded) - nothing written.
"""
import argparse, json, os, stat, struct, sys

BLOCK = 4096
JOURNAL_BYTES = 1 << 30                 # the copied journal of the target filesystem: 1 GiB = 262144 blocks (1546 stat <8>)
MAX_BLOCKS = 262144
OUT_MAX = 16 << 20
MAX_TARGETS = 100000
TARGETS_MAX_BYTES = 4 << 20
# local primary header jbd2.h
MAGIC = 0xC03B3998
DESCRIPTOR, COMMIT, SB_V1, SB_V2, REVOKE = 1, 2, 3, 4, 5
F_ESCAPE, F_SAME_UUID, F_DELETED, F_LAST_TAG = 1, 2, 4, 8
INC_REVOKE, INC_64BIT, INC_ASYNC, INC_CSUM_V2, INC_CSUM_V3, INC_FAST_COMMIT = 1, 2, 4, 8, 0x10, 0x20
COMPAT_CHECKSUM = 1
CRC32C_CHKSUM = 4
SUPPORTED_INCOMPAT = INC_REVOKE | INC_64BIT | INC_CSUM_V3       # exactly the target journal's set (1546 logdump -S)
REQUIRED_INCOMPAT = INC_64BIT | INC_CSUM_V3
TAG3_BYTES, UUID_BYTES, TAIL_BYTES, REVOKE_HDR, REVOKE_REC = 16, 16, 4, 16, 8
LAYOUT_BASIS = {
    "header": "jbd2.h journal_header_t: be32 h_magic, h_blocktype, h_sequence",
    "superblock": "jbd2.h journal_superblock_t field offsets (0x0C blocksize, 0x10 maxlen, 0x14 first, 0x18 sequence, 0x1C start, "
                  "0x24/0x28/0x2C features, 0x30 uuid, 0x50 checksum_type, 0x54 num_fc_blks, 0x58 head, 0xFC checksum)",
    "commit": "jbd2.h struct commit_header: h_chksum_type @0x0C, h_chksum_size @0x0D, h_chksum[8] @0x10, be64 h_commit_sec @0x30, "
              "be32 h_commit_nsec @0x38",
    "tag": "jbd2.h journal_block_tag3_t: be32 t_blocknr, t_flags, t_blocknr_high, t_checksum (16 bytes with csum_v3 + 64bit)",
    "flags": "jbd2.h JBD2_FLAG_ESCAPE 1, SAME_UUID 2, DELETED 4, LAST_TAG 8",
    "revoke": "jbd2.h jbd2_journal_revoke_header_t: header + be32 r_count (bytes used)",
    "INFERRED (not stated in jbd2.h)": [
        "a 16-byte UUID follows each tag whose flags lack SAME_UUID",
        "the jbd2_journal_block_tail (4 bytes) occupies the last 4 bytes of descriptor and revoke blocks",
        "each descriptor tag owns the next log block in order (wrapping from maxlen-1 to s_first); an ESCAPE image had its first 4 "
        "bytes (the magic) zeroed in the log",
        "revoke records are be64 block numbers (64bit feature) from byte 16 up to r_count",
        "the log area is [s_first, s_maxlen) with no fast-commit area (fast_commit unsupported here)"],
    "NOT DERIVABLE LOCALLY": "the JBD2 checksum algorithms (superblock, descriptor/revoke tail, tag, commit): no checksum is verified"}


class Refused(Exception):
    pass


def be32(b, o):
    return struct.unpack_from(">I", b, o)[0]


def open_regular(path, *, max_bytes, what):
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


def read_block(fd, n):
    b = os.pread(fd, BLOCK, n * BLOCK)
    if len(b) != BLOCK:
        raise Refused(f"short read at journal block {n} (the file changed?)")
    return b


def parse_superblock(b, nblocks):
    if be32(b, 0) != MAGIC:
        raise Refused("block 0 is not a JBD2 superblock (magic)")
    if be32(b, 4) != SB_V2:
        raise Refused(f"unsupported superblock type {be32(b, 4)} (only v2)")
    sb = {"blocksize": be32(b, 0x0C), "maxlen": be32(b, 0x10), "first": be32(b, 0x14), "sequence": be32(b, 0x18), "start": be32(b, 0x1C),
          "errno": struct.unpack_from(">i", b, 0x20)[0], "featureCompat": be32(b, 0x24), "featureIncompat": be32(b, 0x28),
          "featureRoCompat": be32(b, 0x2C), "uuid": b[0x30:0x40].hex(), "nrUsers": be32(b, 0x40), "maxTransaction": be32(b, 0x48),
          "checksumType": b[0x50], "numFcBlks": be32(b, 0x54), "head": be32(b, 0x58), "checksumRaw": f"{be32(b, 0xFC):08x}"}
    if sb["blocksize"] != BLOCK:
        raise Refused(f"unsupported journal blocksize {sb['blocksize']} (only {BLOCK})")
    if sb["maxlen"] != nblocks:
        raise Refused(f"superblock maxlen {sb['maxlen']} != file blocks {nblocks}")
    if not 1 <= sb["first"] < sb["maxlen"] or not (sb["start"] == 0 or sb["first"] <= sb["start"] < sb["maxlen"]):
        raise Refused("superblock first/start outside the journal")
    inc = sb["featureIncompat"]
    if sb["featureCompat"] or sb["featureRoCompat"]:                 # incl. COMPAT_CHECKSUM (checksum v1)
        raise Refused(f"unsupported compat/ro_compat features {sb['featureCompat']:#x}/{sb['featureRoCompat']:#x}")
    if inc & ~SUPPORTED_INCOMPAT or inc & REQUIRED_INCOMPAT != REQUIRED_INCOMPAT:
        raise Refused(f"unsupported incompat features {inc:#x} (supported: exactly revoke? + 64bit + csum_v3)")
    if sb["checksumType"] != CRC32C_CHKSUM:
        raise Refused(f"unsupported checksum type {sb['checksumType']} (csum_v3 uses crc32c = {CRC32C_CHKSUM})")
    return sb


def parse_descriptor(b):
    """-> (tags, problem). tags: [{blocknr, flags, checksumRaw}]; problem: None or why it is undecodable"""
    tags, off, end = [], 12, BLOCK - TAIL_BYTES
    while True:
        if off + TAG3_BYTES > end:
            return tags, "tags overflow the block without LAST_TAG"
        low, flags, high, csum = struct.unpack_from(">IIII", b, off)
        if flags & ~(F_ESCAPE | F_SAME_UUID | F_DELETED | F_LAST_TAG):
            return tags, f"unknown tag flags {flags:#x}"
        if not tags and flags & F_SAME_UUID:
            return tags, "first tag claims SAME_UUID"
        tags.append({"blocknr": (high << 32) | low, "flags": flags, "checksumRaw": f"{csum:08x}"})
        off += TAG3_BYTES
        if not flags & F_SAME_UUID:
            off += UUID_BYTES
        if flags & F_LAST_TAG:
            if off > end:
                return tags, "the last tag's UUID overlaps the block tail"
            return tags, None


def parse_revoke(b):
    count = be32(b, 12)
    if count < REVOKE_HDR or count > BLOCK - TAIL_BYTES or (count - REVOKE_HDR) % REVOKE_REC:
        return [], f"revoke r_count {count} is not a valid byte count"
    return [struct.unpack_from(">Q", b, o)[0] for o in range(REVOKE_HDR, count, REVOKE_REC)], None


def inventory(journal_path, *, targets=(), fixture=False):
    fd, st = open_regular(journal_path, max_bytes=JOURNAL_BYTES if not fixture else MAX_BLOCKS * BLOCK, what="journal copy")
    try:
        if fixture:
            if st.st_size % BLOCK or not 2 * BLOCK <= st.st_size <= MAX_BLOCKS * BLOCK:
                raise Refused("fixture journal size must be a multiple of 4096, 2..262144 blocks")
        elif st.st_size != JOURNAL_BYTES:
            raise Refused(f"journal copy must be exactly {JOURNAL_BYTES} bytes (got {st.st_size}); use --fixture only for fixtures")
        nblocks = st.st_size // BLOCK
        sb = parse_superblock(read_block(fd, 0), nblocks)
        first, maxlen = sb["first"], sb["maxlen"]
        logn = maxlen - first
        meta, anomalies = {}, []                    # position -> (type, seq)
        descs, commits, revokes, undecodable = [], [], [], []
        for pos in range(first, maxlen):            # one bounded 4 KiB read per block, sequential
            b = read_block(fd, pos)
            if be32(b, 0) != MAGIC:
                continue
            btype, seq = be32(b, 4), be32(b, 8)
            meta[pos] = (btype, seq)
            if btype == DESCRIPTOR:
                tags, why = parse_descriptor(b)
                if why:
                    undecodable.append({"journalBlock": pos, "type": "descriptor", "sequence": seq, "why": why})
                else:
                    descs.append({"pos": pos, "seq": seq, "tags": tags, "tailRaw": f"{be32(b, BLOCK - 4):08x}"})
            elif btype == COMMIT:
                commits.append({"journalBlock": pos, "sequence": seq, "commitSec": struct.unpack_from(">Q", b, 0x30)[0],
                                "commitNsec": be32(b, 0x38), "chksumType": b[0x0C], "chksumSize": b[0x0D], "chksumRaw": f"{be32(b, 0x10):08x}"})
            elif btype == REVOKE:
                recs, why = parse_revoke(b)
                if why:
                    undecodable.append({"journalBlock": pos, "type": "revoke", "sequence": seq, "why": why})
                else:
                    revokes.append({"journalBlock": pos, "sequence": seq, "blocks": recs, "tailRaw": f"{be32(b, BLOCK - 4):08x}"})
            else:
                anomalies.append({"journalBlock": pos, "type": btype, "sequence": seq, "why": "unexpected block type inside the log area"})
        # map each tag to its image position (the following log blocks, wrapping); an image that is itself a metadata header is stale
        images = []                                  # (blocknr, seq, imagePos, flags, descPos, conflict)
        for d in descs:
            for i, t in enumerate(d["tags"]):
                ipos = first + (d["pos"] - first + 1 + i) % logn
                images.append((t["blocknr"], d["seq"], ipos, t["flags"], d["pos"], ipos in meta))
                t["imageJournalBlock"] = ipos
        commit_by_seq = {}
        for c in commits:
            commit_by_seq.setdefault(c["sequence"], []).append(c)
        txs = {}
        for d in descs:
            tx = txs.setdefault(d["seq"], {"sequence": d["seq"], "descriptors": [], "tags": 0, "conflictingImages": 0, "revokeBlocks": 0})
            tx["descriptors"].append(d["pos"]); tx["tags"] += len(d["tags"])
        for _, seq, _, _, _, conflict in images:
            txs[seq]["conflictingImages"] += conflict
        for r in revokes:
            txs.setdefault(r["sequence"], {"sequence": r["sequence"], "descriptors": [], "tags": 0, "conflictingImages": 0, "revokeBlocks": 0})["revokeBlocks"] += 1
        for seq, cs in commit_by_seq.items():
            txs.setdefault(seq, {"sequence": seq, "descriptors": [], "tags": 0, "conflictingImages": 0, "revokeBlocks": 0})
        tx_list = []
        for seq in sorted(txs):
            tx = txs[seq]; cs = commit_by_seq.get(seq, [])
            tx.update(committed=bool(cs), commitSec=cs[0]["commitSec"] if cs else None, commitNsec=cs[0]["commitNsec"] if cs else None,
                      commitBlocks=[c["journalBlock"] for c in cs], intact=bool(cs) and tx["conflictingImages"] == 0 and len(cs) == 1)
            tx_list.append(tx)
        want = set(targets)
        cand = {str(b): [] for b in sorted(want)}
        for blocknr, seq, ipos, flags, dpos, conflict in images:
            if blocknr in want:
                tx = txs[seq]
                cand[str(blocknr)].append({"sequence": seq, "imageJournalBlock": ipos, "imageByteOffset": ipos * BLOCK, "descriptor": dpos,
                                           "escaped": bool(flags & F_ESCAPE), "deletedFlag": bool(flags & F_DELETED),
                                           "imageIsMetadataHeader": conflict, "committed": tx["committed"], "commitSec": tx["commitSec"],
                                           "txIntact": tx["intact"], "checksum": "unchecked"})
        revoked = {str(b): [] for b in sorted(want)}
        for r in revokes:
            for blk in r["blocks"]:
                if blk in want:
                    revoked[str(blk)].append({"sequence": r["sequence"], "journalBlock": r["journalBlock"]})
        seqs = [t["sequence"] for t in tx_list]
        out = {"format": "journal-recovery-r1-jbd2-inventory/v1",
               "authentication": "UNAUTHENTICATED CANDIDATES",
               "acceptance": "refused: no JBD2 checksum is verified (the algorithm is not derivable from the local primary header); "
                             "candidate bytes are never authority and are never a recovered file",
               "layoutBasis": LAYOUT_BASIS,
               "journal": {"path": journal_path, "bytes": st.st_size, "blocks": nblocks, "fixtureMode": fixture},
               "superblock": sb, "clean": sb["start"] == 0,
               "summary": {"metadataBlocks": len(meta), "descriptors": len(descs), "commits": len(commits), "revokeBlocks": len(revokes),
                           "undecodable": len(undecodable), "anomalies": len(anomalies), "transactions": len(tx_list),
                           "committedTransactions": sum(t["committed"] for t in tx_list), "intactTransactions": sum(t["intact"] for t in tx_list),
                           "images": len(images), "distinctFsBlocks": len({i[0] for i in images}),
                           "sequenceRange": [min(seqs), max(seqs)] if seqs else None,
                           "commitTimeRange": [min(c["commitSec"] for c in commits), max(c["commitSec"] for c in commits)] if commits else None,
                           "staleOnly": sb["start"] == 0},
               "targets": {"requested": len(want), "candidates": cand, "revokedBy": revoked},
               "undecodable": undecodable, "anomalies": anomalies, "transactions": tx_list, "truncated": False}
        return out
    finally:
        os.close(fd)


def bounded_json(out):
    text = json.dumps(out, sort_keys=True)
    if len(text) <= OUT_MAX:
        return text
    out = dict(out); full = len(out["transactions"])
    while len(text) > OUT_MAX and out["transactions"]:
        out["transactions"] = out["transactions"][: len(out["transactions"]) // 2]
        out["truncated"] = {"transactionsListed": len(out["transactions"]), "transactionsTotal": full}
        text = json.dumps(out, sort_keys=True)
    if len(text) > OUT_MAX:
        raise Refused(f"inventory exceeds {OUT_MAX} bytes even without the transaction list (too many targets/candidates)")
    return text


def load_targets(path):
    if path is None:
        return []
    fd, st = open_regular(path, max_bytes=TARGETS_MAX_BYTES, what="targets")
    try:
        raw = os.read(fd, TARGETS_MAX_BYTES + 1)
    finally:
        os.close(fd)
    try:
        v = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise Refused("targets is not UTF-8 JSON")
    if not isinstance(v, dict) or set(v) != {"blocks"} or not isinstance(v["blocks"], list) or len(v["blocks"]) > MAX_TARGETS or \
            any(not isinstance(x, int) or isinstance(x, bool) or not 0 <= x < 1 << 64 for x in v["blocks"]):
        raise Refused(f"targets must be {{\"blocks\": [<= {MAX_TARGETS} non-negative 64-bit integers]}}")
    return v["blocks"]


def write_new(path, text):
    if not isinstance(path, str) or not path.startswith("/") or "\0" in path:
        raise Refused("output path must be absolute")
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    try:
        data = text.encode("utf-8"); n = 0
        while n < len(data):
            n += os.write(fd, data[n:])
    finally:
        os.close(fd)


def main(argv=None):
    ap = argparse.ArgumentParser(description="offline JBD2 journal-copy inventory (unauthenticated candidates)")
    ap.add_argument("--journal", required=True); ap.add_argument("--out", required=True); ap.add_argument("--targets")
    ap.add_argument("--fixture", action="store_true")
    a = ap.parse_args(argv)
    try:
        text = bounded_json(inventory(a.journal, targets=load_targets(a.targets), fixture=a.fixture))
        write_new(a.out, text)
    except Refused as e:
        print(f"REFUSED: {e}", file=sys.stderr); return 3
    except FileExistsError:
        print("REFUSED: the output file already exists (never overwritten)", file=sys.stderr); return 3
    except OSError as e:
        print(f"REFUSED: {type(e).__name__}: {e.strerror or e}", file=sys.stderr); return 3
    print(json.dumps({"written": a.out, "bytes": len(text)}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
