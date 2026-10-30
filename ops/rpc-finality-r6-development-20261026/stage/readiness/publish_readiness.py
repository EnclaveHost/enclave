#!/usr/bin/env python3
"""publish_readiness.py (base-finality-proof-stage/r6; PREPARED): run readiness_sampler ONCE as the unprivileged readiness user and
publish its report atomically as <dir>/latest.json (0644). The sampler's own exit code is returned (0 READY, 3 FAIL, 4 INCOMPLETE).
Usage: publish_readiness.py <out-dir> [sampler args...]   (enclave-base-readiness.service)"""
import os, pathlib, sys
sys.dont_write_bytecode = True
HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import readiness_sampler as rs  # noqa: E402


def main(argv):
    out = pathlib.Path(argv[0]); tmp = out / f'.sample-{os.getpid()}.json'
    code = rs.main(['--out', str(tmp), *argv[1:]])
    if tmp.exists():
        os.chmod(tmp, 0o644); os.replace(tmp, out / 'latest.json')
    return code


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
