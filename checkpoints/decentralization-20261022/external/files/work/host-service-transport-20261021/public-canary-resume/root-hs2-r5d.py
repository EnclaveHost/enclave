#!/usr/bin/env python3
"""ROOT-ONLY: the hs2 config-only upgrade for the DNS step (r5 -> r5d), driven by the REVIEWED compose5-review/root-hs2-r5.py
(28ca0cfe = 2b8b28fe + root's B1 orphan-helper gate, imported UNMODIFIED) with this bundle's pins. PREPARED by reviewer 9d; NEVER run by 9d.
  root-hs2-r5d.py --bundle <dir from make-r5d.mjs --old-receipt-sha .. --out ..> --pin <its manifest sha> [root-hs2-r5.py args]
Everything else (preflight default, --stage, --execute/--revert/--recover, attempt records, post evidence) is root-hs2-r5.py's,
with receipts in root-r5d/ instead of root-r5/.
"""
import hashlib, importlib.util, json, pathlib, sys

HERE = pathlib.Path(__file__).resolve().parent
DRIVER = (HERE.parent.parent / "compose5-review/root-hs2-r5.py", "28ca0cfeb0e5bfaffebad555f83e367a78b288c3a9a5cfa45b9ab191f9ce9dd4")

def main(argv):
    if hashlib.sha256(DRIVER[0].read_bytes()).hexdigest() != DRIVER[1]: raise SystemExit("root-hs2-r5.py is not the reviewed pin")
    take = lambda k: (argv[argv.index(k) + 1], argv[:argv.index(k)] + argv[argv.index(k) + 2:])
    bundle, argv = take("--bundle"); pin, argv = take("--pin"); cfg, argv = take("--config-sha")
    b = pathlib.Path(bundle); man = b / "upgrade-manifest.json"
    if hashlib.sha256(man.read_bytes()).hexdigest() != pin: raise SystemExit("the bundle manifest is not --pin")
    m = json.loads(man.read_text())
    if m["replace"] or m["add"] or m["config"]["old"] != "5768866dc1804435673174f673abfcd2aaf7da15f8fef18886c645ab9c94b87d" or m["config"]["new"] != cfg:
        raise SystemExit("not a config-only r5 -> r5d manifest for --config-sha")
    sp = importlib.util.spec_from_file_location("r5", DRIVER[0]); d = importlib.util.module_from_spec(sp); sp.loader.exec_module(d)
    d.BUNDLE, d.MSHA, d.OUT = b, pin, HERE / "root-r5d"
    d.BUNDLE_FILES = {"upgrade-manifest.json": pin, "config/host-services.json": cfg}
    return d.main(argv)

if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
