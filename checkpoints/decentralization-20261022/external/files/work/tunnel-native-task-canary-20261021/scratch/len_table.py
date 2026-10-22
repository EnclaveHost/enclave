import importlib.util, base64, sys
s = importlib.util.spec_from_file_location("ti", sys.argv[1]); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
t = importlib.util.spec_from_file_location("t", sys.argv[2]); tm = importlib.util.module_from_spec(t); t.loader.exec_module(tm)
WRAP = ";$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"
got = []; m.ps = lambda script, secs=90: (got.append((script, secs)), {})[1]
h = {"tunnel-receiver.ps1": "a"*64, "params.json": "b"*64}
for n in range(6, 25):
    run = "x"*n; d = m.STAGE_WIN.format(run=run); row = []
    for name, mode, at in (("Guard", "guard", f"(Get-Date).AddMinutes({m.GUARD_MIN})"), ("Apply", "apply", None), ("Rollback", "rollback", None)):
        got.clear(); m.register_task(f"EnclaveTunnel{name}-{run}", mode, d, at, h); sc, secs = got[0]
        row.append(len(base64.b64encode((tm.HEAD.replace("SECS", str(secs)) + sc + WRAP).encode("utf-16-le"))))
    print(n, row, "OVER" if max(row) > 7900 else "")
