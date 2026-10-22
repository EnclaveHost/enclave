#!/usr/bin/env python3
"""ROOT ONLY. Executes the READ-ONLY postflight texts (postflight.py) with the pinned transport; NEVER run by its author.
  run-postflight.py --pre                               -> postflight/runs/p0-<ts>.json   (immediately BEFORE the cutover launch,
                                                           after its <=600 s preflight; nothing else in between)
  run-postflight.py --post --receipt <cutover-result-RUN.json> --p0 <p0.json>   -> runs/post-<ts>.json + runs/verdict-<ts>.json
     run --post twice: once right after DONE (P1 will say UNKNOWN until the agent is >= 420 s old) and once >= 420 s after the
     new node agent started (the authoritative sample). Each call is read-only; files are created O_EXCL (never overwritten).
"""
import argparse, hashlib, importlib.util, json, os, pathlib, sys, time
H = pathlib.Path(__file__).resolve().parent; OUT = H / "runs"
spec = importlib.util.spec_from_file_location("postflight", H / "postflight.py"); P = importlib.util.module_from_spec(spec); spec.loader.exec_module(P)

def save(name, obj):
    OUT.mkdir(exist_ok=True)
    with open(OUT / name, "x") as fh: json.dump(obj, fh, indent=1); fh.flush(); os.fsync(fh.fileno())
    print("saved", OUT / name); return OUT / name

def main(argv):
    a = argparse.ArgumentParser(); x = a.add_mutually_exclusive_group(required=True); x.add_argument("--pre", action="store_true"); x.add_argument("--post", action="store_true")
    a.add_argument("--receipt"); a.add_argument("--p0"); o = a.parse_args(argv)
    m = P.head(); ts = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    src = {"postflight.py": hashlib.sha256((H / "postflight.py").read_bytes()).hexdigest(), "transport": P.T[1]}
    if o.pre:
        text, secs = P.fill(P.P0), 60
        if P.enc_len(m.HEAD, text, secs) > P.LIMIT: raise SystemExit("p0 text too long")
        r = m.ps(text, secs); save(f"p0-{ts}.json", {**r, "source": src}); return 0 if "error" not in r else 3
    if not o.receipt: raise SystemExit("--receipt: the cutover's own result receipt (root-node-hold.py runs/cutover-result-RUN.json)")
    receipt = json.loads(pathlib.Path(o.receipt).read_text()); p0 = json.loads(pathlib.Path(o.p0).read_text()) if o.p0 else None
    if not str((P.journal(receipt)["final"] or "")).startswith(("DONE:", "DONE_PARTIAL:", "DONE_CHECK:")):
        raise SystemExit("the cutover did not end on a DONE* line: postflight does not apply (follow REVIEW.txt RECOVERY)")
    texts = P.post_texts(receipt); texts["logs"] = texts["logs"](p0)
    for k, (t, s) in texts.items():
        if P.enc_len(m.HEAD, t, s) > P.LIMIT: raise SystemExit(f"{k} text too long")
    post = {"at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "source": src, "receipt": str(o.receipt), "p0": str(o.p0) if o.p0 else None}
    for k, (t, s) in texts.items():
        r = m.ps(t, s); post[k] = r if "error" not in r else {}      # a failed read is EMPTY evidence (-> UNKNOWN), never a pass
        if "error" in r: post.setdefault("readErrors", {})[k] = str(r.get("error"))[:200]
    save(f"post-{ts}.json", post)
    v = P.evaluate(receipt, p0, post); save(f"verdict-{ts}.json", v); print(json.dumps({"required": v["required"], "optional": v["optional"]}, indent=1))
    return 0 if v["required"] == "PASS" else 3

if __name__ == "__main__": sys.exit(main(sys.argv[1:]))
