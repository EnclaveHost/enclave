import os,sys,subprocess
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True,timeout=2)
os.execv(sys.argv[1],sys.argv[1:])
