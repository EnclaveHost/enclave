#!/usr/bin/env python3
"""Scope bootstrap gateway CORS to public IPFS reads; preserve upload app policy.

Checks/validates by default. --apply backs up the pinned Caddyfile and reloads
enclave-bootstrap-tls without restarting the provider, application or API.
"""
import argparse
import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile

CONFIG=Path('/etc/enclave-bootstrap-tls/Caddyfile')
SERVICE='enclave-bootstrap-tls'
OLD='    header {\n        Access-Control-Allow-Origin *\n        X-Content-Type-Options nosniff\n'
NEW=('    # Public content is cross-origin readable; signed uploads keep the app allowlist.\n'
     '    header /ipfs/* {\n        Access-Control-Allow-Origin "*"\n        defer\n    }\n'
     '    header {\n        X-Content-Type-Options nosniff\n')


def digest(raw):return hashlib.sha256(raw).hexdigest()


def rewrite(raw):
    text=raw.decode('utf-8')
    sites=list(re.finditer(r'^ipfs\.enclave\.host \{\n',text,re.MULTILINE))
    if len(sites)!=1:raise ValueError('expected exactly one IPFS site block')
    start=sites[0].start();end=text.index('\n}',start)+2
    block=text[start:end]
    if NEW in block:
        if block.count(NEW)!=1 or block.count('Access-Control-Allow-Origin')!=1:raise ValueError('ambiguous existing CORS policy')
        return raw
    if block.count(OLD)!=1 or block.count('Access-Control-Allow-Origin')!=1:raise ValueError('unexpected upload CORS baseline')
    changed=block.replace(OLD,NEW,1)
    return (text[:start]+changed+text[end:]).encode()


def service():
    fields=['MainPID','ActiveState','SubState','NRestarts','ExecMainStartTimestamp','CanReload']
    command=['systemctl','show',SERVICE]
    for f in fields:command+=['-p',f]
    return dict(l.split('=',1) for l in subprocess.check_output(command,text=True).splitlines())


def replace(raw,metadata):
    fd,name=tempfile.mkstemp(prefix='.upload-cors-',dir=CONFIG.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(raw);f.flush();os.fsync(f.fileno())
        os.chmod(name,metadata.st_mode & 0o777);os.chown(name,metadata.st_uid,metadata.st_gid)
        os.replace(name,CONFIG)
    finally:
        if os.path.exists(name):os.unlink(name)


def run(expected,apply):
    if os.geteuid()!=0:raise RuntimeError('root required for the existing Caddy configuration')
    if CONFIG.is_symlink() or not CONFIG.is_file():raise RuntimeError('regular Caddyfile required')
    raw=CONFIG.read_bytes();meta=CONFIG.stat()
    if digest(raw)!=expected:raise ValueError('Caddyfile changed since inspection')
    changed=rewrite(raw);before=service()
    if before['ActiveState']!='active' or before['SubState']!='running' or before['CanReload']!='yes':raise RuntimeError('running reloadable bootstrap TLS service required')
    result=dict(beforeSha256=digest(raw),afterSha256=digest(changed),serviceBefore=before,changed=changed!=raw,applied=False)
    if changed==raw:return result
    fd,name=tempfile.mkstemp(prefix='.upload-cors-check-',dir=CONFIG.parent)
    try:
        with os.fdopen(fd,'wb') as f:f.write(changed)
        executable=str(Path('/proc')/before['MainPID']/'exe')
        check=subprocess.run([executable,'validate','--config',name,'--adapter','caddyfile'],capture_output=True,timeout=30)
        if check.returncode:
            # Caddy diagnostics may contain config paths but never dump the config.
            error=check.stderr.decode(errors='replace').splitlines()[-1:]
            raise RuntimeError('candidate Caddy validation failed; installed file unchanged: '+str(error)[:1200])
    finally:os.unlink(name)
    result['validated']=True
    if not apply:return result
    if CONFIG.read_bytes()!=raw or service()!=before:raise RuntimeError('configuration or service changed during validation')
    stamp=datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S.%fZ')
    backup=CONFIG.with_name('Caddyfile.before-upload-cors-'+stamp)
    with backup.open('xb') as f:f.write(raw)
    backup.chmod(0o600)
    replace(changed,meta)
    reload=subprocess.run(['systemctl','reload',SERVICE],capture_output=True,timeout=30)
    if reload.returncode:
        if CONFIG.read_bytes()!=changed:raise RuntimeError('reload failed and concurrent config drift prevents automatic restoration')
        replace(raw,meta)
        subprocess.run(['systemctl','reload',SERVICE],check=True,capture_output=True,timeout=30)
        raise RuntimeError('reload failed; original configuration restored and reloaded')
    after=service()
    if CONFIG.read_bytes()!=changed or any(after[k]!=before[k] for k in ['MainPID','NRestarts','ExecMainStartTimestamp']):raise RuntimeError('post-reload file or service identity differs')
    result.update(applied=True,backup=str(backup),serviceAfter=after)
    return result


if __name__=='__main__':
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('--expected-sha256',required=True);p.add_argument('--apply',action='store_true')
    args=p.parse_args();print(json.dumps(run(args.expected_sha256,args.apply)))
