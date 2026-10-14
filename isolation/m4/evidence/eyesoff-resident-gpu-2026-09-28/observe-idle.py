from pathlib import Path
import subprocess,json,time,datetime
w=Path(__file__).parent;start=time.time();mono=time.monotonic();duration=660;rows=[]
while True:
 text=subprocess.check_output(['nvidia-smi','--query-gpu=index,memory.used,utilization.gpu','--format=csv,noheader,nounits'],text=True)
 cards=[]
 for line in text.splitlines():
  i,mem,util=map(int,line.split(','))
  if i in (1,2):cards.append({'index':i,'memory_mib':mem,'gpu_util_pct':util})
 assert len(cards)==2
 row={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'elapsed_s':time.monotonic()-mono,'cards':cards};rows.append(row)
 (w/'idle-observations.json').write_text(json.dumps({'start_unix':start,'duration_target_s':duration,'samples':rows},indent=2)+'\n')
 if row['elapsed_s']>=duration:break
 time.sleep(min(30,duration-row['elapsed_s']))
logs=subprocess.check_output(['journalctl','--user','-u','enclave-metal0-shield-v100-0.service','-u','enclave-metal0-shield-v100-1.service','--since','@'+str(int(start)),'--no-pager','-o','short-iso'],text=True)
closed=[line for line in logs.splitlines() if ' closed:' in line]
summary={'elapsed_s':rows[-1]['elapsed_s'],'samples':len(rows),'gpu1_initial_mib':rows[0]['cards'][0]['memory_mib'],'gpu2_initial_mib':rows[0]['cards'][1]['memory_mib'],'gpu1_min_mib':min(r['cards'][0]['memory_mib'] for r in rows),'gpu2_min_mib':min(r['cards'][1]['memory_mib'] for r in rows),'worker_disconnects':len(closed),'disconnect_events':closed,'no_test_inference_requests':True}
(w/'idle-summary.json').write_text(json.dumps(summary,indent=2)+'\n');print(json.dumps(summary),flush=True)
assert summary['elapsed_s']>=duration and summary['worker_disconnects']==0
assert summary['gpu1_min_mib']>=.95*summary['gpu1_initial_mib'] and summary['gpu2_min_mib']>=.95*summary['gpu2_initial_mib']
print('Production idle-residency observation passed.',flush=True)
