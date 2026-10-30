#!/usr/bin/env python3
"""state-helper-qualification-stage/r1 tests/test_acceptance.py (PREPARED by Claude 1873; NOT run by Claude). 38 PURE unit tests of
acceptance.py. No process, mount, network, toolchain, production data, part or backup is touched; the only files read are this stage's
acceptance.py and the FROZEN base-state-readonly-stage/r11 SOURCE files (pin and constant cross-checks).

GOLDEN below is a SYNTHETIC report written from the literal json! keys/strings of r11 src/main.rs (lines ~255-285, verify_cache,
the v2 plain arm). It is NOT runtime evidence, NOT a helper output, and qualifies nothing. Every capture below is likewise synthetic:
these are PARSER tests, never compiled-fixture qualification."""
import ast, copy, hashlib, importlib.util, json, unittest
from pathlib import Path

STAGE = Path(__file__).resolve().parent.parent
SPEC = importlib.util.spec_from_file_location("acceptance", STAGE / "acceptance.py")
A = importlib.util.module_from_spec(SPEC); SPEC.loader.exec_module(A)
R11 = STAGE.parent.parent / "base-state-readonly-stage" / "r11"

H_HEADER, H_HASH, H_PARENT, H_WD = "0x" + "11" * 32, "0x" + "22" * 32, "0x" + "33" * 32, "0x" + "44" * 32
FIN = 1000                                                           # synthetic
GOLDEN = {                                                           # SYNTHETIC: literal r11 schema, a passing PARTIAL v2 shape
    "format": "base-state-readonly/r11",
    "acceptance": "NOT A CHAIN ACCEPTANCE: the Finish header is NOT proven canonical here; history tables, receipts, transactions and RocksDB history indices are NOT checked",
    "storageSettings": {"storage_v2": True}, "storageSettingsPresent": True, "trieKeyAdapter": "PackedKeyAdapter",
    "rocksdbCurrentPresent": False, "rocksdbOpened": False,
    "rocksdbClassification": "ABSENT: path absent and the 3 history-index checkpoints are present and 0 (snapshot reset shape); history indices NOT CHECKED",
    "historyIndexCheckpoints": {"TransactionLookup": 0, "IndexAccountHistory": 0, "IndexStorageHistory": 0},
    "historyIndices": "NOT CHECKED (zero index checkpoints only mean the indices are absent; they are NOT a health signal)",
    "unwindMarkerPresent": False, "finishUnitCheckpoint": "none", "finishFrontier": "none", "merkleExecuteProgressBytes": None,
    "checkpoints": {"Era": 0, "Headers": FIN, "Bodies": FIN, "SenderRecovery": FIN, "Execution": FIN, "AccountHashing": FIN,
                    "StorageHashing": FIN, "MerkleExecute": FIN, "TransactionLookup": 0, "IndexAccountHistory": 0,
                    "IndexStorageHistory": 0, "Finish": FIN},
    "finish": FIN, "checkpointsCoherent": True,
    "tipHeader": {"number": FIN, "hash": H_HASH, "stateRoot": H_HEADER, "parentHash": H_PARENT, "withdrawalsRoot": H_WD,
                  "note": "parentHash/withdrawalsRoot are REPORTED only: not verified; the header is NOT proven canonical"},
    "stateRoot": {"computed": H_HEADER, "fromHashedOnly": H_HEADER, "matchesHeader": True, "fromHashedOnlySeconds": 7,
                  "cachedWalk": H_HEADER, "cachedWalkMatchesHeader": True, "cachedWalkEqualsFromHashedOnly": True, "cachedWalkSeconds": 3,
                  "note": "matchesHeader = root recomputed from ALL hashed accounts/storages with no trie table (NoopTrieCursorFactory). cachedWalk reuses stored branch hashes and is DIAGNOSTIC ONLY: it never makes a pass"},
    "trieCache": {"status": "PASS", "accountInconsistencies": 0, "storageInconsistencies": 0, "samplesFirst64": [], "seconds": 9,
                  "accountsTrieEntries": 12, "storagesTrieEntries": 34,
                  "method": "reth_trie::verify::Verifier (repair-trie --dry-run): full recomputation from hashed tables, node-by-node vs the stored trie"},
    "plainVsHashed": {"status": "NOT_APPLICABLE_V2",
                      "why": "storage_v2: plain state is not written (provider.rs write_state_changes); hashed state is canonical",
                      "plainAccountsEntries": 0, "plainStorageEntries": 0},
    "historyIntegrity": "INCOMPLETE: changesets/history indices/receipts/transactions not verified",
    "fullStateIntegrity": False,
    "exitMeaning": "0 FULL (hashed-only root == header + trie cache 0 inconsistencies + cachedWalk consistent + checkpoints + plain->hashed PASS); 5 PARTIAL (plain NOT_RUN/NOT_APPLICABLE: no full state claim); 4 FAILED; 3 refused",
}
LC = {"postUseOk": True, "timedOut": False, "groupLeftovers": [], "groupEmpty": True, "orphansGone": True, "escapedKilled": 0}
MEM = {"memoryDirty": False, "countersReadable": True}


def g(**kw):
    d = copy.deepcopy(GOLDEN)
    for path, v in kw.items():
        cur = d; ks = path.split("__")
        for k in ks[:-1]:
            cur = cur[k]
        cur[ks[-1]] = v
    return d


def raw(d):
    return json.dumps(d).encode()


def failing4():
    """schema-valid, state checks FAIL: header stateRoot differs from the hashed-only root"""
    return g(tipHeader__stateRoot="0x" + "55" * 32, stateRoot__matchesHeader=False, stateRoot__cachedWalkMatchesHeader=False)


def v1_full():
    d = g(storageSettings={"storage_v2": False}, trieKeyAdapter="LegacyKeyAdapter",
          rocksdbClassification="NOT_APPLICABLE_V1: no table is routed to RocksDB (not inspected)", fullStateIntegrity=True)
    for s in ("TransactionLookup", "IndexAccountHistory", "IndexStorageHistory"):
        del d["checkpoints"][s]; d["historyIndexCheckpoints"][s] = None
    d["plainVsHashed"] = {"status": "PASS", "plainAccounts": 3, "hashedAccounts": 3, "accountMismatches": 0, "plainSlots": 4,
                          "hashedSlots": 4, "slotMismatches": 0, "zeroValuedPlainSlots": 0, "mismatchSamplesFirst64": [], "seconds": 1,
                          "method": "every plain entry looked up at keccak256(key) with value equality + equal entry counts (bijection)"}
    return d


SF = [{"name": "static_file_headers_53000000_53499999", "size": 30982072, "sha256": "a" * 64}]
SF_ID = [dict(SF[0], dev=66306, ino=12, mtimeNs=5, ctimeNs=6)]
PINS = {"stageSums": A.R11_STAGE_SUMS_SHA256, "helperSha256": "b" * 64, "buildReceiptSha256": "c" * 64, "positiveReceiptSha256": "d" * 64,
        "fixturesReceiptSha256": "e" * 64, "reportPath": "/vm/x/session/state-report.json", "staticFiles": SF}


def evidence(report_bytes):
    return {"format": "state-final-evidence/r1", "runtimeRc": 35, "outcome": "STATE-PARTIAL-V2", "childRc": 5, "lifecycle": dict(LC),
            "memory": dict(MEM), "cleanupComplete": True, "cancelled": False, "softStop": False, "snapshotsOk": True, "peersUnchanged": True,
            "noMountLeft": True, "noProcessLeft": True,
            "report": {"path": PINS["reportPath"], "outArg": PINS["reportPath"], "sha256": hashlib.sha256(report_bytes).hexdigest(),
                       "regularFile": True, "symlink": False, "size": len(report_bytes)},
            "provenance": {"stageSums": A.R11_STAGE_SUMS_SHA256, "helperSha256Before": "b" * 64, "helperSha256After": "b" * 64,
                           "buildReceiptSha256": "c" * 64, "positiveReceiptSha256": "d" * 64, "fixturesReceiptSha256": "e" * 64,
                           "staticFilesBefore": copy.deepcopy(SF_ID), "staticFilesAfter": copy.deepcopy(SF_ID),
                           "rocksdbAbsentBefore": True, "rocksdbAbsentAfter": True}}


def ident(kind):
    return {"stageSums": A.R11_STAGE_SUMS_SHA256, "scriptSha256": A.R11_POSITIVE_SH_SHA256 if kind == "positive" else A.R11_FIXTURES_SH_SHA256,
            "helperSha256": "1" * 64, "mkFixtureSha256": "2" * 64, "buildReceiptSha256": "3" * 64}


POS = ("".join(f"case {l}: PASS\n" for l in A.POSITIVE_LABELS) + "## runs=26 failed=0\n## outputs /x/runs/positive-a\n"
       "## bsro-r11-positive rc=0\n")
NEG = ("case empty-db rc=3 expect=3 unchanged=y PASS\ncase no-static-files rc=3 expect=3 unchanged=y PASS\n"
       "case relative-path rc=3 expect=3 unchanged=y PASS\ncase unknown-arg rc=3 expect=3 unchanged=y PASS\n"
       "case out-exists rc=3 expect=3 unchanged=y PASS\ncase corrupt-mdbx rc=1 expect=nz unchanged=y PASS\n"
       "## fixtures failed=0\n## bsro-r11-fixtures rc=0\n")


def cap(kind, text, rc=0, to=False, tr=False, obs=None, exp=None):
    return A.check_fixture_capture(kind, text.encode() if type(text) is str else text, rc, to, tr, obs or ident(kind), exp or ident(kind))


class Loader(unittest.TestCase):
    def test_01_duplicate_keys_rejected(self):
        for s in (b'{"a":1,"a":1}', b'{"x":{"b":1,"b":2}}', b'{"x":[{"c":1,"c":1}]}'):
            with self.assertRaises(A.Invalid):
                A.load_json_strict(s)

    def test_02_nonfinite_and_floats_rejected(self):
        for s in (b'{"a":NaN}', b'{"a":Infinity}', b'{"a":-Infinity}', b'{"a":1.0}', b'{"a":1e999}', b'{"a":1e2}'):
            with self.assertRaises(A.Invalid, msg=s):
                A.load_json_strict(s)

    def test_03_malformed_rejected(self):
        for s in (b'\xff{"a":1}', b'\xef\xbb\xbf{"a":1}', b'{"a":1} x', b'[1]', b'', b'"s"', b'{"a":1', b'{' * 100000):
            with self.assertRaises(A.Invalid, msg=s[:20]):
                A.load_json_strict(s)
        with self.assertRaises(A.Invalid):
            A.load_json_strict('{"a":1}')                              # str, not bytes
        with self.assertRaises(A.Invalid):
            A.load_json_strict(b'{"a":"' + b"x" * 64 + b'"}', cap=32)
        self.assertEqual(A.load_json_strict(raw(GOLDEN)), GOLDEN)


class Schema(unittest.TestCase):
    def test_04_golden_valid_and_passing(self):
        self.assertEqual(A.report_schema_errors(copy.deepcopy(GOLDEN)), [])
        self.assertEqual(A.production_v2_errors(copy.deepcopy(GOLDEN)), [])
        self.assertEqual(A.derived_exit(GOLDEN), 5)

    def test_05_each_top_key_missing_or_extra_fails(self):
        for k in GOLDEN:
            d = copy.deepcopy(GOLDEN); del d[k]
            self.assertTrue(A.report_schema_errors(d), k)
        d = g(); d["extra"] = 1
        self.assertTrue(A.report_schema_errors(d))
        self.assertEqual(len(GOLDEN), 24)

    def test_06_nested_keys_missing_or_extra_fail(self):
        for sub in ("tipHeader", "stateRoot", "trieCache", "plainVsHashed", "historyIndexCheckpoints"):
            for k in GOLDEN[sub]:
                d = copy.deepcopy(GOLDEN); del d[sub][k]
                self.assertTrue(A.report_schema_errors(d), f"{sub}.{k}")
            d = copy.deepcopy(GOLDEN); d[sub]["extra"] = 0
            self.assertTrue(A.report_schema_errors(d), f"{sub}+extra")
        self.assertTrue(A.report_schema_errors(g(storageSettings={"storage_v2": True, "x": 1})))
        self.assertTrue(A.report_schema_errors(g(checkpoints={k: v for k, v in GOLDEN["checkpoints"].items() if k != "Finish"})))

    def test_07_bool_is_not_int_and_int_is_not_bool(self):
        bad = [dict(finish=True), dict(tipHeader__number=True), dict(trieCache__accountInconsistencies=False),
               dict(trieCache__seconds=True), dict(plainVsHashed__plainAccountsEntries=True), dict(stateRoot__cachedWalkSeconds=False),
               dict(checkpointsCoherent=1), dict(fullStateIntegrity=0), dict(stateRoot__matchesHeader=1), dict(rocksdbOpened=0),
               dict(unwindMarkerPresent=0), dict(merkleExecuteProgressBytes=False), dict(storageSettings={"storage_v2": 1}),
               dict(storageSettingsPresent=1), dict(rocksdbCurrentPresent=0),
               dict(historyIndexCheckpoints={"TransactionLookup": False, "IndexAccountHistory": 0, "IndexStorageHistory": 0})]
        for kw in bad:
            self.assertTrue(A.report_schema_errors(g(**kw)), kw)
        d = g(); d["checkpoints"]["Execution"] = True
        self.assertTrue(A.report_schema_errors(d))
        self.assertTrue(A.production_v2_errors(g(storageSettings={"storage_v2": 1})))

    def test_08_wrong_types_and_ranges_fail(self):
        for kw in (dict(finish="1000"), dict(finish=-1), dict(finish=1 << 64), dict(tipHeader__hash="0x" + "AB" * 32),
                   dict(tipHeader__hash="0x" + "ab" * 31), dict(tipHeader__parentHash=None), dict(tipHeader__withdrawalsRoot="0x1"),
                   dict(stateRoot__cachedWalk=1), dict(trieCache__samplesFirst64="x"), dict(trieCache__accountsTrieEntries=-3),
                   dict(plainVsHashed__plainStorageEntries="0"), dict(format=1), dict(trieKeyAdapter=None), dict(storageSettings=[]),
                   dict(checkpoints=[]), dict(tipHeader=[])):
            self.assertTrue(A.report_schema_errors(g(**kw)), kw)
        self.assertEqual(A.report_schema_errors(g(tipHeader__withdrawalsRoot=None)), [])     # an absent withdrawals root is valid

    def test_09_constants_must_match(self):
        for k in ("format", "acceptance", "historyIndices", "historyIntegrity", "exitMeaning", "finishFrontier", "tipHeader__note",
                  "stateRoot__note", "trieCache__method", "plainVsHashed__why", "rocksdbClassification", "finishUnitCheckpoint"):
            d = g(); cur = d; ks = k.split("__")
            for x in ks[:-1]:
                cur = cur[x]
            cur[ks[-1]] = cur[ks[-1]] + " "
            self.assertTrue(A.report_schema_errors(d), k)

    def test_10_internal_consistency(self):
        for kw in (dict(stateRoot__matchesHeader=False), dict(stateRoot__cachedWalkEqualsFromHashedOnly=False),
                   dict(stateRoot__cachedWalkMatchesHeader=False), dict(checkpointsCoherent=False), dict(fullStateIntegrity=True),
                   dict(trieCache__status="FAIL"), dict(stateRoot__computed="0x" + "66" * 32), dict(rocksdbCurrentPresent=True),
                   dict(trieKeyAdapter="LegacyKeyAdapter"), dict(storageSettingsPresent=False),
                   dict(trieCache__samplesFirst64=["AccountMissing(..)"]),
                   dict(historyIndexCheckpoints={"TransactionLookup": 0, "IndexAccountHistory": 0, "IndexStorageHistory": 5})):
            self.assertTrue(A.report_schema_errors(g(**kw)), kw)
        d = g(); d["checkpoints"]["Finish"] = FIN + 1
        self.assertTrue(A.report_schema_errors(d))
        d = g(); d["checkpoints"]["IndexStorageHistory"] = 5          # ABSENT requires all three present and 0
        d["historyIndexCheckpoints"]["IndexStorageHistory"] = 5
        self.assertTrue(A.report_schema_errors(d))

    def test_11_nonzero_plain_counts_accepted_when_otherwise_valid(self):
        d = g(plainVsHashed__plainAccountsEntries=5, plainVsHashed__plainStorageEntries=7)  # root 1868/1872: NOT required zero
        self.assertEqual(A.report_schema_errors(d), [])
        self.assertEqual(A.production_v2_errors(d), [])
        self.assertEqual(A.classify_state(LC, 5, raw(d), MEM)["code"], 35)

    def test_12_negative_or_non_int_plain_counts_rejected(self):
        for v in (-1, True, None, "3", 1 << 64):
            self.assertTrue(A.report_schema_errors(g(plainVsHashed__plainAccountsEntries=v)), v)

    def test_13_altered_roots_fail_the_predicate(self):
        d = failing4()
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 4)
        self.assertTrue(A.production_v2_errors(d))
        d = g(stateRoot__cachedWalk="0x" + "77" * 32, stateRoot__cachedWalkMatchesHeader=False, stateRoot__cachedWalkEqualsFromHashedOnly=False)
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 4); self.assertTrue(A.production_v2_errors(d))

    def test_14_altered_checkpoints_fail_the_predicate(self):
        d = g(); d["checkpoints"]["Execution"] = FIN - 1; d["checkpointsCoherent"] = False
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 4); self.assertTrue(A.production_v2_errors(d))
        d = g(tipHeader__number=FIN + 1)                                    # schema-valid, derives 5, but number != finish
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 5)
        self.assertIn("tipHeader.number != finish", A.production_v2_errors(d))
        d = g(); d["checkpoints"]["Headers"] = FIN - 1                      # not one of the 5: still passes
        self.assertEqual(A.production_v2_errors(d), [])

    def test_15_trie_cache_inconsistencies_fail(self):
        d = g(trieCache__status="FAIL", trieCache__storageInconsistencies=2, trieCache__samplesFirst64=["StorageWrong", "StorageMissing"])
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 4); self.assertTrue(A.production_v2_errors(d))

    def test_16_production_specific_shapes(self):
        d = g(rocksdbCurrentPresent=True, rocksdbClassification="PRESENT: a directory with a regular CURRENT file; NOT opened")
        self.assertEqual(A.report_schema_errors(d), []); self.assertIn("RocksDB not ABSENT", A.production_v2_errors(d))
        d = v1_full()
        self.assertEqual(A.report_schema_errors(d), []); self.assertEqual(A.derived_exit(d), 0); self.assertTrue(A.production_v2_errors(d))
        d = g(plainVsHashed={"status": "NOT_RUN"})
        self.assertEqual(A.report_schema_errors(d), []); self.assertTrue(A.production_v2_errors(d))
        self.assertTrue(A.report_schema_errors(g(plainVsHashed={"status": "NOT_APPLICABLE"})))       # the old typo is not a status
        self.assertEqual(A.production_v2_errors(g(finishUnitCheckpoint="Finish(partial_state_trie: None)")), [])
        self.assertEqual(A.production_v2_errors(g(merkleExecuteProgressBytes=0)), [])

    def test_17_frontier_marker_progress_values_rejected(self):
        for kw in (dict(finishFrontier="1"), dict(unwindMarkerPresent=True), dict(merkleExecuteProgressBytes=3),
                   dict(finishUnitCheckpoint="Finish(partial_state_trie: Some(1))")):
            self.assertTrue(A.report_schema_errors(g(**kw)), kw)


class Classify(unittest.TestCase):
    def test_18_rc3_without_report_is_30(self):
        r = A.classify_state(LC, 3, None, MEM)
        self.assertEqual((r["code"], r["outcome"], r["canonical"], r["resetAuthority"]), (30, "STATE-REFUSED", False, False))
        self.assertEqual(A.classify_state(LC, 3, None, {"memoryDirty": True, "countersReadable": False})["code"], 30)

    def test_19_rc3_with_a_report_is_7(self):
        self.assertEqual(A.classify_state(LC, 3, raw(GOLDEN), MEM)["code"], 7)

    def test_20_rc4_valid_failing_report_is_34(self):
        r = A.classify_state(LC, 4, raw(failing4()), MEM)
        self.assertEqual((r["code"], r["reportSchemaValid"], r["canonical"]), (34, True, False))

    def test_21_rc4_missing_malformed_or_inconsistent_is_7(self):
        for rep in (None, b"not json", raw(g(format="x")), raw(GOLDEN), b'{"a":1,"a":2}'):    # GOLDEN derives 5, not 4
            self.assertEqual(A.classify_state(LC, 4, rep, MEM)["code"], 7, rep[:30] if rep else rep)

    def test_22_rc5_full_passing_predicate_is_35_not_canonical(self):
        r = A.classify_state(LC, 5, raw(GOLDEN), MEM)
        self.assertEqual((r["code"], r["outcome"], r["canonical"], r["resetAuthority"]), (35, "STATE-PARTIAL-V2", False, False))

    def test_23_rc5_predicate_failures_are_7(self):
        for d in (failing4(), g(tipHeader__number=FIN + 1), v1_full(), g(plainVsHashed={"status": "NOT_RUN"}),
                  g(rocksdbCurrentPresent=True, rocksdbClassification="PRESENT: a directory with a regular CURRENT file; NOT opened")):
            self.assertEqual(A.classify_state(LC, 5, raw(d), MEM)["code"], 7)
        self.assertEqual(A.classify_state(LC, 5, None, MEM)["code"], 7)

    def test_24_other_child_codes_are_7(self):
        for rc in (0, 1, 2, 6, 101, -9, 124, 137, True, False, None, "5", 5.0):
            self.assertEqual(A.classify_state(LC, rc, raw(GOLDEN), MEM)["code"], 7, rc)
        self.assertEqual(A.classify_state(LC, 0, raw(v1_full()), MEM)["code"], 7)

    def test_25_post_use_false_is_8_before_anything(self):
        lc = dict(LC, postUseOk=False)
        for rc, rep in ((5, raw(GOLDEN)), (3, None), (4, raw(failing4())), (1, None)):
            self.assertEqual(A.classify_state(lc, rc, rep, MEM)["code"], 8)

    def test_26_lifecycle_faults_and_malformed_lifecycle_are_7(self):
        for kw in (dict(timedOut=True), dict(groupLeftovers=[123]), dict(groupEmpty=False), dict(orphansGone=False), dict(escapedKilled=1)):
            for rc, rep in ((5, raw(GOLDEN)), (3, None), (4, raw(failing4()))):
                self.assertEqual(A.classify_state(dict(LC, **kw), rc, rep, MEM)["code"], 7, kw)
        for lc in ({k: v for k, v in LC.items() if k != "timedOut"}, dict(LC, extra=1), dict(LC, timedOut=0), dict(LC, postUseOk=1),
                   dict(LC, escapedKilled=False), dict(LC, groupLeftovers=[True]), None, []):
            self.assertEqual(A.classify_state(lc, 5, raw(GOLDEN), MEM)["code"], 7, lc)

    def test_27_memory_dirty_or_unreadable_downgrades_34_and_35(self):
        for m in ({"memoryDirty": True, "countersReadable": True}, {"memoryDirty": False, "countersReadable": False},
                  {"memoryDirty": 0, "countersReadable": True}, {"memoryDirty": False}, None):
            self.assertEqual(A.classify_state(LC, 5, raw(GOLDEN), m)["code"], 7, m)
            self.assertEqual(A.classify_state(LC, 4, raw(failing4()), m)["code"], 7, m)


class Final(unittest.TestCase):
    def test_28_35_with_complete_bound_evidence_stays_35(self):
        rb = raw(GOLDEN)
        r = A.final_state_status(35, evidence(rb), rb, copy.deepcopy(PINS))
        self.assertEqual((r["final"], r["usable"], r["canonical"], r["resetAuthority"]), (35, True, False, False), r["reasons"])

    def test_29_35_with_any_evidence_fault_is_10(self):
        rb = raw(GOLDEN)
        muts = []
        for k in A.EVIDENCE_KEYS:
            muts.append(lambda e, k=k: e.pop(k))
        for k, v in (("cleanupComplete", False), ("cancelled", True), ("softStop", True), ("snapshotsOk", False), ("peersUnchanged", False),
                     ("noMountLeft", False), ("noProcessLeft", False), ("cleanupComplete", 1), ("runtimeRc", 34), ("childRc", 4),
                     ("outcome", "STATE-FAILED"), ("format", "x")):
            muts.append(lambda e, k=k, v=v: e.__setitem__(k, v))
        muts += [lambda e: e["memory"].__setitem__("memoryDirty", True), lambda e: e["lifecycle"].__setitem__("orphansGone", False),
                 lambda e: e["lifecycle"].__setitem__("postUseOk", False), lambda e: e.__setitem__("extra", 1),
                 lambda e: e["report"].__setitem__("sha256", "0" * 64), lambda e: e["report"].__setitem__("size", 1),
                 lambda e: e["report"].__setitem__("path", "/vm/y/session/state-report.json"),
                 lambda e: e["report"].__setitem__("outArg", "/tmp/other.json"), lambda e: e["report"].__setitem__("symlink", True),
                 lambda e: e["report"].__setitem__("regularFile", False), lambda e: e["provenance"].__setitem__("helperSha256After", "f" * 64),
                 lambda e: e["provenance"].__setitem__("stageSums", "f" * 64),
                 lambda e: e["provenance"].__setitem__("buildReceiptSha256", "f" * 64),
                 lambda e: e["provenance"]["staticFilesAfter"][0].__setitem__("ctimeNs", 7),
                 lambda e: [f.__setitem__("sha256", "f" * 64) for f in e["provenance"]["staticFilesBefore"] + e["provenance"]["staticFilesAfter"]],
                 lambda e: e["provenance"].__setitem__("rocksdbAbsentAfter", False), lambda e: e["provenance"].__setitem__("staticFilesAfter", [])]
        for i, m in enumerate(muts):
            ev = evidence(rb); m(ev)
            self.assertEqual(A.final_state_status(35, ev, rb, copy.deepcopy(PINS))["final"], 10, i)
        self.assertEqual(A.final_state_status(35, evidence(rb), None, copy.deepcopy(PINS))["final"], 10)
        bad = raw(failing4())                                                # a report that does not re-classify to 35
        self.assertEqual(A.final_state_status(35, evidence(bad), bad, copy.deepcopy(PINS))["final"], 10)
        self.assertEqual(A.final_state_status(35, evidence(rb), rb + b" ", copy.deepcopy(PINS))["final"], 10)

    def test_30_runtime_0_and_non_int_are_10_others_preserved(self):
        rb = raw(GOLDEN)
        for rc in (0, True, None, "35", 35.0):
            self.assertEqual(A.final_state_status(rc, evidence(rb), rb, copy.deepcopy(PINS))["final"], 10, rc)
        for rc in (30, 34, 7, 8, 3, 4, 5, 124, 137):
            r = A.final_state_status(rc, {}, None, {})
            self.assertEqual((r["final"], r["usable"]), (rc, False))

    def test_31_bad_pins_are_10(self):
        rb = raw(GOLDEN)
        for p in (dict(PINS, stageSums="f" * 64), {k: v for k, v in PINS.items() if k != "reportPath"}, dict(PINS, reportPath="rel.json"),
                  dict(PINS, staticFiles=[]), None):
            self.assertEqual(A.final_state_status(35, evidence(rb), rb, copy.deepcopy(p))["final"], 10)


class FixtureCapture(unittest.TestCase):
    def test_32_exact_positive_capture_is_output_valid_but_unauthenticated(self):
        r = cap("positive", POS)
        self.assertTrue(r["outputValid"], r["reasons"]); self.assertIs(r["authenticated"], False)
        self.assertEqual(r["labels"], list(A.POSITIVE_LABELS)); self.assertEqual(len(A.POSITIVE_LABELS), 26)

    def test_33_positive_faults(self):
        L = POS.splitlines(keepends=True)
        variants = [
            "".join(L[1:]),                                                                   # missing
            L[0] + "".join(L),                                                                # duplicate
            "".join(L[:26]) + "case v9-extra: PASS\n" + "".join(L[26:]),                      # extra label
            POS.replace("case v1-wrong-root: PASS", "case v1-wrong-root: FAIL rc 3 != 4"),    # failed
            POS.replace("case v1-pass: PASS", "case v1-pass: mk_fixture failed"),
            POS.replace("## runs=26 failed=0", "## runs=26 failed=1"),
            POS.replace("rc=0", "rc=1"), POS.replace("\n", "\r\n"), POS[:-1], "noise\n" + POS,
            "".join([L[1], L[0]] + L[2:]),                                                    # order
            POS.replace("## outputs /x/runs/positive-a", "## outputs runs/positive-a"), "",
        ]
        for i, t in enumerate(variants):
            self.assertFalse(cap("positive", t)["outputValid"], i)
        for kw in (dict(rc=1), dict(rc=True), dict(to=True), dict(tr=True), dict(to=None)):
            self.assertFalse(cap("positive", POS, **kw)["outputValid"], kw)
        self.assertFalse(cap("positive", POS.encode() * 2000)["outputValid"])              # > 1 MiB
        self.assertFalse(cap("other", POS)["outputValid"])

    def test_34_exact_negative_capture_is_output_valid(self):
        r = cap("fixtures", NEG)
        self.assertTrue(r["outputValid"], r["reasons"]); self.assertIs(r["authenticated"], False)
        self.assertEqual(r["labels"], [n for n, _ in A.NEGATIVE_CASES])

    def test_35_negative_faults(self):
        L = NEG.splitlines(keepends=True)
        variants = [NEG.replace("corrupt-mdbx rc=1", "corrupt-mdbx rc=124"), NEG.replace("corrupt-mdbx rc=1", "corrupt-mdbx rc=0"),
                    NEG.replace("corrupt-mdbx rc=1", "corrupt-mdbx rc=137"), NEG.replace("empty-db rc=3", "empty-db rc=4"),
                    NEG.replace("relative-path rc=3 expect=3 unchanged=y", "relative-path rc=3 expect=3 unchanged=n"),
                    NEG.replace("unknown-arg rc=3 expect=3 unchanged=y PASS", "unknown-arg rc=3 expect=3 unchanged=y FAIL"),
                    "".join(L[1:]), L[0] + "".join(L), "".join([L[1], L[0]] + L[2:]), NEG.replace("failed=0", "failed=1"),
                    NEG.replace("bsro-r11-fixtures rc=0", "bsro-r11-fixtures rc=1"), NEG + "extra\n",
                    NEG.replace("out-exists rc=3 expect=3", "out-exists rc=3 expect=nz")]
        for i, t in enumerate(variants):
            self.assertFalse(cap("fixtures", t)["outputValid"], i)
        self.assertFalse(cap("fixtures", NEG, rc=1)["outputValid"])

    def test_36_identities_must_equal_pins(self):
        for k in sorted(A.IDENTITY_KEYS):
            obs = dict(ident("positive")); obs[k] = "9" * 64
            self.assertFalse(cap("positive", POS, obs=obs)["outputValid"], k)
        self.assertFalse(cap("positive", POS, obs=dict(ident("positive"), stageSums="9" * 64),
                             exp=dict(ident("positive"), stageSums="9" * 64))["outputValid"])   # expected must be the r11 SUMS
        self.assertFalse(cap("fixtures", NEG, obs=ident("positive"), exp=ident("positive"))["outputValid"])  # wrong script for kind
        self.assertFalse(cap("positive", POS, obs={k: v for k, v in ident("positive").items() if k != "helperSha256"})["outputValid"])


class Source(unittest.TestCase):
    def test_37_pins_and_constants_match_the_frozen_r11_source(self):
        sums = (R11 / "SHA256SUMS").read_bytes()
        self.assertEqual(hashlib.sha256(sums).hexdigest(), A.R11_STAGE_SUMS_SHA256)
        listed = dict(reversed(l.split("  ", 1)) for l in sums.decode().splitlines())
        for rel, pin in (("src/main.rs", A.R11_MAIN_RS_SHA256), ("jobs/positive.sh", A.R11_POSITIVE_SH_SHA256),
                         ("jobs/fixtures.sh", A.R11_FIXTURES_SH_SHA256)):
            self.assertEqual(listed[rel], pin, rel); self.assertEqual(hashlib.sha256((R11 / rel).read_bytes()).hexdigest(), pin, rel)
        main = (R11 / "src/main.rs").read_text()
        for c in (A.FORMAT, A.ACCEPTANCE, A.HISTORY_INDICES, A.HISTORY_INTEGRITY, A.EXIT_MEANING, A.TIP_NOTE, A.ROOT_NOTE, A.CACHE_METHOD,
                  A.PLAIN_METHOD, A.V2_WHY, A.ROCKS_V1, A.ROCKS_PRESENT, A.ROCKS_ABSENT, *A.FINISH_UNITS, "NOT_APPLICABLE_V2",
                  "PackedKeyAdapter", "LegacyKeyAdapter"):
            self.assertIn(f'"{c}"', main, c[:40])
        for k in A.TOP_KEYS | A.TIP_KEYS | A.ROOT_KEYS | A.CACHE_KEYS | A.PLAIN_V2_KEYS | A.PLAIN_V1_KEYS:
            self.assertIn(f'"{k}":', main, k)
        for s in A.INDEX_STAGES + A.FIVE_STAGES:                       # StageId variants used by main.rs (Display = the name)
            self.assertIn(f"StageId::{s}", main, s)
        pos = (R11 / "jobs/positive.sh").read_text()
        self.assertEqual(tuple(l.split()[1] for l in pos.splitlines() if l.startswith("one ")), A.POSITIVE_LABELS)
        self.assertIn('echo "## runs=26 failed=$fails"', pos); self.assertIn("## bsro-r11-positive rc=", pos)
        fx = (R11 / "jobs/fixtures.sh").read_text()
        self.assertEqual(tuple((l.split()[1], l.split()[2]) for l in fx.splitlines() if l.startswith("run ")), A.NEGATIVE_CASES)
        self.assertIn('echo "case $n rc=$r expect=$e unchanged=', fx); self.assertIn("## bsro-r11-fixtures rc=", fx)

    def test_38_module_is_pure(self):
        tree = ast.parse((STAGE / "acceptance.py").read_text())
        imports = {a.name for n in ast.walk(tree) if isinstance(n, ast.Import) for a in n.names}
        imports |= {n.module for n in ast.walk(tree) if isinstance(n, ast.ImportFrom)}
        self.assertEqual(imports, {"hashlib", "json", "re"})
        names = {n.id for n in ast.walk(tree) if isinstance(n, ast.Name)} | {n.attr for n in ast.walk(tree) if isinstance(n, ast.Attribute)}
        for forbidden in ("open", "os", "subprocess", "system", "popen", "exec", "eval", "__import__", "socket", "Path"):
            self.assertNotIn(forbidden, names, forbidden)


if __name__ == "__main__":
    unittest.main()
