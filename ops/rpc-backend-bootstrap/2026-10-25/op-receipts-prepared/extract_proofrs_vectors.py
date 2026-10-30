#!/usr/bin/env python3
"""Extract the upstream receipt-root vectors from pinned base v1.5.1 crates/execution/consensus/src/proof.rs (git 5476069f)
into test/fixtures/base-proofrs-vectors.json. Read-only; the roots are UPSTREAM-ASSERTED (base/op-reth tests)."""
import hashlib, json, re, subprocess, sys
REPO = sys.argv[1]
src = subprocess.run(["git", "-C", REPO, "show", "5476069f:crates/execution/consensus/src/proof.rs"], check=True, capture_output=True, text=True).stdout
fn = src[src.index("fn check_optimism_receipt_root()"):src.index("fn check_receipt_root_optimism()")]
cases = [{"name": n, "timestamp": int(t), "root": r} for n, t, r in re.findall(r'\(\s*"(\w+)",\s*([0-9_A-Z]+?|\d+),\s*b256!\("(0x[0-9a-f]{64})"\)', fn.replace("REGOLITH_TIMESTAMP", "1679079600").replace("CANYON_TIMESTAMP", "1699981200"))]
receipts = []
for m in re.finditer(r'BaseReceipt::(Deposit|Eip1559)\(', fn):
    end = fn.find("BaseReceipt::", m.end()); body = fn[m.end(): end if end > 0 else len(fn)]
    logs = []
    for lm in re.finditer(r'address: hex!\("([0-9a-f]{40})"\)\.into\(\),\s*data: LogData::new_unchecked\(\s*vec!\[(.*?)\],\s*(?:Bytes::from_static\(&hex!\(\s*"([0-9a-f]*)"\s*\)\)|(Default::default\(\)|Bytes::new\(\)|Bytes::default\(\)))\s*,?\s*\)', body, re.S):
        logs.append({"address": "0x" + lm.group(1), "topics": re.findall(r'"(0x[0-9a-f]{64})"', lm.group(2)), "data": "0x" + (lm.group(3) or "")})
    if len(logs) != body.count("Log {"):
        sys.exit(f"extractor captured {len(logs)} of {body.count('Log {')} logs in a receipt: refuse to write a partial vector")
    rec = {"type": "0x7e" if m.group(1) == "Deposit" else "0x2", "status": 1 if "status: true" in body else 0,
           "cumulativeGasUsed": int(re.search(r'cumulative_gas_used: (\d+)', body).group(1)), "logs": logs}
    n = re.search(r'deposit_nonce: Some\((\d+)u64\)', body)
    if n: rec["depositNonce"] = int(n.group(1))
    v = re.search(r'deposit_receipt_version: Some\((\d+)', body)
    if v: rec["depositReceiptVersion"] = int(v.group(1))
    receipts.append(rec)
t2930 = src[src.index("fn check_receipt_root_optimism()"):]
v2930 = {"name": "eip2930-fixed-bloom", "receipt": {"type": "0x1", "status": 1, "cumulativeGasUsed": int(re.search(r'cumulative_gas_used: (\d+)', t2930).group(1)),
         "logs": [{"address": "0x" + "00" * 20, "topics": [], "data": "0x"}], "bloom": "0x" + re.search(r'bloom!\(\s*"([0-9a-f]{512})"', t2930).group(1)},
         "root": re.search(r'b256!\("(0x[0-9a-f]{64})"\)', t2930).group(1)}
out = {"source": "base v1.5.1 (git 5476069f) crates/execution/consensus/src/proof.rs", "sourceSha256": hashlib.sha256(src.encode()).hexdigest(),
       "note": "roots asserted by upstream Rust tests (not recomputed by this script)", "regolithTimestamp": 1679079600, "canyonTimestamp": 1699981200,
       "cases": cases, "receipts": receipts, "eip2930": v2930}
assert len(cases) == 3 and len(receipts) >= 4 and all(r["logs"] or r["type"] == "0x7e" for r in receipts), (len(cases), len(receipts))
json.dump(out, open("test/fixtures/base-proofrs-vectors.json", "w"), indent=1)
print(len(cases), "cases,", len(receipts), "receipts,", sum(len(r["logs"]) for r in receipts), "logs; sha", out["sourceSha256"][:16])
