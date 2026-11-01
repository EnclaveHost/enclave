"""Compose original owner inputs from actual, still-untrusted guest enrollment.

Runs inside owner_bootstrap_entry's existing independent envelope after source
verification. No listener, issuer, export, new key, clock or journal is created.
The owner-selected template fixes all authority and paths; enrollment supplies
only the guest's public request/certificate. Attestation and chain checks remain
in the unchanged owner actors before any consent or writable grant.
"""
import base64
import hashlib
import os
from pathlib import Path
import re
import ssl
import subprocess


def prepare(entry, config, original):
    c=entry.c
    template=c.protocol.decode(c.read_pinned(config['preparation']))
    fields={'schema','scope','native','bundle','manifest','exportPreparation',
            'control','policy','ownerProvision','binary'}
    if set(template)!=fields or template['schema']!='enclave-rpc-owner-enrollment-preparation/1':
        raise ValueError('Exact owner enrollment preparation required')
    scope=template['scope']
    if set(scope)!={'appId','deployment','profile','l1Volume','baseVolume'}:
        raise ValueError('Fixed owner application scope required')
    enrollment=c.protocol.decode(c.read_pinned(config['enrollment']))
    if set(enrollment)!={'token','vmGuid','ownershipReceiptSha256','originalOriginMs','originalDeadlineMs','enrollment'}:
        raise ValueError('Exact actual native enrollment required')
    if (set(template['native'])!={'vmGuid','ownershipReceiptSha256'} or
            any(enrollment[k]!=v for k,v in template['native'].items()) or
            enrollment['originalOriginMs']!=str(original['windowsOriginMilliseconds']) or
            enrollment['originalDeadlineMs']!=str(original['windowsDeadlineMilliseconds'])):
        raise ValueError('Original native enrollment binding differs')
    candidate=enrollment['enrollment']
    if not isinstance(candidate,dict) or set(candidate)!={'info','keys'}:
        raise ValueError('Exact guest candidate required')
    info=candidate['info']
    if (not isinstance(info,dict) or set(info)!={'purpose','request','requestSha256','runtime','transportKey','certificate','rootsGranted','rpcReady'} or
            info['purpose']!='enclave-rpc-storage-bootstrap/1' or info['rootsGranted'] is not False or info['rpcReady'] is not False):
        raise ValueError('Ungranted public guest enrollment required')
    request=info['request']
    if (not isinstance(request,dict) or set(request)!={'appId','baseVolume','boot','deadlineMonotonicNs','deployment','l1Volume','nonce','originMonotonicNs','profile','schema'} or
            request['schema']!='enclave-rpc-storage-acquire/1' or any(request[k]!=v for k,v in scope.items())):
        raise ValueError('Guest request differs from fixed owner scope')
    for key in ('appId','baseVolume','l1Volume','nonce','profile'):
        c.protocol.digest(request[key])
        if request[key]=='0'*64:raise ValueError('Nonzero guest request identity required')
    c.protocol.boot(request['boot'])
    if (not re.fullmatch('0x[0-9a-f]{64}',request['deployment']) or request['deployment']=='0x'+'0'*64 or
            request['baseVolume']==request['l1Volume'] or not request['boot'].replace('-','').strip('0') or
            any(type(request[k]) is not int or not 0<=request[k]<=2**53-1 for k in ('originMonotonicNs','deadlineMonotonicNs')) or
            request['deadlineMonotonicNs']-request['originMonotonicNs']!=900_000_000_000):
        raise ValueError('Original guest request identity/window required')
    request_sha=hashlib.sha256(c.encode(request).strip()).hexdigest()
    if info['requestSha256']!=request_sha:raise ValueError('Actual guest request digest differs')
    certificate=base64.b64decode(info['certificate'],validate=True)
    if not 0<len(certificate)<=16384 or base64.b64encode(certificate).decode()!=info['certificate']:
        raise ValueError('Bounded canonical guest certificate required')
    client_sha=hashlib.sha256(certificate).hexdigest()
    export=c.protocol.decode(c.read_pinned(template['exportPreparation']))
    if set(export)!={'clock','credentialReceipt','resourceConfig','runtimePins','roles','stateParent','output','floorMiB','reserveMiB'} or export['clock']!=config['clock']:
        raise ValueError('Original unconsumed export preparation required')
    policy=c.protocol.decode(c.read_pinned(template['policy']))
    if (set(policy)!={'schema','runtime','l1Volume','baseVolume','chainId','ledger','rpcs','confirmations','maxAgeSeconds'} or
            policy['schema']!='enclave-rpc-storage-owner/1' or any(policy[k]!=scope[k] for k in ('l1Volume','baseVolume'))):
        raise ValueError('Fixed independent owner policy required')
    control=template['control']
    if set(control)!={'host','port','serverKey','serverCert'}:raise ValueError('Fixed owner control endpoint required')
    # This must precede opening the private TLS key or consuming preparation.
    observer=['/usr/bin/node',str(entry.HERE/'observe_resources.mjs'),export['resourceConfig']['path']]
    for path in observer:
        with open(path,'rb') as f:
            if hashlib.file_digest(f,'sha256').hexdigest()!=export['runtimePins'][path]:
                raise ValueError('Original resource reader pin differs')
    c.read_pinned(export['resourceConfig'])
    observed=subprocess.run(observer,capture_output=True,timeout=3,check=True)
    if len(observed.stdout)+len(observed.stderr)>65536:raise ValueError('Resource observation bound')
    resource=c.protocol.decode(observed.stdout)
    if (resource.get('authenticated') is not True or resource.get('unreadUnits')!=0 or
            any(type(resource.get(k)) is not int or resource[k]<0 for k in ('availableMiB','pendingMiB','floorMiB')) or
            resource['availableMiB']-resource['pendingMiB']-1408<max(27648,export['floorMiB'],resource['floorMiB'])):
        raise ValueError('Whole owner bootstrap admission refused')
    def read(binding,maximum):
        if set(binding)!={'path','sha256'}:raise ValueError('Exact pinned owner input required')
        fd=entry.e.held(binding['path'],maximum,wanted=binding['sha256'])
        try:
            raw=os.read(fd,maximum+1)
            if not 0<len(raw)<=maximum:raise ValueError('Owner input bound')
            return raw
        finally:os.close(fd)
    bundle=read(template['bundle'],2<<20);manifest=read(template['manifest'],65536)
    if hashlib.sha256(bundle).hexdigest()!=scope['appId']:raise ValueError('Owner-selected app bundle differs')
    prepared={'bundle':base64.b64encode(bundle).decode(),'manifest':base64.b64encode(manifest).decode(),'request':request}
    # Reuse the actual wire decoder, including its canonical/complete bound.
    from importlib.util import spec_from_file_location,module_from_spec
    def load(name):
        spec=spec_from_file_location('rpc_enrollment_'+name,entry.HERE/(name+'.py'))
        module=module_from_spec(spec);spec.loader.exec_module(module);return module
    dispatcher=load('dispatch_owner');dispatcher.decode_owner_request(c.encode(prepared).strip())
    owner=entry.load_owner_state();owner.inspect(template['ownerProvision'],{'roles':export['roles']},policy)
    # The permanent fixed subtree consumes preparation, including partial writes.
    parent=c.directory(Path(config['clock']['path']).parent);out=parent/'owner-enrollment'
    c.validate(config['clock']);entry.envelope(original)
    out.mkdir(mode=0o700);c.sync_directory(parent)
    c.write_new(out/'prepare.intent',c.encode({'clock':config['clock'],'template':config['preparation'],
        'enrollment':config['enrollment'],'requestSha256':request_sha,'clientCertificateSha256':client_sha,
        'resource':resource,'guestAuthenticated':False,'rpcReady':False}))
    for name in ('control-tls','exports','dispatches'):
        (out/name).mkdir(mode=0o700)
    c.sync_directory(out)
    tls=out/'control-tls'
    cert=read(control['serverCert'],16384)
    server_der=ssl.PEM_cert_to_DER_cert(cert.decode('ascii'))
    c.write_new(tls/'server-cert.pem',cert)
    # Private bytes stay in the owner's protected namespace, never in a result.
    key=bytearray(read(control['serverKey'],16384))
    try:c.write_new(tls/'server-key.pem',key)
    finally:key[:]=b'\0'*len(key)
    c.write_new(tls/'ca-cert.pem',ssl.DER_cert_to_PEM_cert(certificate).encode('ascii'))
    export['output']=str(out/'exports'/original['attempt'])
    export['appControl']={'schema':'enclave-rpc-export-control/1','host':control['host'],'port':control['port'],
        'tls':str(tls),'clientCertificateSha256':client_sha,'requestSha256':request_sha}
    export_result=load('prepare_export').prepare(export)
    contract=export_result['contract'];actual=c.protocol.decode(c.read_pinned(contract))
    policy['export']={'host':control['host'],'port':control['port'],'contractSha256':contract['sha256'],
        'clientCertificateSha256':client_sha,'serverCertificateSha256':hashlib.sha256(server_der).hexdigest()}
    owner.inspect(template['ownerProvision'],actual,policy)
    signer_sources={str(entry.HERE/n) for n in ('owner_entry.py','owner_state.py','volume_export.py')}
    signer_sources|={str(entry.HERE.parent/n) for n in ('startup_clock.py','storage_protocol.py')}|{'/usr/bin/bwrap','/usr/bin/python3'}
    dispatcher_sources={str(p) for p in entry.HERE.parent.rglob('*.py')}|{'/usr/bin/python3','/usr/bin/systemd-run','/usr/bin/systemctl','/usr/bin/bwrap','/usr/bin/node'}
    issuer={'schema':'enclave-rpc-owner-entry/1','attempt':original['attempt'],'clock':config['clock'],
        'contract':contract,'policy':c.write_new(out/'policy.json',c.encode(policy)),
        'ownerProvision':template['ownerProvision'],'binary':template['binary'],
        'pins':{k:config['pins'][k] for k in signer_sources},'receipt':str(out/'dispatches'/original['attempt']/'signer-started.json')}
    dispatch={'schema':'enclave-rpc-owner-dispatch/1','entry':c.write_new(out/'signer.json',c.encode(issuer)),
        'request':c.write_new(out/'request.json',c.encode(prepared).strip()),'outputParent':str(out/'dispatches'),
        'pins':{k:config['pins'][k] for k in dispatcher_sources}}
    relay=c.write_new(out/'relay.json',c.encode({'schema':'enclave-rpc-owner-relay/1',
        'dispatcher':c.write_new(out/'dispatcher.json',c.encode(dispatch))}))
    c.validate(config['clock']);entry.envelope(original);entry.verify_pins(config['pins'])
    c.write_new(out/'RESULT.json',c.encode({'schema':'enclave-rpc-owner-enrollment-prepared/1',
        'clock':config['clock'],'enrollment':config['enrollment'],'relay':relay,'contract':contract,
        'guestAuthenticated':False,'exportStarted':False,'rpcReady':False}))
    return {**{k:v for k,v in config.items() if k!='preparation'},'schema':'enclave-rpc-owner-bootstrap-entry/2','relay':relay}
