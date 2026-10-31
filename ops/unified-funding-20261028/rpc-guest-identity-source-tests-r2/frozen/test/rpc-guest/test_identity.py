import importlib.util
from pathlib import Path
import os
import stat
import tempfile
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('identity',Path(__file__).resolve().parents[2]/'rpc/guest/identity.py')
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
PASSWD='root:x:0:0:root:/root:/bin/bash\n' + ''.join(f'{n}:x:{u}:{g}::/nonexistent:/usr/sbin/nologin\n' for n,(u,g) in m.ACCOUNTS.items())
GROUP='root:x:0:\n'+''.join(f'{n}:x:{g}:\n' for n,g in m.GROUPS.items())

class IdentityTests(unittest.TestCase):
    def test_exact_distinct_accounts(self):
        m.validate_accounts(PASSWD,GROUP,complete=True)
        m.validate_accounts('root:x:0:0:root:/root:/bin/bash\n','root:x:0:\n')
    def test_uid_collision(self):
        with self.assertRaises(ValueError):m.validate_accounts(PASSWD+'other:x:994:100::/:/bin/bash\n',GROUP)
    def test_gid_collision(self):
        with self.assertRaises(ValueError):m.validate_accounts(PASSWD,GROUP+'other:x:985:\n')
    def test_privileged_service_shell(self):
        with self.assertRaises(ValueError):m.validate_accounts(PASSWD.replace('/usr/sbin/nologin','/bin/bash'),GROUP)
    def test_missing_account(self):
        with self.assertRaises(ValueError):m.validate_accounts('',GROUP,complete=True)
    def test_foreign_primary_access(self):
        for gid in [987,986,985,50002]:
            with self.assertRaises(ValueError):m.validate_accounts(PASSWD+f'other:x:2000:{gid}::/:/bin/bash\n',GROUP)
    def test_no_supplementary_privilege_or_jwt_login(self):
        for group in [GROUP.replace('root:x:0:','root:x:0:rpcbase'),GROUP.replace('rpcjwt:x:50002:','rpcjwt:x:50002:rpcbase'),GROUP.replace('rpcjwt:x:50002:','rpcjwt:x:50002:rpcl1el')]:
            with self.assertRaises(ValueError):m.validate_accounts(PASSWD,group)
    def test_group_named_user_cannot_inherit_jwt_access(self):
        with self.assertRaises(ValueError):m.validate_accounts(PASSWD+'rpcjwt:x:2001:50002::/nonexistent:/usr/sbin/nologin\n',GROUP)
    def test_duplicate_names(self):
        with self.assertRaises(ValueError):m.validate_accounts(PASSWD+PASSWD,GROUP)
    def test_jwt_create_reuse_and_refusals(self):
        # Single-ID isolated user namespace: exercise real file operations with
        # its mapped GID0; this does not prove target GID50002 access behavior.
        self.assertEqual(os.geteuid(),0)
        with tempfile.TemporaryDirectory() as td, patch.dict(m.GROUPS,{'rpcjwt':0}):
            p=Path(td);m.ensure_jwt(p);secret=(p/'jwt.hex').read_bytes()
            self.assertEqual(len(secret),64);self.assertEqual(stat.S_IMODE((p/'jwt.hex').stat().st_mode),0o640)
            m.ensure_jwt(p);self.assertEqual((p/'jwt.hex').read_bytes(),secret)
            (p/'jwt.hex').chmod(0o644)
            with self.assertRaises(ValueError):m.ensure_jwt(p)
            (p/'jwt.hex').chmod(0o640);(p/'jwt.hex').write_bytes(b'partial')
            with self.assertRaises(ValueError):m.ensure_jwt(p)
            self.assertEqual((p/'jwt.hex').read_bytes(),b'partial')
            (p/'jwt.hex').unlink();(p/'jwt.hex').symlink_to('/no-target')
            with self.assertRaises(ValueError):m.ensure_jwt(p)

if __name__=='__main__':unittest.main()
