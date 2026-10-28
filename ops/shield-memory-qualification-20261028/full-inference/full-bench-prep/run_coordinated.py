"""Hold both shared coding lanes throughout this separately coordinated GPU/VM slot."""
from pathlib import Path
import fcntl,sys
import fullbench
ROOT=Path('/home/steven/Documents/Codex/2026-10-18/wo/work')
def main():
 locks=[]
 try:
  if '--execute' in sys.argv:
   for name in ('claude-test-queue.lock','claude-test-small-queue.lock'):
    f=(ROOT/name).open('a+')
    try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
    except BlockingIOError:
     f.close();print('Refusing: shared work lane occupied',file=sys.stderr);return 98
    locks.append(f)
  return fullbench.main()
 finally:
  for f in locks:f.close()
if __name__=='__main__':sys.exit(main())
