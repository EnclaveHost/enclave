    if o.cmd_fixture:     # platform-carrier: cmd.exe's own parse of the carrier line (throwaway files in the stage only)
        t = cmdfix_text(stage); pt = parse_text(t)
        pr = m.ps(pt, 60)
        if not parsed_ok(pr, t): print("REFUSED: the host's PowerShell did not parse the fixture text cleanly; NOT executed"); return 3
        r = m.ps(t, 60); want = "ENCLAVE_PLATFORM_HOST_POLICY_CARRIERS=" + CARRIERS
        ok = isinstance(r, dict) and r.get("out") == [want] and r.get("cleaned") is True
        save(f"cmdfix-{ts}.json", {"what": "cmdfix", "at": now(), "parse": pr, "result": r, "expected": want, "ok": ok}); print(json.dumps({"ok": ok, "out": r.get("out")}, indent=1))
        return 0 if ok else 3
