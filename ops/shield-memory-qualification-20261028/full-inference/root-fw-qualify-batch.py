from pathlib import Path
import subprocess,sys
m=Path(__file__).resolve().parent
cases=[('candidate-debug','control4',True),('candidate-debug','notable',False),('candidate-debug','substitution',False),('candidate-release','control4',True),('candidate-release','notable',False),('candidate-release','substitution',False)]
for target,case,tq in cases:
 cmd=[sys.executable,str(m/'root-fw-boot-check.py'),'--target',target,'--case',case,'--execute','--attempt','r2']
 if tq:cmd.append('--test-qemu')
 subprocess.run(cmd,check=True)
