import json,pathlib
p=pathlib.Path('/home/steven/enclave-prod/custodian-v2/config.json');j=json.loads(p.read_text());print(json.dumps({k:j.get(k) for k in ['registryKeyFile','submitterKeyEnv','endpoint','registryEndpoint','vault']}))
