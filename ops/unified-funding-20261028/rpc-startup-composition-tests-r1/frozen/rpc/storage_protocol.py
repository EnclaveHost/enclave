"""Owner-bound export metadata and guest attachment contracts.

Receipts report negotiated export metadata. They are not signatures, attestations,
writer-fence proofs or RPC readiness. Transfer them through the owner's authenticated
channel, bind the reviewed server contract/source, then verify the live TLS volume.
"""
import hashlib
import ipaddress
import json
import re

BYTES=4_000_000_000_000
UUIDS={'l1':'a2f2a8b5-06ac-4612-95a0-f48a00a7f6e0','base':'11c6bbac-f823-4052-a87a-066eed6ad590'}
WINDOW=900_000_000_000


def decode(raw):
    if not isinstance(raw,bytes) or len(raw)>65536:raise ValueError('Bounded public contract bytes required')
    def pairs(rows):
        result={}
        for key,value in rows:
            if key in result:raise ValueError('Duplicate contract field')
            result[key]=value
        return result
    return json.loads(raw,object_pairs_hook=pairs)


def sha(raw):return hashlib.sha256(raw).hexdigest()


def digest(value):
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{64}',value):raise ValueError('Pinned public digest required')


def boot(value):
    if not isinstance(value,str) or not re.fullmatch('[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}',value):
        raise ValueError('Exact Linux boot identity required')


def identity(attempt,instance):
    if not isinstance(attempt,str) or not re.fullmatch('[0-9a-f]{32}',attempt):raise ValueError('Exact attempt required')
    if not isinstance(instance,str) or not re.fullmatch('rpc-owned-[a-z0-9-]{8,64}',instance):raise ValueError('Exact guest instance required')


def window(start,end,now):
    if any(type(v) is not int for v in [start,end,now]) or start<0 or end-start!=WINDOW or not start<=now<end:
        raise ValueError('Original 900-second startup window required')


def negotiated(roles,attempt):
    if set(roles)!=set(UUIDS):raise ValueError('Both negotiated exports required')
    for role,row in roles.items():
        if set(row)!={'export','bytes','authenticated','flush','fua'}:raise ValueError('Exact negotiated metadata required')
        if row['export']!='rpc-'+attempt+'-'+role or type(row['bytes']) is not int or row['bytes']!=BYTES:
            raise ValueError('Negotiated volume identity differs')
        if any(row[k] is not True for k in ['authenticated','flush','fua']):raise ValueError('Authenticated writable export capabilities required')


def make_ready(server,contract_sha,roles,invocation,now):
    identity(server['attempt'],server['instance']);boot(server['bootId']);digest(contract_sha)
    window(server['createdUtcNs'],server['deadlineUtcNs'],now)
    if not isinstance(invocation,str) or not re.fullmatch('[0-9a-f]{32}',invocation):raise ValueError('Exact supervisor invocation required')
    negotiated(roles,server['attempt'])
    return {'schema':'owned-rpc-server-ready/1','attempt':server['attempt'],'instance':server['instance'],
        'bootId':server['bootId'],'contractSha256':contract_sha,'createdUtcNs':server['createdUtcNs'],
        'deadlineUtcNs':server['deadlineUtcNs'],'atUtcNs':now,'invocation':invocation,'roles':roles,'rpcReady':False}


def validate_ready(ready,contract,now):
    expected={'schema','attempt','instance','bootId','contractSha256','createdUtcNs','deadlineUtcNs','atUtcNs','invocation','roles','rpcReady'}
    if set(ready)!=expected or ready['schema']!='owned-rpc-server-ready/1' or ready['rpcReady'] is not False:
        raise ValueError('Exact server metadata receipt required')
    for left,right in [('attempt','attempt'),('instance','instance'),('bootId','serverBootId'),('contractSha256','serverContractSha256'),('createdUtcNs','createdUtcNs'),('deadlineUtcNs','deadlineUtcNs')]:
        if ready[left]!=contract[right]:raise ValueError('Server/guest attempt, identity or original window differs')
    make_ready(ready,ready['contractSha256'],ready['roles'],ready['invocation'],now)
    at=ready['atUtcNs']
    if type(at) is not int or not ready['createdUtcNs']<=at<=now:raise ValueError('Future or pre-attempt receipt')


def validate_attachment(c,now,guest_boot):
    if set(c)!={'schema','instance','bootId','attempt','createdUtcNs','deadlineUtcNs','serverBootId','serverContractSha256','serverReadySha256','roles'}:
        raise ValueError('Exact attachment v2 contract required')
    if c['schema']!='owned-rpc-attachment/2' or c['bootId']!=guest_boot:raise ValueError('Attachment boot/schema mismatch')
    identity(c['attempt'],c['instance']);boot(c['bootId']);boot(c['serverBootId'])
    window(c['createdUtcNs'],c['deadlineUtcNs'],now)
    digest(c['serverContractSha256']);digest(c['serverReadySha256'])
    if set(c['roles'])!=set(UUIDS):raise ValueError('Both storage roles required')
    for role,row in c['roles'].items():
        if set(row)!={'host','port','tlsName','export','bytes','uuid','caSha256','certificateSha256'}:
            raise ValueError('Exact endpoint fields required')
        ip=ipaddress.ip_address(row['host'])
        if ip.is_loopback or ip.is_unspecified or ip.is_multicast or ip.is_link_local:raise ValueError('Explicit unicast endpoint required')
        if type(row['port']) is not int or not 1024<=row['port']<=65535:raise ValueError('Invalid storage port')
        if type(row['bytes']) is not int or row['bytes']!=BYTES or row['uuid']!=UUIDS[role]:raise ValueError('Fixed expected volume identity differs')
        if row['export']!='rpc-'+c['attempt']+'-'+role or row['tlsName']!='rpc-storage-'+c['attempt']+'-'+role:
            raise ValueError('Attempt/role endpoint binding differs')
        digest(row['caSha256']);digest(row['certificateSha256'])


def compose(server_raw,ready_raw,credential_raw,guest_boot,now):
    """Transform reviewed public bytes; no new authority, receipt flags or deadlines."""
    server=decode(server_raw);ready=decode(ready_raw);credential=decode(credential_raw)
    if credential.get('schema')!='owned-rpc-credentials/1' or set(credential['roles'])!=set(UUIDS):raise ValueError('Exact owner credential receipt required')
    if (credential['attempt'],credential['instance'])!=(server['attempt'],server['instance']):raise ValueError('Credentials belong to another guest/attempt')
    if set(server['roles'])!=set(UUIDS):raise ValueError('Both server contract roles required')
    c={'schema':'owned-rpc-attachment/2','attempt':server['attempt'],'instance':server['instance'],'bootId':guest_boot,
       'serverBootId':server['bootId'],'serverContractSha256':sha(server_raw),'serverReadySha256':sha(ready_raw),
       'createdUtcNs':server['createdUtcNs'],'deadlineUtcNs':server['deadlineUtcNs'],'roles':{}}
    for role,row in server['roles'].items():
        keys=credential['roles'][role]
        if row['tlsName']!=keys['tlsName'] or keys['clientDN']!='CN=rpc-client-'+c['attempt']+'-'+role:
            raise ValueError('Owner credential/server name mismatch')
        c['roles'][role]={'host':row['host'],'port':row['port'],'tlsName':row['tlsName'],
            'export':'rpc-'+c['attempt']+'-'+role,'bytes':row['bytes'],'uuid':UUIDS[role],
            'caSha256':keys['caSha256'],'certificateSha256':keys['clientCertificateSha256']}
    validate_attachment(c,now,guest_boot);validate_ready(ready,c,now)
    return c
