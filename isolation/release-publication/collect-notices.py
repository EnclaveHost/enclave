#!/usr/bin/env python3
"""collect-notices.py -- gather the license texts and notices a domain release's third-party components require, from
the components' OWN sources (never retyped), into <outdir>/licenses/, and write <outdir>/THIRD-PARTY-NOTICES.md.

    collect-notices.py <outdir> --sources <fetch-corresponding-source.sh outdir> --edk2 <edk2 tree of the firmware build>
                       --wasmtime-src <wasmtime checkout at the packaged tag> --crates <crates.json> --cargo-home <dir>

<crates> is the crate list (wasmtime-crates.tsv, or the same rows as JSON) that cargo tree derives (name, version, license, kind, source); only kind "linked" and
"workspace" crates are compiled into the binary (proc-macros run at build time and are not). A crate that ships no
license file gets the SPDX text of its declared license from /usr/share/licenses/spdx, marked as such.
"""
import argparse, glob, hashlib, io, json, os, re, shutil, sys, tarfile

ap = argparse.ArgumentParser()
ap.add_argument("outdir"); ap.add_argument("--sources", required=True); ap.add_argument("--edk2", required=True)
ap.add_argument("--wasmtime-src", required=True); ap.add_argument("--crates", required=True); ap.add_argument("--cargo-home", required=True)
ap.add_argument("--title", default="domain release 0181bce3 (release id 5c3561f9...)")
ap.add_argument("--extra-md", help="a release's own additions (e.g. public data embedded in its front), inserted before the crate table")
a = ap.parse_args()
L = os.path.join(a.outdir, "licenses")
if os.path.exists(L): shutil.rmtree(L)
os.makedirs(L)
sha = lambda b: hashlib.sha256(b).hexdigest()
written = {}   # relative path -> sha256

def label(src):
    """where a text came from, relative to its source (no build host paths in the published notices)"""
    src = str(src)
    for root, name in ((a.sources, "corresponding-source"), (a.edk2, "edk2 2970e569"), (a.wasmtime_src, "wasmtime v48.0.1")):
        if src.startswith(os.path.abspath(root) + "/"): return f"{name}: {os.path.relpath(src, root)}"
    m = re.search(r"/registry/src/index\.crates\.io-[0-9a-f]+/(.+)$", src)
    if m: return "crates.io: " + m.group(1)
    if src.startswith("/usr/share/licenses/spdx/"): return "the SPDX text (Arch package licenses): " + os.path.basename(src)
    return src

def put(rel, data, why):
    p = os.path.join(L, rel); os.makedirs(os.path.dirname(p), exist_ok=True)
    open(p, "wb").write(data); written[rel] = (sha(data), why)
    return "licenses/" + rel

def from_tar(tarname, members, dest):
    out = []
    with tarfile.open(os.path.join(a.sources, tarname)) as t:
        for m in members:
            f = t.extractfile(t.getmember(m))
            out.append(put(dest + "/" + m.split("/", 1)[1], f.read(), f"corresponding-source: {tarname}: {m}"))
    return out

def from_file(src, dest):
    return put(dest, open(src, "rb").read(), label(src))

def crate_text(src, crate, fname):
    """a crate's license text, stored ONCE per content under licenses/crates/<sha256[:16]>-<name> (crates share texts)"""
    data = open(src, "rb").read(); h = sha(data)
    rel = f"crates/{h[:16]}-{fname.replace('/', '_')}"
    if rel not in written: put(rel, data, label(src))
    else: written[rel] = (written[rel][0], written[rel][1] + f"; also {label(src)}")
    return "licenses/" + rel

sections = []
def section(title, where, version, lic, source, files, notes=""):
    sections.append((title, where, version, lic, source, files, notes))

# --- the guest kernel and its modules ---------------------------------------------------------------------------------
section("Linux kernel (Arch Linux build)", "kernel; template/vsock.ko.zst, vmw_vsock_virtio_transport{,_common}.ko.zst, "
        "tsm_report.ko.zst, sev-guest.ko.zst", "linux 7.2.3.arch1-2 (7.2.3 + Arch patch v7.2.3-arch1)", "GPL-2.0-only WITH Linux-syscall-note "
        "(COPYING; individual files carry compatible SPDX identifiers listed in LICENSES/)",
        "linux-7.2.3.tar.xz + linux-v7.2.3-arch1.patch.zst + config.x86_64 (SOURCES.md)",
        from_tar("linux-7.2.3.tar.xz", ["linux-7.2.3/COPYING", "linux-7.2.3/LICENSES/preferred/GPL-2.0",
                 "linux-7.2.3/LICENSES/exceptions/Linux-syscall-note"], "linux"),
        "The kernel image and the five modules are Arch Linux's binaries, copied unmodified. The modules carry Arch's "
        "build-time signatures; the key is Arch's ephemeral per-build key, which no source contains. The kernel does "
        "not enforce module signatures (CONFIG_MODULE_SIG_FORCE is not set), so a kernel and modules rebuilt from this "
        "source run.")

# --- glibc -------------------------------------------------------------------------------------------------------------
section("GNU C Library (glibc)", "template/rt/libc.so.6, libm.so.6, ld-linux-x86-64.so.2 (shared); template/init (static: "
        "libc.a and crt1.o/crti.o/crtn.o linked in)", "glibc 2.44+r24+g16be1518495f-1 (Arch; commit 16be1518495f)",
        "LGPL-2.1-or-later, with the notices in LICENSES", "glibc-16be1518495f.tar.xz + Arch's PKGBUILD (SOURCES.md)",
        from_tar("glibc-16be1518495f.tar.xz", ["glibc-16be1518495f/COPYING.LIB", "glibc-16be1518495f/COPYINGv2",
                 "glibc-16be1518495f/LICENSES"], "glibc"),
        "template/init is linked STATICALLY with glibc, so LGPL-2.1 section 6 applies to it. For relinking it with a "
        "modified glibc, these are provided: its own source (source/isolation/m2/dominit.c in this tarball), the exact "
        "link command (INVENTORY.md) and glibc's source. Whether the repository LICENSE's terms grant everything section "
        "6 asks of the combined work is an open finding, recorded in INVENTORY.md.")

# --- GCC runtime -------------------------------------------------------------------------------------------------------
section("GCC runtime libraries (libgcc_s, libgcc, libgcc_eh, crtbeginT.o, crtend.o)", "template/rt/libgcc_s.so.1 (shared); "
        "template/init (static)", "gcc 16.2.1+r23+gd564253eb6c8-1 / libgcc (Arch; commit d564253eb6c8)",
        "GPL-3.0-or-later WITH GCC-exception-3.1", "gcc-d564253eb6c8.tar.xz + Arch's PKGBUILD and patches (SOURCES.md)",
        from_tar("gcc-d564253eb6c8.tar.xz", ["gcc-d564253eb6c8/COPYING3", "gcc-d564253eb6c8/COPYING.RUNTIME"], "gcc"),
        "The GCC Runtime Library Exception covers the libgcc code compiled into template/init and wasmtime. "
        "libgcc_s.so.1 is also shipped as a file of its own, so its complete corresponding source is provided.")

# --- GRUB (inside the firmware) ----------------------------------------------------------------------------------------
section("GNU GRUB (the AmdSev GRUB image inside the firmware volume)", "firmware.fd (the Grub FFS file, grub.efi)",
        "grub 2:2.14-1 (Arch; tag grub-2.14, gnulib 9f48fb99)", "GPL-3.0-or-later",
        "grub-2.14.tar.xz + gnulib-9f48fb99.tar.xz + Arch's PKGBUILD and patches; the image recipe is edk2's "
        "OvmfPkg/AmdSev/Grub/grub.sh with patches/edk2-amdsev-grub-modules.patch (SOURCES.md)",
        from_tar("grub-2.14.tar.xz", ["grub-2.14/COPYING"], "grub"),
        "grub.efi is made by grub-mkimage from the build host's installed GRUB modules (part_msdos part_gpt cryptodisk "
        "luks gcry_rijndael gcry_sha256 ext2 btrfs xfs fat configfile memdisk sleep normal echo test regexp linux reboot "
        "and their dependencies) with a memdisk holding edk2's grub.cfg. It is a separate program aggregated in the "
        "firmware volume. On the project's -kernel boot path the firmware loads the served kernel itself; the boot "
        "manager reaches GRUB only when no kernel is served (isolation/m1/domain.env). GPL-3.0 section 6's "
        "Installation Information clause concerns User Products; this firmware is a cloud guest's, and a modified "
        "firmware runs (it is measured differently, which is what a measurement is for).")

# --- EDK2 / OVMF -------------------------------------------------------------------------------------------------------
E = a.edk2
section("TianoCore EDK II (OVMF AmdSevX64)", "firmware.fd", "edk2-stable202608 (2970e569), AmdSevX64 RELEASE",
        "BSD-2-Clause-Patent", "the edk2 commit and submodule pins (edk2-submodules.txt), the patch, and rebuild-firmware.sh",
        [from_file(os.path.join(E, "License.txt"), "edk2/License.txt")])
section("OpenSSL (edk2 CryptoPkg OpensslLib, linked into QemuKernelLoaderFsDxe)", "firmware.fd", "OpenSSL 3.5.7 (edk2 submodule 8cf17aae)",
        "Apache-2.0", "edk2 submodule CryptoPkg/Library/OpensslLib/openssl at 8cf17aaeb4599f8af87fefd810b5b5fee90fe69e",
        [from_file(os.path.join(E, "CryptoPkg/Library/OpensslLib/openssl/LICENSE.txt"), "openssl/LICENSE.txt")])
section("LZMA SDK (edk2 LzmaCustomDecompressLib)", "firmware.fd", "LZMA SDK 19.00 (in edk2)", "public domain",
        "edk2 MdeModulePkg/Library/LzmaCustomDecompressLib/Sdk",
        [from_file(os.path.join(E, "MdeModulePkg/Library/LzmaCustomDecompressLib/LZMA-SDK-README.txt"), "lzma-sdk/LZMA-SDK-README.txt")])

# --- Go ----------------------------------------------------------------------------------------------------------------
section("Go standard library and runtime (compiled into template/front)", "template/front", "go 2:1.27.0-1 (Arch; go1.27.0)",
        "BSD-3-Clause", "go1.27.0.src.tar.gz (sha256 in Arch's PKGBUILD, SOURCES.md)",
        from_tar("go1.27.0.src.tar.gz", ["go/LICENSE", "go/PATENTS"], "go"))

# --- wasmtime and its crates -------------------------------------------------------------------------------------------
W = a.wasmtime_src
section("Rust standard library (core, alloc, std, and the runtime pieces rustc links)", "template/rt/wasmtime",
        "rustc 1.98.0 (88d9e12a; Arch rust 1:1.98.0-1, as wasmtime's .comment records)", "MIT OR Apache-2.0 (COPYRIGHT lists the parts under other terms)",
        "rust-lang/rust at 88d9e12ae178fab0fb5cc050a94da85685d449ea",
        [from_file(os.path.join(a.sources, "rust-1.98.0-" + f), "rust/" + f) for f in ("COPYRIGHT", "LICENSE-APACHE", "LICENSE-MIT")],
        "cargo tree lists crates, not the standard library a Rust binary is linked with; these are its texts (enclave-e3).")
wfiles = [from_file(os.path.join(W, "LICENSE"), "wasmtime/LICENSE")]
section("Wasmtime (template/rt/wasmtime)", "template/rt/wasmtime", "wasmtime 48.0.1-1 (Arch; tag v48.0.1)",
        "Apache-2.0 WITH LLVM-exception (the wasmtime workspace crates); its crates below", "the tag v48.0.1 and its Cargo.lock",
        wfiles)
if a.crates.endswith(".tsv"):   # the committed form: comment lines, a header, then name version license kind source
    rows = [l.rstrip("\n").split("\t") + [""] for l in open(a.crates) if l.strip() and not l.startswith("#")][1:]
else:
    rows = json.load(open(a.crates))
reg = glob.glob(os.path.join(a.cargo_home, "registry/src/index.crates.io-*"))[0]
crate_rows = []
spdx = "/usr/share/licenses/spdx"
for name, ver, lic, kind, src, repo in rows:
    if kind != "linked": continue
    d = os.path.join(reg, f"{name}-{ver}")
    fs = sorted(f for f in os.listdir(d) if re.match(r"(?i)^(licen[cs]e|copying|notice|unlicense|copyright)", f) and os.path.isfile(os.path.join(d, f)))
    got = [crate_text(os.path.join(d, f), name, f) for f in fs]
    if os.path.isdir(os.path.join(d, "LICENSES")):   # a REUSE-style directory of license texts
        for f in sorted(os.listdir(os.path.join(d, "LICENSES"))):
            got.append(crate_text(os.path.join(d, "LICENSES", f), name, f)); fs.append(f)
    # C libraries a -sys crate compiles in, with their own terms
    for sub in {"capstone-sys": ["capstone/LICENSE.TXT", "capstone/LICENSE_LLVM.TXT"], "zstd-sys": ["zstd/LICENSE", "zstd/COPYING"],
                "ittapi-sys": ["c-library/LICENSES/BSD-3-Clause.txt", "c-library/LICENSES/GPL-2.0-only.txt"]}.get(name, []):
        if os.path.exists(os.path.join(d, sub)): got.append(crate_text(os.path.join(d, sub), name, sub.split("/")[-1]))
    note = ""
    if not fs:
        # no license file in the crate: the text of the license it is USED under, from the nearest authoritative copy
        if "LLVM-exception" in lic:      # wasmtime's LICENSE is the Bytecode Alliance's Apache-2.0 WITH LLVM-exception text
            got.append(crate_text(os.path.join(W, "LICENSE"), name, "LICENSE")); note = "no license file in the crate: Apache-2.0 WITH LLVM-exception as in wasmtime's LICENSE"
        elif name == "ittapi":           # the same upstream repository (intel/ittapi) as ittapi-sys, whose text it is
            got.append(crate_text(os.path.join(reg, f"ittapi-sys-{ver}", "LICENSES", "BSD-3-Clause.txt"), name, "BSD-3-Clause.txt"))
            note = "no license file in the crate: used under BSD-3-Clause, the text from ittapi-sys (same upstream, intel/ittapi)"
        else:
            ids = [i for i in re.findall(r"[A-Za-z0-9.\-]+", lic) if i not in ("OR", "AND", "WITH")]
            for i in ids:
                t = os.path.join(spdx, i + ".txt")
                if os.path.exists(t): got.append(crate_text(t, name, f"SPDX-{i}.txt")); break
            note = "no license file in the crate: the SPDX text of its declared license"
        if not got: raise SystemExit(f"collect-notices: no text for {name} {ver} ({lic})")
    crate_rows.append((name, ver, lic, got, note))
section(f"Rust crates compiled into wasmtime ({len(crate_rows)})", "template/rt/wasmtime", "Cargo.lock of wasmtime v48.0.1, default features",
        "per crate, below", "crates.io, at the versions below", [])

# --- write -------------------------------------------------------------------------------------------------------------
md = io.StringIO()
w = md.write
w(f"# Third-party notices: {a.title}\n\n")
w("Every component below is part of the release's bytes (INVENTORY.md says where, and how that was established). Each "
  "remains under its own license. The texts are copied from each component's own source into licenses/, byte for byte; "
  "their sha256 are listed at the end. The corresponding source of the copyleft components is listed in SOURCES.md. "
  "Enclave's own code in the release (template/init from isolation/m2/dominit.c, template/front, the release manifest) is "
  "under the repository's LICENSE.\n\n")
for title, where, version, lic, source, files, notes in sections:
    w(f"## {title}\n\n- **In the release:** {where}\n- **Version:** {version}\n- **License:** {lic}\n- **Source:** {source}\n")
    if files: w("- **Texts:** " + ", ".join(f"[{f}]({f})" for f in files) + "\n")
    if notes: w(f"\n{notes}\n")
    w("\n")
if a.extra_md: w(open(a.extra_md).read().rstrip() + "\n\n")
w("## The crates, one per row\n\n| crate | version | license (declared) | texts |\n|---|---|---|---|\n")
for name, ver, lic, got, note in crate_rows:
    w(f"| {name} | {ver} | {lic} | " + ", ".join(f"[{os.path.basename(g)}]({g})" for g in got) + (f" ({note})" if note else "") + " |\n")
w("\nWhere a crate is offered under a choice of licenses (\"X OR Y\"), it is used under any one of them; for the two "
  "crates offered as \"GPL-2.0-only OR BSD-3-Clause\" (ittapi, ittapi-sys), under BSD-3-Clause.\n\n")
w("## The texts, by sha256\n\n| file | sha256 | taken from |\n|---|---|---|\n")
for rel in sorted(written):
    h, why = written[rel]
    w(f"| licenses/{rel} | {h} | {why} |\n")
open(os.path.join(a.outdir, "THIRD-PARTY-NOTICES.md"), "w").write(md.getvalue())
print(f"notices: {len(sections)} sections, {len(crate_rows)} crates, {len(written)} texts")
