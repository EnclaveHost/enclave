import pathlib,subprocess,json,datetime,hashlib
root=pathlib.Path(__file__).resolve().parent
hosts={'us-west':'134.199.235.187','eu-central':'134.209.248.172','ap-southeast':'165.245.191.129','ca-east':'146.190.246.39'}
rows=[]
for host,ip in hosts.items():
 if host!='us-west':
  print('Publishing to '+host,flush=True)
  subprocess.run(['python3',str(root/'publish.py'),host],check=True)
 assert (root/(host+'-publication.json')).exists()
 target=root/('cold-readback-'+host)
 print('Cold CAR retrieval and reconstruction from '+host,flush=True)
 subprocess.run(['python3','work/enclave/network/replicate-artifacts.py',str(root/'manifest.json'),str(target),'http://'+ip+':8189'],check=True)
 rows.append({'region':host,'origin':'http://'+ip+':8189','sha256AndCarBlocksVerified':True,'retrievedWithoutEnclaveDomain':True,'publication':json.loads((root/(host+'-publication.json')).read_text())})
 report={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'artifacts':json.loads((root/'manifest.json').read_text())['verifiedObjects'],'replicas':rows,'operators':'Existing Enclave-operated providers; independent operator diversity not proven','guestActivated':False,'fullDecentralizationComplete':False}
 pathlib.Path('outputs/shield-public-artifacts.json').write_text(json.dumps(report,indent=2)+'\n')
 print('Verified '+host,flush=True)
