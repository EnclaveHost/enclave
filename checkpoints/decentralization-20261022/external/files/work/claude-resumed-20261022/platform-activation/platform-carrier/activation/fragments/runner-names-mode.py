    if o.names:     # platform-carrier: read-only names inventory (no values)
        r = m.ps(NAMES, 60); rep = names_report(r); save(f"names-{ts}.json", {"what": "names", "at": now(), "result": r, "report": rep})
        print(json.dumps(rep, indent=1)); return 0 if "error" not in rep else 3
