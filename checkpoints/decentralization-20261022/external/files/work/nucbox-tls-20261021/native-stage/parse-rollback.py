# Parse-only check of the ROLLBACK step texts (root-activate.py --rollback) on minipc: upload, PowerShell 5.1 parse, nothing runs.
import importlib.util, subprocess, tempfile, os, json
spec = importlib.util.spec_from_file_location("ra", os.path.join(os.path.dirname(__file__), "..", "root-activate.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
inst, rest = m.step_texts(m.files([]), "rollback")
out = {}
for name, text in (("rollback-install", inst), ("rollback-restart", rest)):
    with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False) as f: f.write(m.HEAD.replace("SECS", "200") + text)
    subprocess.run(["scp", "-q", "-o", "BatchMode=yes", f.name, "minipc:/C:/ProgramData/Enclave/hotfix/nucbox-stopfix-20261021/step-%s.ps1.txt" % name], check=True)
    os.unlink(f.name)
    out[name] = m.ps("$s=[IO.File]::ReadAllText('%s\\step-%s.ps1.txt');$t=$null;$e=$null;[void][System.Management.Automation.Language.Parser]::ParseInput($s,[ref]$t,[ref]$e);"
                     "[ordered]@{chars=$s.Length;parseErrors=@($e|ForEach-Object{$_.Message})}|ConvertTo-Json -Compress" % (m.STAGE, name))
print(json.dumps(out, indent=1))
