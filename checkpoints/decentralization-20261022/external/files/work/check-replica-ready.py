import sys,time,urllib.request,json
ip=sys.argv[1];url='http://'+ip+':8189/ipfs/bafybeia5ep5txxswpmdu5gez4v4albuwzgyhquncgvf6imwicbwpe2od44';deadline=time.monotonic()+90
while True:
 try:
  with urllib.request.urlopen(urllib.request.Request(url,method='HEAD'),timeout=3) as r:
   if r.status!=200 or r.headers.get('Content-Length')!='1455741':raise RuntimeError('unexpected artifact response')
  print(json.dumps({'origin':ip,'ready':True}),flush=True);break
 except Exception:
  if time.monotonic()>deadline:raise
  time.sleep(2)
