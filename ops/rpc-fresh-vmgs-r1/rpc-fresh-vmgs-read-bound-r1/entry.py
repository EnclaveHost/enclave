import subprocess
subprocess.run(['/usr/bin/python3','-B','/src/rpc/native/test_prepare_vmgs.py','FreshVMGS.test_tool_growth_stops_before_intent_or_execution','-v'],check=True,timeout=15)
