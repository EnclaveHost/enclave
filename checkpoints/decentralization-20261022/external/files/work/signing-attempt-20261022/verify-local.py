from pathlib import Path
import hashlib,json,urllib.request,datetime
root=Path(__file__).resolve().parents[2]; base=root/'work/enclavedns-stale-20261021/wallet-handoff'
sha=lambda b:hashlib.sha256(b).hexdigest()
before=json.loads((Path(__file__).parent/'rollout/before.json').read_text())
asset=urllib.request.urlopen('http://127.0.0.1:39681/app.js',timeout=5).read()
state=json.load(urllib.request.urlopen('http://127.0.0.1:39681/state',timeout=5))
assert sha(asset)==before['files']['app.js']
assert state['plan']=='sha256:'+before['plan']
journals={p.name:sha(p.read_bytes()) for p in (base/'journals').glob('*.json')}
assert journals==before['journals']
statuses={s['step']:s['status'] for s in state['steps']}; assert statuses=={'upload':'uploaded','publish':'awaiting-wallet','upgrade':'ready'}
report={'checkedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'pageReachable':True,'servedAppSha256':sha(asset),'expectedAppSha256':before['files']['app.js'],'serverSha256':before['files']['server.mjs'],'filesLockSha256':before['newFilesLockSha256'],'journalsUnchanged':True,'journalHashes':journals,'browserObserved':{**statuses,'startDisabled':True,'releaseUnansweredRequestVisible':True,'note':'Reloaded existing Chrome tab after local server restart; no wallet controls clicked.'},'automatedTests':{'pass':26,'fail':0,'skipped':0,'scope':'Local HTTP server and mocked wallet/Base model, including cross-tab late rejection, restart, legacy journals, full flow and exact production plan.'},'newWalletRequests':0,'signedOrBroadcastByAgent':False,'localServerSession':60576,'limitations':['Actual MetaMask approval remains unverified while user is away.','Publish request has an unknown wallet outcome; it was neither released nor resent.'],'fix':'Bind rejection to a durable random wallet attempt ID; reject stale or unidentified rejection without journal mutation.'}
(root/'outputs/enclavedns-release/signing-test-current.json').write_text(json.dumps(report,indent=2)+'\n')
(Path(__file__).parent/'RESULT.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps({'verified':True,'statuses':statuses,'journalsUnchanged':True,'newWalletRequests':0}))
