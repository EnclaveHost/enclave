"""Bounded read-only comparison. No secrets or environment values are output or saved."""
import hashlib,hmac,json,os,pathlib,re,sys
N=int("fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141",16)
def compare(raw):
    pairs=[x.split(b"=",1) for x in raw.split(b"\0") if b"=" in x]
    for name in [b"SESSIONS_RELAYER_KEY",b"HOST_SPONSOR_BUNDLER_KEY"]:
        if sum(k==name for k,v in pairs)>1:raise ValueError("duplicate target")
    e=dict(pairs)
    a,b=e.get(b"SESSIONS_RELAYER_KEY"),e.get(b"HOST_SPONSOR_BUNDLER_KEY")
    def key(x):
        if x is None or not re.fullmatch(rb"(?:0x)?[0-9a-fA-F]{64}",x):return None
        v=bytes.fromhex(x.removeprefix(b"0x").decode("ascii"))
        return v if 0<int.from_bytes(v,"big")<N else None
    ka,kb=key(a),key(b)
    return {"sessionConfigured":a is not None,"sponsorConfigured":b is not None,"sessionValid":ka is not None,"sponsorValid":kb is not None,"samePrivateKey":hmac.compare_digest(ka,kb) if ka is not None and kb is not None else None}
def sha(p):
    h=hashlib.sha256()
    with open(p,"rb") as f:
        for b in iter(lambda:f.read(1024*1024),b""):h.update(b)
    return h.hexdigest()
def main():
    if sys.argv[1:]!=["--readonly-live-compare"] or os.geteuid()!=0:raise ValueError("scope")
    pid=228946;p=pathlib.Path(f"/proc/{pid}")
    def identity():
        v=p.joinpath("stat").read_text();start=int(v[v.rfind(")")+2:].split()[19])
        return (start,p.joinpath("cmdline").read_bytes(),str(p.joinpath("cwd").resolve()))
    expected=(43738495,b"/usr/bin/node\0/opt/nan-relay/api-relay.js\0","/opt/nan-relay")
    if identity()!=expected:raise ValueError("identity")
    if sha(p/"exe")!="93956de2e59480474a7b46571da1651180b1a050cdf32641ebec4ce6e478e068":raise ValueError("executable")
    pins={"sessions.mjs":"457e86472adce2f1fdd2dfa82759578a56f7d72f0c5e5ee18e53999a26d0682d","api-relay.js":"481f00410b87f30ee467183db7121175d37c010be5b2c23891a0a19e63b4579d"}
    for f,h in pins.items():
        if sha(pathlib.Path("/opt/nan-relay")/f)!=h:raise ValueError("source")
    with (p/"environ").open("rb") as f:raw=f.read(262145)
    if len(raw)>262144:raise ValueError("environment bound")
    result=compare(raw);del raw
    if identity()!=expected:raise ValueError("identity changed")
    print(json.dumps({"schema":"signer-scope-equality-r1","pid":pid,"startTicks":expected[0],"identityVerified":True,**result}))
if __name__=="__main__":
    try:main()
    except BaseException:
        print(json.dumps({"schema":"signer-scope-equality-r1","refused":True}),file=sys.stderr);sys.exit(1)
