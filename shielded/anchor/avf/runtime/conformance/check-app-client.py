#!/usr/bin/env python3
"""check-app-client.py <dir> -- the INSTALLED pVM client on the phone (cpu/app-client-run.sh; client/DESIGN.md; LAB, not
production). Exit 0 only when:
  - the built CLI and the built browser extension, each anchored at install on the lab policy key, streamed the Pixel VM's
    answer complete under the signed policy, and followed a newer signed policy;
  - each refused, before sending anything: a policy signed by another key, a rollback to an older signed policy, and a
    relay swapping the VM's app key; the CLI also refused a policy narrowing the roots off the Pixel's own root (at verify,
    on the real chain), a minimum version above it (disabled), and a policy that does not admit the app;
  - the extension refused a relay-truncated stream as incomplete;
  - the VM served exactly the requests that were released; no private key and no plaintext appear in the results or logs.
From 0.2.0 the extension also posts a "policy-committed" event under a page's label when it has durably committed the
policy, BEFORE anything else: outcomes are the non-event lines, and each accepted page's commit must precede its outcome.
The CLI's state is read through its `state` command (cli-state-cmd.json); a 0.1.0 run kept it in cli-state.json."""
import json, os, re, sys
d = sys.argv[1]
fails = []
def expect(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok: fails.append(what)
def rd(n):
    p = os.path.join(d, n)
    return open(p, errors="replace").read() if os.path.exists(p) else ""
def cli(label):
    lines = [json.loads(l) for l in rd(f"cli-{label}.jsonl").splitlines() if l.startswith("{")]
    r = next((x["result"] for x in reversed(lines) if "result" in x), {})
    return r, [x["line"] for x in lines if "line" in x]
ext = [json.loads(l) for l in rd("ext-results.jsonl").splitlines() if l.startswith("{")]
outcomes = [x for x in ext if not x.get("event")]
e = lambda label: next((x for x in reversed(outcomes) if x.get("label") == label), {})
def complete(r, n=24): return r.get("complete") is True and r.get("tokens") == n and r.get("status") == 200
inst = json.loads(rd("cli-install.json") or "{}")
expect(inst.get("anchor", {}).get("policyKeyFp") == json.loads(rd("policy-key.json") or "{}").get("fingerprint"), "CLI: installed with the lab policy key's fingerprint as its anchor")
r, lines = cli("stream")
expect(complete(r) and r.get("policySerial") == 1 and len([l for l in lines if '"token":' in l]) == 24, f"CLI: streamed 24 tokens complete under policy 1 (first token {r.get('firstTokenMs')} ms, all {r.get('ms')} ms)")
r, _ = cli("whole"); expect(r.get("status") == 200 and '"token":' in (r.get("body") or ""), "CLI: a whole-mode answer under the same policy")
for label, step, why in [("attacker-policy", "policy", "anchor does not name"), ("rollback", "policy", "rollback"), ("narrow-roots", "verify", "not a pinned Google attestation root"),
                         ("min-version", "policy", "disabled until updated"), ("other-app", "policy", "does not admit this app"),
                         ("relay-swaps-key", "verify", "not signed by the attested transport key")]:
    r, _ = cli(label)
    expect(r.get("step") == step and r.get("sent") is False and why in (r.get("refused") or ""), f"CLI {label}: refused at {step}, nothing sent ({(r.get('refused') or '')[:90]})")
r, _ = cli("policy-2"); expect(complete(r) and r.get("policySerial") == 2, "CLI: followed the newer signed policy (serial 2), complete")
st = json.loads(rd("cli-state-cmd.json") or "{}").get("state") if rd("cli-state-cmd.json") else json.loads(rd("cli-state.json") or "{}"); st = st or {}; expect(st.get("serial") == 6, f"CLI: its state holds serial {st.get('serial')}, the newest genuine policy it saw (the rollback memory)")
labels = [x.get("label") for x in outcomes if x.get("label")]
expect(len(labels) == len(set(labels)) == 6, f"extension: each of its 6 pages ran exactly once (no restored tab re-ran a page): {sorted(labels)}")
installed = next((x for x in ext if x.get("installed")), {})
expect(installed.get("anchor", {}).get("policyKeyFp") == inst.get("anchor", {}).get("policyKeyFp"), "extension: anchored from its own options page on the lab policy key")
for label, ser in [("ext-stream", 1), ("ext-policy-2", 2)]:
    x = e(label); expect(sum(1 for y in outcomes if y.get("label") == label) == 1 and complete(x) and x.get("policySerial") == ser and "HeadlessChrome" in x.get("userAgent", "") and x.get("extension"),
                         f"extension {label}: 24 tokens complete under policy {ser} in {x.get('userAgent', '?')[-28:]} (first token {x.get('firstTokenMs')} ms)")
for label, step, why in [("ext-attacker-policy", "policy", "anchor does not name"), ("ext-rollback", "policy", "rollback"),
                         ("ext-relay-swaps-key", "verify", "not signed by the attested transport key")]:
    x = e(label); expect(x.get("step") == step and x.get("sent") is False and why in (x.get("refused") or ""), f"extension {label}: refused at {step}, nothing sent ({(x.get('refused') or '')[:90]})")
if any(y.get("event") for y in ext):   # 0.2.0: the policy was committed durably before the page fetched evidence or sent anything
    for label, ser in [("ext-stream", 1), ("ext-policy-2", 2), ("ext-relay-swaps-key", 2), ("ext-relay-truncates", 2)]:
        c = next((i for i, y in enumerate(ext) if y.get("label") == label and y.get("event") == "policy-committed"), None)
        o = next((i for i, y in enumerate(ext) if y.get("label") == label and not y.get("event")), None)
        expect(c is not None and o is not None and c < o and ext[c].get("serial") == ser, f"extension {label}: policy serial {ser} committed (generation {ext[c].get('gen') if c is not None else '?'}) before anything was sent")
    for label in ["ext-attacker-policy", "ext-rollback"]:
        expect(not any(y.get("label") == label and y.get("event") for y in ext), f"extension {label}: the refused policy was never committed")
x = e("ext-relay-truncates"); expect(x.get("complete") is False and x.get("error") == "truncated", f"extension ext-relay-truncates: incomplete, never called complete ({(x.get('refused') or '')[:80]}; {x.get('tokens')} authentic tokens)")
L = rd("l1.log"); L += "\n" + "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", L))
fins = len(re.findall(r"SEALED stream nonce=\w+ fin after", L)); whole = len(re.findall(r"SEALED served nonce=", L))
expect(fins == 5 and whole == 1, f"the VM served exactly the released requests: {fins} streams (want 5: CLI x2, extension x3 incl. the one the relay cut) + {whole} whole (want 1)")
expect("was fooled" not in rd("evil.jsonl"), "no client ever sealed a request to the relay")
allfiles = [os.path.join(r, f) for r, _, fs in os.walk(d) for f in fs]
expect(not any("PRIVATE KEY" in open(f, errors="replace").read() for f in allfiles), "no private key anywhere in the results (lab keys stay outside the repository)")
for n in ["l1.log", "hub.jsonl", "hub.err", "evil.jsonl", "evil.err", "sink.jsonl", "sink.err", "carrier.log"]:
    t = rd(n); t += "\n".join(bytes.fromhex(m.group(1)).decode("utf-8", "replace") for m in re.finditer(r"APPOUT \d+ ([0-9a-f]+)", t))
    hit = [m for m in ["GET /?graph", "steps=", '"token":', "tok_per_s"] if m in t]
    expect(not hit, f"{n}: no request or token in the clear{' (found ' + ', '.join(hit) + ')' if hit else ''}")
print("PASS the installed client on the device" if not fails else f"FAIL ({len(fails)})"); sys.exit(1 if fails else 0)
