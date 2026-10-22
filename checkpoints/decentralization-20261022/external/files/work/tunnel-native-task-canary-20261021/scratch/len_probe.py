# measure the encoded length each controller remote script would have through the reviewed transport (nothing sent)
import importlib.util, base64, sys, pathlib
ctl = sys.argv[1]
s = importlib.util.spec_from_file_location("ti", ctl); m = importlib.util.module_from_spec(s); s.loader.exec_module(m)
t = importlib.util.spec_from_file_location("t", m.WORK / "nucbox-tls-20261021/root-activate-reviewed.py"); tm = importlib.util.module_from_spec(t); t.loader.exec_module(tm)
WRAP = ";$j=$o|ConvertTo-Json -Depth 6 -Compress;@{payload=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($j))}|ConvertTo-Json -Compress"
def enc_len(script, secs=90):
    text = tm.HEAD.replace("SECS", str(secs)) + script + WRAP
    return len(base64.b64encode(text.encode("utf-16-le")).decode())
got = []
m.ps = lambda script, secs=90: (got.append((script, secs)), {})[1]
h = {"tunnel-receiver.ps1": "a"*64, "params.json": "b"*64}
run = "abcdefghijklmnopqrstuvwx"   # 24 = longest RUN
d = m.STAGE_WIN.format(run=run)
for label, fn in [("register guard", lambda: m.register_task(f"EnclaveTunnelGuard-{run}", "guard", d, f"(Get-Date).AddMinutes({m.GUARD_MIN})", h)),
                  ("register apply", lambda: m.register_task(f"EnclaveTunnelApply-{run}", "apply", d, None, h)),
                  ("register rollback", lambda: m.register_task(f"EnclaveTunnelRollback-{run}", "rollback", d, None, h)),
                  ("seal_and_prove", lambda: m.seal_and_prove(d, ["params.json", "tunnel-receiver.ps1"])),
                  ("fresh_proof", lambda: m.fresh_proof(d)), ("write_confirm", lambda: m.write_confirm(d)),
                  ("mkdir_protected", lambda: m.mkdir_protected(d))]:
    got.clear(); fn(); sc, secs = got[0]
    print(f"{label:18s} encoded={enc_len(sc, secs)} limit=7900 {'OVER' if enc_len(sc, secs) > 7900 else 'ok'}")
print("launcher-only task_args len", len(m.task_args(d, "guard", h)))
