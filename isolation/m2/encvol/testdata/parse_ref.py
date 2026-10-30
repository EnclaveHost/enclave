#!/usr/bin/env python3
"""The standard runtime's own encVolumes parser, as the reference for encvol.Parse (encvol_test.go).

Reads a JSON list of config objects on stdin, runs wasm/wasm_manager.py's _parse_enc_volumes on each and prints a JSON
list of {"ok": [spec...]} or {"err": "<message>"}. Imports the real module from this repository with every directory it
creates redirected to a temp dir; never starts the manager."""
import json, os, pathlib, sys, tempfile

repo = pathlib.Path(__file__).resolve().parents[4]
tmp = tempfile.mkdtemp(prefix="encvol-parse-ref-")
for k in ("WASM_LOG_DIR", "WASM_FS_DIR", "WASM_ENC_DIR", "WASM_APPS_DIR"):
    os.environ[k] = os.path.join(tmp, k.lower())
os.environ.setdefault("RCLONE_BIN", sys.argv[1] if len(sys.argv) > 1 else "rclone")
sys.path.insert(0, str(repo / "wasm"))
import contextlib  # noqa: E402
with contextlib.redirect_stdout(sys.stderr):  # the manager announces itself on import; stdout is the JSON alone
    import wasm_manager as m  # noqa: E402

out = []
for cfg in json.load(sys.stdin):
    try:
        with contextlib.redirect_stdout(sys.stderr):
            out.append({"ok": m._parse_enc_volumes(cfg)})
    except ValueError as e:
        out.append({"err": str(e)})
print(json.dumps(out))
