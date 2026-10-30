"""One fresh read, root-launch only. Does not grant or launch native authority."""
from pathlib import Path
import os
import json
import time
from binding import HERE, checked_binding, write_exclusive

def main():
    os.umask(0o077)
    binding, runtime, manifest = checked_binding()
    assert os.sched_getaffinity(0) == {1}
    assert not (runtime/'ATTEMPT.json').exists(), 'native-already-attempted'
    for name in ('ROOT-ADMISSION.json', 'FRESH-OBSERVATION.json'):
        assert not (runtime/name).exists(), 'runtime-metadata-already-exists'
    write_exclusive(HERE/'FRESH-READ-ATTEMPT.json', {'at': time.time(), 'readOnlyRemote': True,
                    'nativeAdmitted': False, 'runtimePinsSha256': binding['runtimePinsSha256']})
    # Definition-only qualified capture module, loaded after exact source hashes.
    g = {}
    exec(compile((HERE/'capture-local.py').read_text(), 'qualified-local-capture', 'exec'), g)
    remote = (HERE/'capture-remote.py').read_bytes()+b'\n'+(HERE/'fresh-read-body.py').read_bytes()
    command = ('sudo -n systemd-run --quiet --wait --pipe '
               '--unit=enclave-rpc-nan-fresh-read-n10-admission-r1 '
               '--property=MemoryMax=128M --property=MemorySwapMax=0 '
               '--property=CPUQuota=100% --property=AllowedCPUs=1 '
               '--property=RuntimeMaxSec=40 /usr/bin/python3 -B -')
    args = ['/usr/bin/ssh', '-oBatchMode=yes', '-oStrictHostKeyChecking=yes',
            '-oConnectTimeout=5', '-oControlMaster=no', '-oControlPath=none',
            binding['target'], command]
    result = g['capture'](args, 50, stdin=remote, limit=131072)
    write_exclusive(HERE/'FRESH-READ-RESULT.json', result)
    assert result['rc'] == 0 and not result['reason'] and not result['truncated'], 'fresh-read-failed'
    value = json.loads(result['stdout'])
    assert value['readOnly'] is True and not value['errors'] and value['boot'] == binding['bootId']
    checked_binding()
    write_exclusive(HERE/'FRESH-OBSERVATION.json', value)
    print(json.dumps({'readOnlyRemote': True, 'nativeAdmitted': False,
                      'at': value['at'], 'processes': len(value['processes'])}))

if __name__ == '__main__':
    main()
