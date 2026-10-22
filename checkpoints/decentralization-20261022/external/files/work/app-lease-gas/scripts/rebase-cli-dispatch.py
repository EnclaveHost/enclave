"""Build the isolated CLI candidate (shadow-cli/cli/enclave.mjs) from CURRENT main cli/enclave.mjs: the `lease-gas`
command (cli/lease-gas.mjs, network/lease-gas-owner.mjs), independent mode only. Writes patches/lease-gas-cli-dispatch.hunk.patch.
No production or main-repository edits.
"""
from pathlib import Path
import difflib

root = Path(__file__).resolve().parents[1]
main = root.parent / "enclave"
target = root / "shadow-cli" / "cli" / "enclave.mjs"


def replace_once(source, before, after):
    assert source.count(before) == 1, before[:100]
    return source.replace(before, after)


src = (main / "cli" / "enclave.mjs").read_text()
out = replace_once(src,
    '"config", "encvol", "host", "gpu", "move", "login", "logout", "account", "signer", "custody"]);',
    '"config", "encvol", "host", "gpu", "move", "login", "logout", "account", "signer", "custody", "lease-gas"]);')
out = replace_once(out,
    '  "app-token": cmdAppToken, "cpu-profile": cmdCpuProfile, signer: cmdSigner,\n};',
    '  "app-token": cmdAppToken, "cpu-profile": cmdCpuProfile, signer: cmdSigner, "lease-gas": cmdLeaseGas,\n};')
out = replace_once(out, 'function requireIndependent(what) {', '''// app-funded lease gas: an app owner's reserve, policy and caps (cli/lease-gas.mjs, network/lease-gas-owner.mjs). Every read
// is the quorum; a request goes through the same independent writer and external signer as every other command, or is
// printed unsigned. The local wallet key is never used for it.
async function cmdLeaseGas(rest) {
  requireIndependent("lease-gas");
  const { cmdLeaseGas: run } = await import("./lease-gas.mjs");
  return run(rest, { flags, say, jout, env, json: !!opt.json, chain: INDEPENDENT.chain, trust: INDEPENDENT.trust, I: INDEPENDENT.I,
    signer: INDEPENDENT.signer || null, from: opt.from, maxFeeGwei: INDEPENDENT.maxFeeGwei, readFileBytes: (p) => fs.readFileSync(p), log: (m) => trace(m) });
}
function requireIndependent(what) {''')
if target.is_symlink() or target.exists():
    target.unlink()
target.write_text(out)
target.chmod(0o755)
patch = "".join(difflib.unified_diff(src.splitlines(True), out.splitlines(True), fromfile="a/cli/enclave.mjs", tofile="b/cli/enclave.mjs"))
(root / "patches" / "lease-gas-cli-dispatch.hunk.patch").write_text(patch)
print("Rebased CLI dispatch candidate from current main; main and production unchanged.")
