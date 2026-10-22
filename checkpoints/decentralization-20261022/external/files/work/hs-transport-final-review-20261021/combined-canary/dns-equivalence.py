#!/usr/bin/env python3
"""READ-ONLY DNS answer equivalence for the single pin (A5). Same query list, same parser (node, DNS over TCP) on both sides.
  dns-equivalence.py --pre    minipc route-dns on 127.0.0.1:18153 (via the reviewed m.ps) vs ca-east's public 53 today
  dns-equivalence.py --post   ca-east's public 53 (now DNATed to minipc) vs us-west's public 53 (unpinned)
  dns-equivalence.py --public ca-east vs us-west, both unpinned (a baseline; no minipc call)
Compared: rcode, aa, sorted answer data; SOA serial ignored (time-based on every server). Names are public labels only."""
import base64, hashlib, importlib.util, json, pathlib, subprocess, sys, time

HERE = pathlib.Path(__file__).resolve().parent
OWN = "f7hpjdlk22izuytea5czfmjykwlixh334uwemn3emcngrl2bir5a"
Q = [("app.enclave.host", 6), ("app.enclave.host", 2), ("app.enclave.host", 257), ("ip.enclave.host", 6), ("ip.enclave.host", 2),
     ("7ae476a3.app.enclave.host", 1), ("38f368d6.app.enclave.host", 1), ("59f1273d.app.enclave.host", 1), ("9eb4e600.app.enclave.host", 1),
     ("custody-ca-east.app.enclave.host", 1), ("custody-us-west.app.enclave.host", 1), ("7ae476a3.app.enclave.host", 28),
     ("_acme-challenge.app.enclave.host", 16), ("probe-9d.ip.enclave.host", 1), ("nonexistent-9d-canary.app.enclave.host", 1),
     (f"dir-{OWN}.app.enclave.host", 1), (f"boot-{OWN}.app.enclave.host", 1), (f"policy-{OWN}.app.enclave.host", 1)]
# DNS over TCP: one query per connection; prints one JSON line per query {q,t,rcode,aa,an[]} (SOA serial dropped)
JS = r"""const net=require('net');const [host,port,qs]=[process.argv[1],+process.argv[2],JSON.parse(Buffer.from(process.argv[3],'base64').toString())];
const enc=(n)=>Buffer.concat([...n.split('.').filter(Boolean).map(l=>Buffer.concat([Buffer.from([l.length]),Buffer.from(l)])),Buffer.from([0])]);
const name=(b,o)=>{const p=[];let j=0,end=-1;while(j++<64){const l=b[o];if(l===0){o++;break}if((l&0xc0)===0xc0){if(end<0)end=o+2;o=((l&0x3f)<<8)|b[o+1];continue}p.push(b.slice(o+1,o+1+l).toString());o+=1+l}return [p.join('.').toLowerCase(),end<0?o:end]};
const rd=(b,o,t,l)=>{if(t===1)return [...b.slice(o,o+4)].join('.');if(t===28)return b.slice(o,o+16).toString('hex');if(t===2)return name(b,o)[0];
 if(t===6){const [m,o1]=name(b,o);const [r,o2]=name(b,o1);return m+' '+r+' '+[0,1,2,3,4].map(i=>b.readUInt32BE(o2+4*i)).join(' ')}
 if(t===16){const s=[];let i=o;while(i<o+l){s.push(b.slice(i+1,i+1+b[i]).toString());i+=1+b[i]}return s.join('')}return b.slice(o,o+l).toString('hex')};
const one=([qn,qt])=>new Promise((res)=>{const id=Math.floor(Math.random()*65535);const h=Buffer.alloc(12);h.writeUInt16BE(id,0);h.writeUInt16BE(0,2);h.writeUInt16BE(1,4);
 const q=Buffer.concat([h,enc(qn),Buffer.from([qt>>8,qt&255,0,1])]);const len=Buffer.alloc(2);len.writeUInt16BE(q.length);let acc=Buffer.alloc(0);
 const s=net.connect({host,port,timeout:6000},()=>s.write(Buffer.concat([len,q])));const done=(x)=>{s.destroy();res(x)};
 s.on('data',(d)=>{acc=Buffer.concat([acc,d]);if(acc.length>=2&&acc.length>=2+acc.readUInt16BE(0)){const b=acc.slice(2);const f=b.readUInt16BE(2);const an=b.readUInt16BE(6);
  let o=name(b,12)[1]+4;const out=[];for(let i=0;i<an;i++){const [,o1]=name(b,o);const t=b.readUInt16BE(o1),l=b.readUInt16BE(o1+8);out.push(t+' '+rd(b,o1+10,t,l));o=o1+10+l}
  done({q:qn,t:qt,id:b.readUInt16BE(0)===id,rcode:f&15,aa:!!(f&0x400),an:out.sort()})}});
 s.on('timeout',()=>done({q:qn,t:qt,error:'timeout'}));s.on('error',(e)=>done({q:qn,t:qt,error:e.code||String(e)}))});
(async()=>{for(const x of qs)console.log(JSON.stringify(await one(x)))})();"""

def b64(v): return base64.b64encode(json.dumps(v).encode()).decode()

def local(host):
    r = subprocess.run(["timeout", "180", "node", "-e", JS, host, "53", b64(Q)], capture_output=True, text=True)
    return [json.loads(l) for l in r.stdout.splitlines() if l.strip()] or [{"error": r.stderr[-300:]}]

def deflated():
    import zlib
    c = zlib.compressobj(9, zlib.DEFLATED, -15)   # raw deflate (node inflateRawSync)
    # minipc variant: argv shifted by one (the program itself is argv[1]); the query list is compiled in (deflated with it)
    js = JS.replace("process.argv[1],+process.argv[2],JSON.parse(Buffer.from(process.argv[3],'base64').toString())", "process.argv[2],+process.argv[3]," + json.dumps(Q))
    return base64.b64encode(c.compress(js.encode()) + c.flush()).decode()

def minipc():
    T = HERE.parent.parent / "nucbox-tls-20261021/root-activate-reviewed.py"
    assert hashlib.sha256(T.read_bytes()).hexdigest() == "c50aac8ec282fbbb37d3e7a438b4bbcd433c6d1b363ec947165a156a904a041f"
    sp = importlib.util.spec_from_file_location("transport", T); m = importlib.util.module_from_spec(sp); sp.loader.exec_module(m)
    # the program and the query list travel as base64 (no double quote reaches PS 5.1 native argument quoting)
    prog = "eval(require('zlib').inflateRawSync(Buffer.from(process.argv[1],'base64')).toString())"   # deflated: under 7900 encoded
    r = m.ps("[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false);$ErrorActionPreference='Continue';"
             f"$z=@(& 'C:\\Program Files\\Enclave\\runtime\\node\\node.exe' -e \"{prog}\" '{deflated()}' '127.0.0.1' '18153' 2>&1);"
             "@{lines=@($z|ForEach-Object{[string]$_})}|ConvertTo-Json -Compress", 150)
    return [json.loads(l) for l in r.get("lines", []) if l.startswith("{")] or [{"error": str(r)[:300]}]

def norm(x):
    if "error" in x: return ("error", x["error"])
    an = [(" ".join(a.split(" ")[:3] + a.split(" ")[4:]) if a.startswith("6 ") else a) for a in x["an"]]   # SOA: drop the serial
    return (x["rcode"], x["aa"], tuple(an), x.get("id"))

def main(argv):
    mode = (argv or ["--public"])[0]
    a_name, a = ("minipc-route-dns", minipc()) if mode == "--pre" else ("ca-east", local("146.190.246.39"))
    b_name, b = ("ca-east", local("146.190.246.39")) if mode == "--pre" else ("us-west", local("134.199.235.187"))
    rows = [{"q": x.get("q"), "t": x.get("t"), "same": norm(x) == norm(y), a_name: x, b_name: y} for x, y in zip(a, b)]
    # this host's 3 own service labels exist only in its route-dns appStatic (r5d), not on the unpinned fronts: expected to differ
    own = lambda r: str(r["q"]).endswith(f"-{OWN}.app.enclave.host")
    diff = [r for r in rows if not r["same"] and not own(r)]
    rec = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "mode": mode, "queries": len(Q), "answered": [len(a), len(b)], "differences": diff,
           "ownLabels": [{"q": r["q"], a_name: r[a_name].get("an"), b_name: r[b_name].get("rcode")} for r in rows if own(r)]}
    out = HERE / "root-runs"; out.mkdir(exist_ok=True)
    (out / f"dns-equivalence{mode.replace('--', '-')}-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.json").write_text(json.dumps({**rec, "rows": rows}, indent=1) + "\n")
    print(json.dumps(rec, indent=1)); return 0 if not diff and len(a) == len(b) == len(Q) else 1

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
