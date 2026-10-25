#!/usr/bin/python3 -I
"""ROOT-ONLY, after the Base snapshot download unit finished: write the completion receipt a2a4.py `gate_download` binds.
PREPARED, NOT RUN. It never starts, stops or downloads anything and invents no success: every field is read from systemd's
record of the downloader's LAST invocation, the pinned manifest and the datadir; any doubt refuses (exit 3) and writes nothing.

  write_download_receipt.py --profile final-h48000000-s52500000 --datadir D --manifest /opt/enclave-rpc/snapshots/base-1792886410-manifest.json \
      --marker /srv/enclave-base-holder/snapshot-complete --out /root/<dir>/base-snapshot-completion-receipt.json

Where full BLAKE3 verification comes from (pinned reth 7134be3 crates/cli/commands/src/download; no per-file log exists):
  1. planning.rs `collect_planned_archives`: the client bails if ANY planned archive lacks plain output checksums;
  2. archive.rs:180-186: every archive reaches Complete only via VerifyOutputs (per-file size + BLAKE3, verify.rs:40) after
     extraction; a failed verification retries and finally fails the command;
  3. planning.rs `partition_reusable`: an already-present archive is reused only after its outputs verify.
  So `ExecMainStatus=0` of THIS invocation, with the exact profile argv and the pinned manifest, means every planned archive
  verified. The receipt records that inference with the invocation id; it is NOT an independent re-hash (none is prepared).
"""
import argparse, datetime, hashlib, json, os, pathlib, re, subprocess, sys
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))
import selection as SEL

UNIT = 'enclave-rpc-base-snapshot.service'
MANIFEST_SHA = '1f0c4e6c259d4353f598a94ac75a0540321ced2b52b464fb4e11c2ec34c649f2'
SNAPSHOT_HEAD = 53_048_526
REQUIRE_ROOT = True                              # tests override
CLD_EXITED = '1'                                 # systemd ExecMainCode is the waitid si_code: CLD_EXITED == 1 (normal exit)


class Refused(Exception):
    pass


def show(prop):
    return subprocess.run(['systemctl', 'show', UNIT, '-p', prop, '--value'], capture_output=True, text=True, timeout=30, check=True).stdout.strip()


def exec_start_argv(text):
    """systemctl `ExecStart` value: '{ path=P ; argv[]=A B C ; ignore_errors=no ; ... ; code=exited ; status=0/SUCCESS }'."""
    m = re.fullmatch(r'\{ path=(\S+) ; argv\[\]=(.*?) ; ignore_errors=\w+ ; .*?code=(\w+) ; status=(\d+)(?:/\w+)? \}', text.strip())
    if not m:
        raise Refused('ExecStart record not parseable (multiple ExecStart lines or unknown format)')
    path, argv, code, status = m.group(1), m.group(2).split(' '), m.group(3), int(m.group(4))
    if argv[0] != path:
        raise Refused('ExecStart argv[0] differs from its path')
    return argv, code, status


def main(args=None):
    a = argparse.ArgumentParser()
    for k in ('--profile', '--datadir', '--manifest', '--marker', '--out'):
        a.add_argument(k, required=True)
    o = a.parse_args(args)
    try:
        if REQUIRE_ROOT and os.geteuid() != 0:
            raise Refused('must run as root')
        if o.profile not in SEL.PROFILES:
            raise Refused(f'unknown profile {o.profile}')
        props = {p: show(p) for p in ('ActiveState', 'Result', 'ExecMainStatus', 'ExecMainCode', 'InvocationID', 'ExecMainExitTimestamp', 'ExecStart')}
        if props['ActiveState'] not in ('inactive', 'failed') or props['Result'] != 'success' or props['ExecMainStatus'] != '0':
            raise Refused(f'{UNIT} last invocation did not succeed: {props["ActiveState"]}/{props["Result"]}/{props["ExecMainStatus"]}')
        if props['ExecMainCode'] != CLD_EXITED:
            raise Refused(f'ExecMainCode {props["ExecMainCode"]!r} is not a normal exit (CLD_EXITED=1)')
        if not re.fullmatch(r'[0-9a-f]{32}', props['InvocationID']):
            raise Refused('InvocationID missing or malformed: cannot attribute the result to one invocation')
        argv, code, status = exec_start_argv(props['ExecStart'])
        if code != 'exited' or status != 0:
            raise Refused('the recorded ExecStart did not exit 0')
        if argv[0] != SEL.BASE_BINARY:
            raise Refused(f'ExecStart ran {argv[0]!r}, not the pinned {SEL.BASE_BINARY}')
        if hashlib.sha256(pathlib.Path(SEL.BASE_BINARY).read_bytes()).hexdigest() != SEL.BASE_BINARY_SHA256:
            raise Refused('the base binary on disk is not the pinned 9c44836d...: verification cannot be attributed to the audited client')
        SEL.check_argv(argv, o.profile, o.datadir, o.manifest)
        raw = pathlib.Path(o.manifest).read_bytes()
        if hashlib.sha256(raw).hexdigest() != MANIFEST_SHA:
            raise Refused('manifest bytes differ from the pin')
        m = json.loads(raw)
        if (m.get('block'), m.get('chain_id'), m.get('storage_version')) != (SNAPSHOT_HEAD, 8453, 2):
            raise Refused('manifest block/chain/storage version differ')
        sel = sorted(SEL.derive(m, o.profile), key=lambda k: (k[0], -1 if k[1] is None else k[1]))
        for key in sel:
            if not SEL.checksums(m, key):
                raise Refused(f'{key} has no per-file checksums in the manifest')
        mk = os.stat(o.marker)
        if mk.st_size != 0 or (REQUIRE_ROOT and mk.st_uid != 0):
            raise Refused('marker must be the empty root-owned file the unit touched')
        dd = os.stat(o.datadir)
        receipt = {'format': 'base-snapshot-completion-receipt/v1', 'profile': o.profile, 'manifestSha256': MANIFEST_SHA,
                   'block': SNAPSHOT_HEAD, 'chainId': 8453, 'storageVersion': 2, 'unit': UNIT, 'unitResult': 'success', 'execMainStatus': 0,
                   'invocationId': props['InvocationID'], 'exitedAt': props['ExecMainExitTimestamp'], 'downloadArgv': argv,
                   'baseBinarySha256': SEL.BASE_BINARY_SHA256,
                   'datadir': o.datadir, 'datadirIdentity': {'dev': dd.st_dev, 'ino': dd.st_ino},
                   'selectedArchives': [{'component': c, 'chunk': i} for c, i in sel],
                   'verification': 'client per-file BLAKE3 VerifyOutputs for every planned archive, inferred from ExecMainStatus=0 of this invocation (see docstring)',
                   'writtenAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}
        fd = os.open(o.out, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(fd, 'w') as f:
            json.dump(receipt, f, indent=1); f.flush(); os.fsync(f.fileno())
        print(json.dumps({'ok': True, 'archives': len(sel), 'profile': o.profile}))
        return 0
    except (Refused, SEL.SelectionError, OSError, subprocess.SubprocessError, ValueError, KeyError) as e:
        print(json.dumps({'ok': False, 'refused': str(e)[:400]}))
        return 3


if __name__ == '__main__':
    sys.exit(main())
