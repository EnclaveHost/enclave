#!/usr/bin/env python3
"""ROOT-EXECUTABLE native watchdog probe for the review-fix hs2 helper (harmless; touches only its own processes).
NOT run by Claude (no remote runs allowed to it). Proves on minipc what structural tests cannot: the helper's real session
path (gzip bootstrap -> Invoke-Expression in one process -> watchdog) ends the session AND its descendant tree on timeout.

  python3 watchdog-probe.py          (through the queue: python3 work/claude-test-queue.py --mib 256 --log <abs> -- python3 ...)

Session A (helper ps(), 25 s watchdog): makes C:\\ProgramData\\Enclave\\staging\\hs2-watchdog-probe-<marker>, starts its OWN
  children, each carrying a unique <marker> in its command line - c1 (sleep 600) and c2 (sleep 600) which starts a grandchild
  g (sleep 600) - prints RESULT, then sleeps 120 s, so only the watchdog can end it.
Session B (60 s): counts processes whose command line contains <marker>. PASS = 0, with session A ended in < 60 s.
Session C (only if something survived): Stop-Process ONLY on processes whose command line contains <marker> (no other
  process can carry it), then removes the probe's temp dir. Nothing else is touched: no task, service, port or stage file.
Receipt: watchdog-probe-<UTC>.json. Exit 0 = PASS, 1 = FAIL (see the receipt)."""
import datetime, importlib.util, json, pathlib, secrets, sys, time
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
spec = importlib.util.spec_from_file_location("helper", HERE / "root-hs2-activate.py"); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

marker = "hs2wdprobe" + secrets.token_hex(6)
tmp = r"C:\ProgramData\Enclave\staging\hs2-watchdog-probe-" + marker
A = ("$d='" + tmp + "';New-Item -ItemType Directory -Force -Path $d|Out-Null;"
     "$c1=Start-Process -FilePath powershell.exe -WorkingDirectory $d -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 600 #" + marker + "-c1');"
     "$c2=Start-Process -FilePath powershell.exe -WorkingDirectory $d -WindowStyle Hidden -PassThru -ArgumentList @('-NoProfile','-Command',"
     "\"Start-Process -FilePath powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 600 #" + marker + "-g';Start-Sleep -Seconds 600 #" + marker + "-c2\");"
     "Start-Sleep -Seconds 3;$n=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -like '*" + marker + "*'}).Count;"
     "'RESULT '+(@{spawned=$n;session=$PID;c1=$c1.Id;c2=$c2.Id}|ConvertTo-Json -Compress);[Console]::Out.Flush();Start-Sleep -Seconds 120")
B = ("$s=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -like '*" + marker + "*' -and $_.ProcessId -ne $PID});"
     "'RESULT '+(@{survivors=$s.Count;list=@($s|ForEach-Object {[string]$_.ProcessId+' '+$_.Name})}|ConvertTo-Json -Compress)")
C = ("$s=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -like '*" + marker + "*' -and $_.ProcessId -ne $PID});"
     "foreach($p in $s){try{Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop}catch{}};Start-Sleep -Seconds 2;"
     "Remove-Item -LiteralPath '" + tmp + "' -Recurse -Force -ErrorAction SilentlyContinue;"
     "'RESULT '+(@{cleaned=$s.Count;left=@(Get-CimInstance Win32_Process|Where-Object {$_.CommandLine -like '*" + marker + "*' -and $_.ProcessId -ne $PID}).Count}|ConvertTo-Json -Compress)")
o = {"at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "marker": marker, "helperSha256": m.sha(HERE / "root-hs2-activate.py"),
     "libSha256": m.sha(HERE / "hs2lib.py"), "encodedLengthA": len(m.encoded(A, 25))}
t0 = time.time()
try: rc, outA, _ = m.ps(A, 25); o["A"] = {"rc": rc, "result": outA, "elapsedS": round(time.time() - t0, 1)}
except Exception as e: o["A"] = {"error": f"{type(e).__name__}: {e}"[:200], "elapsedS": round(time.time() - t0, 1)}
time.sleep(10)
try: rc, outB, _ = m.ps(B, 60); o["B"] = {"rc": rc, "result": outB}
except Exception as e: o["B"] = {"error": f"{type(e).__name__}: {e}"[:200]}
surv = (o.get("B", {}).get("result") or {}).get("survivors")
if surv != 0:
    try: rc, outC, _ = m.ps(C, 60); o["C"] = {"rc": rc, "result": outC}
    except Exception as e: o["C"] = {"error": f"{type(e).__name__}: {e}"[:200]}
else:
    try: rc, outC, _ = m.ps("Remove-Item -LiteralPath '" + tmp + "' -Recurse -Force -ErrorAction SilentlyContinue;'RESULT '+(@{removed=-not (Test-Path -LiteralPath '" + tmp + "')}|ConvertTo-Json -Compress)", 60); o["tmpRemoved"] = outC
    except Exception as e: o["tmpRemoved"] = {"error": str(e)[:120]}
spawned = (o.get("A", {}).get("result") or {}).get("spawned")
o["pass"] = spawned == 3 and surv == 0 and o["A"].get("elapsedS", 999) < 60
o["meaning"] = ("PASS: the watchdog ended the session and its 3 marked descendants (c1, c2, grandchild g)" if o["pass"]
                else "FAIL: see A (spawned should be 3; elapsed < 60 s) and B (survivors should be 0); C cleaned only marked processes")
p = HERE / f"watchdog-probe-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}.json"
p.write_text(json.dumps(o, indent=1) + "\n"); print(json.dumps(o, indent=1)); sys.exit(0 if o["pass"] else 1)
