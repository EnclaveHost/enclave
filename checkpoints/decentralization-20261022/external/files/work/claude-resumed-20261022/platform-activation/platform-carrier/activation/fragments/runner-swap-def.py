# platform-carrier D1: the host-admission bundle CAS swap through the FROZEN helper's pinned bundle-swap.ps1 (21d85c69: inspect / apply
# with private backup + node --check on the exact bytes + journal / rollback by CAS). Inert for the running agent (module loaded at start).
LIVE_BUNDLE_SHA = "6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18"     # installed now (root postflight F1)
CAND_FILE, CAND_NAME = A.parent / "out/candidate.host-admission.bundle.mjs", "host-admission.bundle.candidate.mjs"
SWAP = H.SCRIPTS["bundle-swap.ps1"]                                                  # (path, 21d85c69...) pinned by the frozen helper
def swap_params(stage, mode):
    p = {"Mode": mode, "Target": BUNDLE, "WorkDir": stage + "\\swap-host-admission", "OldSha": LIVE_BUNDLE_SHA}
    p.update({"ExpectCurrent": BUNDLE_SHA} if mode == "rollback" else {"NewFile": stage + "\\" + CAND_NAME, "NewSha": BUNDLE_SHA})
    return p
SWAP_OK = {"inspect": lambda d: d == "would apply", "apply": lambda d: d.startswith("applied") or d.startswith("noop"), "rollback": lambda d: d == "rolled back"}
