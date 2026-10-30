import importlib.util,pathlib,sys,tempfile,subprocess,signal,time,os
s=importlib.util.spec_from_file_location('watch',pathlib.Path(__file__).with_name('guest-build-watch-2.py'));m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as td:
 p=pathlib.Path(td);marker=p/'stop';stop=[sys.executable,'-c',f'from pathlib import Path; Path({str(marker)!r}).write_text("stop")']
 r=m.monitor([sys.executable,'-c','raise SystemExit(0)'],stop,p/'ok',read_memory=lambda:20000,interval=.01)
 assert r['exit']==0 and not marker.exists()
 r=m.monitor([sys.executable,'-c','raise SystemExit(7)'],stop,p/'failed',read_memory=lambda:20000,interval=.01)
 assert r['exit']==7 and marker.read_text()=='stop';marker.unlink()
 r=m.monitor(['/not-started'],stop,p/'low',read_memory=lambda:16383,interval=.01)
 assert r['exit']==98 and not r['started'] and not marker.exists() and not (p/'low').exists()
 readings=iter([20000,16383]);r=m.monitor([sys.executable,'-c','import time;time.sleep(20)'],stop,p/'drops',read_memory=lambda:next(readings,16383),interval=.01)
 assert r['exit']==99 and r['minimumAvailableMiB']==16383 and marker.exists();marker.unlink()
 # Real signal during monitoring: exact stop command runs and the local child is reaped.
 sender=subprocess.Popen([sys.executable,'-c',f'import os,signal,time;time.sleep(.1);os.kill({os.getpid()},signal.SIGTERM)'])
 r=m.monitor([sys.executable,'-c','import time;time.sleep(20)'],stop,p/'cancel',read_memory=lambda:20000,interval=.01);sender.wait()
 assert r['exit']==143 and marker.exists()
 marker.unlink();reads=[0]
 def bad_memory():
  reads[0]+=1
  if reads[0]>1:raise OSError('fixture memory read error')
  return 20000
 try:m.monitor([sys.executable,'-c','import time;time.sleep(20)'],stop,p/'error',read_memory=bad_memory,interval=.01)
 except OSError:pass
 else:raise AssertionError('expected memory error')
 assert marker.exists()
 print('PASS six monitor controls: success, remote failure, prestart floor, active floor, cancellation, unexpected observer error')
