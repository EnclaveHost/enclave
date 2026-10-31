"""Actual finite fork/pipe/pidfd/deadline tests, no production resources."""
import importlib.util
import json
import os
from pathlib import Path
import signal
import sys
import time
import unittest

sys.path.insert(0,str(Path(__file__).resolve().parents[2]/'rpc/server'))
import guarded_export as g

GOOD={'authenticated':True,'availableMiB':40000,'pendingMiB':1000,'floorMiB':27648,'unreadUnits':0}
def command(row=GOOD,delay=0):
    return [sys.executable,'-c','import time;time.sleep('+repr(delay)+');print('+repr(json.dumps(row))+',flush=True)']
def blocked(channel,deadline):
    while True:time.sleep(.05)
def ready(channel,deadline):
    channel.send(b'READY {}')
    while True:time.sleep(.05)

class Tests(unittest.TestCase):
    def run_guard(self,owner,argv,seconds=.3,adopted=lambda:False):
        beats=[];rows=[];start=time.monotonic()
        result=g.guard(owner,argv,start+seconds,27648,512,lambda:beats.append(time.monotonic()),rows.append,adopted)
        self.assertLess(time.monotonic()-start,seconds+1.1)
        self.assertTrue(beats)
        self.assertFalse(result['writersFenced']);self.assertFalse(result['reservationMayRelease'])
        return result,rows
    def test_blocked_owner_original_deadline(self):
        r,_=self.run_guard(blocked,command());self.assertTrue(r['released']);self.assertEqual(r['reason'],'startup-deadline')
    def test_expired_before_fork(self):
        with self.assertRaises(ValueError):g.guard(blocked,command(),time.monotonic()-1,27648,512,lambda:None,lambda _:None,lambda:False)
    def test_low_reserve_never_opens_gate(self):
        r,_=self.run_guard(blocked,command(dict(GOOD,availableMiB=28000)),seconds=1)
        self.assertEqual(r['reason'],'host-reserve');self.assertFalse(r['released'])
    def test_hung_resource_never_opens_gate(self):
        r,_=self.run_guard(blocked,command(delay=5),seconds=2)
        self.assertEqual(r['reason'],'resource-observer-timeout');self.assertFalse(r['released'])
    def test_wrong_authority_cleans_gated_owner(self):
        with self.assertRaises(ValueError):self.run_guard(blocked,command(dict(GOOD,authenticated=False)),seconds=1)
    def test_owner_exit_is_terminal(self):
        r,_=self.run_guard(lambda *_:None,command(),seconds=1)
        self.assertIn(r['reason'],['owner-exited','owner-channel-closed']);self.assertTrue(r['released']);self.assertEqual(r['ownerExit'],0)
    def test_readiness_does_not_adopt(self):
        r,rows=self.run_guard(ready,command());self.assertEqual(rows,[{}]);self.assertFalse(r['adopted']);self.assertEqual(r['reason'],'startup-deadline')
    def test_adoption_must_remain(self):
        count=[0]
        def adopted():
            count[0]+=1
            return count[0]==1
        with self.assertRaises(ValueError):self.run_guard(ready,command(),seconds=1,adopted=adopted)

if __name__=='__main__':unittest.main(verbosity=2)
