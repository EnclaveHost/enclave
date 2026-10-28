#!/usr/bin/env python3
"""Hold both shared coding lanes throughout the separately coordinated VM slot."""
from pathlib import Path
import fcntl
import run_snp_ab
import sys
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
def main():
    locks=[]
    if '--execute' in sys.argv:
        for name in ('claude-test-queue.lock','claude-test-small-queue.lock'):
            f=(ROOT/name).open('a+')
            try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except BlockingIOError:
                print('Refusing: shared work lane occupied',file=sys.stderr);return 98
            locks.append(f)
    try:return run_snp_ab.main()
    finally:
        for f in locks:f.close()
if __name__=='__main__':sys.exit(main())
