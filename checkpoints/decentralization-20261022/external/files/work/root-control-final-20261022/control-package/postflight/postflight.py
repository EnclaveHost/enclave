#!/usr/bin/env python3
"""POST-CUTOVER SEMANTIC VERIFICATION RECIPE (Claude control-package; prepared source only, NEVER executed by its author).
Frozen target: work/root-control-final-20261022/control-package (helper 613b6f38, cutover 943a5f01, manifest 5094dca0).

The cutover's DONE line is a POINT-IN-TIME proof (privacy status enforcing for THIS runner, the new node's channel generation
applied, every expected id in status.walletAdmission.allows within 240 s, identities/VM sets, channel-file ACL, node.log
retire/spawn/OFF counts). This recipe does NOT repeat it; it reads it from the cutover result receipt and adds what DONE
cannot see:
  W  wallet-host admission keeps working: same node agent + privacy agent as the cutover journaled; the channel is alive
     (revision advances over 25 s, never expires); the network applies the SAME generation; every expected id is granted with
     the EXACT lease binding (appRef + configCid equal to its network expectation; compared remotely, only booleans leave
     the host), unexpired wallet/lease/proof deadlines, an egress route, and a running non-held node record
  A  no admin bypass: the platform host policy gate is ON and ADMITS this host (only an ON gate logs "[host-policy] this host
     is ADMITTED"), no "not serving" since the cutover, no persisted knownRefusal, no ENCLAVE_PLATFORM_HOST_POLICY=off|unset;
     the owner wallet admission is configured (all four ENCLAVE_HOST_* names present) and its channel started (only a host
     with a decision()-capable admission logs "written EMPTY"), never OFF / NOT written
  P  config propagation: after >= 1 enrollment pass (agent start + 420 s), every operator block of enclaveNetwork present at
     P0 (taken immediately before the cutover) is still present byte-for-byte (PowerShell-canonical sha256), walletAdmission
     is exactly {file: <agent dir>\\wallet-admission.json}, no unexplained privacy-agent restart
  H  host services (only if configured): worker = Program Files\\Enclave\\network\\host-service-ingress.mjs c952dce4, node
     reports no INVALID block, the privacy agent logged "host services:" and no "HOST SERVICES REFUSED" since P0
  C  challenge replica (only if configured): "challenge replica serving:" and no not-started/STOPPED/restart-refused since P0
     (DNS hs2 is still old: NOT_CONFIGURED is the expected state now; no 31053 listener is assumed)
Verdicts: PASS | FAIL | UNKNOWN (evidence missing/insufficient: never green) | NOT_CONFIGURED (H/C only; semantic unproven).
Outputs never contain a config value or secret: only booleans, counts, categories, hashes, public paths, ids, pids, times.

  postflight.py texts --stage P --run R --pre        -> P0 marker text (run read-only immediately before the cutover launch)
  postflight.py texts --receipt <cutover-result.json> -> the post texts (after a DONE final; repeat later for persistence)
  postflight.py evaluate --receipt <cutover-result.json> [--p0 p0.json] --post post.json -> verdicts
  run-postflight.py (ROOT ONLY) executes the texts with the pinned transport and saves p0.json / post-*.json.
"""
import argparse, base64, calendar, hashlib, importlib.util, json, pathlib, re, sys, time
W = pathlib.Path(__file__).resolve().parents[3]
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
LIMIT = 7600
PD, PF = r"C:\ProgramData\Enclave", r"C:\Program Files\Enclave"
ID = re.compile(r"^0x[0-9a-f]{64}$")
# the frozen bytes whose semantics this recipe verifies (manifest 5094dca0 + the live network files)
FILES = {"control/windows/node/agent.mjs": "76cac3559713313251a0c0ab618fc31980c750496b6d55d94969d30b32c083a1",
         "control/windows/node/host.mjs": "9634cb40c60b74f92eff8497f687dcaa1ec04a33c21cbd22dc745d773b1da396",
         "control/windows/node/network-enroll.mjs": "a9729786598107e69d24d5163ea8592d114f93a9b6693106a7fa3414c95430d6",
         "control/windows/node/host-admission.bundle.mjs": "6bef372d00a27567e94a11d00f165312f9d715a795519e7a7ad77b4718623b18",
         "control/network/wallet-admission.mjs": "0fa7678f7586388b4725f1432683fa4ab172fd1d57c163d9a63195fbb2f445ee",
         "control/network/host-service-names.mjs": "a46123cbb70ab666f9dfb23b5b545fe76d87658c6bf82c7f7574579d0c65b32c",
         "control/network/host-service-transport.mjs": "de5bb98a2e77ffd90ccf65211f564d9515f667b4cd6d17cbb3644fb2ca454e06",
         "network/privacy-agent.mjs": "cfb69370a00dea147340c64bbd712f118eb8cb825237ac79b3b053b586350801",
         "network/host-service-ingress.mjs": "c952dce4fe007c48c81e1726a743d850dc2f5231204d01466349bfa5ffcc62d3"}
BLOCKS = ["hostServices", "challengeReplica", "hostEgress", "directories", "paceMbps", "serviceWorkerModule"]
ENVN = ["ENCLAVE_HOST_OWNERSHIP", "ENCLAVE_HOST_REGISTRY_PIN", "ENCLAVE_HOST_CATALOG_PIN", "ENCLAVE_HOST_POLICY_DIR", "ENCLAVE_NETWORK_AGENT_DIR"]
NODE_PATS = {"admitted": "[host-policy] this host is ADMITTED", "notServing": "[host-policy] this host is not serving",
             "notServingChange": "[host-policy] this host is NOT serving", "persistFailed": "[host-policy] persisting",
             "channelStarted": "written EMPTY (nothing is admitted on the network", "channelOff": "wallet hold channel OFF",
             "channelNotWritten": "wallet hold channel NOT written", "policyUnavailable": "host wallet policy unavailable",
             "hostServicesInvalid": "HOST SERVICES CONFIG INVALID", "privacyRestart": "restarting the privacy agent on its new network configuration",
             "enrollError": "[network] enrollment: ", "retired": "isolated domain retired", "notKept": "not kept:"}
NET_PATS = {"hostServicesUp": "[privacy] host services: ", "hostServicesRefused": "HOST SERVICES REFUSED",
            "challengeServing": "challenge replica serving:", "challengeNotStarted": "challenge replica not started",
            "challengeStopped": "challenge replica STOPPED", "challengeRestartRefused": "challenge replica restart refused",
            "walletWithheld": "wallet admission withheld"}
q = lambda v: "'" + str(v).replace("'", "''") + "'"
arr = lambda xs: "@(" + ",".join(q(x) for x in xs) + ")"

FN = {"J": r"function ReadJ($p){try{[IO.File]::ReadAllText($p)|ConvertFrom-Json}catch{$null}};",
      "NowMs": r"function NowMs{[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()};",
      "H": r"function HashOf($s){-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes([string]$s))|%{$_.ToString('x2')})};",
      "FS": r"function FileSha2($p){if(Test-Path -LiteralPath $p){(Get-FileHash -Algorithm SHA256 -LiteralPath $p).Hash.ToLower()}else{'absent'}};",
      "Len": r"function LenOf($p){try{(Get-Item -LiteralPath $p).Length}catch{-1}};"}
fn = lambda *n: r"$pd=PDX;$pf=PFX;" + "".join(FN[x] for x in n)
# enclaveNetwork key names + a PowerShell-canonical sha256 of each operator block (same serializer before and after)
BLK = (r"function Blocks{$c=ReadJ (Join-Path $pd 'network/privacy-config.json');$en=$c.enclaveNetwork;$b=[ordered]@{cfgSha=FileSha2 (Join-Path $pd 'network/privacy-config.json');"
       r"present=($null -ne $en);keys=@($(if($en){$en.PSObject.Properties.Name}))};foreach($k in BLOCKSX){$b[$k]=$(if($en -and @($en.PSObject.Properties.Name) -ccontains $k){HashOf ($en.$k|ConvertTo-Json -Compress -Depth 30)}else{'absent'})};"
       r"$w=$en.walletAdmission;$b.walletFile=$(if($w -and (@($w.PSObject.Properties.Name) -join ',') -ceq 'file'){[string]$w.file}elseif($w){'not-exactly-file'}else{'absent'});"
       r"$b.serviceWorker=$(if($en.serviceWorkerModule){[string]$en.serviceWorkerModule}else{'absent'});$b};")
P0 = fn("J", "H", "FS", "Len") + BLK + (r"$o=[ordered]@{what='p0';at=[DateTime]::UtcNow.ToString('o');nodeLog=LenOf (Join-Path $pd 'logs/node.log');networkLog=LenOf (Join-Path $pd 'logs/network.log');"
                     r"blocks=Blocks};$o|ConvertTo-Json -Compress -Depth 6")
# W2/W3: two samples SLEEPX s apart (channel heartbeat 10 s, status 1 s)
CHAN = fn("J", "NowMs") + (r"$R=RX;function DocNow{$d=ReadJ (Join-Path $pd 'network/wallet-admission.json');$n=NowMs;if(!$d){return @{present=$false}};"
               r"[ordered]@{present=$true;version=$d.version;runnerOk=([string]$d.runner -ceq $R);generation=[string]$d.generation;revision=$d.revision;expiresInMs=[int64]$d.expiresAt-$n;allowCount=@($d.allows.PSObject.Properties).Count}};"
               r"function StatNow{$s=ReadJ (Join-Path $pd 'network/state/status.json');$n=NowMs;if(!$s){return @{present=$false}};$w=$s.walletAdmission;"
               r"[ordered]@{present=$true;version=$s.version;ageMs=$n-[int64]$s.updatedAt;wallet=$(if($w){[ordered]@{runnerOk=([string]$w.runner -ceq $R);generation=[string]$w.generation;revision=$w.revision;"
               r"fresh=($w.fresh -eq $true);applied=($w.applied -eq $true);errorNull=($null -eq $w.error);expiresInMs=[int64]$w.expiresAt-$n;allowCount=@($w.allows).Count}}else{$null})}};"
               r"$o=[ordered]@{what='channel';a=[ordered]@{doc=DocNow;status=StatNow}};Start-Sleep -Seconds SLEEPX;$o.b=[ordered]@{doc=DocNow;status=StatNow};$o|ConvertTo-Json -Compress -Depth 6")
# W4 (per id, batched): exact binding compared HERE, only booleans/deltas leave the host
BIND = fn("J", "NowMs") + (r"$ids=IDSX;$d=ReadJ (Join-Path $pd 'network/wallet-admission.json');$s=ReadJ (Join-Path $pd 'network/state/status.json');$c=ReadJ (Join-Path $pd 'network/privacy-config.json');$e=ReadJ (Join-Path $pd 'network/state/egress-routes.json');$n=NowMs;"
               r"$eg=@($(if($e -and $e.apps){$e.apps.PSObject.Properties.Name}));$sa=@($(if($s.walletAdmission){$s.walletAdmission.allows}));"
               r"$o=[ordered]@{what='bind';ids=@(foreach($id in $ids){$x=[ordered]@{id=$id};$a=$(if($d -and $d.allows){$d.allows.$id});$x.docAllow=($null -ne $a);"
               r"if($a){$x.validInMs=[int64]$a.validUntil-$n;$ex=@($c.apps|?{[string]$_.deploymentId -ceq $id});$p=$(if($ex.Count -eq 1){ReadJ ([string]$ex[0].expectedFile)});$x.expectation=($null -ne $p);"
               r"if($p){$x.appRefMatch=([string]$a.appRef -ceq [string]$p.appRef);$x.configCidMatch=([string]$a.configCid -ceq [string]$p.configCid)}};"
               r"$x.statusAllow=($sa -ccontains $id);$ap=@($s.apps|?{[string]$_.deploymentId -ceq $id});$x.statusApp=$ap.Count;"
               r"if($ap.Count -eq 1){$x.walletInMs=[int64]$ap[0].walletUntil-$n;$x.leaseInMs=[int64]$ap[0].leaseUntil-$n;$x.proofInMs=[int64]$ap[0].proofUntil-$n};$x.egress=($eg -ccontains $id);$x})};"
               r"$o|ConvertTo-Json -Compress -Depth 6")
BLOCKS_T = fn("J", "H", "FS") + BLK + (r"$R=RX;$pa=ReadJ (Join-Path $pd 'node/platform-host-admission.json');$o=[ordered]@{what='blocks';blocks=Blocks;"
                      r"platformAdmission=$(if($pa){[ordered]@{present=$true;hostIdOk=([string]$pa.hostId -ceq $R);knownRefusalNull=($null -eq $pa.knownRefusal);knownRefusalStatus=$(if($pa.knownRefusal){[string]$pa.knownRefusal.status}else{$null})}}else{@{present=$false}})};"
                      r"$o|ConvertTo-Json -Compress -Depth 6")
# A1/A2: NAME presence and the CATEGORY of the last assignment only (never a value)
ENV = fn() + (r"function EnvCat($f){$r=[ordered]@{present=(Test-Path -LiteralPath $f)};if(!$r.present){return $r};$t=@([IO.File]::ReadAllLines($f));"
                      r"foreach($k in ENVX){$r[$k]=@($t|?{$_ -match ('^\s*set\s+§?'+$k+'=')}).Count -gt 0};"
                      r"$v=@($t|%{if($_ -match '^\s*set\s+§?ENCLAVE_PLATFORM_HOST_POLICY=([^§]*)§?\s*$'){$matches[1].Trim()}});$v=$(if($v.Count){$v[-1]}else{$null});"
                      r"$r.platformPolicy=$(if($null -eq $v){'unset'}elseif($v -ceq 'production'){'production'}elseif($v -ceq 'off'){'off'}elseif($v.StartsWith('{')){'json'}elseif($v -eq ''){'empty'}else{'other'});"
                      r"$h=@($t|%{if($_ -match '^\s*set\s+§?ENCLAVE_NETWORK_WALLET_HOLD=([^§]*)§?\s*$'){$matches[1].Trim()}});$r.walletHold=$(if($h.Count){$h[-1] -ceq '1'}else{'unset'});$r};"
                      r"$o=[ordered]@{what='env';nodeConfig=EnvCat (Join-Path $pd 'node-config.cmd');local=EnvCat (Join-Path $pd 'node-config.local.cmd');runNode=EnvCat (Join-Path $pd 'run-node.cmd')};"
                      r"$o|ConvertTo-Json -Compress -Depth 6").replace("§", '"')
# W1/F1: ONLY the two journaled PIDs (no process listing), and the frozen file hashes
PROC = fn("FS") + (r"function ProcOf($id,$pat){try{$p=Get-CimInstance Win32_Process -Filter ('ProcessId='+[int]$id) -OperationTimeoutSec 15}catch{return @{error=$true}};if(!$p){return @{alive=$false}};"
                r"[ordered]@{alive=$true;start=$p.CreationDate.ToUniversalTime().ToString('o');match=([string]$p.CommandLine -like $pat)}};"
                r"$o=[ordered]@{what='proc';nowMs=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds();agent=ProcOf AGENTPIDX '*\control\windows\node\agent.mjs*';privacy=ProcOf PRIVPIDX '*privacy-agent.mjs*';files=[ordered]@{}};"
                r"foreach($f in FILESX){$o.files[$f]=FileSha2 (Join-Path $pf $f)};$o|ConvertTo-Json -Compress -Depth 6")
# W4: the node's own records (projected: status, walletHeld, lease delta)
HOST = fn() + (r"$ids=IDSX;try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 10 -Uri 'http://127.0.0.1:9600/v1/host/state';$ns=[DateTimeOffset]::UtcNow.ToUnixTimeSeconds();"
                r"$o=[ordered]@{what='host';answered=$true;heldCount=@($h.deployments|?{$_.walletHeld -eq $true}).Count;ids=@(foreach($id in $ids){$r=@($h.deployments|?{[string]$_.id -ceq $id});"
                r"if($r.Count -eq 1){[ordered]@{id=$id;status=[string]$r[0].status;walletHeld=($r[0].walletHeld -eq $true);leaseInSec=[int64]$r[0].leaseUntil-$ns}}else{[ordered]@{id=$id;records=$r.Count}}})}}catch{$o=@{what='host';answered=$false}};"
                r"$o|ConvertTo-Json -Compress -Depth 6")
LOGS = fn() + (r"function CountIn($p,$off,$pats){$r=[ordered]@{};if($off -lt 0){$r.unbounded=$true;return $r};try{$fs=[IO.File]::Open($p,'Open','Read','ReadWrite,Delete');"
                 r"try{$r.length=$fs.Length;if($fs.Length -lt $off){$r.rotated=$true;return $r};[void]$fs.Seek($off,'Begin');$t=(New-Object IO.StreamReader($fs)).ReadToEnd()}finally{$fs.Close()};"
                 r"foreach($k in $pats.Keys){$r[$k]=([regex]::Matches($t,[regex]::Escape($pats[$k]))).Count}}catch{$r.error='unreadable'};$r};"
                 r"$o=[ordered]@{what='logs';node=CountIn (Join-Path $pd 'logs/node.log') NODEOFFX NODEPATSX;network=CountIn (Join-Path $pd 'logs/network.log') NETOFFX NETPATSX};$o|ConvertTo-Json -Compress -Depth 6")

# NATIVE PARSE ONLY: the exact text travels gzip+base64 and is handed to PowerShell's own parser on the host; it is never run.
# Returns its sha256 (must equal the local text's), its length, and the parser's error count / first ids.
PARSE = (r"$z=[Convert]::FromBase64String('B64X');$ms=New-Object IO.MemoryStream(,$z);$gz=New-Object IO.Compression.GZipStream($ms,[IO.Compression.CompressionMode]::Decompress);"
         r"$sr=New-Object IO.StreamReader($gz,[Text.Encoding]::UTF8);$t=$sr.ReadToEnd();$sr.Close();$tk=$null;$er=$null;$null=[Management.Automation.Language.Parser]::ParseInput($t,[ref]$tk,[ref]$er);"
         r"[ordered]@{what='parse';sha256=(-join([Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($t))|%{$_.ToString('x2')}));chars=$t.Length;"
         r"errors=@($er).Count;ids=@($er|Select-Object -First 3|%{[string]$_.ErrorId})}|ConvertTo-Json -Compress")
def parse_text(text):
    import gzip
    return PARSE.replace("B64X", base64.b64encode(gzip.compress(text.encode("utf-8"), mtime=0)).decode())
def parsed_ok(r, text):
    return isinstance(r, dict) and "error" not in r and r.get("what") == "parse" and r.get("errors") == 0 and r.get("sha256") == hashlib.sha256(text.encode("utf-8")).hexdigest()

def ht(d): return "@{" + ";".join(f"{k}={q(v)}" for k, v in d.items()) + "}"
def fill(t, pd=PD, pf=PF, **kv):
    t = t.replace("PDX", q(pd)).replace("PFX", q(pf)).replace("BLOCKSX", arr(BLOCKS)).replace("ENVX", arr(ENVN)).replace("FILESX", arr(FILES))
    for k, v in kv.items(): t = t.replace(k, v)
    return t

def head():
    if hashlib.sha256(T[0].read_bytes()).hexdigest() != T[1]: raise SystemExit("transport pin differs")
    spec = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m

def enc_len(h, text, secs): return len(base64.b64encode((h.replace("SECS", str(secs)) + text).encode("utf-16-le")))

def journal(receipt):
    lines = [json.loads(l) for l in (receipt.get("journal") or {}).get("lines", []) if l.strip().startswith("{")]
    step = lambda s: next((l for l in lines if l.get("step") == s), None)
    fin = [l["final"] for l in lines if "final" in l]
    return {"pins": step("pins"), "privacy": step("privacy-restart"), "start": step("start-node"), "post": step("post"), "final": fin[-1] if fin else None}

def post_texts(receipt, pd=PD, pf=PF, sleep=25):
    p = receipt["params"]; j = journal(receipt); ids = p["expectedIds"]; R = p["runner"]
    if not all(ID.match(i) for i in ids) or not ID.match(R): raise SystemExit("ids/runner are not exact")
    ag, pv = (j["start"] or {}).get("agent") or {}, j["privacy"] or {}
    if not ag.get("pid") or not pv.get("newPid"): raise SystemExit("the receipt journal has no new node agent / privacy agent identity: no postflight")
    off = int((j["pins"] or {}).get("nodeLogOffset", -1))
    return {"channel": (fill(CHAN, pd, pf, RX=q(R), SLEEPX=str(int(sleep))), 90), "bind": (fill(BIND, pd, pf, IDSX=arr(ids)), 60),
            "blocks": (fill(BLOCKS_T, pd, pf, RX=q(R)), 60), "env": (fill(ENV, pd, pf), 60),
            "proc": (fill(PROC, pd, pf, AGENTPIDX=str(int(ag["pid"])), PRIVPIDX=str(int(pv["newPid"]))), 90), "host": (fill(HOST, pd, pf, IDSX=arr(ids)), 60),
            "logs": lambda p0: (fill(LOGS, pd, pf, NODEOFFX=str(off), NETOFFX=str(int((p0 or {}).get("networkLog", -1))), NODEPATSX=ht(NODE_PATS), NETPATSX=ht(NET_PATS)), 90)}

# ----------------------------------------------------------------------------------------------------- evaluation
def V(verdict, why, **ev): return {"verdict": verdict, "why": why, **ev}
def num(x): return isinstance(x, (int, float)) and not isinstance(x, bool)

def evaluate(receipt, p0, post, pd=PD, pf=PF):
    p = receipt["params"]; j = journal(receipt); ids, R = p.get("expectedIds"), p.get("runner")
    hex64 = lambda v: isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None
    # B0: the receipt's own binding; empty/duplicate/garbled ids or runner can never make W4 vacuously green
    exact_ids = isinstance(ids, list) and len(ids) > 0 and all(isinstance(i, str) and ID.match(i) for i in ids) and len(set(ids)) == len(ids)
    exact_r = isinstance(R, str) and ID.match(R) is not None
    if not isinstance(ids, list): ids = []
    ch_, bind, blk, envo, proc, hst, logs = (post.get(k) or {} for k in ("channel", "bind", "blocks", "env", "proc", "host", "logs"))
    g = {**ch_, "ids": bind.get("ids")} if ch_ or bind else {}
    cfg = {"blocks": blk.get("blocks"), "platformAdmission": blk.get("platformAdmission"), "env": {k: envo.get(k) for k in ("nodeConfig", "local", "runNode")} if envo else None} if blk or envo else {}
    idn = {**proc, "host": hst} if proc or hst else {}
    out = {"run": p.get("runId"), "expectedIds": len(ids) if isinstance(ids, list) else None, "checks": {}}
    ch = out["checks"]
    ch["B0_receiptBinding"] = (V("PASS", f"{len(ids)} distinct exact expected ids and an exact runner") if exact_ids and exact_r else
                               V("UNKNOWN", "receipt params: expectedIds must be a non-empty list of distinct exact ids and runner an exact id"))
    # C0: the cutover's own proof (referenced, not repeated)
    f = j["final"] or ""
    ch["C0_cutoverDone"] = (V("PASS", "cutover final is DONE:") if f.startswith("DONE:") else
                            V("UNKNOWN", "DONE_PARTIAL: some ids were not re-granted inside the cutover") if f.startswith("DONE_PARTIAL:") else
                            V("FAIL", f"cutover final is not DONE: {f[:60]!r}"))
    gen = (j["start"] or {}).get("channelGeneration")
    # W1: the same processes as the cutover journaled
    ag, pv = (j["start"] or {}).get("agent") or {}, j["privacy"] or {}
    ia, ip = idn.get("agent") or {}, idn.get("privacy") or {}
    nl = logs.get("node") or {}
    restarts = nl.get("privacyRestart") if num(nl.get("privacyRestart")) else None
    if not idn or "error" in ia or "error" in ip or ia.get("alive") is None: ch["W1_identities"] = V("UNKNOWN", "process identities were not read")
    elif not (ia.get("alive") and ia.get("match") and ia.get("start") == ag.get("start")): ch["W1_identities"] = V("FAIL", "the node agent is not the one the cutover started")
    elif ip.get("alive") and ip.get("match") and ip.get("start") == pv.get("newStart"): ch["W1_identities"] = V("PASS", "node agent and privacy agent are the cutover's")
    elif restarts and restarts > 0: ch["W1_identities"] = V("UNKNOWN", "the privacy agent was restarted by an enrollment config switch (logged): P1/W3 decide whether the hold survived")
    else: ch["W1_identities"] = V("FAIL", "the privacy agent changed without an enrollment restart in node.log")
    # W2/W3: the channel is alive and applied by the network, with the cutover's generation
    a, b = g.get("a") or {}, g.get("b") or {}
    da, db, sa, sb = (a.get("doc") or {}), (b.get("doc") or {}), (a.get("status") or {}), (b.get("status") or {})
    if not (da.get("present") and db.get("present")): ch["W2_channel"] = V("UNKNOWN" if not (g.get("a") and g.get("b")) else "FAIL", "wallet-admission.json not readable in both samples")
    else:
        bad = [k for k, ok in (("version1", da.get("version") == 1 and db.get("version") == 1), ("runner", da.get("runnerOk") and db.get("runnerOk")),
               ("generationIsCutovers", bool(gen) and da.get("generation") == gen and db.get("generation") == gen),
               ("revisionAdvances", num(da.get("revision")) and num(db.get("revision")) and db["revision"] > da["revision"]),
               ("unexpired", all(num(x.get("expiresInMs")) and 0 < x["expiresInMs"] <= 31000 for x in (da, db)))) if not ok]
        ch["W2_channel"] = V("FAIL", "channel: " + ", ".join(bad)) if bad else V("PASS", "channel alive (heartbeat), cutover generation, this runner, unexpired")
    if not (sa.get("present") and sb.get("present")): ch["W3_networkApplies"] = V("UNKNOWN" if not (g.get("a") and g.get("b")) else "FAIL", "status.json not readable in both samples")
    else:
        wa, wb = sa.get("wallet") or {}, sb.get("wallet") or {}
        bad = [k for k, ok in (("version2", sa.get("version") == 2 and sb.get("version") == 2), ("fresh<5s", all(num(x.get("ageMs")) and 0 <= x["ageMs"] < 5000 for x in (sa, sb))),
               ("walletAdmission", bool(wa) and bool(wb)), ("runner", wa.get("runnerOk") and wb.get("runnerOk")),
               ("sameGeneration", bool(gen) and wa.get("generation") == gen and wb.get("generation") == gen),
               ("freshApplied", all(x.get("fresh") is True and x.get("applied") is True and x.get("errorNull") is True for x in (wa, wb))),
               ("revisionTracks", num(wb.get("revision")) and num(db.get("revision")) and num(da.get("revision")) and wb["revision"] >= da["revision"]),
               ("unexpired", all(num(x.get("expiresInMs")) and x["expiresInMs"] > 0 for x in (wa, wb)))) if not ok]
        ch["W3_networkApplies"] = V("FAIL", "network: " + ", ".join(bad)) if bad else V("PASS", "the network agent applies the node's channel (same generation, fresh, applied)")
    # W4: every expected id granted with the exact binding, live deadlines, a route and a running node record
    gi = {x.get("id"): x for x in (g.get("ids") or [])}; hi = {x.get("id"): x for x in ((idn.get("host") or {}).get("ids") or [])}
    rows, missing = [], []
    for i in ids:
        x, h = gi.get(i), hi.get(i)
        if x is None or h is None or not (idn.get("host") or {}).get("answered"): missing.append(i); continue
        bad = [k for k, ok in (("docAllow", x.get("docAllow")), ("expectation", x.get("expectation")), ("appRef", x.get("appRefMatch")), ("configCid", x.get("configCidMatch")),
               ("validUntil", num(x.get("validInMs")) and 0 < x["validInMs"] <= 90000), ("statusAllow", x.get("statusAllow")), ("statusApp", x.get("statusApp") == 1),
               ("walletUntil", num(x.get("walletInMs")) and x["walletInMs"] > 0), ("leaseUntil", num(x.get("leaseInMs")) and x["leaseInMs"] > 0),
               ("proofUntil", num(x.get("proofInMs")) and x["proofInMs"] > 0), ("egress", x.get("egress")),
               ("nodeRunning", h.get("status") == "running"), ("notHeld", h.get("walletHeld") is False), ("nodeLease", num(h.get("leaseInSec")) and h["leaseInSec"] > 0)) if not ok]
        if bad: rows.append({"id": i, "bad": bad})
    ch["W4_grants"] = (V("UNKNOWN", f"no per-id evidence for {len(missing)} id(s)", missing=missing) if missing else
                       V("FAIL", f"{len(rows)} id(s) not fully granted", rows=rows) if rows else V("PASS", f"all {len(ids)} ids granted with exact appRef/configCid binding, live deadlines, routes, running"))
    if not exact_ids: ch["W4_grants"] = V("UNKNOWN", "no exact non-empty expected id list in the receipt: grants cannot be proven")
    # A1: platform (admin) host policy ON and ADMITTING this host since the cutover
    env = cfg.get("env") or {}; pa = cfg.get("platformAdmission") or {}
    cats = [env.get(k, {}).get("platformPolicy") for k in ("nodeConfig", "local", "runNode") if (env.get(k) or {}).get("present")]
    set_ = [c for c in cats if c and c != "unset"]
    if not cfg or not nl or nl.get("error") or nl.get("rotated") or nl.get("unbounded"): ch["A1_platformPolicy"] = V("UNKNOWN", "config or bounded node.log evidence missing")
    elif any(c in ("off", "empty", "other") for c in set_): ch["A1_platformPolicy"] = V("FAIL", f"ENCLAVE_PLATFORM_HOST_POLICY assignment category {set_}: admin policy disabled or unusable")
    elif not set_: ch["A1_platformPolicy"] = V("FAIL", "ENCLAVE_PLATFORM_HOST_POLICY unset (this node passes book:null: unset means OFF)")
    elif (nl.get("notServing") or 0) > 0 or (nl.get("notServingChange") or 0) > 0: ch["A1_platformPolicy"] = V("FAIL", "the platform host policy reported this host NOT serving since the cutover")
    elif pa.get("present") and not (pa.get("hostIdOk") and pa.get("knownRefusalNull")): ch["A1_platformPolicy"] = V("FAIL", "a persisted platform refusal (or another host's state) is present", status=pa.get("knownRefusalStatus"))
    elif not num(nl.get("admitted")) or nl["admitted"] < 1: ch["A1_platformPolicy"] = V("UNKNOWN", "no '[host-policy] this host is ADMITTED' line since the cutover's log offset")
    else: ch["A1_platformPolicy"] = V("PASS", "platform host policy ON and ADMITTED by the new process; no not-serving; no persisted refusal", categories=set_)
    # A2: owner wallet admission configured and its channel running (the cutover's own OFF count is not repeated as proof)
    have = {k: any((env.get(f) or {}).get(k) for f in ("nodeConfig", "local", "runNode")) for k in ENVN}
    hold = [env.get(f, {}).get("walletHold") for f in ("nodeConfig", "local", "runNode") if (env.get(f) or {}).get("present")]
    if not cfg or not nl or nl.get("error") or nl.get("rotated") or nl.get("unbounded"): ch["A2_walletAdmission"] = V("UNKNOWN", "config or bounded node.log evidence missing")
    elif not all(have.values()): ch["A2_walletAdmission"] = V("FAIL", "owner wallet admission names missing: " + ",".join(k for k, v in have.items() if not v))
    elif True not in hold: ch["A2_walletAdmission"] = V("FAIL", "ENCLAVE_NETWORK_WALLET_HOLD=1 is not set in any node config file")
    elif (nl.get("channelOff") or 0) or (nl.get("channelNotWritten") or 0): ch["A2_walletAdmission"] = V("FAIL", "wallet hold channel OFF / NOT written since the cutover")
    elif not num(nl.get("channelStarted")) or nl["channelStarted"] < 1: ch["A2_walletAdmission"] = V("UNKNOWN", "no channel start line since the cutover offset")
    else: ch["A2_walletAdmission"] = V("PASS", "owner admission configured (4 ENCLAVE_HOST_* names), hold flag 1, channel started, never OFF", policyUnavailableLines=nl.get("policyUnavailable"))
    # P1: operator blocks retained across >= 1 enrollment pass; walletAdmission exactly the channel file
    bl, b0 = cfg.get("blocks") or {}, (p0 or {}).get("blocks") or {}
    age = None
    try: age = idn["nowMs"] / 1000 - calendar.timegm(time.strptime(ag["start"][:19], "%Y-%m-%dT%H:%M:%S"))
    except Exception: pass
    wf = pd + "\\network\\wallet-admission.json"
    shaok0 = lambda v: v == "absent" or hex64(v)
    # the P0 baseline must itself be a real read: parsed privacy-config WITH enclaveNetwork, a real file sha, real keys/hashes
    base_ok = (isinstance(b0, dict) and b0.get("present") is True and hex64(b0.get("cfgSha")) and isinstance(b0.get("keys"), list) and len(b0["keys"]) > 0
               and all(isinstance(k, str) for k in b0["keys"]) and all(shaok0(b0.get(k)) for k in BLOCKS))
    if not (bl.get("present") is True and hex64(bl.get("cfgSha"))): ch["P1_propagation"] = V("UNKNOWN", "enclaveNetwork not read")
    elif bl.get("walletFile") != wf: ch["P1_propagation"] = V("FAIL", f"walletAdmission is not exactly {{file: {wf}}}: {bl.get('walletFile')}")
    elif not p0: ch["P1_propagation"] = V("UNKNOWN", "no P0 marker: operator-block retention cannot be compared")
    elif not base_ok: ch["P1_propagation"] = V("UNKNOWN", "P0 baseline missing or invalid (privacy-config unreadable, not JSON, or no enclaveNetwork): never a retention baseline")
    elif not hex64(p.get("cfgSha")) or b0["cfgSha"] != p["cfgSha"]:
        ch["P1_propagation"] = V("UNKNOWN", "P0 is not bound to this cutover: its privacy-config sha differs from the receipt's pinned pre-cutover cfgSha (stale or other config)")
    elif age is None or age < 420: ch["P1_propagation"] = V("UNKNOWN", f"agent started {age and int(age)} s ago: wait >= 420 s for an enrollment pass")
    else:
        k0 = set(b0.get("keys") or []); k1 = set(bl.get("keys") or [])
        allowedNew = {"walletAdmission"} | ({"serviceWorkerModule"} if b0.get("hostServices") not in (None, "absent") else set())
        drop = sorted(k0 - k1); extra = sorted(k1 - k0 - allowedNew)
        shaok = lambda v: v == "absent" or (isinstance(v, str) and re.fullmatch(r"[0-9a-f]{64}", v) is not None)
        unread = [k for k in BLOCKS if not (shaok(b0.get(k)) and shaok(bl.get(k)))]
        changed = [k for k in BLOCKS if k != "serviceWorkerModule" and b0.get(k) != bl.get(k)]
        ch["P1_propagation"] = (V("UNKNOWN", "a block hash was not computed (null/garbled): never compared as unchanged", unread=unread) if unread else
                                V("FAIL", "enclaveNetwork keys dropped by enrollment", dropped=drop) if drop else
                                V("FAIL", "operator blocks changed since P0", changed=changed) if changed else
                                V("UNKNOWN", "unexpected new enclaveNetwork keys", extra=extra) if extra else
                                V("PASS", "every P0 operator block byte-identical after an enrollment pass; walletAdmission exact"))
    # H1 / C1: optional services, only when the operator configured them
    netl = logs.get("network") or {}
    netok = netl and not (netl.get("error") or netl.get("rotated") or netl.get("unbounded"))
    hs = bl.get("hostServices")
    if bl and hs is None: ch["H1_hostServices"] = V("UNKNOWN", "hostServices presence not read")
    elif hs in (None, "absent"): ch["H1_hostServices"] = V("NOT_CONFIGURED", "no enclaveNetwork.hostServices: host-service propagation is retained by design but not exercised")
    else:
        fl = idn.get("files") or {}
        if bl.get("serviceWorker") != pf + "\\network\\host-service-ingress.mjs" or fl.get("network/host-service-ingress.mjs") != FILES["network/host-service-ingress.mjs"]:
            ch["H1_hostServices"] = V("FAIL", "service worker is not the pinned ingress")
        elif (nl.get("hostServicesInvalid") or 0) > 0 or (netok and (netl.get("hostServicesRefused") or 0) > 0): ch["H1_hostServices"] = V("FAIL", "host services INVALID / REFUSED since P0")
        elif not netok: ch["H1_hostServices"] = V("UNKNOWN", "no bounded network.log evidence (P0 missing or log rotated)")
        elif (netl.get("hostServicesUp") or 0) < 1: ch["H1_hostServices"] = V("UNKNOWN", "no 'host services:' start line since P0")
        else: ch["H1_hostServices"] = V("PASS", "host services started by the privacy agent with the pinned worker; none refused")
    cr = bl.get("challengeReplica")
    if bl and cr is None: ch["C1_challengeReplica"] = V("UNKNOWN", "challengeReplica presence not read")
    elif cr in (None, "absent"): ch["C1_challengeReplica"] = V("NOT_CONFIGURED", "no enclaveNetwork.challengeReplica (expected until root's hs2/replica activation)")
    elif not netok: ch["C1_challengeReplica"] = V("UNKNOWN", "no bounded network.log evidence")
    elif any((netl.get(k) or 0) > 0 for k in ("challengeNotStarted", "challengeStopped", "challengeRestartRefused")): ch["C1_challengeReplica"] = V("FAIL", "challenge replica not started / stopped / refused since P0")
    elif (netl.get("challengeServing") or 0) < 1: ch["C1_challengeReplica"] = V("UNKNOWN", "no 'challenge replica serving:' line since P0")
    else: ch["C1_challengeReplica"] = V("PASS", "challenge replica serving under the new control")
    # F1: the semantic claims are about these exact bytes
    fl = idn.get("files") or {}
    badf = [k for k, h in FILES.items() if fl.get(k) != h]
    ch["F1_files"] = V("UNKNOWN", "file hashes not read") if not fl else V("FAIL", "files differ from the frozen package", files=badf) if badf else V("PASS", "all 9 semantic files are the frozen bytes")
    req = ["B0_receiptBinding", "C0_cutoverDone", "F1_files", "W1_identities", "W2_channel", "W3_networkApplies", "W4_grants", "A1_platformPolicy", "A2_walletAdmission", "P1_propagation"]
    vs = [ch[k]["verdict"] for k in req]
    out["required"] = "PASS" if all(v == "PASS" for v in vs) else "FAIL" if "FAIL" in vs else "NOT PROVEN (UNKNOWN)"
    out["optional"] = {k: ch[k]["verdict"] for k in ("H1_hostServices", "C1_challengeReplica")}
    return out

def main(argv):
    a = argparse.ArgumentParser(); s = a.add_subparsers(dest="cmd", required=True)
    t = s.add_parser("texts"); t.add_argument("--receipt"); t.add_argument("--pre", action="store_true"); t.add_argument("--p0")
    e = s.add_parser("evaluate"); e.add_argument("--receipt", required=True); e.add_argument("--p0"); e.add_argument("--post", required=True)
    o = a.parse_args(argv); rd = lambda f: json.loads(pathlib.Path(f).read_text()) if f else None
    if o.cmd == "evaluate":
        print(json.dumps(evaluate(rd(o.receipt), rd(o.p0), rd(o.post)), indent=1)); return 0
    m = head(); ts = {"p0": (fill(P0), 60)} if o.pre else post_texts(rd(o.receipt))
    if "logs" in ts: ts["logs"] = ts["logs"](rd(o.p0))
    res = {k: {"secs": sc, "encodedChars": enc_len(m.HEAD, x, sc), "sha256": hashlib.sha256(x.encode()).hexdigest(), "text": x} for k, (x, sc) in ts.items()}
    for k, v in res.items():
        if v["encodedChars"] > LIMIT: raise SystemExit(f"{k}: {v['encodedChars']} encoded chars > {LIMIT}")
    print(json.dumps(res, indent=1)); return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
