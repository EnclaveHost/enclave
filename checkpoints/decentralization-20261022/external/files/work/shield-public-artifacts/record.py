import json,pathlib,hashlib
root=pathlib.Path(__file__).resolve().parent
r=json.loads(pathlib.Path('outputs/shield-public-artifacts.json').read_text())
assert len(r['replicas'])==4
w=json.loads(pathlib.Path('outputs/shield-windows-candidate-staging.json').read_text())
assert w['Sha256']==r['artifacts'][0]['sha256'] and not w['Activated'] and not w['VMCreated']
record={'verifiedAt':r['at'],'artifacts':r['artifacts'],'replicas':[{'region':x['region'],'origin':x['origin'],'carBlocksAndReconstructedBytesVerified':x['sha256AndCarBlocksVerified'],'retrievedWithoutEnclaveDomain':x['retrievedWithoutEnclaveDomain']} for x in r['replicas']],'windowsRetrieval':{'source':w['Source'],'cid':w['Cid'],'bytes':w['Bytes'],'sha256':w['Sha256'],'stagedOnly':True},'operatorDiversityProven':False,'independentBuilderReproductionProven':False,'hardwareBootValidated':False,'guestActivated':False}
p=pathlib.Path('work/enclave/isolation/m3/shield-direct-candidate-20261020')
(p/'publication.json').write_text(json.dumps(record,indent=2)+'\n')
f=p/'README.md';s=f.read_text();s=s.replace('This is still one-builder reproduction. Independent publication,\nretrieval and another operator\'s rebuild remain unproven.','This is still one-builder reproduction; another operator\'s rebuild remains\nunproven.')
needle='Before activation: validate separate legacy/direct/GPU selection;'
section='''`publication.json` records public distribution of the candidate and portable
inputs. Each object has a UnixFS CID, raw-byte SHA-256 and CAR SHA-256. Four
existing providers serve both forms at `/ipfs/<CID>` and
`/ipfs/<CID>?format=car`. Fresh downloads from each provider's numeric address
verified every CAR block and reconstructed the exact original bytes, without
Nan, Enclave DNS or this workstation serving as the source. HTTP is transport
only: recipients must verify the published CID and pinned hashes.

The Windows host separately fetched the 77,056,796-byte candidate from a public
replica and verified its SHA-256 before staging it. No VM or image pointer was
changed. These are all existing Enclave-operated providers; this establishes
public retrieval and replica copies, not independent operator diversity.

'''
assert needle in s
if '`publication.json` records public distribution' not in s:s=s.replace(needle,section+needle)
f.write_text(s)
print('Recorded four verified public replicas and independent Windows-machine retrieval (not independent ownership or activation)')
