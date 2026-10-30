import importlib.util
from pathlib import Path
import unittest

spec=importlib.util.spec_from_file_location('fix',Path(__file__).with_name('fix-bootstrap-upload-cors.py'))
fix=importlib.util.module_from_spec(spec);spec.loader.exec_module(fix)


class CorsTests(unittest.TestCase):
    def source(self):return ('unrelated.example {\n    header Access-Control-Allow-Origin example\n}\nipfs.enclave.host {\n'+fix.OLD+'        Content-Security-Policy "default-src \'none\'; sandbox"\n    }\n    handle /add-wasm {\n        reverse_proxy https://app.example\n    }\n}\nafter.example {\n    respond 200\n}\n').encode()

    def test_only_public_read_header_block_changes(self):
        raw=self.source();changed=fix.rewrite(raw)
        self.assertEqual(changed.replace(fix.NEW.encode(),fix.OLD.encode()),raw)
        self.assertIn(b'header /ipfs/* {',changed);self.assertIn(b'        defer\n',changed)
        self.assertEqual(fix.rewrite(changed),changed)

    def test_unknown_or_duplicate_policy_refused(self):
        for raw in [self.source().replace(b'Allow-Origin *',b'Allow-Origin example'),
                    self.source().replace(fix.OLD.encode(),(fix.OLD+fix.OLD).encode()),
                    self.source()+b'ipfs.enclave.host {\n}\n']:
            with self.assertRaises(ValueError):fix.rewrite(raw)

    def test_http_redirect_site_is_preserved(self):
        raw=self.source()+b'http://ipfs.enclave.host {\n    redir https://ipfs.enclave.host{uri}\n}\n'
        self.assertEqual(fix.rewrite(raw).replace(fix.NEW.encode(),fix.OLD.encode()),raw)


if __name__=='__main__':unittest.main(verbosity=2)
