#!/usr/bin/env python3
"""public-read.json -> catalog-flags.json in riso-probe 7364c643's --catalog format. Per id: gpuMilli (ledger). For a VERSION
source without a version configCid: the delivered flags (encNonEmpty, volNonEmpty as isolationPlan names them). For envelope
sources: volNonEmpty = the version's `volumes` param non-empty (the evaluator consumes it only when the delivered config is
_media-only). A version source WITH a version configCid is OMITTED (the evaluator would otherwise read an entry as its flags);
it is listed in missingCachedConfigCids for a --version-cids re-probe. Refuses on any provider/probe mismatch."""
import json, pathlib, sys
H = pathlib.Path(__file__).resolve().parent; d = json.loads((H / "public-read.json").read_text())
assert d["contracts"]["ledger"]["ok"] and d["contracts"]["catalog"]["ok"] and d["addressBook"]["matchesTrust"]
flags, missing, owner, notes = {}, [], [], []
for r in d["deployments"]:
    i, e, v = r["id"], r["envelope"], r["version"]
    if not e["matchesRisoRead"]: sys.exit(f"{i}: the ledger envelope source differs from root's native riso-read: root decides")
    if e["src"] == "owner-startup": owner.append(i); continue
    if v.get("error") or v.get("yanked"): notes.append({"id": i, "version": v}); continue
    if e["src"] == "version":
        if v["configCid"]: missing.append({"id": i, "versionConfigCid": v["configCid"]}); continue
        dl = r["delivered"]; flags[i] = {"gpuMilli": r["gpuMilli"], "encNonEmpty": dl["encNonEmpty"], "volNonEmpty": dl["volNonEmptyAsPlanned"]}
        if dl["volNonEmptyAsPlanned"] is None: flags.pop(i); notes.append({"id": i, "why": "version volumes unreadable: plan input unknown"})
    else:
        p = v["volumesParamNonEmpty"]
        flags[i] = {"gpuMilli": r["gpuMilli"], **({"volNonEmpty": p} if p is not None else {})}
(H / "catalog-flags.json").write_text(json.dumps(flags, indent=1, sort_keys=True) + "\n")
(H / "gaps.json").write_text(json.dumps({"missingCachedConfigCids": missing, "ownerStartup": owner, "notes": notes}, indent=1) + "\n")
print(json.dumps({"flags": len(flags), "missingCachedConfigCids": missing, "ownerStartup": owner, "notes": notes}))
