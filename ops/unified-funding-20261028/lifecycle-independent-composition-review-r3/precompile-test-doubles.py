"""Owned fixture only: compile the exact original input in a child that exits.

The suites load its unchanged JSON output instead of retaining solc WASM beside
Anvil. No test assertion, deployed bytecode, compiler setting or RPC is changed.
"""
from pathlib import Path
import hashlib, json, subprocess, sys, difflib

tree, out = map(Path, sys.argv[1:])
fixture = tree / 'test/fixtures/r5-world.mjs'
original = fixture.read_text()
assert hashlib.sha256(fixture.read_bytes()).hexdigest() == '26a67fff56d238072db398eafd25cbe16f4f47fd6aa9c23f42a2f7f3e22bb661'
prefix = '    const out = JSON.parse(solc.compile('
start = original.index(prefix)
end = original.index('\n    if (out.errors?', start)
block = original[start:end]
assert block.endswith('));')
expression = block[len(prefix):-3]
assert expression.startswith('JSON.stringify(') and expression.endswith(')')
compiler = fixture.with_name('root-compile-doubles.mjs')
compiler.write_text("import fs from 'node:fs';\nimport solc from 'solc';\n" +
    'const input = ' + expression + ';\n' +
    "fs.writeFileSync(process.argv[2]+'/doubles-input.json',input);\n" +
    "const output=solc.compile(input);\n" +
    "fs.writeFileSync(process.argv[2]+'/doubles-output.json',output);\n" +
    "if(JSON.parse(output).errors?.some(e=>e.severity==='error'))process.exitCode=1;\n")
subprocess.run(['node', '--max-old-space-size=128', '--max-semi-space-size=4',
    str(compiler), str(out)], check=True, timeout=90)
compiled = out / 'doubles-output.json'
digest = hashlib.sha256(compiled.read_bytes()).hexdigest()
target = fixture.with_name('root-doubles-output.json')
target.write_bytes(compiled.read_bytes())
replacement = ("    const compiled = fs.readFileSync(new URL('./root-doubles-output.json', import.meta.url));\n"
    "    if (createHash('sha256').update(compiled).digest('hex') !== '" + digest + "') throw Error('TEST doubles output changed');\n"
    "    const out = JSON.parse(compiled);")
changed = original.replace("import solc from 'solc';", "import {createHash} from 'node:crypto';").replace(block, replacement)
assert changed != original and 'solc.compile' not in changed
fixture.write_text(changed)
(out/'fixture-precompile.diff').write_text(''.join(difflib.unified_diff(original.splitlines(True), changed.splitlines(True), fromfile='original-test-fixture', tofile='owned-precompiled-fixture')))
(out/'fixture-precompile.json').write_text(json.dumps({
    'qualification':'exact original compiler input; unchanged raw output, test fixture only',
    'originalFixtureSha256': hashlib.sha256(original.encode()).hexdigest(),
    'compiledInputSha256': hashlib.sha256((out/'doubles-input.json').read_bytes()).hexdigest(),
    'compiledOutputSha256': digest,
    'ownedFixtureSha256': hashlib.sha256(changed.encode()).hexdigest(),
}, indent=2)+'\n')
