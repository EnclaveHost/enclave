from pathlib import Path
import subprocess,os,json
w=Path(__file__).resolve().parent
with (w/'cpu-micro.jsonl').open('w') as out:
 for i in range(3):
  order=['off','row','snapshot','both'];order=order if i%2==0 else order[::-1]
  for mode in order:
   env={**os.environ,'ENCLAVE_GGML_GDN_ROW_LOCALITY':str(int(mode in ['row','both'])),'ENCLAVE_GGML_GDN_NTSNAP':str(int(mode in ['snapshot','both'])),'LD_PRELOAD':'/home/steven/enclave-prod/release-fef26ae1/template/rt/libshielded-omp-affinity.so','SHIELDED_CPU_COMPUTE':'0,2,3,4,5,6'}
   p=subprocess.run([str(w/'gdn-bench'),'2','6','192','2','48'],env=env,check=True,capture_output=True,text=True)
   row={'round':i,'mode':mode,'stdout':p.stdout.strip()};out.write(json.dumps(row)+'\n');out.flush();print(row,flush=True)
