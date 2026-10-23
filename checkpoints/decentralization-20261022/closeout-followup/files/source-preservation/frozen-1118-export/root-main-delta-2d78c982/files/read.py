import subprocess,json,datetime,pathlib
old='7752a4239b3bec2cf452491cd1b95164a8c2bdb8';new='68b82926968c99503d38ae78dbcb04694cc2c56c'
r=subprocess.run(['gh','api','repos/EnclaveHost/enclave/compare/'+old+'...'+new],capture_output=True,text=True,timeout=30,check=True)
b=json.loads(r.stdout)
o={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'old':old,'new':new,'status':b.get('status'),'aheadBy':b.get('ahead_by'),'behindBy':b.get('behind_by'),'totalCommits':b.get('total_commits'),'commits':[{'sha':x['sha'],'message':x['commit']['message'],'time':x['commit']['committer']['date']} for x in b.get('commits',[])],'files':[{'name':x['filename'],'status':x['status'],'additions':x['additions'],'deletions':x['deletions']} for x in b.get('files',[])]}
pathlib.Path('work/root-main-delta-20261023/RESULT.json').write_text(json.dumps(o,indent=2)+'\n');print(json.dumps(o))
