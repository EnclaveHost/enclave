    if o.swap_inspect or o.swap_bundle or o.swap_back:     # platform-carrier D1 (root only; inspect is read-only apart from its private dir)
        v = st.get("verify") or {}
        if v.get(stage + "\\bundle-swap.ps1") != SWAP[1] or v.get(stage + "\\" + CAND_NAME) != BUNDLE_SHA:
            raise SystemExit("--stage-receipt: that stage does not hold bundle-swap.ps1 21d85c69 and the candidate bundle: --stage anew")
        mode = "inspect" if o.swap_inspect else "apply" if o.swap_bundle else "rollback"; p = swap_params(stage, mode)
        if mode != "inspect" and not attempt(f"attempt-swap-{mode}-{stage.rsplit('-', 1)[-1]}.json", {"params": p}): return 4
        r = H.run_script(stage, "bundle-swap.ps1", p, 150); save(f"swap-{mode}-{ts}.json", {"what": "swap", "at": now(), "params": p, "result": r})
        print(json.dumps(r, indent=1)); ok = isinstance(r, dict) and SWAP_OK[mode](str(r.get("decision", "")))
        print("OK" if ok else "NOT OK: root reads the result (observed hashes, journal); never retried automatically"); return 0 if ok else 3
