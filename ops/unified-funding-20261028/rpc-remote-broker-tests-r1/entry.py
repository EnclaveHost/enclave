import os,subprocess,sys
subprocess.run(['/usr/sbin/ip','link','set','lo','up'],check=True,timeout=2)
os.execv('/usr/bin/go',['/usr/bin/go']+sys.argv[1:])
