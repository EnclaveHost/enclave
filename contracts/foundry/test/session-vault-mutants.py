#!/usr/bin/env python3
"""Mutation check for SessionVault: every safety check, deleted or inverted one
at a time, must make the SessionVault Foundry suites fail. A mutant that
survives names a check no test covers.

Runs on a COPY of the repo's contracts tree (never the working file):
    python3 contracts/foundry/test/session-vault-mutants.py [workdir]
"""
import os, shutil, subprocess, sys, tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))
SRC = "contracts/SessionVault.sol"

# (name, exact text in SessionVault.sol, replacement)
MUTANTS = [
    ("execute: liveness",        "        if (!_live(s)) revert NotLive();\n        if (block.timestamp > deadline) revert Expired();\n        {", "        if (block.timestamp > deadline) revert Expired();\n        {"),
    ("execute: deadline",        "        if (!_live(s)) revert NotLive();\n        if (block.timestamp > deadline) revert Expired();\n        {", "        if (!_live(s)) revert NotLive();\n        {"),
    ("execute: nonce",           "            if (seqOf[sid][lane] != uint64(nonce)) revert BadNonce();\n", ""),
    ("execute: signature",       "        if (!_sessionSigValid(s, d, x, y, r, sv)) revert BadSignature();\n        if (action > ACT_LAST", "        if (action > ACT_LAST"),
    ("execute: action bit",      "if (action > ACT_LAST || ((s.actions >> action) & 1) == 0) revert NotAllowed(action);", "if (action > ACT_LAST) revert NotAllowed(action);"),
    ("execute: fee cap",         "        if (fee > s.maxFee6) revert FeeTooHigh(fee, s.maxFee6);\n", ""),
    ("execute: attestation",     "        if (s.measurement != bytes32(0)) _requireAttested(s.keyHash, s.measurement);\n", ""),
    ("spend: budget",            "        if (amt > s.balance6) revert BudgetExceeded(amt, s.balance6);\n", "        if (amt > s.balance6 + 1e12) revert BudgetExceeded(amt, s.balance6);\n"),
    ("spend: period",            "        if (amt > left) revert PeriodLimit(amt, left);\n", ""),
    ("spend: rate",              "        if (s.opsPerPeriod != 0 && s.periodOps >= s.opsPerPeriod) revert RateLimit();\n", ""),
    ("spend: locked debit",      "        locked6 -= amt;\n    }", "    }"),
    ("held env in policy",       "        if (s.envs & env == 0) revert EnvNotAllowed(env);\n", ""),
    ("setAppRef staging only",   "            if (_requireHeldEnv(s, id) != ENV_STAGING) revert WrongEnvironment(id, held[id].env);\n            (bytes32 appId, ) = SessionVaultLib.parseRef(ref);", "            _requireHeldEnv(s, id);\n            (bytes32 appId, ) = SessionVaultLib.parseRef(ref);"),
    ("setConfig staging only",   "            if (_requireHeldEnv(s, id) != ENV_STAGING) revert WrongEnvironment(id, held[id].env);\n            L.setConfig(id, cfg);", "            _requireHeldEnv(s, id);\n            L.setConfig(id, cfg);"),
    ("create: env in policy",    "        if (s.envs & c.env == 0) revert EnvNotAllowed(c.env);\n", ""),
    ("create: app in policy",    "        (bytes32 appId, uint256 idx) = SessionVaultLib.parseRef(c.appRef);\n        _requireApp(sid, s, appId);", "        (bytes32 appId, uint256 idx) = SessionVaultLib.parseRef(c.appRef);"),
    ("create: catalog fee cap",  "            if (feeSec * 3600 > maxAppFeeHour6) revert AppFeeTooHigh(feeSec * 3600, maxAppFeeHour6);\n", ""),
    ("publish: named app",       "        if (!_appListed(sid, appId)) revert AppNotAllowed(appId);\n        return SessionVaultLib.publish(book, p);", "        return SessionVaultLib.publish(book, p);"),
    ("fund: whose deployment",   "            else if (o != owner || s.envs & ENV_PROD == 0) revert NotMine(id);", "            else if (o == address(0)) revert NotMine(id);"),
    ("fund: allowance back to 0","        if (usdc.allowance(address(this), address(L)) != 0) revert AllowanceLeft();\n", ""),
    ("ownerAuth: signature",     "        if (!_ownerSigValid(_hashTypedData(structHash), sig)) revert BadSignature();\n    }", "    }"),
    ("ownerAuth: nonce reuse",   "        if (ownerNonceUsed[opNonce]) revert NonceUsed();\n", ""),
    ("ownerAuth: low-s",         "if (uint256(s) <= HALF_N && (v == 27 || v == 28)) {", "if (v == 27 || v == 28) {"),
    ("grant: signature",         "        if (!_ownerSigValid(gd, ownerSig)) revert BadSignature();\n", ""),
    ("grant: replay",            "        if (s.state != 0) revert Exists();\n", ""),
    ("open: free balance",       "        if (g.budget > _free()) revert BudgetExceeded(g.budget, _free());\n        sid = _open(g);", "        sid = _open(g);"),
    ("withdraw: free only",      "        if (amount > _free()) revert BudgetExceeded(amount, _free());\n        _send(owner, amount);", "        _send(owner, amount);"),
    ("ownerCall: not usdc",      "if (target == address(usdc) || target == address(this) || target.code.length == 0) revert BadTarget();", "if (target == address(this) || target.code.length == 0) revert BadTarget();"),
    ("ownerCall: owner only",    "        if (msg.sender != owner) revert NotOwner();\n        if (target == address(usdc)", "        if (target == address(usdc)"),
    ("deposit cap",              "        if (b > maxVault6) revert OverCap(b, maxVault6);\n", ""),
    ("end: refund owner",        "        if (refund > 0) _send(owner, refund);\n", ""),
    ("revokeAll: free escrow",   "        epoch += 1;\n        locked6 = 0;", "        epoch += 1;"),
    ("close: not before expiry", "        if (block.timestamp <= s.expiresAt) revert NotExpired();\n", ""),
    ("promote: version label",   "        if (keccak256(bytes(v.version)) != keccak256(bytes(label))) revert LabelMismatch();\n", ""),
    ("release: derived target",  "            if (f == address(0) || to != ISVFactory(f).vaultFor(owner) || to == address(this)) revert BadTarget();", "            if (f == address(0)) revert BadTarget();"),
    ("p256: key binding",        "        if (keccak256(abi.encode(x, y)) != s.keyHash) return false;\n", ""),
    ("parseRef: strict digits",  "            if (c < 48 || c > 57) revert BadRef();\n", ""),
]


def main():
    work = sys.argv[1] if len(sys.argv) > 1 else tempfile.mkdtemp(prefix="sv-mutants-")
    if not os.path.exists(os.path.join(work, "foundry.toml")):
        shutil.copytree(os.path.join(ROOT, "contracts"), os.path.join(work, "contracts"),
                        ignore=shutil.ignore_patterns("out", "cache"))
        shutil.copy(os.path.join(ROOT, "foundry.toml"), work)
    path = os.path.join(work, SRC)
    original = open(path).read()
    survived = []
    try:
        for name, old, new in MUTANTS:
            if original.count(old) != 1:
                print(f"STALE  {name}: pattern found {original.count(old)}x")
                survived.append(name + " (stale pattern)")
                continue
            open(path, "w").write(original.replace(old, new))
            r = subprocess.run(["forge", "test", "--match-path", "contracts/foundry/test/SessionVault*.t.sol"],
                               cwd=work, capture_output=True, text=True)
            out = r.stdout + r.stderr
            if r.returncode == 0:
                print(f"SURVIVED  {name}")
                survived.append(name)
            elif "Compiler run failed" in out or "Error (" in out:
                print(f"NOCOMPILE {name}")
                survived.append(name + " (did not compile)")
            else:
                print(f"killed    {name}")
    finally:
        open(path, "w").write(original)
    print(f"\n{len(MUTANTS) - len(survived)}/{len(MUTANTS)} mutants killed")
    if survived:
        print("survivors:", *survived, sep="\n  ")
        sys.exit(1)


if __name__ == "__main__":
    main()
