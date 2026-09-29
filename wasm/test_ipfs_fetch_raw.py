"""Raw CID responses must meet the same content verification as CAR blocks."""
import base64
import hashlib
import io
import unittest
from unittest.mock import patch
import ipfs_fetch

class RawFetchTests(unittest.TestCase):
    def test_raw_content_is_verified_and_bounded(self):
        data = b'public fixture'
        cid = 'b' + base64.b32encode(b'\x01\x55\x12\x20' + hashlib.sha256(data).digest()).decode().lower().rstrip('=')
        for response, cap, valid in [(data, len(data), True),
                                     (b'wrong bytes', len(data), False),
                                     (data, len(data)-1, False)]:
            with self.subTest(response=response, cap=cap):
                with patch.object(ipfs_fetch.urllib.request, 'urlopen', return_value=io.BytesIO(response)):
                    if valid:
                        self.assertEqual(ipfs_fetch.fetch_verified(cid, 'https://example.test', cap), data)
                    else:
                        with self.assertRaises(ValueError):
                            ipfs_fetch.fetch_verified(cid, 'https://example.test', cap)

if __name__ == '__main__':
    unittest.main()
