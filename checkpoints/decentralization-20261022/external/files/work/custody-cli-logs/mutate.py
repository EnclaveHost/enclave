# mutation checks for cli/custody-independent.mjs, in the ISOLATED copy only; each file is restored after its run
import subprocess, os, re, sys
I=os.path.realpath('/home/steven/Documents/Codex/2026-10-18/wo/work/custody-cli-logs/iso'); F='cli/custody-independent.mjs'
M=[("m1 enclave seat admitted","if (enclaveSeats.length && !f[\"allow-enclave-seat\"])","if (false)","refused before anything"),
   ("m2 no readback","async function readBack(reader, id, before, expect, receipt, { timeoutMs = READBACK_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {",
    "async function readBack(reader, id, before, expect, receipt, { timeoutMs = READBACK_MS, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) { return reader.readRelease({ id, endpoint: null });","readback is exact"),
   ("m3 no policy-owner check","    if (pol.owner !== me) throw","    if (false) throw","refused before anything"),
   ("m4 pause re-encodes rules","rules: bytesToHex(pol.rules), setBundle: false, bundle: \"0x\", clear: false };","rules: bytesToHex(canonicalRules(parseRules(pol.rules))), setBundle: false, bundle: \"0x\", clear: false };","Enclave Shield rules"),
   ("m5 no vault binding check","    if (String(s.value[i]).toLowerCase() !== String(expected).toLowerCase())","    if (false)","the vault itself")]
only=sys.argv[1:]
p=os.path.join(I,F); src=open(p).read()
for name,a,b,pat in M:
    if only and name.split()[0] not in only: continue
    av=int(re.search(r'MemAvailable:\s+(\d+)',open('/proc/meminfo').read()).group(1))
    if av<18874368: print(f"{name}: NOT RUN (MemAvailable {av} kB < 18 GiB)",flush=True); continue
    if src.count(a)!=1: print(name,"PATTERN",src.count(a),flush=True); continue
    open(p,'w').write(src.replace(a,b))
    try:
        r=subprocess.run(['node','test/helpers/memory-guard.mjs','--max-rss-mib','512','--floor-available-mib','16384','--','node','--test','--test-concurrency=1','--test-name-pattern',pat,'test/custody-cli-independent.test.mjs'],cwd=I,capture_output=True,text=True,timeout=400)
        out=r.stdout+r.stderr; m=re.search(r'^# fail (\d+)',out,re.M); pk=re.search(r'peakTreeRssMiB=(\d+)',out)
        print(f"{name}: {'KILLED' if m and int(m.group(1))>0 else 'SURVIVED'} fail={m.group(1) if m else '?'} peak={pk.group(1) if pk else '?'}MiB",flush=True)
    finally: open(p,'w').write(src)
