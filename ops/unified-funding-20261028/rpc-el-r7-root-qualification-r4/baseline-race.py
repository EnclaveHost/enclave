import runpy
g=runpy.run_path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-control-vm-l1-client-root-r7-repaired-r2/test_source.py')
g['WatchdogReason'].invoke.__globals__['s']=__import__('pathlib').Path('/home/steven/Documents/Codex/2026-10-18/wo/work/rpc-production-final-20261025/unified-funding-20261028/rpc-control-vm-l1-client-root-r7-repaired-r1/source')
g['WatchdogReason']('test_stop_arrives_after_top_check').test_stop_arrives_after_top_check()
