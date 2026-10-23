#!/usr/bin/env python3
"""Review the exact successful attempt, preserve non-secret evidence, remove its remote staging copy."""
import contextlib
import importlib.util
import io
import json
from datetime import datetime, timezone
from pathlib import Path
from types import SimpleNamespace

base = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("whole_restore", base / "whole_restore.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
args = SimpleNamespace(run="work/private/sia-whole-restore-vm/20261023T032514Z-fccd01cf",
                       attempt="001-fa7094", abandon=False)
attempt, handle = module.attempt_handle(args)
assert handle["unit"] == "sia-whole-restore-fccd01cf-001", "unexpected unit"
state, observed = module.status(handle)
assert state == "succeeded", state
result = observed["result"]
restore = result["restore"]
assert result["success"] is True and result["restoreExit"] == 0
assert result["binarySha256"] == "3ef760ede4e46b5a944f429a78706b0822900434246bd8a24aeb22ceaba388aa"
assert result["originalSnapshotUnchanged"] is True and result["bridge"]["ok"] is True
assert result["probes"] == {"allowedReached": 2, "allowedTried": 2, "blocked": 33,
                             "blockedTried": 33, "isolated": True, "namesResolved": 0, "namesTried": 6}
assert restore["complete"] is True
assert restore["keys"] == restore["restored"] == restore["onDiskFiles"] == 1488
assert restore["restoredBytes"] == restore["totalBytes"] == restore["onDiskBytes"] == 21445494044
assert all(restore[k] == 0 for k in ("failed", "notAttempted", "expectedButAbsent", "onDiskMismatches"))
assert restore["indexerUsed"] is False and restore["writesToSia"] is False
assert restore["etagChecks"] == {"md5": 1487, "multipart-md5": 1}
assert restore["independentSha256"] == {"not-provided": 1488}
receipt = {
    "reviewedAt": datetime.now(timezone.utc).isoformat(),
    "unit": handle["unit"], "attempt": attempt.name, "state": state,
    "sourceCommit": "f98786e90e83c66da6f593315faea83e717caeed",
    "runnerSha256": "6d2438580b14b1b2beb29ee0b6cc51d74d9a6a10517296836089d3812dc937f2",
    "result": result,
    "limitations": [
        "Completeness applies to the frozen recovery snapshot identified by its digest, not to live writes made after that snapshot.",
        "Read-only recovery on the same physical host as indexd; not physical-host-loss proof.",
        "ETags checked for all objects and restored bytes rehashed against the restore inventory; no independently supplied SHA-256 digests existed for these objects.",
        "Does not prove decentralized write/indexer failover or future fresh-state availability.",
        "Bridge transient retries occurred; the final complete inventory, successful exit and ended bridge threads establish this run's result."
    ]
}
output = Path("outputs/decentralization-audit/storage-whole-recovery-final-20261023.json")
with output.open("x") as stream:
    json.dump(receipt, stream, indent=2)
    stream.write("\n")
captured = io.StringIO()
with contextlib.redirect_stdout(captured):
    code = module.finish(args)
cleanup = json.loads(captured.getvalue())
receipt["cleanup"] = cleanup
receipt["cleanupExitCode"] = code
with output.open("w") as stream:
    json.dump(receipt, stream, indent=2)
    stream.write("\n")
assert code == 0 and cleanup["stagingRemoved"] is True and cleanup["restoredDataKept"] is True, "cleanup not confirmed"
print(json.dumps({"state": state, "files": restore["restored"], "bytes": restore["restoredBytes"],
                  "cleanup": cleanup, "receipt": str(output)}))
