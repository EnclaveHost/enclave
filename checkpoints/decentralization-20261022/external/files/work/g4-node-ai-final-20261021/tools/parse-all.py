#!/usr/bin/env python3
"""PARSE (never run) the cutover script and every inline remote text of root-node-hold.py (with realistic substitutions)
with PowerShell 7.4's parser, locally. A 5.1-only construct would not be caught; this proves syntax, not behaviour."""
import base64, importlib.util, json, pathlib, subprocess, sys, tempfile
H = pathlib.Path(__file__).resolve().parent.parent / "helper"
spec = importlib.util.spec_from_file_location("r", H / "root-node-hold.py"); R = importlib.util.module_from_spec(spec); spec.loader.exec_module(R); R.verify_local()
st = "C:\\ProgramData\\Enclave\\staging\\nodehold-0123456789ab"; run = "20261021t230000z-abcdef"
loader = R.LOADER.replace("PS1X", st + "\\node-hold-cutover.ps1").replace("PSHA", "a" * 64).replace("PFX", st + f"\\params-{run}.json").replace("PFSHA", "b" * 64).replace("MODEX", "cutover")
texts = {"cutover.ps1": (H / "node-hold-cutover.ps1").read_text(), "IDN": R.IDN, "CFGS": R.CFGS, "ACLS": R.ACLS, "COV": R.COV,
         "FIL": R.FIL.replace("TARGETS", ",".join(R.q(v[1]) for v in R.FILES.values())),
         "PUT": R.PUT.replace("TX", R.q("C:\\a")).replace("SX", R.q("C:\\b")).replace("OX", R.q("absent")).replace("NX", R.q("c" * 64)).replace("PX", R.q("C:\\p")),
         "UNPUT": R.UNPUT.replace("TX", R.q("C:\\a")).replace("OX", R.q("c" * 64)).replace("NX", R.q("d" * 64)).replace("PX", R.q("C:\\p")),
         "AGENT": R.AGENT.replace("PIDX", "123").replace("STARTX", R.q("2026-10-21T00:05:03.7361540Z")),
         "LOADER": loader, "LAUNCH": R.LAUNCH.replace("TNX", R.q("node-hold-" + run)).replace("ENCX", base64.b64encode(loader.encode("utf-16-le")).decode()),
         "JOURNAL": R.JOURNAL.replace("JX", R.q(st + "\\x.jsonl")).replace("TNX", R.q("node-hold-" + run)),
         "HEAD": R.m.HEAD.replace("SECS", "120") + "1"}
d = pathlib.Path(tempfile.mkdtemp()); out = {}
for k, t in texts.items():
    f = d / (k + ".ps1"); f.write_text(t)
    r = subprocess.run([str(pathlib.Path(__file__).parent / "pwsh/pwsh"), "-NoProfile", "-NonInteractive", "-Command",
        f"$e=$null;$null=[System.Management.Automation.Language.Parser]::ParseFile('{f}',[ref]$null,[ref]$e);@($e|ForEach-Object{{$_.Extent.StartLineNumber.ToString()+':'+$_.Message}})|ConvertTo-Json -Compress"],
        capture_output=True, text=True, timeout=120)
    out[k] = r.stdout.strip() or r.stderr.strip()[-300:]
print(json.dumps(out, indent=1))
sys.exit(0 if all(v in ("", "[]", "null") for v in out.values()) else 1)
