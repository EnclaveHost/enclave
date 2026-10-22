"""Windows candidate as a DELTA on CURRENT main (root has already integrated the round-3 Windows source into main:
outputs/app-lease-gas-review/windows-source-integration.json). Applies only the corrections made since that integration:
  - a pending sponsored release is settled by the identity RECORDED with its signed lease (operator, chain, reserve,
    executor, ledger), never by the current key/configuration (root rotation review 2026-10-20T20:21Z).
The shared modules (client, journal) change in network/ and reach Windows through the bundle (build-windows-lease-runtime).
Writes shadow-win/windows/node/chain.mjs and patches/current-chain.hunk.patch (against current main); host.mjs is main's.
No production or main-repository edits.
"""
from pathlib import Path
import difflib
import shutil

root = Path(__file__).resolve().parents[1]
main = root.parent / "enclave"


def replace_once(source, before, after):
    assert source.count(before) == 1, before[:100]
    return source.replace(before, after)


rel = "windows/node/chain.mjs"
src = (main / rel).read_text()
out = replace_once(src,
    '    const r = await leaseSender().resolveSigned(want, BigInt(x.fromBlock), e.intents.map((i) => i.payee));\n',
    '    // settled by the identity RECORDED with the signed lease, never by this process\'s current key or configuration\n'
    '    const recorded = { operator: x.operator, chainId: x.chainId, reserve: x.reserve, executor: x.executor, ledger: x.ledger };\n'
    '    const r = await leaseSender().resolveSigned(want, BigInt(x.fromBlock), e.intents.map((i) => i.payee), recorded);\n')
out = replace_once(out,
    '    else out.push({ id: e.id, outcome: "pending" });\n',
    '    else out.push({ id: e.id, outcome: r.why ? `held: ${r.why}` : "pending" });\n')
dest = root / "shadow-win" / rel
if dest.is_symlink() or dest.exists():
    dest.unlink()
dest.write_text(out)
(root / "patches" / "current-chain.hunk.patch").write_text("".join(difflib.unified_diff(src.splitlines(True), out.splitlines(True),
    fromfile="a/" + rel, tofile="b/" + rel)))
host = root / "shadow-win" / "windows/node/host.mjs"
if host.is_symlink() or host.exists():
    host.unlink()
shutil.copyfile(main / "windows/node/host.mjs", host)            # unchanged: main's integrated host.mjs
(root / "patches" / "current-host.hunk.patch").write_text("")   # nothing to change in host.mjs against current main
for name in ("lease-executor-client.mjs", "lease-executor-authority.mjs", "lease-gas-owner.mjs", "lease-gas-runtime.mjs",
             "lease-release-journal.mjs", "rpc-identity.mjs"):
    d = root / "shadow-win" / "network" / name
    if d.is_symlink() or d.exists():
        d.unlink()
    shutil.copyfile(root / "network" / name, d)
print("Windows candidate = current main + rotation correction; main and production unchanged.")
