from pathlib import Path
p=Path('/home/steven/enclave-bench/nucbox-public-web-20261005/build-image.mjs');s=p.read_text();root=Path(__file__).resolve().parent
s=s[s.index('import fs from'):]
s=s.replace('const build = (tag, manBuf, res, args = [], over = {}) => {','const build = (tag, manBuf, res, args = [], over = {}) => {\n    global.gc?.();')
s=s.replace('return { bin, vbs, binSha: sha(bin), vbsSha: sha(vbs), digest: digest(vbs), path: o, vbsPath: vj };', '''return { bytes: bin.length, markers: Object.fromEntries([...m.rebuild.g4probe.mustContain, ...m.rebuild.g4probe.mustNotContain, ...ud.mustContain].map(s => [s, bin.includes(Buffer.from(s))])), binSha: sha(bin), vbsSha: sha(vbs), digest: digest(vbs), path: o, vbsPath: vj };''')
s=s.replace('bytes: c1.bin.length','bytes: c1.bytes').replace('bytes: dbg.bin.length','bytes: dbg.bytes')
s=s.replace('has(c1.bin, s)','c1.markers[s]').replace('has(dbg.bin, s)','dbg.markers[s]')
s=s.replace('const over = { linux_initrd:', '''if (sha(kernel) !== "6bbd7340f7505cffb4d00cfa84604052b394f2d6467918e24d4c44935783e0c0") throw Error("kernel pin mismatch");
  if (sha(underhill) !== "71a91101f8f9b870199946076db2b220c68167e029539d4619a6b7600432124e") throw Error("patched OpenHCL pin mismatch");
  const over = { linux_initrd:''')
s=s.replace('for (const mu of u.mutations)', 'for (const mu of [...u.mutations, { name: "one byte of patched OpenHCL initrd", kind: "resourceByte", resource: "underhill_initrd", at: "middle" }])')
s=s.replace('b[off] ^= 1;', 'if (off < 0 || off >= b.length) throw Error("mutation offset invalid"); b[off] ^= 1;')
s=s.replace('// 4. keep the outputs, read-only, in this lane\'s own directory', '''if (!out.candidate.deterministic) throw Error("nonrepeatable image assembly");
  if (out.debugTwin.digest === out.candidate.digest || out.debugTwin.strings.some(([,v])=>!v)) throw Error("debug twin guard failed");
  if (out.candidate.strings.mustContain.some(([,v])=>!v) || out.candidate.strings.mustNotContain.some(([,v])=>v)) throw Error("candidate command-line guard failed");
  if (out.mutations.some(x=>!x.changed)) throw Error("unmeasured image mutation");
  // 4. keep the outputs, read-only, in this lane's own directory''')
s=s.replace('linux_kernel: sha(kernel), manifest:', 'linux_kernel: sha(kernel), underhill_initrd: sha(underhill), recipeManifest: sha(fs.readFileSync(V)), sourceCommit: "0ed5a8ba", manifest:')
s=s.replace('by: "enclave-61 (public-web egress, risc-box)"', 'by: "Shield-direct candidate preparation; source0ed5a8ba; unactivated"')
s=s.replace('recipe: "v41\'s rebuild.vbsLinux1539 (b7ba7731\'s manifest and resources) with linux_initrd and linux_kernel swapped"','recipe: "Pinned v41 rebuild.vbsLinux1539 manifest/resources with committed Shield-direct initrd, pinned TPM kernel and volatile-input patched OpenHCL initrd"')
(root/'build-image.mjs').write_text(s)
