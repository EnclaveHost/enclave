from pathlib import Path
import json,re,statistics,hashlib
w=Path(__file__).resolve().parent
rows={}
for p in sorted(w.glob('native*.json')):
 try:d=json.loads(p.read_text())
 except ValueError:continue
 if not isinstance(d,dict) or 'decode_tok_s' not in d:continue
 log=p.with_suffix('.err').read_text()
 summaries=re.findall(r'\[bench\] shielded: offloaded=(\d+) local=(\d+) GMAC=[\d.]+ verify_fail=(\d+)',log)
 assert summaries and int(summaries[-1][0])>0 and summaries[-1][1:]==('0','0'),p
 assert d['text_identical'] is True and d['obs_fail']==0 and d['first_diff_token']==-1,p
 assert not re.search(r'verification FAILED|all operations stay on CPU|exceeds the budget|cannot reserve',log),p
 rows[p.stem]={k:d[k] for k in ['prompt_tokens','generated','plain_generated','plain_tok_s','decode_tok_s','verify_ms_per_round','draft_ms_per_round','rounds','accepted','text_identical','obs_fail']}
 rows[p.stem]['offloaded_nodes']=int(summaries[-1][0]);rows[p.stem]['log_sha256']=hashlib.sha256(p.with_suffix('.err').read_bytes()).hexdigest()
snp={}
for label,vcpu,decode,refill in [('refill16',16,8,16),('refill24',24,8,16),('wb',24,8,16),('four',16,4,16),('vector',16,4,16)]:
 a=json.loads((w/f'{label}-results.json').read_text());assert len(a)==7 and len({tuple(x['tokens']) for x in a})==1
 for i in range(1,8):
  log=(w/f'{label}-run{i}.txt').read_text();assert 'RESULT gate=open' in log and 'RESULT app_status=200' in log
 snp[label]={'vcpus':vcpu,'decode_threads':decode,'refill_threads_total':refill,'vector_crt':label=='vector','tokens':len(a[0]['tokens']),'all_tokens_identical':True,'measurement':(w/f'{label}-measurement.txt').read_text().strip(),'modes':{}}
 for mode,subset in [('plain',[x for x in a if not x['mtp'] and not x['fast']]),('topk',[x for x in a if not x['mtp'] and x['fast']]),('mtp',[x for x in a if x['mtp']])]:
  snp[label]['modes'][mode]={'rates':[x['tok_per_s'] for x in subset],'median_tok_s':statistics.median(x['tok_per_s'] for x in subset),'aggregate_tok_s':sum(len(x['tokens'])-1 for x in subset)/(sum(x['decode_ms'] for x in subset)/1000)}
(w/'summary.json').write_text(json.dumps({'native':rows,'snp':snp},indent=2)+'\n')
print('Validated',len(rows),'native runs and',len(snp)*7,'attested guest requests; wrote summary.json')
