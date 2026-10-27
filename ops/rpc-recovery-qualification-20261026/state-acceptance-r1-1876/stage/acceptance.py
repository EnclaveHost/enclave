#!/usr/bin/env python3
"""state-helper-qualification-stage/r1 acceptance.py (PREPARED by Claude 1873; NOT run by Claude). Standard library only.

PURE input validation and classification for the base-state-readonly r11 state helper (plan 1867, review 1869, root 1868 + 1872).
It NEVER executes a process, opens a file, reads production data or touches a mount: every input is a Python value or `bytes`
handed over by a FUTURE trusted caller (the production runner / the fixture-capture wrapper), which is NOT implemented here and
must bind real process, output and provenance capture itself. Nothing returned here is a canonical-chain proof, a recovery
acceptance or an original-reset authority (every result carries canonical=False, resetAuthority=False).

  load_json_strict(raw, cap)            bytes -> dict: UTF-8 (no BOM), no duplicate keys, no NaN/Infinity, NO floats, object top level
  report_schema_errors(doc)             exact r11 report schema + the helper's own internal consistency (types exact: bool is NOT int)
  derived_exit(doc)                     the helper's exit (0/4/5) recomputed from a schema-valid report, as main.rs computes it
  production_v2_errors(doc)             the PASSING predicate for a production v2 run (separate from schema validity)
  classify_state(lifecycle, child_rc, report_raw, memory)
                                        8 VOID (post-use) > 7 lifecycle faults > child 3 (no report) 30 > child 4 (valid failing report)
                                        34 > child 5 (full passing predicate) 35 > everything else 7; memory dirty/unreadable: 34/35 -> 7
  final_state_status(runtime_rc, evidence, report_raw, pins)
                                        35 stays 35 ONLY with complete typed evidence + report/provenance binding; else 10;
                                        runtime 0 -> 10; any other nonzero runtime rc is preserved (never usable)
  check_fixture_capture(kind, captured, rc, timed_out, truncated, observed, expected)
                                        the exact r11 positive.sh (26 runs) / fixtures.sh (6 cases) output + identities. It validates
                                        CALLER-SUPPLIED captures only: authenticated=False; it is NOT a receipt and qualifies nothing alone
"""
import hashlib
import json
import re

# ---- pins: frozen base-state-readonly-stage/r11 (verified against the r11 source by tests/test_acceptance.py when it is present) ----
R11_STAGE_SUMS_SHA256 = "246ff06b4df2869596af7f8fdbc784af349bfe88c071e5660ae982048cfa1ced"
R11_MAIN_RS_SHA256 = "5a6fa214e913ffe23048257c2feb73548526e72afd56e6736b05eef89ae52d66"
R11_POSITIVE_SH_SHA256 = "24b8c3e95783be0e7d7f9ab3c3261228e2d3a9f6c9e28836e4af80e3b2d67c42"
R11_FIXTURES_SH_SHA256 = "fc1e2842d74686b6d92a6da9a53379db4bbf8f4b9432d3dbc1c5e090c8b66efa"

# ---- the r11 report: literal constants of src/main.rs (doc json!, verify_cache, plain) ----
FORMAT = "base-state-readonly/r11"
ACCEPTANCE = ("NOT A CHAIN ACCEPTANCE: the Finish header is NOT proven canonical here; history tables, receipts, transactions and "
              "RocksDB history indices are NOT checked")
HISTORY_INDICES = "NOT CHECKED (zero index checkpoints only mean the indices are absent; they are NOT a health signal)"
HISTORY_INTEGRITY = "INCOMPLETE: changesets/history indices/receipts/transactions not verified"
EXIT_MEANING = ("0 FULL (hashed-only root == header + trie cache 0 inconsistencies + cachedWalk consistent + checkpoints + plain->hashed "
                "PASS); 5 PARTIAL (plain NOT_RUN/NOT_APPLICABLE: no full state claim); 4 FAILED; 3 refused")
TIP_NOTE = "parentHash/withdrawalsRoot are REPORTED only: not verified; the header is NOT proven canonical"
ROOT_NOTE = ("matchesHeader = root recomputed from ALL hashed accounts/storages with no trie table (NoopTrieCursorFactory). cachedWalk "
             "reuses stored branch hashes and is DIAGNOSTIC ONLY: it never makes a pass")
CACHE_METHOD = ("reth_trie::verify::Verifier (repair-trie --dry-run): full recomputation from hashed tables, node-by-node vs the "
                "stored trie")
PLAIN_METHOD = "every plain entry looked up at keccak256(key) with value equality + equal entry counts (bijection)"
V2_WHY = "storage_v2: plain state is not written (provider.rs write_state_changes); hashed state is canonical"
ROCKS_V1 = "NOT_APPLICABLE_V1: no table is routed to RocksDB (not inspected)"
ROCKS_PRESENT = "PRESENT: a directory with a regular CURRENT file; NOT opened"
ROCKS_ABSENT = ("ABSENT: path absent and the 3 history-index checkpoints are present and 0 (snapshot reset shape); history indices "
                "NOT CHECKED")
FINISH_UNITS = ("none", "Finish(partial_state_trie: None)")
INDEX_STAGES = ("TransactionLookup", "IndexAccountHistory", "IndexStorageHistory")
COHERENT_STAGES = ("MerkleExecute", "AccountHashing", "StorageHashing", "Execution")       # main.rs: each == finish
FIVE_STAGES = ("Execution", "AccountHashing", "StorageHashing", "MerkleExecute", "Finish")

TOP_KEYS = frozenset({"format", "acceptance", "storageSettings", "storageSettingsPresent", "trieKeyAdapter", "rocksdbCurrentPresent",
                      "rocksdbOpened", "rocksdbClassification", "historyIndexCheckpoints", "historyIndices", "unwindMarkerPresent",
                      "finishUnitCheckpoint", "finishFrontier", "merkleExecuteProgressBytes", "checkpoints", "finish",
                      "checkpointsCoherent", "tipHeader", "stateRoot", "trieCache", "plainVsHashed", "historyIntegrity",
                      "fullStateIntegrity", "exitMeaning"})
TIP_KEYS = frozenset({"number", "hash", "stateRoot", "parentHash", "withdrawalsRoot", "note"})
ROOT_KEYS = frozenset({"computed", "fromHashedOnly", "matchesHeader", "fromHashedOnlySeconds", "cachedWalk", "cachedWalkMatchesHeader",
                       "cachedWalkEqualsFromHashedOnly", "cachedWalkSeconds", "note"})
CACHE_KEYS = frozenset({"status", "accountInconsistencies", "storageInconsistencies", "samplesFirst64", "seconds", "accountsTrieEntries",
                        "storagesTrieEntries", "method"})
PLAIN_V2_KEYS = frozenset({"status", "why", "plainAccountsEntries", "plainStorageEntries"})
PLAIN_V1_KEYS = frozenset({"status", "plainAccounts", "hashedAccounts", "accountMismatches", "plainSlots", "hashedSlots", "slotMismatches",
                           "zeroValuedPlainSlots", "mismatchSamplesFirst64", "seconds", "method"})

MAX_REPORT_BYTES = 32 << 20                       # r6 read_all cap for a report
MAX_CAPTURE_BYTES = 1 << 20                       # the wrapper's capture bound (1869 §3)
U64 = (1 << 64) - 1
HEX32 = re.compile(r"0x[0-9a-f]{64}")
SHA256_HEX = re.compile(r"[0-9a-f]{64}")

# outcome codes (job level; distinct from the r6 lifecycle codes 3/4/5)
VOID, INCONCLUSIVE, STATE_REFUSED, STATE_FAILED, STATE_PARTIAL_V2, FINAL_EVIDENCE_FAILED = 8, 7, 30, 34, 35, 10
NAMES = {VOID: "VOID", INCONCLUSIVE: "INCONCLUSIVE", STATE_REFUSED: "STATE-REFUSED", STATE_FAILED: "STATE-FAILED",
         STATE_PARTIAL_V2: "STATE-PARTIAL-V2", FINAL_EVIDENCE_FAILED: "FINAL-EVIDENCE-FAILED"}
NOT_AUTHORITY = {"canonical": False, "resetAuthority": False,
                 "note": "state self-consistency at the DB's own Finish header only: NOT canonical-chain proof, NOT recovery acceptance"}


class Invalid(ValueError):
    pass


# ---- exact types (bool is NOT an int; no truthiness) ---------------------------------------------------------------------------------
def is_int(x, lo=0, hi=U64):
    return type(x) is int and lo <= x <= hi


def is_bool(x):
    return type(x) is bool


def is_str(x):
    return type(x) is str


def is_hex32(x):
    return type(x) is str and HEX32.fullmatch(x) is not None


def is_sha256(x):
    return type(x) is str and SHA256_HEX.fullmatch(x) is not None


def exact_keys(d, keys, where, errs):
    if type(d) is not dict:
        errs.append(f"{where}: not an object"); return False
    present = set(d)
    missing, extra = sorted(set(keys) - present), sorted(present - set(keys))
    if missing:
        errs.append(f"{where}: missing {missing}")
    if extra:
        errs.append(f"{where}: unexpected {extra}")
    return not missing and not extra


# ---- strict loader ---------------------------------------------------------------------------------------------------------------------
def _pairs(pairs):
    d = {}
    for k, v in pairs:
        if k in d:
            raise Invalid(f"duplicate JSON key {k!r}")
        d[k] = v
    return d


def _no_constant(name):
    raise Invalid(f"non-finite JSON constant {name}")


def _no_float(text):
    raise Invalid(f"JSON number {text!r} is not an integer (no floats in this contract)")


def load_json_strict(raw, cap=MAX_REPORT_BYTES):
    if type(raw) is not bytes:
        raise Invalid("input must be bytes")
    if len(raw) > cap:
        raise Invalid(f"{len(raw)} bytes > cap {cap}")
    if raw.startswith(b"\xef\xbb\xbf"):
        raise Invalid("UTF-8 BOM")
    try:
        text = raw.decode("utf-8", errors="strict")
    except UnicodeDecodeError as e:
        raise Invalid(f"not UTF-8: {e}") from None
    try:
        doc = json.loads(text, object_pairs_hook=_pairs, parse_constant=_no_constant, parse_float=_no_float)
    except Invalid:
        raise
    except (ValueError, RecursionError) as e:
        raise Invalid(f"malformed JSON: {e}") from None
    if type(doc) is not dict:
        raise Invalid("top level is not an object")
    return doc


# ---- schema validity (any genuine r11 report, passing or failing) ----------------------------------------------------------------------
def _v2(doc):
    return doc.get("storageSettings") == {"storage_v2": True} and doc["storageSettings"]["storage_v2"] is True


def report_schema_errors(doc):
    """[] iff doc has EXACTLY the r11 report shape, types and constants, and its derived flags agree with its own values (as
    main.rs derives them). Says nothing about whether the state checks passed."""
    e = []
    if not exact_keys(doc, TOP_KEYS, "report", e):
        return e
    for k, want in (("format", FORMAT), ("acceptance", ACCEPTANCE), ("historyIndices", HISTORY_INDICES),
                    ("historyIntegrity", HISTORY_INTEGRITY), ("exitMeaning", EXIT_MEANING), ("finishFrontier", "none")):
        if not (is_str(doc[k]) and doc[k] == want):
            e.append(f"{k}: not the r11 constant")
    for k in ("storageSettingsPresent", "rocksdbCurrentPresent", "checkpointsCoherent", "fullStateIntegrity"):
        if not is_bool(doc[k]):
            e.append(f"{k}: not a bool")
    if doc["rocksdbOpened"] is not False:
        e.append("rocksdbOpened: not literal false")
    if doc["unwindMarkerPresent"] is not False:
        e.append("unwindMarkerPresent: not literal false")
    ss = doc["storageSettings"]
    if ss is not None and not (type(ss) is dict and ss.keys() == {"storage_v2"} and is_bool(ss["storage_v2"])):
        e.append("storageSettings: not null or {storage_v2: bool}")
    elif is_bool(doc["storageSettingsPresent"]) and doc["storageSettingsPresent"] != (ss is not None):
        e.append("storageSettingsPresent disagrees with storageSettings")
    v2 = ss is not None and type(ss) is dict and ss.get("storage_v2") is True
    if doc["trieKeyAdapter"] != ("PackedKeyAdapter" if v2 else "LegacyKeyAdapter") or not is_str(doc["trieKeyAdapter"]):
        e.append("trieKeyAdapter disagrees with storageSettings")
    rc = doc["rocksdbClassification"]
    want_rc = ROCKS_V1 if not v2 else (ROCKS_PRESENT if doc["rocksdbCurrentPresent"] is True else ROCKS_ABSENT)
    if not (is_str(rc) and rc == want_rc):
        e.append("rocksdbClassification disagrees with v2/rocksdbCurrentPresent")
    if not (is_str(doc["finishUnitCheckpoint"]) and doc["finishUnitCheckpoint"] in FINISH_UNITS):
        e.append("finishUnitCheckpoint: not an accepted r11 value")
    mp = doc["merkleExecuteProgressBytes"]
    if not (mp is None or (type(mp) is int and mp == 0)):
        e.append("merkleExecuteProgressBytes: not null or 0 (r11 refuses non-empty)")
    fin, cps = doc["finish"], doc["checkpoints"]
    if not is_int(fin):
        e.append("finish: not a u64 int")
    if type(cps) is not dict or not all(is_str(k) and is_int(v) for k, v in cps.items()):
        e.append("checkpoints: not {str: u64 int}")
        cps = {}
    elif is_int(fin) and cps.get("Finish") != fin:
        e.append("checkpoints.Finish != finish")
    hic = doc["historyIndexCheckpoints"]
    if exact_keys(hic, frozenset(INDEX_STAGES), "historyIndexCheckpoints", e):
        for s in INDEX_STAGES:
            if not (hic[s] is None or is_int(hic[s])) or hic[s] != cps.get(s):
                e.append(f"historyIndexCheckpoints.{s} disagrees with checkpoints")
        if v2 and rc == ROCKS_ABSENT and not all(type(hic[s]) is int and hic[s] == 0 for s in INDEX_STAGES):
            e.append("ABSENT classification without the 3 index checkpoints present and 0")
    if is_bool(doc["checkpointsCoherent"]) and is_int(fin):
        if doc["checkpointsCoherent"] != all(cps.get(s) == fin for s in COHERENT_STAGES):
            e.append("checkpointsCoherent disagrees with checkpoints")
    tip = doc["tipHeader"]
    if exact_keys(tip, TIP_KEYS, "tipHeader", e):
        if not is_int(tip["number"]):
            e.append("tipHeader.number: not a u64 int")
        for k in ("hash", "stateRoot", "parentHash"):
            if not is_hex32(tip[k]):
                e.append(f"tipHeader.{k}: not 0x + 64 lowercase hex")
        if not (tip["withdrawalsRoot"] is None or is_hex32(tip["withdrawalsRoot"])):
            e.append("tipHeader.withdrawalsRoot: not null or 0x + 64 lowercase hex")
        if tip["note"] != TIP_NOTE or not is_str(tip["note"]):
            e.append("tipHeader.note: not the r11 constant")
    sr = doc["stateRoot"]
    if exact_keys(sr, ROOT_KEYS, "stateRoot", e):
        for k in ("computed", "fromHashedOnly", "cachedWalk"):
            if not is_hex32(sr[k]):
                e.append(f"stateRoot.{k}: not 0x + 64 lowercase hex")
        for k in ("matchesHeader", "cachedWalkMatchesHeader", "cachedWalkEqualsFromHashedOnly"):
            if not is_bool(sr[k]):
                e.append(f"stateRoot.{k}: not a bool")
        for k in ("fromHashedOnlySeconds", "cachedWalkSeconds"):
            if not is_int(sr[k]):
                e.append(f"stateRoot.{k}: not a u64 int")
        if sr["note"] != ROOT_NOTE or not is_str(sr["note"]):
            e.append("stateRoot.note: not the r11 constant")
        if sr["computed"] != sr["fromHashedOnly"]:
            e.append("stateRoot.computed != fromHashedOnly (one value in main.rs)")
        if type(tip) is dict and is_hex32(tip.get("stateRoot")) and is_hex32(sr["fromHashedOnly"]) and is_hex32(sr["cachedWalk"]):
            for k, want in (("matchesHeader", sr["fromHashedOnly"] == tip["stateRoot"]),
                            ("cachedWalkMatchesHeader", sr["cachedWalk"] == tip["stateRoot"]),
                            ("cachedWalkEqualsFromHashedOnly", sr["cachedWalk"] == sr["fromHashedOnly"])):
                if is_bool(sr[k]) and sr[k] != want:
                    e.append(f"stateRoot.{k} disagrees with the roots")
    tc = doc["trieCache"]
    if exact_keys(tc, CACHE_KEYS, "trieCache", e):
        for k in ("accountInconsistencies", "storageInconsistencies", "seconds", "accountsTrieEntries", "storagesTrieEntries"):
            if not is_int(tc[k]):
                e.append(f"trieCache.{k}: not a u64 int")
        sm = tc["samplesFirst64"]
        if type(sm) is not list or len(sm) > 64 or not all(is_str(x) for x in sm):
            e.append("trieCache.samplesFirst64: not a list of <= 64 strings")
        if tc["method"] != CACHE_METHOD or not is_str(tc["method"]):
            e.append("trieCache.method: not the r11 constant")
        if is_int(tc["accountInconsistencies"]) and is_int(tc["storageInconsistencies"]):
            n = tc["accountInconsistencies"] + tc["storageInconsistencies"]
            if tc["status"] != ("PASS" if n == 0 else "FAIL") or not is_str(tc["status"]):
                e.append("trieCache.status disagrees with the inconsistency counts")
            if type(sm) is list and len(sm) != min(n, 64):
                e.append("trieCache.samplesFirst64 length != min(inconsistencies, 64)")
    pv = doc["plainVsHashed"]
    st = pv.get("status") if type(pv) is dict else None
    if type(pv) is not dict:
        e.append("plainVsHashed: not an object")
    elif st == "NOT_RUN":
        exact_keys(pv, frozenset({"status"}), "plainVsHashed", e)
    elif st == "NOT_APPLICABLE_V2":
        if not v2:
            e.append("plainVsHashed NOT_APPLICABLE_V2 on a non-v2 report")
        if exact_keys(pv, PLAIN_V2_KEYS, "plainVsHashed", e):
            if pv["why"] != V2_WHY or not is_str(pv["why"]):
                e.append("plainVsHashed.why: not the r11 constant")
            for k in ("plainAccountsEntries", "plainStorageEntries"):
                if not is_int(pv[k]):                                  # root 1868/1872: nonnegative ints, NOT required zero
                    e.append(f"plainVsHashed.{k}: not a nonnegative u64 int")
    elif st in ("PASS", "FAIL"):
        if v2:
            e.append("plainVsHashed PASS/FAIL on a v2 report")
        if exact_keys(pv, PLAIN_V1_KEYS, "plainVsHashed", e):
            ints = ("plainAccounts", "hashedAccounts", "accountMismatches", "plainSlots", "hashedSlots", "slotMismatches",
                    "zeroValuedPlainSlots", "seconds")
            if not all(is_int(pv[k]) for k in ints):
                e.append("plainVsHashed: counts not u64 ints")
            elif st != ("PASS" if pv["accountMismatches"] == 0 and pv["slotMismatches"] == 0 and pv["plainAccounts"] == pv["hashedAccounts"]
                        and pv["plainSlots"] == pv["hashedSlots"] and pv["zeroValuedPlainSlots"] == 0 else "FAIL"):
                e.append("plainVsHashed.status disagrees with its counts")
            sm = pv["mismatchSamplesFirst64"]
            ok_sample = lambda s: type(s) is dict and ((s.keys() == {"table", "address"} and s["table"] == "account")
                                                       or (s.keys() == {"table", "address", "slot"} and s["table"] == "storage")) \
                and all(is_str(v) for v in s.values())
            if type(sm) is not list or len(sm) > 64 or not all(ok_sample(s) for s in sm):
                e.append("plainVsHashed.mismatchSamplesFirst64: malformed")
            if pv["method"] != PLAIN_METHOD or not is_str(pv["method"]):
                e.append("plainVsHashed.method: not the r11 constant")
    else:
        e.append("plainVsHashed.status: unknown")
    if not e:
        full = (sr["matchesHeader"] and tc["status"] == "PASS" and sr["cachedWalkEqualsFromHashedOnly"] and doc["checkpointsCoherent"]
                and st == "PASS")
        if doc["fullStateIntegrity"] != full:
            e.append("fullStateIntegrity disagrees with the checks")
    return e


def derived_exit(doc):
    """main.rs: exit 4 if !root_ok || !cache_ok || !cached_consistent || !coherent || plain FAIL; 0 if full; else 5.
    Only meaningful for a schema-valid report."""
    sr, tc, pv = doc["stateRoot"], doc["trieCache"], doc["plainVsHashed"]
    if (not sr["matchesHeader"] or tc["status"] != "PASS" or not sr["cachedWalkEqualsFromHashedOnly"] or not doc["checkpointsCoherent"]
            or pv["status"] == "FAIL"):
        return 4
    return 0 if doc["fullStateIntegrity"] is True else 5


# ---- the PASSING predicate (production v2; separate from schema validity) ----------------------------------------------------------
def production_v2_errors(doc):
    """[] iff a schema-valid report is a passing PARTIAL v2 production result: v2, RocksDB ABSENT (the runner passes an absent path),
    the 3 index checkpoints 0, no frontier/marker/progress, the 5 checkpoints == finish, header number == finish, hashed-only root
    == header stateRoot, cached walk == hashed-only root, trie cache 0/0, plain NOT_APPLICABLE_V2 with nonnegative counts (NOT
    required zero), never full, derived exit 5."""
    e = report_schema_errors(doc)
    if e:
        return ["schema: " + x for x in e]
    tip, sr, tc, pv, fin = doc["tipHeader"], doc["stateRoot"], doc["trieCache"], doc["plainVsHashed"], doc["finish"]
    checks = [
        (doc["storageSettingsPresent"] is True and _v2(doc), "not storage v2"),
        (doc["trieKeyAdapter"] == "PackedKeyAdapter", "not PackedKeyAdapter"),
        (doc["rocksdbCurrentPresent"] is False and doc["rocksdbClassification"] == ROCKS_ABSENT, "RocksDB not ABSENT"),
        (all(doc["historyIndexCheckpoints"][s] == 0 and type(doc["historyIndexCheckpoints"][s]) is int for s in INDEX_STAGES),
         "history-index checkpoints not all 0"),
        (all(type(doc["checkpoints"].get(s)) is int and doc["checkpoints"].get(s) == fin for s in FIVE_STAGES),
         "the 5 checkpoints are not all == finish"),
        (doc["checkpointsCoherent"] is True, "checkpoints not coherent"),
        (tip["number"] == fin, "tipHeader.number != finish"),
        (sr["matchesHeader"] is True and sr["fromHashedOnly"] == tip["stateRoot"] and sr["computed"] == tip["stateRoot"],
         "hashed-only root != header stateRoot"),
        (sr["cachedWalkEqualsFromHashedOnly"] is True and sr["cachedWalk"] == sr["fromHashedOnly"], "cached walk != hashed-only root"),
        (tc["status"] == "PASS" and tc["accountInconsistencies"] == 0 and tc["storageInconsistencies"] == 0 and tc["samplesFirst64"] == [],
         "trie cache inconsistencies"),
        (pv["status"] == "NOT_APPLICABLE_V2", "plain status is not NOT_APPLICABLE_V2"),
        (doc["fullStateIntegrity"] is False, "fullStateIntegrity is not false"),
        (derived_exit(doc) == 5, "derived exit is not 5"),
    ]
    return [msg for ok, msg in checks if not ok]


# ---- classification ---------------------------------------------------------------------------------------------------------------
LIFECYCLE_KEYS = frozenset({"postUseOk", "timedOut", "groupLeftovers", "groupEmpty", "orphansGone", "escapedKilled"})
MEMORY_KEYS = frozenset({"memoryDirty", "countersReadable"})


def lifecycle_errors(lc):
    e = []
    if exact_keys(lc, LIFECYCLE_KEYS, "lifecycle", e):
        for k in ("postUseOk", "timedOut", "groupEmpty", "orphansGone"):
            if not is_bool(lc[k]):
                e.append(f"lifecycle.{k}: not a bool")
        if type(lc["groupLeftovers"]) is not list or not all(is_int(p, 1, 1 << 31) for p in lc["groupLeftovers"]):
            e.append("lifecycle.groupLeftovers: not a list of pids")
        if not is_int(lc["escapedKilled"]):
            e.append("lifecycle.escapedKilled: not an int")
    return e


def memory_errors(m):
    e = []
    if exact_keys(m, MEMORY_KEYS, "memory", e):
        for k in MEMORY_KEYS:
            if not is_bool(m[k]):
                e.append(f"memory.{k}: not a bool")
    return e


def _result(code, reasons, report_valid=None):
    return {"outcome": NAMES[code], "code": code, "reasons": list(reasons), "reportSchemaValid": report_valid, **NOT_AUTHORITY}


def classify_state(lifecycle, child_rc, report_raw, memory):
    """Order (root 1872 #2): lifecycle contract / post-use -> 8; exec faults -> 7; THEN the child rc:
    3 with NO report -> 30 (a refusal writes none); 4 with a schema-valid report whose derived exit is 4 -> 34; 5 with a schema-valid
    report passing the production predicate -> 35; anything else (0, 1, 101, signals, a malformed/missing report) -> 7.
    Memory: dirty or unreadable counters (or a malformed memory record) turn 34/35 into 7 (as r10 memory_classify)."""
    le = lifecycle_errors(lifecycle)
    if le:
        return _result(INCONCLUSIVE, ["lifecycle record malformed"] + le)
    if lifecycle["postUseOk"] is not True:
        return _result(VOID, ["post-use recheck failed"])
    faults = [k for k, bad in (("timedOut", lifecycle["timedOut"] is True), ("groupLeftovers", lifecycle["groupLeftovers"] != []),
                               ("groupNotEmpty", lifecycle["groupEmpty"] is not True), ("orphansLeft", lifecycle["orphansGone"] is not True),
                               ("escapedKilled", lifecycle["escapedKilled"] != 0)) if bad]
    if faults:
        return _result(INCONCLUSIVE, [f"exec lifecycle fault: {faults}"])
    if type(child_rc) is not int:
        return _result(INCONCLUSIVE, [f"child rc {child_rc!r} is not an int"])
    if report_raw is not None and type(report_raw) is not bytes:
        return _result(INCONCLUSIVE, ["report is neither absent (None) nor bytes"])
    if child_rc == 3:
        if report_raw is not None:
            return _result(INCONCLUSIVE, ["child 3 (refused) but a report exists"])
        return _result(STATE_REFUSED, ["helper refused (3): nothing was checked"])
    if child_rc not in (4, 5):
        return _result(INCONCLUSIVE, [f"helper rc {child_rc} is not 3/4/5"])
    if report_raw is None:
        return _result(INCONCLUSIVE, [f"child {child_rc} without a report"])
    try:
        doc = load_json_strict(report_raw)
    except Invalid as ex:
        return _result(INCONCLUSIVE, [f"report not strict JSON: {ex}"], False)
    se = report_schema_errors(doc)
    if se:
        return _result(INCONCLUSIVE, ["report schema invalid"] + se, False)
    if derived_exit(doc) != child_rc:
        return _result(INCONCLUSIVE, [f"report derives exit {derived_exit(doc)} but the child exited {child_rc}"], True)
    if child_rc == 4:
        code, reasons = STATE_FAILED, ["helper reported FAILED state checks (4)"]
    else:
        pe = production_v2_errors(doc)
        if pe:
            return _result(INCONCLUSIVE, ["child 5 report fails the production v2 predicate"] + pe, True)
        code, reasons = STATE_PARTIAL_V2, ["self-consistent PARTIAL v2 state at the report's Finish (NOT canonical)"]
    me = memory_errors(memory)
    if me or memory["memoryDirty"] is not False or memory["countersReadable"] is not True:
        return _result(INCONCLUSIVE, reasons + ["memory counters dirty/unreadable or malformed: not trusted"] + me, True)
    return _result(code, reasons, True)


# ---- final evidence (root 1868 #1) ----------------------------------------------------------------------------------------------------
EVIDENCE_KEYS = frozenset({"format", "runtimeRc", "outcome", "childRc", "lifecycle", "memory", "cleanupComplete", "cancelled", "softStop",
                           "snapshotsOk", "peersUnchanged", "noMountLeft", "noProcessLeft", "report", "provenance"})
EVIDENCE_FORMAT = "state-final-evidence/r1"
REPORT_EV_KEYS = frozenset({"path", "outArg", "sha256", "regularFile", "symlink", "size"})
PROV_KEYS = frozenset({"stageSums", "helperSha256Before", "helperSha256After", "buildReceiptSha256", "positiveReceiptSha256",
                       "fixturesReceiptSha256", "staticFilesBefore", "staticFilesAfter", "rocksdbAbsentBefore", "rocksdbAbsentAfter"})
SF_KEYS = frozenset({"name", "size", "sha256", "dev", "ino", "mtimeNs", "ctimeNs"})
PIN_KEYS = frozenset({"stageSums", "helperSha256", "buildReceiptSha256", "positiveReceiptSha256", "fixturesReceiptSha256", "reportPath",
                      "staticFiles"})
PIN_SF_KEYS = frozenset({"name", "size", "sha256"})


def _sf_list_errors(lst, keys, where, e):
    if type(lst) is not list or not lst:
        e.append(f"{where}: not a non-empty list"); return
    for i, f in enumerate(lst):
        if exact_keys(f, keys, f"{where}[{i}]", e):
            if not is_str(f["name"]) or not f["name"] or "/" in f["name"]:
                e.append(f"{where}[{i}].name: not a plain file name")
            if not is_sha256(f["sha256"]):
                e.append(f"{where}[{i}].sha256: not 64 hex")
            for k in keys - {"name", "sha256"}:
                if not is_int(f[k]):
                    e.append(f"{where}[{i}].{k}: not a u64 int")


def pins_errors(p):
    e = []
    if exact_keys(p, PIN_KEYS, "pins", e):
        for k in ("stageSums", "helperSha256", "buildReceiptSha256", "positiveReceiptSha256", "fixturesReceiptSha256"):
            if not is_sha256(p[k]):
                e.append(f"pins.{k}: not 64 hex")
        if p["stageSums"] != R11_STAGE_SUMS_SHA256:
            e.append("pins.stageSums is not the frozen r11 SUMS")
        if not (is_str(p["reportPath"]) and p["reportPath"].startswith("/") and p["reportPath"].endswith("/state-report.json")):
            e.append("pins.reportPath: not an absolute .../state-report.json")
        _sf_list_errors(p["staticFiles"], PIN_SF_KEYS, "pins.staticFiles", e)
    return e


def final_state_status(runtime_rc, evidence, report_raw, pins):
    """runtime 35 -> 35 ONLY if every typed evidence item and binding holds; otherwise 10. runtime 0 -> 10 (never valid for the
    state runner). Non-int runtime -> 10. Any other nonzero runtime rc is PRESERVED (never usable). Never preserves 35 on missing
    or malformed evidence."""
    def out(final, reasons):
        return {"final": final, "usable": final == STATE_PARTIAL_V2, "reasons": reasons, **NOT_AUTHORITY}
    if type(runtime_rc) is not int:
        return out(FINAL_EVIDENCE_FAILED, [f"runtime rc {runtime_rc!r} is not an int"])
    if runtime_rc == 0:
        return out(FINAL_EVIDENCE_FAILED, ["runtime 0 is never a valid state-runner result"])
    if runtime_rc != STATE_PARTIAL_V2:
        return out(runtime_rc, [f"runtime rc {runtime_rc} preserved (not usable)"])
    e = pins_errors(pins)
    if exact_keys(evidence, EVIDENCE_KEYS, "evidence", e):
        ev = evidence
        e += lifecycle_errors(ev["lifecycle"]) + memory_errors(ev["memory"])
        for k, want in (("format", EVIDENCE_FORMAT), ("outcome", "STATE-PARTIAL-V2")):
            if not (is_str(ev[k]) and ev[k] == want):
                e.append(f"evidence.{k} != {want}")
        if not (type(ev["runtimeRc"]) is int and ev["runtimeRc"] == STATE_PARTIAL_V2):
            e.append("evidence.runtimeRc != 35")
        if not (type(ev["childRc"]) is int and ev["childRc"] == 5):
            e.append("evidence.childRc != 5")
        for k, want in (("cleanupComplete", True), ("cancelled", False), ("softStop", False), ("snapshotsOk", True),
                        ("peersUnchanged", True), ("noMountLeft", True), ("noProcessLeft", True)):
            if ev[k] is not want:
                e.append(f"evidence.{k} is not {want}")
        rp = ev["report"]
        if exact_keys(rp, REPORT_EV_KEYS, "evidence.report", e):
            if type(report_raw) is not bytes:
                e.append("report bytes absent")
            else:
                if not is_sha256(rp["sha256"]) or hashlib.sha256(report_raw).hexdigest() != rp["sha256"]:
                    e.append("report sha256 does not bind the report bytes")
                if not (type(rp["size"]) is int and rp["size"] == len(report_raw) <= MAX_REPORT_BYTES):
                    e.append("report size does not bind the report bytes")
            if rp["regularFile"] is not True or rp["symlink"] is not False:
                e.append("report is not a regular non-symlink file")
            if not (is_str(rp["path"]) and type(pins) is dict and rp["path"] == pins.get("reportPath") and rp["outArg"] == rp["path"]):
                e.append("report path != pinned path != the helper --out argument")
        pv = ev["provenance"]
        if exact_keys(pv, PROV_KEYS, "evidence.provenance", e) and type(pins) is dict:
            for k, pk in (("stageSums", "stageSums"), ("helperSha256Before", "helperSha256"), ("helperSha256After", "helperSha256"),
                          ("buildReceiptSha256", "buildReceiptSha256"), ("positiveReceiptSha256", "positiveReceiptSha256"),
                          ("fixturesReceiptSha256", "fixturesReceiptSha256")):
                if not is_sha256(pv[k]) or pv[k] != pins.get(pk):
                    e.append(f"provenance.{k} != pinned {pk}")
            _sf_list_errors(pv["staticFilesBefore"], SF_KEYS, "provenance.staticFilesBefore", e)
            _sf_list_errors(pv["staticFilesAfter"], SF_KEYS, "provenance.staticFilesAfter", e)
            if pv["staticFilesBefore"] != pv["staticFilesAfter"]:
                e.append("static files changed during the run (identity/ctime/sha)")
            if type(pv["staticFilesBefore"]) is list and type(pins.get("staticFiles")) is list:
                got = [{k: f.get(k) for k in ("name", "size", "sha256")} if type(f) is dict else None for f in pv["staticFilesBefore"]]
                if got != pins["staticFiles"]:
                    e.append("static files != the pinned extraction (name/size/sha256, order)")
            if pv["rocksdbAbsentBefore"] is not True or pv["rocksdbAbsentAfter"] is not True:
                e.append("the RocksDB path was not absent before AND after")
        if not e:
            c = classify_state(ev["lifecycle"], ev["childRc"], report_raw, ev["memory"])
            if c["code"] != STATE_PARTIAL_V2:
                e.append(f"re-classification of the bound evidence is {c['outcome']}: {c['reasons'][:4]}")
    return out(FINAL_EVIDENCE_FAILED, e) if e else out(STATE_PARTIAL_V2, ["35 with complete bound evidence (NOT canonical)"])


# ---- compiled-fixture capture checks (frozen r11 positive.sh / fixtures.sh) ------------------------------------------------------------
POSITIVE_LABELS = ("v1-pass", "v1-pass-noplain", "v1-plain-modified", "v1-hashed-missing", "v1-hashed-extra", "v1-wrong-root",
                   "v1-checkpoint-mismatch", "v2-not-applicable", "v1-no-header", "v2-no-rocksdb", "v1-pass-cached-trie",
                   "v1-cached-trie-account-modified", "v1-cached-trie-storage-modified", "v1-stale-trie-node",
                   "v2-no-rocksdb-index-reset", "v2-no-rocksdb-index-nonzero", "v2-no-rocksdb-index-one-missing", "v2-rocksdb-no-current",
                   "v2-frontier-lt", "v2-frontier-eq", "v2-frontier-gt", "v2-finish-none", "v2-finish-unknown-variant",
                   "v2-merkle-progress-nonempty", "v2-merkle-progress-empty", "v2-unwind-marker")
NEGATIVE_CASES = (("empty-db", "3"), ("no-static-files", "3"), ("relative-path", "3"), ("unknown-arg", "3"), ("out-exists", "3"),
                  ("corrupt-mdbx", "nz"))
IDENTITY_KEYS = frozenset({"stageSums", "scriptSha256", "helperSha256", "mkFixtureSha256", "buildReceiptSha256"})
OUTPUTS_LINE = re.compile(r"## outputs /[^\s]+")
NEG_LINE = re.compile(r"case (?P<n>[a-z0-9-]+) rc=(?P<rc>[0-9]{1,3}) expect=(?P<e>3|nz) unchanged=(?P<u>[yn]) (?P<v>PASS|FAIL)")


def _identity_errors(kind, observed, expected):
    e = []
    if exact_keys(observed, IDENTITY_KEYS, "observed", e) and exact_keys(expected, IDENTITY_KEYS, "expected", e):
        for k in sorted(IDENTITY_KEYS):
            if not is_sha256(expected[k]):
                e.append(f"expected.{k}: not 64 hex")
            elif observed[k] != expected[k]:
                e.append(f"identity {k}: observed != expected")
        if expected["stageSums"] != R11_STAGE_SUMS_SHA256:
            e.append("expected.stageSums is not the frozen r11 SUMS")
        if expected["scriptSha256"] != (R11_POSITIVE_SH_SHA256 if kind == "positive" else R11_FIXTURES_SH_SHA256):
            e.append(f"expected.scriptSha256 is not the frozen r11 {kind} script")
    return e


def check_fixture_capture(kind, captured, rc, timed_out, truncated, observed, expected):
    """Validate ONE caller-captured run of the frozen r11 positive.sh (26 runs) or fixtures.sh (6 cases): exact lines in order, the
    exact end markers, rc 0, no timeout/truncation, and every identity == the caller's expected pins. The result is NOT a receipt and
    authenticates nothing (authenticated=False): only a future trusted wrapper that itself ran and captured the script may turn it
    into one. Synthetic test inputs are parser tests, never compiled-fixture qualification."""
    e = []
    if kind not in ("positive", "fixtures"):
        e.append(f"unknown kind {kind!r}")
    if not (type(rc) is int and rc == 0):
        e.append(f"script rc {rc!r} != 0")
    if timed_out is not False:
        e.append("timed out (or not exactly false)")
    if truncated is not False:
        e.append("capture truncated (or not exactly false)")
    if type(captured) is not bytes:
        e.append("capture is not bytes"); lines = []
    elif len(captured) > MAX_CAPTURE_BYTES:
        e.append("capture exceeds 1 MiB"); lines = []
    else:
        try:
            text = captured.decode("utf-8", errors="strict")
        except UnicodeDecodeError:
            e.append("capture is not UTF-8"); text = ""
        if "\r" in text or (text and not text.endswith("\n")):
            e.append("capture has CR or no final newline")
        lines = text.split("\n")[:-1] if text.endswith("\n") else text.split("\n")
    if kind in ("positive", "fixtures"):
        e += _identity_errors(kind, observed, expected)
    seen = []
    if kind == "positive":
        want = [f"case {l}: PASS" for l in POSITIVE_LABELS] + ["## runs=26 failed=0", None, "## bsro-r11-positive rc=0"]
        cases = [l for l in lines if l.startswith("case ")]
        seen = [l[5:].split(":", 1)[0] for l in cases]
        if any(" FAIL" in l or not l.endswith(": PASS") for l in cases):
            e.append("a case did not PASS")
        dup = sorted({s for s in seen if seen.count(s) > 1})
        if dup:
            e.append(f"duplicate labels {dup}")
        if sorted(set(POSITIVE_LABELS) - set(seen)):
            e.append(f"missing labels {sorted(set(POSITIVE_LABELS) - set(seen))}")
        if sorted(set(seen) - set(POSITIVE_LABELS)):
            e.append(f"unexpected labels {sorted(set(seen) - set(POSITIVE_LABELS))}")
        if len(lines) != len(want) or any((w is None and not OUTPUTS_LINE.fullmatch(l)) or (w is not None and l != w)
                                          for l, w in zip(lines, want)):
            e.append("output is not exactly the 26 PASS lines + '## runs=26 failed=0' + '## outputs <abs>' + "
                     "'## bsro-r11-positive rc=0' in order")
    elif kind == "fixtures":
        ms = [NEG_LINE.fullmatch(l) for l in lines[:-2]]
        seen = [m["n"] if m else None for m in ms]
        if None in seen or len(lines) != len(NEGATIVE_CASES) + 2:
            e.append("output is not exactly 6 case lines + '## fixtures failed=0' + '## bsro-r11-fixtures rc=0'")
        else:
            for m, (n, ex) in zip(ms, NEGATIVE_CASES):
                r = int(m["rc"])
                if m["n"] != n or m["e"] != ex:
                    e.append(f"case order/expectation: got {m['n']}/{m['e']}, want {n}/{ex}")
                if m["u"] != "y" or m["v"] != "PASS":
                    e.append(f"case {m['n']} not unchanged=y PASS")
                if (ex == "3" and r != 3) or (ex == "nz" and (r == 0 or r > 255 or r in (124, 137))):
                    e.append(f"case {m['n']} rc {r} not acceptable (3 / nonzero without timeout)")
            if lines[-2:] != ["## fixtures failed=0", "## bsro-r11-fixtures rc=0"]:
                e.append("end markers are not exactly '## fixtures failed=0' + '## bsro-r11-fixtures rc=0'")
        if len(set(s for s in seen if s)) != len([s for s in seen if s]):
            e.append("duplicate case names")
    return {"format": "bsro-fixture-capture-check/r1", "kind": kind, "outputValid": not e, "reasons": e, "labels": seen,
            "authenticated": False,
            "note": "validates caller-supplied captured output + identities only; NOT a receipt; a synthetic input never qualifies"}
