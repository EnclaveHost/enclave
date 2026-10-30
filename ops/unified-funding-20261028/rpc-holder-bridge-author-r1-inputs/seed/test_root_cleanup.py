"""Root regressions: actual exec signal inheritance and missing known process metadata."""
import json,os,signal,sys,tempfile,time,unittest
from pathlib import Path
import offline_mask as om


class CleanupBoundaryTests(unittest.TestCase):
    def test_exec_child_does_not_inherit_blocked_termination(self):
        with tempfile.TemporaryDirectory() as d:
            exposed=Path(d)/'exposed';exposed.write_bytes(b'x')
            report=Path(d)/'mask.json'
            script="import signal,json,sys,time;from pathlib import Path;Path(sys.argv[1]).write_text(json.dumps([int(x) for x in signal.pthread_sigmask(signal.SIG_BLOCK,[])]));time.sleep(10)"
            fx=om.OsEffects();registered=[]
            before=signal.pthread_sigmask(signal.SIG_BLOCK,[])
            try:
                fx.export_start([sys.executable,'-c',script,str(report)],d,str(exposed),1,3,1024,registered.append,'/usr/bin/fusermount3')
                end=time.monotonic()+3
                while not report.exists() and time.monotonic()<end:time.sleep(.01)
                self.assertTrue(report.exists())
                mask=json.loads(report.read_text())
                self.assertNotIn(int(signal.SIGTERM),mask,'actual exec child inherits blocked TERM: prompt cleanup ineffective')
                self.assertEqual(signal.pthread_sigmask(signal.SIG_BLOCK,[]),before)
            finally:
                # Fixture cleanup only: fake exposed file is not a mount. Never count this as product teardown proof.
                for h in registered:
                    p=h['proc']
                    if p.poll() is None:p.kill()
                    p.wait(timeout=3)
                    h['drainer'].join(3)
                    self.assertFalse(h['drainer'].is_alive())
                    p.stderr.close()
                signal.pthread_sigmask(signal.SIG_SETMASK,before)

    def test_missing_known_owned_metadata_is_not_death(self):
        fx=om.OsEffects(proc_table=lambda:{},proc_starttime=lambda pid:200)
        h={'pid':4242,'owned':{(4243,200)}}
        with self.assertRaisesRegex(om.Refusal,'(?i)(unreadable|visibility|metadata|incomplete)'):
            fx._owned_scan(h)


if __name__=='__main__':unittest.main()
