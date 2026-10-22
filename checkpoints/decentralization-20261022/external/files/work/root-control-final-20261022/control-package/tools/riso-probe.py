#!/usr/bin/env python3
"""R-ISO READ-ONLY PROBE RECIPE (prepared by Claude control-package r2; NEVER executed by its author; this file has no transport call).

Question: will the candidate isolationPlan (node-bridge 6a80bb3c) DEFINITELY refuse an already-running expected deployment at the
first post-restart reconcile (host.mjs launch verdict -> #giveUp -> its VM is retired)? The new refusals are exactly:
  * encVolumesNamed(deliveredConfig) and manager /health supports.encVolumes !== true    (also: no secrets, or memory too small)
  * non-inference: named model volumes (deliveredConfig ? configVolumes(deliveredConfig) : version volumes) and
    supports.modelVolumes !== true                                                         (also: a name not held, ggml w/o nnPreload)
deliveredConfig = appConfigOf(host.appConfig(d, v, {strictCid: true})): the envelope's configCid file (node\\apps\\cfg-<cid>.json),
else the envelope's inline `config`, else the version's own config (its configCid file, else its inline config); `_media` dropped.

What the remote text reads (and NOTHING else; no process/CIM/task query, no write):
  * GET 127.0.0.1:8091/health -> ONLY supports.{config,configCid,secrets,encVolumes,modelVolumes,nnPreload} as true/false/'absent',
    the COUNT of held model volumes, and whether inference is present
  * privacy-config.json apps[] -> the expectedFile of each GIVEN expected id (the same read as root-node-hold.py COV)
  * that expectation's configCid field (the lease envelope) -> its SOURCE KIND, and the CID when it names one (a public content id)
  * the one config file that source names (or the version CID file root passes in) -> KEY PRESENCE + non-emptiness flags only
Output never contains a config value, a volume name, a path or a secret: only ids, CIDs, source kinds, booleans and counts.

usage:  riso-probe.py --ids ids.txt [--version-cids map.json]   -> prints the remote text(s), their sha256 and encoded lengths
        riso-probe.py --evaluate probe-output.json [--catalog catalog-flags.json]   -> offline verdict per id (no remote access)
ids.txt: the preflight's coverage.expectedIds (one per line). map.json (optional, from the PUBLIC catalog, read by root's own tools):
{"<id>": "<version configCid>"}. catalog-flags.json (optional, public catalog): {"<id>": {"volNonEmpty": bool, "encNonEmpty": bool}}
for versions whose INLINE config is the delivered one (no CID), plus "gpuMilli": <ledger value> per id when the manager reports
inference (node-bridge applies its inference rule only to gpuMilli > 0).
"""
import argparse, base64, hashlib, importlib.util, json, pathlib, re, sys
W = pathlib.Path(__file__).resolve().parents[3]
T = (W / "nucbox-tls-20261021/root-activate-reviewed.py", "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f")
LIMIT = 7600
ID = re.compile(r"^0x[0-9a-f]{64}$"); CID = re.compile(r"^[A-Za-z0-9]{10,100}$")
q = lambda v: "'" + str(v).replace("'", "''") + "'"

# key presence + non-emptiness of ONE config text, as node-bridge encVolumesNamed / model-volumes configVolumes see it (keys are
# case-sensitive as in JS: -ccontains). Output is ASCII (ids, CIDs, booleans, counts): no console-encoding line is needed.
FLAGS = (r"$P=[Management.Automation.PSCustomObject];"
         r"function N($v){if(($null -eq $v) -or ($v -is [bool] -and !$v) -or ($v -is [string] -and $v -eq '') -or ($v -is [ValueType] -and $v -eq 0)){return $false};"
         r"if($v -is [array]){return $v.Count -gt 0};if($v -is $P){return @($v.PSObject.Properties).Count -gt 0};$true};"
         r"function F($t){$r=[ordered]@{parse=$false;encKey=$false;encNonEmpty=$false;volKey=$false;volNonEmpty=$false;mediaOnly=$false};"
         r"try{$o=$t|ConvertFrom-Json}catch{return $r};if($o -isnot $P){return $r};$r.parse=$true;$n=@($o.PSObject.Properties.Name);$r.mediaOnly=!@($n|?{$_ -cne '_media'}).Count;"
         r"if($n -ccontains 'encVolumes'){$r.encKey=$true;$r.encNonEmpty=N $o.encVolumes};"
         r"if($n -ccontains 'volumes'){$r.volKey=$true;$v=$o.volumes;$r.volNonEmpty=$v -is [array] -and @($v|?{§$(if($_ -is [string]){$_}else{$_|ConvertTo-Json -Co -D 20})§.Trim()}).Count -gt 0};$r};").replace("§", '"')
MGR = (r"$m=[ordered]@{at=[DateTime]::UtcNow.ToString('o')};try{$h=Invoke-RestMethod -UseBasicParsing -TimeoutSec 5 -Uri 'http://127.0.0.1:8091/health';$m.answered=$true;$sp=$h.supports;"
       r"$pn=$(if($sp){@($sp.PSObject.Properties.Name)}else{@()});foreach($k in 'config','configCid','secrets','encVolumes','modelVolumes','nnPreload'){$m[$k]=$(if($pn -ccontains $k){[bool]($sp.$k -is [bool] -and $sp.$k)}else{'absent'})};"
       r"$m.modelVolumesHeld=@($h.volumes|?{$_ -and $_.kind -ceq 'model'}).Count;$m.inference=($null -ne $h.inference)}catch{$m.answered=$false};$m|ConvertTo-Json -Co")
APPS = FLAGS + (r"$pd=PDX;function C($c){$f=Join-Path $pd §node/apps/cfg-$c.json§;if(Test-Path -LiteralPath $f){F ([IO.File]::ReadAllText($f))}else{'absent'}};"
       r"$c=[IO.File]::ReadAllText((Join-Path $pd 'network/privacy-config.json'))|ConvertFrom-Json;$out=@();"
       r"foreach($it in @(ITEMSX)){$id,$vc=$it.Split('|');$x=[ordered]@{id=$id};$a=@($c.apps|?{§$($_.deploymentId)§ -ceq $id});"
       r"if($a.Count -ne 1){$x.src='no-expectation'}else{$s=$null;try{$s=§$(([IO.File]::ReadAllText(§$($a[0].expectedFile)§)|ConvertFrom-Json).configCid)§.Trim()}catch{$x.src='expectation-unreadable'};"
       r"if($null -ne $s){if(!$s){$x.src='version'}elseif(!$s.StartsWith('{')){$x.src='bare-envelope'}else{$k=$null;try{$en=$s|ConvertFrom-Json;$k=@($en.PSObject.Properties.Name)}catch{$x.src='envelope-unreadable'};"
       r"if($null -ne $k){if($k -ccontains 'guestBootstrap'){$x.src='owner-startup'}elseif($k -ccontains 'configCid'){$cc=§$($en.configCid)§;if($cc -cmatch '^[A-Za-z0-9]{10,100}$'){$x.src='envelope-cid';$x.cid=$cc;$x.flags=C $cc}else{$x.src='envelope-cid-invalid'}}"
       r"elseif($k -ccontains 'config'){$x.src='envelope-inline';$x.flags=$(if($en.config -is $P){F ($en.config|ConvertTo-Json -Co -D 20)}else{'not-an-object'})}else{$x.src='version'}}}}};"
       r"if($x.src -eq 'version' -and $vc){$x.cid=$vc;$x.flags=C $vc};$out+=,$x};@{apps=$out}|ConvertTo-Json -Co -D 6").replace("§", '"')

def head():
    if hashlib.sha256(T[0].read_bytes()).hexdigest() != T[1]: raise SystemExit("transport pin differs")
    spec = importlib.util.spec_from_file_location("transport", T[0]); m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    return m.HEAD                                     # ONLY the constant; ps() is never called from here

def enc_len(h, text, secs=60): return len(base64.b64encode((h.replace("SECS", str(secs)) + text).encode("utf-16-le")))

def apps_text(items, pd=r"C:\ProgramData\Enclave"):
    return APPS.replace("PDX", q(pd)).replace("ITEMSX", ",".join(q(i) for i in items))

def texts(ids, vcids, h):
    for i in ids:
        if not ID.match(i): raise SystemExit(f"not an exact deployment id: {i!r}")
    for i, c in vcids.items():
        if i not in ids or not CID.match(c): raise SystemExit(f"version CID map: {i} -> {c!r} is not an expected id / bare CID")
    items = [f"{i}|{vcids.get(i, '')}" for i in ids]; out, batch = [MGR], []
    for it in items + [None]:
        if it is not None and (not batch or enc_len(h, apps_text(batch + [it])) <= LIMIT): batch.append(it); continue
        if batch: out.append(apps_text(batch))
        batch = [it] if it is not None else []
    for t in out:
        if enc_len(h, t) > LIMIT: raise SystemExit("a probe text exceeds the batch limit")
    return out

def verdict(app, mgr, catalog):
    """-> (kind, why). kind: SAFE (no new definite refusal) | AT_RISK (definite refusal -> giveUp) | UNKNOWN (root decides)"""
    if not mgr.get("answered"): return "UNKNOWN", "the manager /health did not answer"
    pub = catalog.get(app.get("id")) or {}
    if mgr.get("inference") and pub.get("gpuMilli") != 0:     # node-bridge: inf = deployment.gpuMilli > 0 ? manager.inference : null
        return "UNKNOWN", "the manager reports inference and this deployment's ledger gpuMilli is not given as 0 (--catalog gpuMilli): a GPU deployment's volume rule differs"
    src, fl = app.get("src"), app.get("flags")
    if src in ("no-expectation", "expectation-unreadable", "envelope-unreadable", "envelope-cid-invalid", "bare-envelope"):
        return "UNKNOWN", f"source {src}: a running app should not look like this; root reads it"
    if src == "owner-startup": return "UNKNOWN", "owner-committed startup: the package's configText decides (root's package evidence)"
    if fl == "not-an-object": return "UNKNOWN", "inline envelope config is not an object (parseEnvelope throws)"
    if src == "version" and fl is None:
        c = catalog.get(app["id"])
        if c is None: return "UNKNOWN", "the version's own config decides: give its configCid (--version-cids) or its inline flags (--catalog)"
        fl = {"parse": True, "encNonEmpty": bool(c.get("encNonEmpty")), "volNonEmpty": bool(c.get("volNonEmpty")), "mediaOnly": False}
    if fl == "absent": return "UNKNOWN", "the config CID file is not cached: the node fetches it at launch"
    if not isinstance(fl, dict): return "UNKNOWN", f"unexpected flags {fl!r}"
    if not fl.get("parse"): return "SAFE", "the delivered config is not a JSON object: neither rule can name volumes from it"
    if fl.get("mediaOnly"):
        c = catalog.get(app["id"])
        if c is None: return "UNKNOWN", "delivered config is only _media (empty): the VERSION's volumes decide (--catalog volNonEmpty)"
        fl = dict(fl, encNonEmpty=False, volNonEmpty=bool(c.get("volNonEmpty")))
    why = []
    if fl.get("encNonEmpty") and mgr.get("encVolumes") is not True: why.append("names encVolumes; manager supports.encVolumes is not true")
    if fl.get("volNonEmpty") and mgr.get("modelVolumes") is not True: why.append("names model volumes; manager supports.modelVolumes is not true")
    if why: return "AT_RISK", "; ".join(why)
    if fl.get("encNonEmpty") or fl.get("volNonEmpty"):
        return "UNKNOWN", "names volumes and the manager supports them: secrets/memory/held-name rules still apply (root checks)"
    return "SAFE", "names neither encVolumes nor model volumes"

def evaluate(probe, catalog):
    mgr = probe["manager"]; apps = [a for part in probe["apps"] for a in (part.get("apps") or [])]
    rows = [{"id": a.get("id"), "src": a.get("src"), "cid": a.get("cid"), **dict(zip(("verdict", "why"), verdict(a, mgr, catalog)))} for a in apps]
    ids = probe.get("expectedIds") or []
    missing = sorted(set(ids) - {r["id"] for r in rows})
    ok = not missing and bool(rows) and all(r["verdict"] == "SAFE" for r in rows)
    return {"manager": mgr, "rows": rows, "missingIds": missing, "riso": "PASS" if ok else "NOT PASSED (root decides; see rows)"}

def main(argv):
    a = argparse.ArgumentParser(); a.add_argument("--ids"); a.add_argument("--version-cids"); a.add_argument("--evaluate"); a.add_argument("--catalog")
    o = a.parse_args(argv)
    if o.evaluate:
        print(json.dumps(evaluate(json.loads(pathlib.Path(o.evaluate).read_text()), json.loads(pathlib.Path(o.catalog).read_text()) if o.catalog else {}), indent=1)); return 0
    ids = [l.strip() for l in pathlib.Path(o.ids).read_text().splitlines() if l.strip()]
    vc = json.loads(pathlib.Path(o.version_cids).read_text()) if o.version_cids else {}
    h = head(); ts = texts(ids, vc, h)
    print(json.dumps([{"n": i, "sha256": hashlib.sha256(t.encode()).hexdigest(), "encodedChars": enc_len(h, t), "text": t} for i, t in enumerate(ts)], indent=1))
    print("NOT EXECUTED. Root runs each text read-only with its reviewed transport (m.ps(text, 60)), saves {'expectedIds', 'manager': <text 0>,"
          " 'apps': [<text 1..>]} and evaluates with --evaluate.", file=sys.stderr)
    return 0

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
