"""Bind untrusted native enrollment to the original storage owner's inputs.

Called only inside owner_bootstrap_entry's admitted independent envelope. The
native token/VM/receipt hash is correlation, NOT authenticated VM ownership.
Actual guest/host evidence must still pass the owner-minted challenge verifier.
No key, service, clock, request, journal or writer grant is created here.
"""
import base64
import hashlib
from pathlib import Path
import re
import ssl


def prepare(c, config, original, prepared, contract, policy, contract_sha):
    enrollment = c.protocol.decode(c.read_pinned(config['enrollment']))
    if set(enrollment) != {'token','vmGuid','ownershipReceiptSha256','originalOriginMs','originalDeadlineMs','enrollment'}:
        raise ValueError('Exact native enrollment receipt required')
    for key, pattern in [('token','[0-9a-f]{128}'), ('vmGuid','[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}'),
                         ('ownershipReceiptSha256','[0-9a-f]{64}')]:
        if not isinstance(enrollment[key],str) or not re.fullmatch(pattern,enrollment[key]) or not enrollment[key].replace('-','').strip('0'):
            raise ValueError('Native correlation identity required')
    if (enrollment['originalOriginMs'] != str(original['windowsOriginMilliseconds']) or
            enrollment['originalDeadlineMs'] != str(original['windowsDeadlineMilliseconds'])):
        raise ValueError('Enrollment reset the original Windows clock')
    candidate = enrollment['enrollment']
    if not isinstance(candidate,dict) or set(candidate) != {'info','keys'}:
        raise ValueError('Exact enrollment candidate required')
    info = candidate['info']
    if (not isinstance(info,dict) or set(info) != {'purpose','request','requestSha256','runtime','transportKey','certificate','rootsGranted','rpcReady'} or
            info['purpose'] != 'enclave-rpc-storage-bootstrap/1' or info['request'] != prepared['request'] or
            info['rootsGranted'] is not False or info['rpcReady'] is not False):
        raise ValueError('Enrollment differs from original prepared request')
    request_sha = hashlib.sha256(c.encode(prepared['request']).strip()).hexdigest()
    control = contract['appControl']
    if info['requestSha256'] != request_sha or control['requestSha256'] != request_sha:
        raise ValueError('Enrollment/export request digest differs')
    cert = base64.b64decode(info['certificate'],validate=True)
    if not 0 < len(cert) <= 16384 or base64.b64encode(cert).decode() != info['certificate']:
        raise ValueError('Bounded canonical guest certificate required')
    client_sha = hashlib.sha256(cert).hexdigest()
    export = policy['export']
    if (export['contractSha256'] != contract_sha or export['clientCertificateSha256'] != client_sha or
            control['clientCertificateSha256'] != client_sha or export['host'] != control['host'] or export['port'] != control['port']):
        raise ValueError('Original export/client binding differs')
    # Public certificate comes from the actual prepared export namespace, never
    # an enrollment-selected path. Original signer policy pins its DER bytes.
    pem = c.read(Path(control['tls'])/'server-cert.pem').decode('ascii')
    der = ssl.PEM_cert_to_DER_cert(pem)
    if hashlib.sha256(der).hexdigest() != export['serverCertificateSha256']:
        raise ValueError('Original export certificate differs')
    bootstrap_policy = c.protocol.decode(c.read_pinned(config['bootstrapPolicy']))
    if bootstrap_policy.get('schema') != 'enclave-rpc-bootstrap-policy/1':
        raise ValueError('Explicit original owner attestation policy required')
    if policy.get('schema') != 'enclave-rpc-storage-owner/1':
        raise ValueError('Original owner service policy required')
    for role in ('l1','base'):
        if policy[role+'Volume'] != prepared['request'][role+'Volume']:
            raise ValueError('Original owner volume differs')
    bundle = base64.b64decode(prepared['bundle'],validate=True)
    bundle_sha = hashlib.sha256(bundle).hexdigest()
    if bundle_sha != prepared['request']['appId']:
        raise ValueError('Original loaded bundle differs')
    # Guest receives exactly the issuer's chain authority selection. It performs
    # its own current-chain verification; these settings are not an authorization.
    broker = {k:policy[k] for k in ('runtime','chainId','ledger','rpcs','confirmations','maxAgeSeconds')}
    broker.update(schema='enclave-rpc-broker-policy/1',bundleSha256=bundle_sha,manifest=prepared['manifest'])
    session = {'request':prepared['request'],'runtime':policy['runtime'],
        'clientCertificate':info['certificate'],'keys':candidate['keys'],'policy':bootstrap_policy}
    delivery = {'exportServerDer':base64.b64encode(der).decode(),
        'policy':base64.b64encode(c.encode(broker).strip()).decode()}
    return session, {'candidate':candidate,'receiptSha256':config['enrollment']['sha256']}, delivery
