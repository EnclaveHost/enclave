"""One-shot mTLS lifetime input for the storage-owner export supervisor.

The protected owner contract supplies an exact client certificate and request
digest. This is transport authentication, not app-owner consent or a writer
grant. The broker must provision it from its authenticated, reserved attempt.
No reconnect, renewal, silent adoption, or replacement client is accepted.
"""
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


class ControlLost(ValueError):
    pass


def validate(config):
    fields = {'schema', 'host', 'port', 'tls', 'clientCertificateSha256', 'requestSha256'}
    if not isinstance(config, dict) or set(config) != fields or config['schema'] != 'enclave-rpc-export-control/1':
        raise ValueError('Exact app control contract required')
    ip = ipaddress.ip_address(config['host'])
    if ip.is_unspecified or ip.is_multicast or ip.is_link_local or str(ip) != config['host']:
        raise ValueError('Explicit canonical control address required')
    if type(config['port']) is not int or not 1024 <= config['port'] <= 65535:
        raise ValueError('Explicit control port required')
    for name in ('clientCertificateSha256', 'requestSha256'):
        if not isinstance(config[name], str) or not re.fullmatch('[0-9a-f]{64}', config[name]) or config[name] == '0'*64:
            raise ValueError('Exact control identity required')
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
    extends the original startup deadline. After binding, any application byte,
    EOF, TLS error or original deadline is loss. BOUND is NOT export readiness.
    """
    def __init__(self, config, contract_sha, deadline):
        self.listener = self.peer = None
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
        self.expected = HELLO + bytes.fromhex(config['requestSha256']) + bytes.fromhex(contract_sha)
        self.reply = BOUND + hashlib.sha256(self.expected).digest()
        self.client_sha = config['clientCertificateSha256']
        self.context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        self.context.minimum_version = ssl.TLSVersion.TLSv1_3
        self.context.maximum_version = ssl.TLSVersion.TLSv1_3
        self.context.verify_mode = ssl.CERT_REQUIRED
        self.context.num_tickets = 0
        self.context.load_verify_locations(cafile=str(root/'ca-cert.pem'))
        self.context.load_cert_chain(str(root/'server-cert.pem'), str(root/'server-key.pem'))
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
            if self.stage == 'held':
                # SSL buffering is checked as well as the underlying socket;
                # select() alone can miss decrypted bytes already queued here.
                self.peer.recv(1)
                raise ControlLost('App control closed or sent additional data')
        except (ssl.SSLWantReadError, ssl.SSLWantWriteError):
            return self.bound
        except (OSError, ValueError) as error:
            self.close()
            if isinstance(error, ControlLost):
                raise
            raise ControlLost('App control transport failed') from error
        return self.bound

    def close(self):
        # close(), never shutdown(): the forked worker uses this to drop only
        # its inherited references without altering the guardian's connection.
        for value in (self.peer, self.listener):
            if value is not None:
                value.close()
        self.peer = self.listener = None
        self.bound = False
        self.stage = 'lost'
