"""One-shot mTLS lifetime input for the storage-owner export supervisor.

The protected owner contract supplies an exact client certificate and request
digest. This is transport authentication, not app-owner consent or a writer
grant. The broker must provision it from its authenticated, reserved attempt.
No reconnect, silent adoption, or replacement client is accepted. Explicit /2
serving permits additionally require exact records in the original held owner
journal and acknowledgement from the existing worker.
"""
import base64
import json
import struct
import hashlib
import importlib.util
import ipaddress
import os
from pathlib import Path
import re
import socket
import ssl
import stat
import time

_spec = importlib.util.spec_from_file_location('volume_export', Path(__file__).with_name('volume_export.py'))
_volume = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_volume)
directory = _volume.directory

HELLO = b'ENCLAVE-RPC-EXPORT-CONTROL/1\n'
BOUND = b'ENCLAVE-RPC-EXPORT-BOUND/1\n'
HELLO2 = b'ENCLAVE-RPC-EXPORT-CONTROL/2\n'
BOUND2 = b'ENCLAVE-RPC-EXPORT-BOUND/2\n'
PERMIT_ACK = b'ENCLAVE-RPC-EXPORT-PERMIT/2\n'


class ControlLost(ValueError):
    pass


def validate(config):
    fields = {'schema', 'host', 'port', 'tls', 'clientCertificateSha256', 'requestSha256'}
    if not isinstance(config, dict) or config.get('schema') not in ('enclave-rpc-export-control/1','enclave-rpc-export-control/2') or set(config) != (fields|{'ownerJournal'} if config.get('schema')=='enclave-rpc-export-control/2' else fields):
        raise ValueError('Exact app control contract required')
    ip = ipaddress.ip_address(config['host'])
    if ip.is_unspecified or ip.is_multicast or ip.is_link_local or str(ip) != config['host']:
        raise ValueError('Explicit canonical control address required')
    if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
        raise ValueError('Explicit control port required')
    for name in ('clientCertificateSha256', 'requestSha256'):
        if not isinstance(config[name], str) or not re.fullmatch('[0-9a-f]{64}', config[name]) or config[name] == '0'*64:
            raise ValueError('Exact control identity required')
    if config['schema']=='enclave-rpc-export-control/2':
        j=config['ownerJournal']
        if not isinstance(j,dict) or set(j)!={'path','device','inode'} or any(type(j[k]) is not int or j[k]<0 for k in ('device','inode')):raise ValueError('Exact original owner journal identity required')
        root=directory(Path(j['path']));row=root.stat()
        if row.st_uid!=os.geteuid() or stat.S_IMODE(row.st_mode)!=0o700 or (row.st_dev,row.st_ino)!=(j['device'],j['inode']):raise ValueError('Original owner journal substituted')
    root = directory(Path(config['tls']))
    for name in ('ca-cert.pem', 'server-cert.pem', 'server-key.pem'):
        st = (root/name).lstat()
        if (not stat.S_ISREG(st.st_mode) or st.st_uid != os.geteuid() or st.st_nlink != 1
                or stat.S_IMODE(st.st_mode) != 0o600 or not 0 < st.st_size <= 16384):
            raise ValueError('Protected bounded control credentials required')
    return root


class AppControl:
    """Nonblocking state machine; only guard's process owns these sockets.

    Constructor/step may run only inside the admitted independent watchdog unit.
    A stalled TLS library or callback is then killed by that existing backstop.
    The first accepted connection consumes the listener even on authentication
    failure. Silence while connecting is bounded to three seconds and never
    extends the original startup deadline. /1 rejects additional application bytes.
    /2 accepts bounded original-owner permits through a separate worker handoff;
    the prior cutoff remains until acknowledgement. EOF/error/expiry is loss.
    BOUND is NOT export readiness.
    """
    def __init__(self, config, contract_sha, deadline):
        self.listener = self.peer = None
        self.journal = None
        self.serving_enabled = config.get("schema")=="enclave-rpc-export-control/2"
        self.serving = False
        self.offer = None
        self.ready = False
        self.generation = 0
        self.sequence = 0
        self.last_proof = None
        self.prepared_hash = None
        self.observation_hash = None
        self.anchor_mono = time.monotonic_ns()
        self.anchor_wall = time.time_ns()
        self.bound = False
        self.deadline = deadline
        self.handshake_deadline = deadline
        self.stage = 'accept'
        self.input = bytearray()
        self.sent = 0
        root = validate(config)
        if not isinstance(contract_sha, str) or not re.fullmatch('[0-9a-f]{64}', contract_sha):
            raise ValueError('Exact export contract digest required')
        if not 0 < deadline-time.monotonic() <= 900:
            raise ValueError('Original control deadline required')
        self.request_sha=config["requestSha256"]
        self.contract_sha=contract_sha
        self.expected = (HELLO2 if self.serving_enabled else HELLO) + bytes.fromhex(config['requestSha256']) + bytes.fromhex(contract_sha)
        self.reply = (BOUND2 if self.serving_enabled else BOUND) + hashlib.sha256(self.expected).digest()
        self.client_sha = config['clientCertificateSha256']
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_3
        self.context.maximum_version = ssl.TLSVersion.TLSv1_3
        self.context.verify_mode = ssl.CERT_REQUIRED
        self.context.num_tickets = 0
        self.context.load_verify_locations(cafile=str(root/'ca-cert.pem'))
        self.context.load_cert_chain(str(root/'server-cert.pem'), str(root/'server-key.pem'))
        if self.serving_enabled:
            j=config['ownerJournal'];fd=os.open(j['path'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW|os.O_CLOEXEC)
            row=os.fstat(fd)
            if (row.st_dev,row.st_ino)!=(j['device'],j['inode']) or row.st_uid!=os.geteuid() or stat.S_IMODE(row.st_mode)!=0o700:
                os.close(fd);raise ValueError('Held original journal differs')
            self.journal=fd
        family = socket.AF_INET6 if ':' in config['host'] else socket.AF_INET
        self.listener = socket.socket(family, socket.SOCK_STREAM)
        try:
            # No reuse-port and no replacement listener on failure.
            if family == socket.AF_INET6:
                self.listener.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 1)
            self.listener.setblocking(False)
            self.listener.bind((config['host'], config['port']))
            self.listener.listen(1)
        except BaseException:
            self.close()
            raise

    def step(self):
        if self.stage == 'lost':
            raise ControlLost('Consumed app control connection')
        try:
            now = time.monotonic()
            if now >= self.deadline or now >= self.handshake_deadline:
                raise ControlLost('Original app control deadline or handshake timeout')
            if self.stage == 'accept':
                try:
                    raw, _ = self.listener.accept()
                except BlockingIOError:
                    return False
                self.listener.close()
                self.listener = None
                self.handshake_deadline = min(self.deadline, now+3)
                try:
                    raw.setblocking(False)
                    self.peer = self.context.wrap_socket(raw, server_side=True, do_handshake_on_connect=False)
                except BaseException:
                    raw.close()
                    raise
                self.stage = 'tls'
            if self.stage == 'tls':
                self.peer.do_handshake()
                cert = self.peer.getpeercert(binary_form=True)
                if not cert or hashlib.sha256(cert).hexdigest() != self.client_sha:
                    raise ControlLost('App control certificate differs')
                self.stage = 'bind'
            if self.stage == 'bind':
                part = self.peer.recv(len(self.expected)+1-len(self.input))
                if not part:
                    raise ControlLost('App control closed before binding')
                self.input.extend(part)
                if not self.expected.startswith(self.input):
                    raise ControlLost('App control request/contract binding differs')
                if len(self.input) != len(self.expected):
                    return False
                self.stage = 'ack'
            if self.stage == 'ack':
                count = self.peer.send(self.reply[self.sent:])
                if count <= 0:
                    raise ControlLost('App control acknowledgement failed')
                self.sent += count
                if self.sent != len(self.reply):
                    return False
                self.stage = 'held'
                self.handshake_deadline = self.deadline
                self.bound = True
                self.input.clear()
            if self.stage == 'permit-ack':
                count=self.peer.send(self.reply[self.sent:])
                if count<=0:raise ControlLost('Serving acknowledgement failed')
                self.sent+=count
                if self.sent!=len(self.reply):return self.bound
                self.stage='held'
            if self.stage == 'held' and self.serving_enabled:
                self.read_permit()
                return self.bound
            if self.stage == 'pending':
                self.peer.recv(1)
                raise ControlLost('Pipelined permit or lost peer during worker handoff')
            if self.stage == 'held':
                # SSL buffering is checked as well as the underlying socket;
                # select() alone can miss decrypted bytes already queued here.
                self.peer.recv(1)
                raise ControlLost('App control closed or sent additional data')
        except (ssl.SSLWantReadError, ssl.SSLWantWriteError):
            return self.bound
        except (OSError, ValueError, KeyError, TypeError, OverflowError) as error:
            self.close()
            if isinstance(error, ControlLost):
                raise
            raise ControlLost('App control transport failed') from error
        return self.bound

    def owner_record(self,name,maximum):
        # Relative opens stay on the original held directory, never a replacement
        # namespace. The original issuer alone writes these 0400 one-shot records.
        fd=os.open(name,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC,dir_fd=self.journal)
        try:
            before=os.fstat(fd)
            if not stat.S_ISREG(before.st_mode) or before.st_uid!=os.geteuid() or stat.S_IMODE(before.st_mode)!=0o400 or before.st_nlink!=1 or not 0<before.st_size<=maximum:raise ControlLost('Bounded original owner record required')
            raw=os.read(fd,maximum+1);after=os.fstat(fd)
            identity=lambda r:(r.st_dev,r.st_ino,r.st_size,r.st_mtime_ns,r.st_ctime_ns)
            if len(raw)!=before.st_size or identity(before)!=identity(after):raise ControlLost('Original owner record changed')
            return raw
        finally:os.close(fd)

    def read_permit(self):
        target=4 if len(self.input)<4 else 4+struct.unpack('!I',self.input[:4])[0]
        if target>2052 or target<4:raise ControlLost('Bounded owner permit frame required')
        part=self.peer.recv(target-len(self.input))
        if not part:raise ControlLost('Serving peer closed')
        self.input.extend(part)
        if len(self.input)<4:return
        size=struct.unpack('!I',self.input[:4])[0]
        if not 0<size<=2048:raise ControlLost('Bounded owner permit required')
        if len(self.input)<4+size:return
        raw=bytes(self.input[4:]);self.input.clear()
        if not self.ready:raise ControlLost('Exports not ready for serving commit')
        def decode(raw):
            def pairs(rows):
                result={}
                for k,v in rows:
                    if k in result:raise ControlLost('Duplicate owner proof field')
                    result[k]=v
                return result
            return json.loads(raw,object_pairs_hook=pairs)
        proof=decode(raw)
        if set(proof)!={'permit','l1','base'}:raise ControlLost('Exact owner continuation required')
        p=proof['permit']
        if set(p)!={'schema','phase','sequence','previousSha256','readinessSha256','issuedAt','notAfter'} or p['schema']!='enclave-rpc-continuation/1' or p['phase']!='serving':raise ControlLost('Serving permit required')
        for k in ('sequence','issuedAt','notAfter'):
            if type(p[k]) is not int or not 0<p[k]<=2**53-1:raise ControlLost('Bounded owner permit integers required')
        for k in ('previousSha256','readinessSha256'):
            if not isinstance(p[k],str) or not re.fullmatch('[0-9a-f]{64}',p[k]) or p[k]=='0'*64:raise ControlLost('Exact permit binding required')
        stem='continuation-%s-%016x'%(self.request_sha,p['sequence'])
        if self.owner_record(stem+'-proof',2048)!=raw:raise ControlLost('Permit not persisted by original owner')
        intent=decode(self.owner_record('serving-commit-%s-%016x-submit'%(self.request_sha,p['sequence']),1024))
        if set(intent)!={'schema','preparedSha256','permit'} or intent['schema']!='enclave-rpc-serving-commit/1' or intent['permit']!=p:raise ControlLost('Original consumed owner commit differs')
        prepared=self.owner_record('serving-prepare-'+self.request_sha+'-proof',2048)
        prepared_hash=hashlib.sha256(prepared).hexdigest()
        preparation=self.owner_record('serving-prepare-'+self.request_sha+'-submit',1024)
        pr=decode(preparation);ps=decode(prepared)
        observation=base64.b64decode(pr['observation'],validate=True)
        if len(observation)!=152 or observation[:8]!=b'ERPCRD01' or ps['requestSha256']!=hashlib.sha256(preparation).hexdigest() or intent['preparedSha256']!=prepared_hash or p['readinessSha256']!=hashlib.sha256(observation).hexdigest():raise ControlLost('Original preparation/observation differs')
        if self.serving:
            if p['sequence']!=self.sequence+1 or p['previousSha256']!=self.last_proof or prepared_hash!=self.prepared_hash or p['readinessSha256']!=self.observation_hash:raise ControlLost('Serving replay/gap/substitution')
        else:
            if p['sequence']<2:raise ControlLost('Original startup chain required')
            previous=self.owner_record('continuation-%s-%016x-proof'%(self.request_sha,p['sequence']-1),2048)
            prior=decode(previous)['permit']
            if hashlib.sha256(previous).hexdigest()!=p['previousSha256'] or prior['phase']!='startup' or prior['sequence']!=p['sequence']-1:raise ControlLost('First commit not linked to original startup')
            initial=decode(self.owner_record('proof-'+self.request_sha,2048))
            if initial.get('schema')!='enclave-rpc-storage-consent/2' or initial.get('export',{}).get('contractSha256')!=self.contract_sha:raise ControlLost('Original export contract differs')
        now=time.monotonic_ns();wall=(self.anchor_wall+now-self.anchor_mono)//1_000_000_000
        expiry=self.anchor_mono+p['notAfter']*1_000_000_000-self.anchor_wall-1000
        if not p['issuedAt']<=wall<p['notAfter'] or not 0<p['notAfter']-p['issuedAt']<=30 or not now<expiry<=now+30_000_000_000 or time.monotonic()>=self.deadline or (self.serving and expiry<=int(self.deadline*1e9)):raise ControlLost('Prior/new serving expiry invalid')
        self.offer=(self.generation+1,expiry,hashlib.sha256(raw).digest(),p,prepared_hash)
        self.stage='pending'

    def accept_offer(self,generation,expiry):
        # Called only after the exact original export worker acknowledges this
        # offer. The prior bound stays active while it is pending or blocked.
        offer=self.offer
        if self.stage!='pending' or offer is None or offer[:2]!=(generation,expiry) or time.monotonic()>=self.deadline or time.monotonic_ns()>=expiry:raise ControlLost('Worker handoff late or substituted')
        prior_deadline=self.deadline
        self.deadline=expiry/1e9;self.handshake_deadline=self.deadline
        self.serving=True;self.generation=generation;self.sequence=offer[3]['sequence'];self.last_proof=offer[2].hex()
        self.prepared_hash=offer[4];self.observation_hash=offer[3]['readinessSha256']
        ack=PERMIT_ACK+offer[2];self.reply=struct.pack('!I',len(ack))+ack;self.sent=0
        if time.monotonic()>=prior_deadline or time.monotonic_ns()>=expiry:raise ControlLost('Prior/new bound expired during publication')
        self.offer=None;self.stage='permit-ack'

    def close(self):
        # close(), never shutdown(): the forked worker uses this to drop only
        # its inherited references without altering the guardian's connection.
        for value in (self.peer, self.listener):
            if value is not None:
                value.close()
        self.peer = self.listener = None
        if self.journal is not None:
            os.close(self.journal);self.journal=None
        self.bound = False
        self.stage = 'lost'
