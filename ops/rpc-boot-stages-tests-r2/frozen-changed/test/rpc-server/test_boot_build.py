"""Strict build-input checks; no native mounts, devices, VM or network."""
import importlib.util
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location("rpc_boot_build", ROOT / "isolation/m3/build-rpc-boot.py")
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


def fixture():
    return {"controllerSha256": "1" * 64, "entrySha256": "2" * 64,
            "kernel": {"bootSha256": "3" * 64, "elfSha256": "4" * 64, "release": "6.6.87.2-enclave-kvm-box"},
            "profile": "ethereum-base-rpc-v1", "root": {"dataBlocks": 262144, "hashBytes": 8458240,
            "hashSha256": "5" * 64, "imageBytes": 1073741824, "imageSha256": "6" * 64,
            "rootHash": "7" * 64, "salt": "8" * 64}, "schema": "enclave-native-rpc-profile/2", "wrapperSha256": "9" * 64}


def wire(p):
    return json.dumps(p, sort_keys=True, separators=(",", ":")).encode() + b"\n"


class BootBuild(unittest.TestCase):
    def test_profile_and_header(self):
        raw = wire(fixture())
        p = build.profile(raw)
        h = build.header(p, build.base.sha256(raw))
        self.assertIn(b'#define DATA_BLOCKS "262144"', h)
        self.assertIn(b'#define VERITY_ROOT "' + b'7' * 64 + b'"', h)
        self.assertNotIn(b"MODEL_", h)

    def test_refuse_selectors_geometry_and_injection(self):
        changes = [("schema", "enclave-native-rpc-profile/1"), ("profile", "kvm-box-masked-v1"),
                   ("command", "/bin/sh"), ("entrySha256", "0" * 64), ("wrapperSha256", '"\n#error injected')]
        for k, v in changes:
            with self.subTest(field=k):
                p = fixture(); p[k] = v
                with self.assertRaises(build.base.BuildError): build.profile(wire(p))
        for k, v in (("dataBlocks", True), ("dataBlocks", 262145), ("salt", "a" * 63), ("imageBytes", 1073741824.0)):
            with self.subTest(root=k, value=v):
                p = fixture(); p["root"][k] = v
                with self.assertRaises(build.base.BuildError): build.profile(wire(p))

    def test_noncanonical_duplicate(self):
        raw = wire(fixture())
        for bad in (b" " + raw, raw + b"\n", raw[:-1], raw.replace(b'{', b'{"schema":"duplicate",', 1)):
            with self.subTest(wire=bad[:25]):
                with self.assertRaises(build.base.BuildError): build.profile(bad)


if __name__ == "__main__":
    unittest.main()
