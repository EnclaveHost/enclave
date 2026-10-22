import pathlib,datetime,hashlib,hmac,http.client,json,re,os,collections
p=pathlib.Path('/home/steven/enclave-prod/apps-to-sia/sia-s3.client.env')
assert p.stat().st_mode & 0o077 == 0
v=dict(l.split('=',1) for l in p.read_text().splitlines() if '=' in l and not l.startswith('#'))
ak=v['AWS_ACCESS_KEY_ID'].strip().strip('\"\'');sk=v['AWS_SECRET_ACCESS_KEY'].strip().strip('\"\'')
host='ef514ed3.app.enclave.host';qs='limit=60&sia-diag=&timeout=30';region='auto';path='/'
now=datetime.datetime.now(datetime.timezone.utc);amz=now.strftime('%Y%m%dT%H%M%SZ');day=now.strftime('%Y%m%d');ph=hashlib.sha256(b'').hexdigest()
h={'host':host,'x-amz-date':amz,'x-amz-content-sha256':ph};signed=';'.join(sorted(h));canon='\n'.join(['GET',path,qs,''.join(f'{k}:{h[k]}\n' for k in sorted(h)),signed,ph]);scope=f'{day}/{region}/s3/aws4_request'
sts=f'AWS4-HMAC-SHA256\n{amz}\n{scope}\n{hashlib.sha256(canon.encode()).hexdigest()}'
k=hmac.new(('AWS4'+sk).encode(),day.encode(),hashlib.sha256).digest()
for part in (region,'s3','aws4_request'):k=hmac.new(k,part.encode(),hashlib.sha256).digest()
h['authorization']=f'AWS4-HMAC-SHA256 Credential={ak}/{scope}, SignedHeaders={signed}, Signature={hmac.new(k,sts.encode(),hashlib.sha256).hexdigest()}'
try:
 c=http.client.HTTPSConnection(host,443,timeout=110);c.request('GET',path+'?'+qs,headers=h);r=c.getresponse();b=r.read(131073);assert len(b)<=131072
 out={'httpStatus':r.status,'at':now.isoformat()}
 if r.status==200:
  x=json.loads(b);out.update({key:x.get(key) for key in ['hostsOffered','ok','withoutSiamux','failedByStage','elapsedMs','egress']})
  errs=collections.Counter()
  for q in x.get('probes',[]):
   if q.get('ok'):continue
   e=str(q.get('err',''))[:350].replace(ak,'[redacted]').replace(sk,'[redacted]');e=re.sub(r'(?:0x)?[a-fA-F0-9]{40,}','[hex]',e)
   errs[str(q.get('stage'))+': '+e]+=1
  out['errors']=dict(errs)
 else:out['bodyType']='json' if b.startswith(b'{') else 'other'
 pathlib.Path('work/enclavedns-upload-502-20261021/sia-diag-result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
except Exception as e:print(json.dumps({'failureType':type(e).__name__}));raise SystemExit(1)
