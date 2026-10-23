#!/usr/bin/env python3
"""make-manifest.py: the scratch harness that runs sia_storage's OWN unit tests (src/**/mod test) offline on the vendored
sources. Every compiled file is the vendored one; only manifests differ.
- unit/Cargo.toml is the vendored sia_storage/Cargo.toml, except:
  - [lib] points at the vendored sia_storage/src/lib.rs;
  - its path dependencies point at unit/deps/;
  - the bench and the dev-dependencies used only by benches/examples (criterion, env_logger, clap, indicatif,
    directories, toml) are dropped: they are not in the offline cargo cache, and no src/ test uses them;
  - autobenches/autoexamples/autotests off, its own [workspace], and opt-level 2 (as sia-s3's test profile builds it).
- unit/deps/<crate>/ mirrors each vendored path dependency: every entry is a symlink to the vendored one, except
  Cargo.toml, which is a copy without its [[bench]] stanza (the vendored copies ship without benches/, and cargo test
  refuses a declared bench whose file is missing). Asserted: that stanza is the only difference.
Versions come from sia-s3's Cargo.lock (copied as the seed lockfile by unit-step.sh)."""
import os, pathlib, re, shutil
here = pathlib.Path(__file__).resolve().parent
vendor = pathlib.Path(os.environ.get("SIA_SDK_VENDOR", here.parent / "sia-s3/vendor/sia-sdk-rs")).resolve()   # the negative control passes its own copy
deps = here / "deps"
shutil.rmtree(deps, ignore_errors=True)
for crate in ("sia_core", "sia_mux", "sia_core_derive", "reqwest_wasi"):
    (deps / crate).mkdir(parents=True)
    for entry in (vendor / crate).iterdir():
        if entry.name != "Cargo.toml":
            os.symlink(entry, deps / crate / entry.name)
    t = (vendor / crate / "Cargo.toml").read_text()
    out = re.sub(r'\n\[\[bench\]\]\nname = "[a-z_]+"\nharness = false\n?', "\n", t)
    assert out == t or out.replace("\n", "") == re.sub(r'\[\[bench\]\]name = "[a-z_]+"harness = false', "", t.replace("\n", "")), crate
    (deps / crate / "Cargo.toml").write_text(out)
t = (vendor / "sia_storage/Cargo.toml").read_text()
t = t.replace('path = "src/lib.rs"', f'path = "{vendor}/sia_storage/src/lib.rs"')
t = re.sub(r'path = "\.\./(sia_core|sia_mux|reqwest_wasi|sia_core_derive)"', lambda m: f'path = "deps/{m.group(1)}"', t)
for dep in ("criterion", "env_logger", "clap", "indicatif", "directories", "toml"):
    t, n = re.subn(rf'^{dep} = .*\n', "", t, flags=re.M)
    assert n == 1, dep
t, n = re.subn(r'\n\[\[bench\]\]\nname = "upload"\nharness = false\nrequired-features = \["mock"\]\n?', "\n", t)
assert n == 1
t = t.replace('[package]\n', '[package]\nautobenches = false\nautoexamples = false\nautotests = false\n', 1)
# as sia-s3 builds sia_storage for its tests ([profile.dev.package."*"] opt-level = 2: "with unoptimized dependencies each
# 4 MiB-sector slab takes seconds"); here sia_storage is the root package, so the dev profile itself is set too. Debug
# assertions and overflow checks stay on (the dev profile's defaults).
t += '\n[profile.dev]\nopt-level = 2\n\n[profile.dev.package."*"]\nopt-level = 2\n'
t += "\n[workspace]\n"
(here / "Cargo.toml").write_text(t)
print("unit/Cargo.toml and unit/deps written from", vendor)
