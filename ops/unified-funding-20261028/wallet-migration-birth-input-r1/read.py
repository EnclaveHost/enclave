import json,urllib.request,pathlib
p=pathlib.Path(__file__).resolve().parent
body=json.dumps({'jsonrpc':'2.0','id':1,'method':'eth_getTransactionByHash','params':['0xddc85def2d8bc739831b931a60ae2d0597e7e922812c3c582e9dbd5984609a89']}).encode()
with (p/'attempt').open('x') as f:f.write('one public transaction read')
r=urllib.request.urlopen(urllib.request.Request('https://api.enclave.host/rpc/base',data=body,headers={'Content-Type':'application/json'}),timeout=20)
b=r.read(262145);assert len(b)<=262144
j=json.loads(b);assert j.get('result')
(p/'result.json').write_text(json.dumps(j,indent=2)+'\n')
x=j['result'];print(json.dumps({'from':x['from'],'nonce':x['nonce'],'blockHash':x['blockHash'],'constructor':x['input'][-256:]}))
