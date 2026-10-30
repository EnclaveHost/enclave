#!/usr/bin/env python3
"""production-bootstrap-wiring-stage (PREPARED; NOT run): ROOT runs the reviewed capture module's ORIGINAL-GAME recheck for the first
bootstrap (harness-first a1Mode capture-original-recheck). It is only a launcher with the production inputs; it decides nothing and
writes no receipt of its own:
  - the capture module is loaded by the installed, pinned first harness's own load_capture() (HOLD unless root's activation artifact
    names that harness for A1_FIRST_CAPTURE_REVIEWED; the module's sha is the harness's A1_CAPTURE_SHA256);
  - mode `recheck`: the module's RECHECK_ORIGINAL game/N/root and its INITIAL_SHA256 pin (b9a90847, the existing live-1958 receipt,
    installed root-owned at /opt/enclave-rpc/bootstrap/a1-initial-evidence.json; never re-made or edited);
  - Sources ONLY from root's /etc/enclave-rpc/a1-capture-sources.json (guest EL 127.0.0.1:18645, guest Helios config, installed
    modules/deps/node; never the module's workstation defaults), plus that initial receipt path;
  - then the module's verify() once, as a pre-flight. The HARNESS re-verifies it, checks freshness and admits it (a2, release);
    the producer re-verifies the A2 and release captures again. A capture is admitted at most once: run this before EACH of a2 and
    release (plan only checks).
  a1_capture_original.py run <new-out-dir>
Exit 0: prints the harness config values {a1Mode, a1CaptureOut, a1Evidence}; 75 the capture run failed (new out dir, retry);
78 HOLD; 1 refused; 2 usage."""
import dataclasses, hashlib, json, os, pathlib, stat, sys, types

FIRST = (pathlib.Path('/opt/enclave-rpc/a2a4/a2a4.py'), 'a2fd563a024f6b90246a815ad62db521f25eb3e54bcef600215a43944d7690e0')   # composition: the composed harness-first sha
SELECTION_SHA256 = 'e6c312f4007f6d747197a6569eaeb36c8c949a0819be49738ce6a0723b999532'
SOURCES = pathlib.Path('/etc/enclave-rpc/a1-capture-sources.json')
# r2: EXPLICIT, bounded run limits (capture() defaults to helios_timeout=90; a fresh guest Helios measured > 120 s to fresh-finalized from
# the pinned checkpoint; the original-game canary uses 900). These bound only how long the launcher WAITS: Helios must still reach the
# pinned binary's `fresh-finalized` status (verify), the receipt/L1 ages and the 300 s window are the harness's, unchanged. No proof
# or freshness check is relaxed.
HELIOS_COLD_START_SEC = 900
A1_RUN_SEC = 240                                    # == capture()'s default a1_timeout, stated explicitly (cold reader budget 200 s)
CAP_SOURCE, CAP_RECEIPT = 4 << 20, 1 << 20          # read_root bounds: harness modules (~100 KB) / the 3950-byte initial receipt
INITIAL = pathlib.Path('/opt/enclave-rpc/bootstrap/a1-initial-evidence.json')


def read_root(p, cap=CAP_SOURCE):
    fd = os.open(p, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        st = os.fstat(fd)
        if not stat.S_ISREG(st.st_mode) or st.st_uid != 0 or st.st_mode & 0o022:
            raise ValueError(f'{p} must be a root-owned regular file, not group/other writable')
        b = b''
        while len(b) <= cap and (c := os.read(fd, 1 << 20)):
            b += c
        if len(b) > cap:
            raise ValueError(f'{p} exceeds {cap} bytes')
        return b
    finally:
        os.close(fd)


def exec_bytes(name, b, path):
    m = types.ModuleType(name); m.__file__ = str(path); sys.modules[name] = m     # reviewed() hashes exactly this path
    exec(compile(b, str(path), 'exec'), m.__dict__)
    return m


def run(out, HF, C, src, pins=None, hooks=None):
    if os.path.lexists(out):
        raise ValueError(f'{out} exists: every recheck is a NEW directory')
    ok, res = C.capture('recheck', out, src=src, pins=pins, hooks=hooks, helios_timeout=HELIOS_COLD_START_SEC, a1_timeout=A1_RUN_SEC)
    if not ok:
        return 75, {'ok': False, 'capture': 'failed', 'error': str(res.get('error') or res.get('a1Exit'))[:300]}
    s = C.verify(out, pins=pins, node=src.node, workdir=str(pathlib.Path(out).parent))
    if s['mode'] != 'recheck' or s['boundInputs'].get('inputs/initial-a1-evidence.json') != HF.A1_INITIAL_SHA256:
        return 1, {'ok': False, 'refused': 'not a recheck of the source-pinned initial receipt'}
    return 0, {'ok': True, 'config': {'a1Mode': 'capture-original-recheck', 'a1CaptureOut': str(out),
                                      'a1Evidence': os.path.join(str(out), 'capture', 'evidence.json')},
               'capture': {k: s[k] for k in ('captureId', 'captureSha256', 'evidenceSha256', 'finishedAt')}}


def main(argv):
    if os.geteuid() != 0:
        print('REFUSED: root only'); return 2
    if len(argv) != 3 or argv[1] != 'run' or not os.path.isabs(argv[2]):
        print(__doc__); return 2
    try:
        b, sb = read_root(FIRST[0]), read_root(FIRST[0].parent / 'selection.py')
        if hashlib.sha256(b).hexdigest() != FIRST[1] or hashlib.sha256(sb).hexdigest() != SELECTION_SHA256:
            raise ValueError(f'{FIRST[0]} is not the reviewed first harness')
        exec_bytes('selection', sb, FIRST[0].parent / 'selection.py'); HF = exec_bytes('a2a4_first_reviewed', b, FIRST[0])
        try:
            C = HF.load_capture()
        except HF.Refused as e:
            print(json.dumps({'ok': False, 'hold': str(e)})); return 78
        read_root(INITIAL, CAP_RECEIPT)
        src = dataclasses.replace(C.Sources.from_settings(SOURCES), initial_receipt=INITIAL)
        rc, r = run(argv[2], HF, C, src)
    except Exception as e:                                   # noqa: BLE001 - the reviewed modules' own refusals
        print(json.dumps({'ok': False, 'refused': f'{type(e).__name__}: {str(e)[:400]}'})); return 1
    print(json.dumps(r, indent=1)); return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv))
