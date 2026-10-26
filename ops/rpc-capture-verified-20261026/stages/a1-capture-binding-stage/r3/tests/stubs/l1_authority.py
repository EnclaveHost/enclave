"""STUB l1_authority.py (tests only): the reviewed launcher's interface (load_config / status / `run CONFIG`), no Helios."""
import json, signal, sys, time
def load_config(path):
    cfg = json.load(open(path)); json.load(open(cfg['checkpointFile']))            # the derived config must name the copy
    return {'cfg': cfg, 'listenIp': cfg['listen']['ip'], 'listenPort': cfg['listen']['port']}
def status(c):
    return {'verdict': c['cfg'].get('stubVerdict', 'fresh-finalized'), 'binarySha256': c['cfg']['binary']['sha256']}
if __name__ == '__main__' and sys.argv[1:2] == ['run']:
    load_config(sys.argv[2]); signal.signal(signal.SIGTERM, lambda *a: sys.exit(0))
    while True: time.sleep(1)
