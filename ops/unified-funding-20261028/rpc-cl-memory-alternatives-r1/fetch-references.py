from pathlib import Path
import urllib.request,hashlib,json
p=Path(__file__).resolve().parent
r=p/"references";r.mkdir(exist_ok=False)
refs={
"nimbus-conf.nim":"https://raw.githubusercontent.com/status-im/nimbus-eth2/v26.10.2/beacon_chain/conf.nim",
"nimbus-rest-beacon.nim":"https://raw.githubusercontent.com/status-im/nimbus-eth2/v26.10.2/beacon_chain/rpc/rest_beacon_api.nim",
"nimbus-rest-node.nim":"https://raw.githubusercontent.com/status-im/nimbus-eth2/v26.10.2/beacon_chain/rpc/rest_node_api.nim"}
out=[]
for name,url in refs.items():
 with urllib.request.urlopen(url,timeout=15) as response:
  data=response.read(524289)
  assert len(data)<=524288, "source exceeds bound"
 (r/name).write_bytes(data)
 out.append({"path":name,"url":url,"bytes":len(data),"sha256":hashlib.sha256(data).hexdigest()})
(p/"REFERENCE-PINS.json").write_text(json.dumps(out,indent=2)+"\n")
print(json.dumps({"files":len(out),"bytes":sum(x["bytes"] for x in out)}))
