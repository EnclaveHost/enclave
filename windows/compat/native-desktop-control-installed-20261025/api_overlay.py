#!/usr/bin/env python3
"""Apply/restore only the native API modules and additive public policy; no service control."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('native_code_transaction',HERE/'transaction.py')
tx=importlib.util.module_from_spec(spec);spec.loader.exec_module(tx)
PREFIX='opt/nan-relay/'
POLICY='etc/nan-relay/shield-policy.json'
ADDED={PREFIX+n for n in ['shield-desktop-derive.mjs','shield-desktop-release.mjs','shield-image-candidates.mjs','vbs-image-identity.mjs']}
MODIFIED={PREFIX+n for n in ['shield-app-fresh.mjs','shield-app-policy.mjs','shield-app-verifier.mjs','shield-marketplace.mjs','shield-secrets.mjs','vbs-app-verify.mjs','vbs-vm-report-core.mjs','vbs-vm-report.mjs']}|{POLICY}
UNCHANGED={PREFIX+n for n in ['api-relay.js','package.json','package-lock.json','network-runtime.bundle.mjs']}


def validate_manifest(m):
    if m.get('schema')!='native-api-transaction/1' or m.get('service')!='enclave-api-relay':
        raise ValueError('unexpected API transaction')
    for key,want in [('modified',MODIFIED),('added',ADDED),('requiredUnchanged',UNCHANGED)]:
        got=[e['path'] for e in m[key]]
        if len(got)!=len(want) or set(got)!=want:
            raise ValueError('API transaction has an unexpected path set: '+key)
    tx.entries(m)
    return m


def validate_policy(before,after,m):
    old=json.loads(before);new=json.loads(after)
    if 'desktop' in old or set(new)!=set(old)|{'desktop'}:
        raise ValueError('expected exactly one new desktop release field')
    for k in old:
        if k!='images' and new[k]!=old[k]:
            raise ValueError('existing policy field changed: '+k)
    if not isinstance(old['images'],list) or new['images']!=old['images']+[m['nativeImage']]:
        raise ValueError('existing image policy changed')
    if new['desktop']!=m['desktopRelease']:
        raise ValueError('desktop release differs from prepared identity')
    image=m['nativeImage'];release=m['desktopRelease']
    if image.get('nativeDesktop') is not True or image.get('minimumGuestSvn')!=13:
        raise ValueError('native image must enforce SVN 13')
    for name in ['runtimeId','igvmSha256','profileSha256','controllerSha256']:
        if image[name]!=release[name]:raise ValueError('native image/release mismatch: '+name)
    if image['measurement']!=release['launchMeasurement']:
        raise ValueError('native launch identity mismatch')


def metadata(root,m,*,uid=0,gid=0):
    # This installed baseline is root:root 0644 in root:root 0755 directories.
    # Refuse other layouts rather than silently changing ownership or permissions.
    for name in ['opt/nan-relay','etc/nan-relay']:
        p=tx.path_in(root,name);s=p.stat()
        if not p.is_dir() or (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))!=(uid,gid,0o755):
            raise ValueError('API directory metadata drift: '+name)
    for e in [*tx.entries(m),*m['requiredUnchanged']]:
        p=tx.path_in(root,e['path'])
        if p.exists():
            s=p.stat()
            if not p.is_file() or (s.st_uid,s.st_gid,stat.S_IMODE(s.st_mode))!=(uid,gid,0o644):
                raise ValueError('API file metadata drift: '+e['path'])


def stopped(root,m):
    if not sys.platform.startswith('linux') or root.resolve()!=Path('/') or os.geteuid()!=0:
        raise RuntimeError('live API apply/rollback requires root on the installed Linux filesystem')
    keys=['LoadState','ActiveState','SubState','MainPID','KillMode','User','Group']
    args=['systemctl','show','enclave-api-relay']
    for k in keys:args+=['-p',k]
    r=subprocess.run(args,capture_output=True,text=True,timeout=15,check=True)
    state=dict(line.split('=',1) for line in r.stdout.splitlines() if '=' in line)
    required={'LoadState':'loaded','ActiveState':'inactive','SubState':'dead','MainPID':'0','KillMode':'control-group','User':'enclave-api-relay','Group':'enclave-api-relay'}
    if state!=required:
        raise RuntimeError('API service must be stopped; no service action was attempted')
    metadata(root,m)


def apply(root,payload,manifest_bytes,journal,*,guard=None,write=tx.atomic_write):
    m=validate_manifest(json.loads(manifest_bytes))
    validate_policy(tx.path_in(root,POLICY).read_bytes(),tx.path_in(payload,POLICY).read_bytes(),m)
    check=guard if guard is not None else lambda r:stopped(r,m)
    result=tx.apply(root,payload,manifest_bytes,journal,guard=check,write=write)
    return result


def rollback(root,journal,*,guard=None):
    m=validate_manifest(json.loads((journal/'manifest.json').read_text()))
    check=guard if guard is not None else lambda r:stopped(r,m)
    return tx.rollback(root,journal,guard=check)


def main():
    p=argparse.ArgumentParser(description=__doc__)
    p.add_argument('action',choices=['inspect','apply','rollback'])
    p.add_argument('--installed',type=Path,default=Path('/'))
    p.add_argument('--manifest',type=Path);p.add_argument('--payload',type=Path);p.add_argument('--journal',type=Path)
    a=p.parse_args()
    if a.action=='rollback':
        if not a.journal:p.error('--journal is required')
        result=rollback(a.installed,a.journal)
    else:
        if not a.manifest:p.error('--manifest is required')
        raw=a.manifest.read_bytes();m=validate_manifest(json.loads(raw))
        if a.action=='inspect':
            metadata(a.installed,m)
            result=tx.inspect(a.installed,m)
        else:
            if not a.payload or not a.journal:p.error('--payload and --journal are required')
            result=apply(a.installed,a.payload,raw,a.journal)
    print(json.dumps(result))

if __name__=='__main__':main()
