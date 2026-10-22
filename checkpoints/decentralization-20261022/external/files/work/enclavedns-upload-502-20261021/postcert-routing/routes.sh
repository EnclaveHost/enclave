#!/usr/bin/env bash
# READ-ONLY public GETs: the directory's route map, filtered to sia-s3 (ef514ed3), from the canonical API and both exits.
for u in https://api.enclave.host/v1/network/routes; do
  echo "== $u $(date -u +%TZ)"; curl -sS --max-time 20 "$u" -o /tmp/routes.$$.json -w 'code=%{http_code} bytes=%{size_download}\n'
  python3 - /tmp/routes.$$.json <<'P'
import json,sys
try: d=json.load(open(sys.argv[1]))
except Exception as e: print('unparsed',e); sys.exit()
def walk(o,path=''):
    if isinstance(o,dict):
        for k,v in o.items():
            if 'ef514ed3' in str(k).lower(): print('KEY',path+'/'+str(k), json.dumps(v)[:400])
            walk(v,path+'/'+str(k))
    elif isinstance(o,list):
        for i,v in enumerate(o):
            if 'ef514ed3' in json.dumps(v).lower() and not isinstance(v,(dict,list)) : print('VAL',path,v)
            elif isinstance(v,dict) and any('ef514ed3' in str(x).lower() for x in v.values() if isinstance(x,str)): print('ITEM',path,json.dumps(v)[:400])
            walk(v,path+f'[{i}]')
print('top', list(d)[:10] if isinstance(d,dict) else type(d).__name__)
for k in ('pending','withheld','apps','routes'):
    if isinstance(d,dict) and k in d: print(k, 'count', len(d[k]) if hasattr(d[k],'__len__') else d[k])
walk(d)
P
  rm -f /tmp/routes.$$.json
done
